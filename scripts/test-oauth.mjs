import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import express from "express";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { createFoundryOAuth } from "../src/oauth.mjs";
import { browserLocale, currentLocale, message, normalizeLocale } from "../src/i18n.mjs";
import { render, nextPage } from "../src/paging.mjs";
import { handleCards } from "../src/tables.mjs";
import { handleGm } from "../src/gm.mjs";
import { showSnapshot } from "../src/snapshots.mjs";

const callback = "https://chatgpt.com/connector/oauth/test-foundry";
const resource = "https://foundry.example.org/mcp";

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foundry-oauth-test-"));
  const key = crypto.randomBytes(32), stateFile = path.join(dir, "oauth.json");
  const credentials = new Map([["Gabin", "secret-gabin"], ["Alice", "secret-alice"]]);
  const logins = [];
  const login = async (username, password) => {
    if (credentials.get(username) !== password) return null;
    logins.push(username);
    return { close() {} };
  };
  const oauth = createFoundryOAuth({ mcpUrl: resource, key, stateFile, login });
  const app = express();
  app.use(mcpAuthRouter({ provider: oauth.provider, issuerUrl: new URL("https://foundry.example.org"), resourceServerUrl: oauth.resource, scopesSupported: ["foundry:access"] }));
  app.post("/oauth/approve", express.urlencoded({ extended: false }), oauth.approve);
  const server = await new Promise(resolve => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { base: `http://127.0.0.1:${server.address().port}`, oauth, key, stateFile, login, logins };
}

async function register(base, override = {}) {
  const response = await fetch(`${base}/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "ChatGPT Foundry", redirect_uris: [callback], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", ...override })
  });
  return { status: response.status, data: await response.json() };
}

async function authorizePlayer({ base, client, username, password, language }) {
  const verifier = crypto.randomBytes(40).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const query = new URLSearchParams({ client_id: client.client_id, response_type: "code", redirect_uri: callback, code_challenge: challenge, code_challenge_method: "S256", resource, state: "csrf-check", scope: "foundry:access" });
  const page = await fetch(`${base}/authorize?${query}`, language ? { headers: { "Accept-Language": language } } : {});
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy") || "", /form-action 'self' https:\/\/chatgpt\.com/,
    "La CSP doit autoriser la redirection du formulaire vers l'origine OAuth");
  const form = await page.text();
  const requestId = form.match(/name="request_id" value="([\w-]+)"/)?.[1];
  assert.ok(requestId, "La page OAuth affiche un formulaire de connexion");
  const approval = await fetch(`${base}/oauth/approve`, {
    method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ request_id: requestId, username, password })
  });
  return { approval, requestId, verifier, form };
}

async function exchange(base, client, code, verifier) {
  const response = await fetch(`${base}/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", client_id: client.client_id, code, code_verifier: verifier, redirect_uri: callback, resource })
  });
  return { status: response.status, data: await response.json() };
}

test("OAuth MCP : découverte, DCR, connexion distincte de deux joueurs, rafraîchissement et persistance", async t => {
  const { base, oauth, key, stateFile, login } = await setup(t);
  const metadata = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
  assert.equal(metadata.status, 200);
  assert.deepEqual((await metadata.json()).authorization_servers, ["https://foundry.example.org/"]);
  const serverMetadata = await fetch(`${base}/.well-known/oauth-authorization-server`);
  assert.equal((await serverMetadata.json()).code_challenge_methods_supported[0], "S256");

  const registered = await register(base);
  assert.equal(registered.status, 201);
  const client = registered.data;
  const otherSite = await register(base, { redirect_uris: ["https://pirate.example/callback"] });
  assert.equal(otherSite.status, 400, "Impossible de faire rediriger le code vers un domaine tiers");

  const player1 = await authorizePlayer({ base, client, username: "Gabin", password: "secret-gabin" });
  assert.equal(player1.approval.status, 302);
  assert.match(player1.approval.headers.get("content-security-policy") || "", /form-action 'self' https:\/\/chatgpt\.com/,
    "Le 302 doit autoriser la redirection vers ChatGPT");
  const redirect1 = new URL(player1.approval.headers.get("location"));
  assert.equal(redirect1.searchParams.get("state"), "csrf-check");
  const code1 = redirect1.searchParams.get("code");
  assert.ok(code1);
  const invalidPkce = await exchange(base, client, code1, "bad-verifier");
  assert.equal(invalidPkce.status, 400);
  const token1 = await exchange(base, client, code1, player1.verifier);
  assert.equal(token1.status, 200);
  assert.equal(token1.data.token_type, "Bearer");
  assert.deepEqual(await oauth.credentialsForToken(token1.data.access_token), { username: "Gabin", password: "secret-gabin" });

  const reusedCode = await exchange(base, client, code1, player1.verifier);
  assert.equal(reusedCode.status, 400, "Le code OAuth est à usage unique");
  const player2 = await authorizePlayer({ base, client, username: "Alice", password: "secret-alice" });
  assert.equal(player2.approval.status, 302);
  const code2 = new URL(player2.approval.headers.get("location")).searchParams.get("code");
  const token2 = await exchange(base, client, code2, player2.verifier);
  assert.equal(token2.status, 200);
  assert.deepEqual(await oauth.credentialsForToken(token2.data.access_token), { username: "Alice", password: "secret-alice" });
  assert.notEqual(token1.data.access_token, token2.data.access_token);

  const stateOnDisk = fs.readFileSync(stateFile, "utf8");
  assert.equal(stateOnDisk.includes("secret-gabin"), false, "Aucun mot de passe Foundry en clair sur disque");
  assert.equal(stateOnDisk.includes(token1.data.access_token), false, "Aucun jeton d'accès en clair sur disque");
  assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
  const restarted = createFoundryOAuth({ mcpUrl: resource, key, stateFile, login });
  assert.deepEqual(await restarted.credentialsForToken(token2.data.access_token), { username: "Alice", password: "secret-alice" });
  assert.throws(() => createFoundryOAuth({ mcpUrl: resource, key: crypto.randomBytes(32), stateFile, login }));

  const refreshed = await fetch(`${base}/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: client.client_id, refresh_token: token1.data.refresh_token, resource })
  });
  assert.equal(refreshed.status, 200);
  const fresh = await refreshed.json();
  assert.deepEqual(await oauth.credentialsForToken(fresh.access_token), { username: "Gabin", password: "secret-gabin" });
  const oldRefresh = await fetch(`${base}/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: client.client_id, refresh_token: token1.data.refresh_token, resource })
  });
  assert.equal(oldRefresh.status, 400, "L'ancien jeton de rafraîchissement est révoqué");
  await oauth.provider.revokeToken(client, { token: fresh.access_token });
  await assert.rejects(oauth.credentialsForToken(fresh.access_token));
});

