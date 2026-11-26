// Client Foundry VTT "headless" : login comme un navigateur, puis socket.io
import { createRequire } from "node:module";
import { ChatHistory } from "./chat-history.mjs";
import { message } from "./i18n.mjs";
const require = createRequire(import.meta.url);
const { io } = require("socket.io-client");

export const FOUNDRY = process.env.FOUNDRY_URL || "http://127.0.0.1:30000";
// Recheck the authoritative history even when Foundry broadcasts are arriving.
const requestedChatCacheAge = Number(process.env.CHAT_CACHE_MAX_AGE_MS);
const CHAT_CACHE_MAX_AGE_MS = Number.isFinite(requestedChatCacheAge) && requestedChatCacheAge >= 1000
  ? Math.min(requestedChatCacheAge, 120000) : 15000;

function cookieFrom(res) {
  const sc = res.headers.getSetCookie?.() || [];
  const m = sc.map(c => c.match(/^session=([^;]+)/)).find(Boolean);
  return m ? m[1] : null;
}

function connectSocket(session) {
  return new Promise((resolve, reject) => {
    const s = io(FOUNDRY, { path: "/socket.io", transports: ["websocket"], extraHeaders: { cookie: `session=${session}` }, reconnection: false, timeout: 10000 });
    const t = setTimeout(() => { s.close(); reject(new Error(message("Foundry socket connection timed out", "Timeout connexion socket Foundry"))); }, 15000);
    s.once("session", info => { clearTimeout(t); resolve({ socket: s, info }); });
    s.once("connect_error", e => { clearTimeout(t); reject(e); });
  });
}

const emit = (socket, ev, ...args) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`Timeout ${ev}`)), 30000);
  socket.emit(ev, ...args, r => { clearTimeout(t); resolve(r); });
});

export class FoundrySession {
  static async login(username, password, { adminPassword } = {}) {
    let r = await fetch(`${FOUNDRY}/join`, { redirect: "manual" });
    const session = cookieFrom(r);
    if (!session) throw new Error(message("No session cookie (is a world active?)", "Pas de cookie de session (aucun monde actif ?)"));
    const headers = { cookie: `session=${session}`, "content-type": "application/json", "sec-fetch-site": "same-origin" };
    // Trouver l'ID du user depuis son nom
    const pre = await connectSocket(session);
    const join = await emit(pre.socket, "getJoinData");
    pre.socket.close();
    if (!join?.world) throw new Error(message("No active world", "Aucun monde actif"));
    const user = join.users.find(u => u.name.toLowerCase() === String(username).toLowerCase());
    if (!user) return null;
    if (adminPassword) { // chemin de test : session admin + loginAs
      await fetch(`${FOUNDRY}/setup`, { method: "POST", headers, body: JSON.stringify({ action: "noop", adminPassword }) });
      r = await fetch(`${FOUNDRY}/join`, { method: "POST", headers, body: JSON.stringify({ action: "loginAs", userId: user._id }) });
    } else {
      if (!password) return null;
      r = await fetch(`${FOUNDRY}/join`, { method: "POST", headers, body: JSON.stringify({ action: "join", userId: user._id, password }) });
    }
    if (r.status !== 200) return null;
    const j = await r.json().catch(() => ({}));
    if (j.status !== "success") return null;
    const { socket, info } = await connectSocket(session);
    if (!info?.userId) { socket.close(); return null; }
    const s = new FoundrySession();
    Object.assign(s, { socket, session, userId: info.userId, user: { id: user._id, name: user.name, role: user.role }, world: join.world });
    return s;
  }
  get alive() { return this.socket?.connected; }
  /** Événement socket relayé par le serveur Foundry aux autres clients (shareImage, showEntry, pause, pullToScene…). */
  broadcast(ev, ...args) {
    return new Promise(resolve => {
      const t = setTimeout(() => resolve(null), 3000);
      this.socket.emit(ev, ...args, r => { clearTimeout(t); resolve(r ?? true); });
    });
  }
  close() {
    if (this._chatSocket) {
      this._chatSocket.off("modifyDocument", this._chatOnChange);
      this._chatSocket.off("disconnect", this._chatOnDisconnect);
      this._chatSocket = null;
    }
    this._chatHistory?.clear();
    this.socket?.close();
  }
  _watchChat() {
    if (this._chatSocket === this.socket) return;
    this._chatHistory = new ChatHistory();
    this._chatSocket = this.socket;
    this._chatOnChange = event => this._chatHistory.observe(event);
    this._chatOnDisconnect = () => this._chatHistory.clear();
    this.socket.on("modifyDocument", this._chatOnChange);
    this.socket.on("disconnect", this._chatOnDisconnect);
  }
  async _refreshChat() {
    if (this._chatRefresh) return this._chatRefresh;
    this._chatHistory.beginRefresh();
    const pending = (async () => {
      const documents = await emit(this.socket, "modifyDocument", {
        type: "ChatMessage", action: "get", operation: { query: {} }
      });
      if (documents?.error) throw new Error(documents.error.message || JSON.stringify(documents.error));
      const result = documents?.result ?? documents?.results;
      this._chatHistory.completeRefresh(result);
      return result;
    })();
    this._chatRefresh = pending;
    try { return await pending; }
    catch (error) { this._chatHistory.failRefresh(); throw error; }
    finally { this._chatRefresh = null; }
  }
  async doc(action, type, operation = {}) {
    if (action === "get" && type === "ChatMessage" && !operation.pack && !operation.parentUuid) {
      const query = operation.query || {};
      const keys = Object.keys(query);
      const threshold = query.timestamp?.$gte;
      const onlySince = keys.length === 1 && keys[0] === "timestamp" &&
        query.timestamp && Object.keys(query.timestamp).length === 1 &&
        typeof threshold === "number" && Number.isFinite(threshold) && threshold >= 0;
      if (!keys.length || onlySince) {
        this._watchChat();
        if (!onlySince) return this._refreshChat();
        if (!this._chatHistory.isFresh(CHAT_CACHE_MAX_AGE_MS)) await this._refreshChat();
        return this._chatHistory.since(threshold);
      }
    }
    const r = await emit(this.socket, "modifyDocument", { type, action, operation });
    if (r?.error) throw new Error(r.error.message || JSON.stringify(r.error));
    if (type === "ChatMessage" && ["create", "update", "delete"].includes(action)) {
      this._chatHistory?.observe({ type, action, result: r?.result ?? r?.results });
    }
    return r?.result ?? r?.results;
  }
  async worldData() { return emit(this.socket, "world"); }
  async files(data, options = {}) {
    const r = await emit(this.socket, "manageFiles", data, options);
    if (r?.error) throw new Error(r.error);
    return r;
  }
  async upload(target, filename, buffer, mime) {
    try { await this.files({ action: "createDirectory", storage: "data", target }); } catch (e) { if (!/exists/i.test(e.message)) throw e; }
    const fd = new FormData();
    fd.append("source", "data"); fd.append("target", target);
    fd.append("upload", new Blob([buffer], { type: mime || "application/octet-stream" }), filename);
    const r = await fetch(`${FOUNDRY}/upload`, { method: "POST", headers: { cookie: `session=${this.session}`, "sec-fetch-site": "same-origin" }, body: fd });
    const j = await r.json().catch(() => ({}));
    if (j.error || !j.path) throw new Error(j.error || j.message || message(`Upload failed (${r.status})`, `Upload échoué (${r.status})`));
    return j.path;
  }
}
