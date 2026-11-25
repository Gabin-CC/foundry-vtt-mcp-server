// OAuth 2.1 pour ChatGPT, en complément de HTTP Basic pour les clients existants.
// Les identifiants Foundry sont chiffrés au repos : un jeton OAuth ne contient
// jamais le mot de passe du joueur. Le SDK MCP gère DCR, PKCE et les endpoints OAuth.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { InvalidClientMetadataError, InvalidGrantError, InvalidScopeError, InvalidTargetError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { browserLocale, message } from "./i18n.mjs";

const ACCESS_TTL = 60 * 60;
const REFRESH_TTL = 30 * 24 * 60 * 60;
const CODE_TTL = 5 * 60;
const SCOPE = "foundry:access";
const DEFAULT_STATE = fileURLToPath(new URL("../data/oauth-state.json", import.meta.url));
const now = () => Math.floor(Date.now() / 1000);
const randomToken = () => crypto.randomBytes(32).toString("base64url");
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[char]);

export function oauthEncryptionKey(env = process.env) {
  const raw = env.OAUTH_KEY_FILE ? fs.readFileSync(env.OAUTH_KEY_FILE, "utf8").trim() : env.OAUTH_ENCRYPTION_KEY;
  if (!raw || !/^[0-9a-f]{64}$/i.test(raw)) {
    throw new Error(message("OAuth requires OAUTH_KEY_FILE (64 hexadecimal characters) or OAUTH_ENCRYPTION_KEY", "OAuth exige OAUTH_KEY_FILE (64 caractères hexadécimaux) ou OAUTH_ENCRYPTION_KEY"));
  }
  return Buffer.from(raw, "hex");
}

class StateStore {
  constructor(filename, key) {
    this.filename = filename;
    this.key = key;
    if (fs.existsSync(filename)) {
      this.data = JSON.parse(fs.readFileSync(filename, "utf8"));
      if (this.data.version !== 1 || this.open(this.data.keyCheck) !== "foundry-mcp-oauth-v1") {
        throw new Error(message("Incompatible OAuth state or incorrect encryption key", "État OAuth incompatible ou mauvaise clé de chiffrement"));
      }
    } else {
      this.data = { version: 1, keyCheck: this.seal("foundry-mcp-oauth-v1"), clients: {}, codes: {}, access: {}, refresh: {} };
      this.save();
    }
  }

  seal(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map(b => b.toString("base64url")).join(".");
  }

  open(value) {
    const [iv, tag, data] = String(value).split(".").map(v => Buffer.from(v, "base64url"));
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  }

