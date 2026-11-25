import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

async function unusedPort() {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

async function launch(t, oauthEnabled) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foundry-http-test-"));
  const port = await unusedPort();
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env, HOST: "127.0.0.1", PORT: String(port),
      OAUTH_ENABLED: oauthEnabled ? "1" : "0",
      OAUTH_MCP_URL: "https://foundry.example.org/mcp",
      OAUTH_ENCRYPTION_KEY: crypto.randomBytes(32).toString("hex"),
      OAUTH_STATE_PATH: path.join(dir, "oauth.json")
    }
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise(resolve => child.once("exit", resolve));
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  let timeout;
  try {
    await Promise.race([
      new Promise((resolve, reject) => {
        let error = "";
        child.stderr.on("data", chunk => { error += String(chunk); });
        child.stdout.on("data", chunk => { if (String(chunk).includes("MCP Foundry sur")) resolve(); });
        child.on("exit", code => reject(new Error(`Serveur arrêté (${code}) : ${error}`)));
      }),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Démarrage MCP trop lent")), 5000); })
    ]);
  } finally { clearTimeout(timeout); }
  return `http://127.0.0.1:${port}`;
}

test("HTTP : OAuth activé, challenge Bearer et endpoints de découverte", async t => {
  const base = await launch(t, true);
  const unauthorized = await fetch(`${base}/mcp`);
  assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.headers.get("www-authenticate"), /^Bearer resource_metadata="https:\/\/foundry\.example\.org\/\.well-known\/oauth-protected-resource\/mcp"$/);
  const invalidBearer = await fetch(`${base}/mcp`, { headers: { authorization: "Bearer invalide" } });
  assert.equal(invalidBearer.status, 401);
  const metadata = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
  assert.equal(metadata.status, 200);
  assert.equal((await metadata.json()).resource, "https://foundry.example.org/mcp");
  const hidden = await fetch(`${base}/random`);
  assert.equal(hidden.status, 404);
});

test("HTTP : mode Basic historique inchangé sans OAuth", async t => {
  const base = await launch(t, false);
  const unauthorized = await fetch(`${base}/mcp`);
  assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.headers.get("www-authenticate"), /^Basic realm=/);
  const noOauth = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
  assert.equal(noOauth.status, 404);
});