test("OAuth MCP : refus des mauvais identifiants et du mauvais public", async t => {
  const { base, oauth } = await setup(t);
  const { data: client } = await register(base);
  const bad = await authorizePlayer({ base, client, username: "Gabin", password: "incorrect", language: "fr-FR" });
  assert.equal(bad.approval.status, 401);
  assert.match(await bad.approval.text(), /Identifiants Foundry incorrects/);
  const outsider = await fetch(`${base}/authorize?${new URLSearchParams({
    client_id: client.client_id, response_type: "code", redirect_uri: callback,
    code_challenge: "A".repeat(43), code_challenge_method: "S256", resource: "https://ailleurs.example/mcp"
  })}`, { redirect: "manual" });
  assert.equal(outsider.status, 302);
  assert.equal(new URL(outsider.headers.get("location")).searchParams.get("error"), "invalid_target");
  await assert.rejects(oauth.credentialsForToken("un-faux-jeton"));
});

test("MCP human-readable localization is opt-in and preserves legacy protocol keys", t => {
  const prior = process.env.MCP_LOCALE;
  t.after(() => {
    if (prior === undefined) delete process.env.MCP_LOCALE;
    else process.env.MCP_LOCALE = prior;
  });
  delete process.env.MCP_LOCALE;
  assert.equal(currentLocale(), "fr");
  assert.equal(message("Not found", "Introuvable"), "Introuvable");
  assert.equal(normalizeLocale("en-US"), "en");
  assert.equal(browserLocale("de;q=1, en-GB;q=0.8, fr;q=0.6"), "en");
  assert.equal(browserLocale("fr-FR, en;q=0.8"), "fr");
  assert.equal(browserLocale("de;q=1", "en"), "en");
  assert.equal(browserLocale("fr;q=0, en;q=0.5"), "en");

  process.env.MCP_LOCALE = "en";
  assert.equal(currentLocale(), "en");
  assert.equal(message("Not found", "Introuvable"), "Not found");
  const payload = { documents: Array.from({ length: 1500 }, (_, i) => ({ _id: String(i), name: "x".repeat(100) })) };
  const first = JSON.parse(render(payload, "test-user"));
  assert.ok(first.curseur_suivant, "The legacy cursor field remains present in English mode");
  assert.ok(first.contenu, "The legacy content field remains present in English mode");
  assert.match(first.note, /Response split into valid JSON pages/);
  assert.ok(nextPage(first.curseur_suivant, "test-user").contenu);
  assert.throws(() => nextPage("invalid", "test-user"), /Unknown or expired cursor/);
});

test("OAuth login page and validation errors follow the browser language", async t => {
  const { base } = await setup(t);
  const { data: client } = await register(base);
  const english = await authorizePlayer({ base, client, username: "Gabin", password: "incorrect", language: "en-US,en;q=0.9" });
  assert.match(english.form, /<html lang="en">/);
  assert.match(english.form, /Sign in and authorize/);
  assert.equal(english.approval.status, 401);
  assert.match(await english.approval.text(), /Invalid Foundry credentials/);

  const french = await authorizePlayer({ base, client, username: "Gabin", password: "incorrect", language: "fr-FR,fr;q=0.9" });
  assert.match(french.form, /<html lang="fr">/);
  assert.match(french.form, /Se connecter et autoriser/);
  assert.equal(french.approval.status, 401);
  assert.match(await french.approval.text(), /Identifiants Foundry incorrects/);
});

test("GM, cards and snapshot errors switch language without changing tool inputs", async t => {
  const prior = process.env.MCP_LOCALE;
  t.after(() => {
    if (prior === undefined) delete process.env.MCP_LOCALE;
    else process.env.MCP_LOCALE = prior;
  });
  const fakeFoundry = { doc: async () => [] };
  process.env.MCP_LOCALE = "en";
  await assert.rejects(handleCards(fakeFoundry, { action: "draw" }, {}), /Specify 'from'/);
  await assert.rejects(handleGm(fakeFoundry, "gm_scene", { action: "activate" }), /Specify 'scene'/);
  await assert.rejects(showSnapshot(fakeFoundry, false, "invalid"), /Invalid snapshot ID/);

  process.env.MCP_LOCALE = "fr";
  await assert.rejects(handleCards(fakeFoundry, { action: "draw" }, {}), /Préciser 'from'/);
  await assert.rejects(handleGm(fakeFoundry, "gm_scene", { action: "activate" }), /Préciser 'scene'/);
  await assert.rejects(showSnapshot(fakeFoundry, false, "invalid"), /Identifiant d'instantané invalide/);
});
