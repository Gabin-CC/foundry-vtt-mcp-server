// Client Foundry VTT "headless" : login comme un navigateur, puis socket.io
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { io } = require("socket.io-client");

export const FOUNDRY = process.env.FOUNDRY_URL || "http://127.0.0.1:30000";

function cookieFrom(res) {
  const sc = res.headers.getSetCookie?.() || [];
  const m = sc.map(c => c.match(/^session=([^;]+)/)).find(Boolean);
  return m ? m[1] : null;
}

function connectSocket(session) {
  return new Promise((resolve, reject) => {
    const s = io(FOUNDRY, { path: "/socket.io", transports: ["websocket"], extraHeaders: { cookie: `session=${session}` }, reconnection: false, timeout: 10000 });
    const t = setTimeout(() => { s.close(); reject(new Error("Timeout connexion socket Foundry")); }, 15000);
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
    if (!session) throw new Error("Pas de cookie de session (aucun monde actif ?)");
    const headers = { cookie: `session=${session}`, "content-type": "application/json", "sec-fetch-site": "same-origin" };
    // Trouver l'ID du user depuis son nom
    const pre = await connectSocket(session);
    const join = await emit(pre.socket, "getJoinData");
    pre.socket.close();
    if (!join?.world) throw new Error("Aucun monde actif");
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
  close() { this.socket?.close(); }
  async doc(action, type, operation = {}) {
    const r = await emit(this.socket, "modifyDocument", { type, action, operation });
    if (r?.error) throw new Error(r.error.message || JSON.stringify(r.error));
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
    if (j.error || !j.path) throw new Error(j.error || j.message || `Upload échoué (${r.status})`);
    return j.path;
  }
}