  save() {
    const base = path.dirname(this.filename);
    fs.mkdirSync(base, { recursive: true, mode: 0o700 });
    for (const name of ["codes", "access", "refresh"]) {
      for (const [id, item] of Object.entries(this.data[name])) {
        if (item.expiresAt <= now()) delete this.data[name][id];
      }
    }
    const tmp = `${this.filename}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, this.filename);
    fs.chmodSync(this.filename, 0o600);
  }
}

function loginPage({ requestId, clientName, error = "", locale = "fr" }) {
  const warning = error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : "";
  const en = locale === "en";
  const copy = en ? {
    title: "Connect to Foundry VTT",
    intro: "Allow", account: "your own Foundry account", suffix: "to use MCP tools with",
    permissions: "and its permissions.", username: "Foundry username", password: "Foundry password",
    submit: "Sign in and authorize",
    note: "Your password is stored encrypted on your server so it can reconnect to Foundry. It is never sent to the OAuth client."
  } : {
    title: "Connecter Foundry VTT",
    intro: "Autoriser", account: "ton propre compte Foundry", suffix: "à utiliser les outils MCP avec",
    permissions: "et ses permissions.", username: "Nom du joueur Foundry", password: "Mot de passe Foundry",
    submit: "Se connecter et autoriser",
    note: "Le mot de passe est conservé chiffré sur ton serveur pour pouvoir rouvrir une session Foundry. Il n'est jamais transmis au client OAuth."
  };
  return `<!doctype html>
<html lang="${en ? "en" : "fr"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${en ? "Foundry sign-in — MCP" : "Connexion Foundry — MCP"}</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;background:#f5f4f0;color:#252522;margin:0;padding:5vh 1rem}
main{max-width:420px;margin:auto;background:#fff;border:1px solid #ddd;border-radius:14px;padding:2rem;box-shadow:0 12px 40px #0001}
h1{font-size:1.45rem;margin:0 0 .6rem}p{color:#555}label{display:block;margin:1rem 0 .3rem;font-weight:600}
input{width:100%;box-sizing:border-box;border:1px solid #aaa;border-radius:7px;padding:.7rem;font:inherit}
button{width:100%;margin-top:1.4rem;padding:.8rem;border:0;border-radius:7px;background:#385a47;color:white;font:inherit;font-weight:700;cursor:pointer}
.error{color:#a51c30;font-weight:600}.note{font-size:.9rem}
</style></head><body><main><h1>${copy.title}</h1>
<p>${copy.intro} <strong>${escapeHtml(clientName)}</strong> ${copy.suffix} <strong>${copy.account}</strong> ${copy.permissions}</p>
${warning}
<form method="post" action="/oauth/approve">
<input type="hidden" name="request_id" value="${escapeHtml(requestId)}">
<label for="user">${copy.username}</label><input id="user" name="username" autocomplete="username" maxlength="120" required>
<label for="pass">${copy.password}</label><input id="pass" name="password" type="password" autocomplete="current-password" maxlength="1024" required>
<button type="submit">${copy.submit}</button></form>
<p class="note">${copy.note}</p>
</main></body></html>`;
}

function setLoginHeaders(res, extraFormOrigins = []) {
  // form-action s'applique aussi à la cible des redirections d'un formulaire :
  // sans l'origine de retour OAuth, le navigateur bloque le 302 vers ChatGPT.
  const formAction = ["'self'", ...extraFormOrigins.filter(Boolean)].join(" ");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; base-uri 'none'; frame-ancestors 'none'`);
}

const originOf = value => {
  try { return new URL(value).origin; } catch { return null; }
};

/**
 * @param {object} options
 * @param {string} options.mcpUrl URL publique exacte de /mcp (HTTPS)
 * @param {Buffer} options.key Clé AES-256 (32 octets)
 * @param {string} [options.stateFile] État persistant, mode 0600
 * @param {(username:string, password:string)=>Promise<any>} options.login Vérification du mot de passe via Foundry
 * @param {string[]} [options.redirectOrigins] Origines OAuth autorisées (ChatGPT par défaut)
 */
export function createFoundryOAuth({ mcpUrl, key, stateFile = DEFAULT_STATE, login, redirectOrigins = ["https://chatgpt.com"] }) {
  const resource = new URL(mcpUrl);
  if (resource.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(resource.hostname)) {
    throw new Error(message("OAUTH_MCP_URL must be a public HTTPS URL", "OAUTH_MCP_URL doit être une URL HTTPS publique"));
  }
  if (resource.search || resource.hash || !resource.pathname.endsWith("/mcp")) throw new Error(message("OAUTH_MCP_URL must end with /mcp", "OAUTH_MCP_URL doit se terminer par /mcp"));
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error(message("Invalid OAuth key (32 bytes required)", "Clé OAuth invalide (32 octets requis)"));
  const store = new StateStore(stateFile, key);
  const pending = new Map();
  const allowed = new Set(redirectOrigins);
  const metadataUrl = getOAuthProtectedResourceMetadataUrl(resource);

  const validateResource = requested => {
    if (requested && requested.href !== resource.href) throw new InvalidTargetError(message("Incorrect OAuth resource", "Ressource OAuth incorrecte"));
  };
  const getRecord = (collection, raw, clientId) => {
    const record = store.data[collection][digest(raw)];
    if (!record || record.expiresAt <= now() || (clientId && record.clientId !== clientId)) {
      throw collection === "access" ? new InvalidTokenError(message("Expired or invalid token", "Jeton expiré ou invalide")) : new InvalidGrantError(message("Invalid authorization code or token", "Code ou jeton invalide"));
    }
    return record;
  };
  const issueTokens = (clientId, encryptedCredentials) => {
    const access = randomToken(), refresh = randomToken();
    const common = { clientId, encryptedCredentials, scopes: [SCOPE], resource: resource.href };
    store.data.access[digest(access)] = { ...common, expiresAt: now() + ACCESS_TTL };
    store.data.refresh[digest(refresh)] = { ...common, expiresAt: now() + REFRESH_TTL };
    store.save();
    return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL, refresh_token: refresh, scope: SCOPE };
  };

  const provider = {
    clientsStore: {
      getClient: clientId => store.data.clients[clientId],
      registerClient: client => {
        // Un enregistrement DCR ne doit pas permettre de rediriger les identifiants des joueurs
        // vers une application tierce. L'origine autorisée est configurable explicitement.
        if (!client.redirect_uris?.length || !client.redirect_uris.every(uri => {
          try { return allowed.has(new URL(uri).origin); } catch { return false; }
        })) throw new InvalidClientMetadataError(message("Redirect URI is not allowed", "URI de retour non autorisée"));
        if (Object.keys(store.data.clients).length >= 200) throw new InvalidClientMetadataError(message("Maximum number of clients reached", "Nombre maximal de clients atteint"));
        store.data.clients[client.client_id] = client;
        store.save();
        return client;
      }
    },

    async authorize(client, params, res) {
      validateResource(params.resource);
      if (params.scopes?.some(scope => scope !== SCOPE)) throw new InvalidScopeError(message("Unknown OAuth scope", "Scope non reconnu"));
      console.log(`[oauth] authorization requested by ${client.client_name || "?"} (${client.client_id}); state ${params.state ? "present" : "MISSING"}, redirect ${params.redirectUri}`);
      const requestId = randomToken();
      for (const [id, entry] of pending) if (entry.expiresAt <= now()) pending.delete(id);
      if (pending.size >= 1000) throw new InvalidGrantError(message("Too many pending sign-in requests", "Trop de demandes de connexion en attente"));
      const locale = browserLocale(res.req?.headers?.["accept-language"]);
      pending.set(requestId, { clientId: client.client_id, clientName: client.client_name || "ChatGPT", params, locale, expiresAt: now() + CODE_TTL });
      setLoginHeaders(res, [originOf(params.redirectUri)]);
      res.status(200).type("html").send(loginPage({ requestId, clientName: client.client_name || "ChatGPT", locale }));
    },

    async challengeForAuthorizationCode(client, authorizationCode) {
      return getRecord("codes", authorizationCode, client.client_id).codeChallenge;
    },

    async exchangeAuthorizationCode(client, authorizationCode, _verifier, redirectUri, requestedResource) {
      const record = getRecord("codes", authorizationCode, client.client_id);
      validateResource(requestedResource);
      if (redirectUri && record.redirectUri !== redirectUri) throw new InvalidGrantError(message("Redirect URI does not match", "URI de retour différente"));
      delete store.data.codes[digest(authorizationCode)]; // code à usage unique
      return issueTokens(client.client_id, record.encryptedCredentials);
    },

    async exchangeRefreshToken(client, refreshToken, scopes, requestedResource) {
      const record = getRecord("refresh", refreshToken, client.client_id);
      validateResource(requestedResource);
      if (scopes?.some(scope => scope !== SCOPE)) throw new InvalidScopeError(message("Unknown OAuth scope", "Scope non reconnu"));
      delete store.data.refresh[digest(refreshToken)]; // rotation obligatoire
      return issueTokens(client.client_id, record.encryptedCredentials);
    },

    async verifyAccessToken(token) {
      const record = getRecord("access", token);
      return { token, clientId: record.clientId, scopes: record.scopes, expiresAt: record.expiresAt, resource: new URL(record.resource) };
    },

    async revokeToken(client, { token }) {
      let changed = false;
      for (const collection of ["access", "refresh"]) {
        const record = store.data[collection][digest(token)];
        if (record?.clientId === client.client_id) { delete store.data[collection][digest(token)]; changed = true; }
      }
      if (changed) store.save();
    }
  };

  const credentialsForToken = async token => {
    await provider.verifyAccessToken(token);
    return JSON.parse(store.open(getRecord("access", token).encryptedCredentials));
  };

  const approve = async (req, res) => {
    setLoginHeaders(res);
    const { request_id: requestId, username, password } = req.body || {};
    const attempt = pending.get(requestId);
    if (!attempt || attempt.expiresAt <= now()) return res.status(400).send(message("Sign-in expired. Restart the connection from ChatGPT.", "Connexion expirée. Recommence depuis ChatGPT."));
    setLoginHeaders(res, [originOf(attempt.params.redirectUri)]);
    if (typeof username !== "string" || typeof password !== "string" || !username || !password || username.length > 120 || password.length > 1024) {
      return res.status(400).type("html").send(loginPage({ requestId, clientName: attempt.clientName, locale: attempt.locale, error: message("Enter your Foundry username and password.", "Saisis ton nom et ton mot de passe Foundry.", attempt.locale) }));
    }
    let foundrySession;
    try { foundrySession = await login(username, password); }
    catch { return res.status(503).type("html").send(loginPage({ requestId, clientName: attempt.clientName, locale: attempt.locale, error: message("Foundry is temporarily unavailable.", "Foundry est momentanément indisponible.", attempt.locale) })); }
    if (!foundrySession) {
      return res.status(401).type("html").send(loginPage({ requestId, clientName: attempt.clientName, locale: attempt.locale, error: message("Invalid Foundry credentials.", "Identifiants Foundry incorrects.", attempt.locale) }));
    }
    foundrySession.close();
    pending.delete(requestId);
    const code = randomToken();
    store.data.codes[digest(code)] = {
      clientId: attempt.clientId,
      redirectUri: attempt.params.redirectUri,
      codeChallenge: attempt.params.codeChallenge,
      encryptedCredentials: store.seal(JSON.stringify({ username, password })),
      expiresAt: now() + CODE_TTL
    };
    store.save();
    const callback = new URL(attempt.params.redirectUri);
    callback.searchParams.set("code", code);
    if (attempt.params.state) callback.searchParams.set("state", attempt.params.state);
    setLoginHeaders(res, [callback.origin]);
    console.log(`[oauth] sign-in approved for "${username}" → ${callback.origin}${callback.pathname} (state ${attempt.params.state ? "returned" : "MISSING"}, code length ${code.length})`);
    res.redirect(302, callback.href);
  };

  return { provider, approve, credentialsForToken, metadataUrl, resource };
}
