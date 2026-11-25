import assert from "node:assert/strict";
import { test } from "node:test";
import { message } from "../src/i18n.mjs";
import { setSafePath } from "../src/security.mjs";
import { withEffects } from "../src/dnd5e.mjs";
import {
  decodeUploadBase64, downloadPublicFile, isPublicAddress,
  validateUploadContent, validateUploadDestination
} from "../src/upload.mjs";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4//8/AwAI/AL+HBZLAAAAAElFTkSuQmCC", "base64");

test("safe document paths write ordinary fields without traversing inherited properties", () => {
  const target = { system: { abilities: { str: { value: 10 } } } };
  setSafePath(target, "system.abilities.str.value", 14);
  assert.equal(target.system.abilities.str.value, 14);
  setSafePath(target, "system.toString.note", "local");
  assert.equal(target.system.toString.note, "local");
  assert.equal(Object.prototype.toString.call({}), "[object Object]");
});

test("safe document paths reject prototype pollution at any depth", () => {
  for (const path of [
    "__proto__.auditMarker", "system.__proto__.auditMarker",
    "system.constructor.prototype.auditMarker", "system.prototype.auditMarker",
    "system..hp.value", "system."
  ]) {
    assert.throws(() => setSafePath({ system: {} }, path, "polluted"),
      error => error.message === message(`Unsafe document path: ${path}`, `Chemin de document dangereux : ${path}`));
  }
  assert.equal(({}).auditMarker, undefined);
});

test("untrusted Foundry effects can no longer modify Object.prototype", () => {
  const actor = { system: {}, items: [], effects: [{ changes: [{
    key: "system.__proto__.auditMarker", value: "polluted", mode: 5
  }] }] };
  assert.throws(() => withEffects(actor),
    error => error.message.includes(message("Unsafe document path", "Chemin de document dangereux")));
  assert.equal(({}).auditMarker, undefined);
});

test("ordinary active effects still update the copied actor", () => {
  const actor = {
    system: { abilities: { str: { value: 10 } } }, items: [],
    effects: [{ changes: [{ key: "system.abilities.str.value", value: 14, mode: 5 }] }]
  };
  const updated = withEffects(actor);
  assert.equal(updated.system.abilities.str.value, 14);
  assert.equal(actor.system.abilities.str.value, 10);
});

test("upload destinations reject directory traversal, active SVG and unknown formats", () => {
  assert.deepEqual(validateUploadDestination("portrait.png"), {
    filename: "portrait.png", folder: "images/uploads", mime: "image/png"
  });
  assert.equal(validateUploadDestination("Cœur du dragon.webp", "maps/Acte 1").folder, "maps/Acte 1");
  for (const filename of ["../secret.png", "../../secret.png", "nested/file.png", "evil.svg", ".hidden.png", "evil.png.exe", "bad\\name.png"]) {
    assert.throws(() => validateUploadDestination(filename),
      new RegExp(message("Unsafe upload filename|Unsupported upload format",
        "Nom de fichier téléversé dangereux|Format de téléversement non pris en charge")));
  }
  for (const folder of ["../data", "/tmp", "images/../../secrets", "C:\\secret", "folder/%2e%2e", "images//upload"]) {
    assert.throws(() => validateUploadDestination("file.png", folder),
      new RegExp(message("Unsafe upload folder", "Dossier de téléversement dangereux")));
  }
});

test("upload file content must match extension and enforce a size limit", () => {
  assert.doesNotThrow(() => validateUploadContent(PNG, "portrait.png"));
  assert.throws(() => validateUploadContent(Buffer.from("<script>"), "portrait.png"),
    new RegExp(message("do not match", "ne correspond pas")));
  assert.throws(() => validateUploadContent(Buffer.alloc(20 * 1024 * 1024 + 1), "portrait.png"), /20 MiB/);
  assert.throws(() => validateUploadContent(Buffer.alloc(0), "portrait.png"),
    new RegExp(message("between 1 byte", "entre 1 octet")));
});

test("base64 input rejects malformed and oversized data before decoding", () => {
  assert.deepEqual(decodeUploadBase64(PNG.toString("base64")), PNG);
  assert.deepEqual(decodeUploadBase64(`data:image/png;base64,${PNG.toString("base64")}`), PNG);
  assert.throws(() => decodeUploadBase64("not@@base64"),
    new RegExp(message("Invalid base64", "Données base64 invalides")));
  assert.throws(() => decodeUploadBase64("data:text/html,<script>"),
    new RegExp(message("Only base64", "Seules les URL de données base64")));
  assert.throws(() => decodeUploadBase64("A".repeat(28 * 1024 * 1024 + 1)),
    new RegExp(message("too large", "trop volumineux"), "i"));
});

test("remote downloads are opt-in and cannot target local or private addresses", async () => {
  await assert.rejects(downloadPublicFile("https://example.com/a.png", { allowedOrigins: [] }),
    new RegExp(message("disabled", "désactivé")));
  await assert.rejects(downloadPublicFile("http://example.com/a.png", { allowedOrigins: ["http://example.com"] }), /HTTPS/);
  await assert.rejects(downloadPublicFile("https://127.0.0.1/a.png", { allowedOrigins: ["https://127.0.0.1"] }),
    new RegExp(message("private or reserved", "privées ou réservées")));
  await assert.rejects(downloadPublicFile("https://[::1]/a.png", { allowedOrigins: ["https://[::1]"] }),
    new RegExp(message("private or reserved", "privées ou réservées")));
  await assert.rejects(downloadPublicFile("https://example.com/a.png", { allowedOrigins: ["https://assets.example.com"] }),
    new RegExp(message("not allowed", "non autorisée")));
  for (const ip of ["127.0.0.1", "10.10.0.1", "172.17.0.1", "192.168.1.5", "169.254.169.254", "::1", "::ffff:7f00:1", "fc00::1", "fe80::1", "64:ff9b::a00:1", "2001:db8::1"]) {
    assert.equal(isPublicAddress(ip), false, `${ip} should be blocked`);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "2001:4860:4860::8888"]) {
    assert.equal(isPublicAddress(ip), true, `${ip} should be allowed`);
  }
});

test("the upload_file tool checks data before calling Foundry", async () => {
  process.env.NO_LISTEN = "1";
  const { handleTool } = await import("../src/server.mjs");
  const uploads = [];
  const session = {
    userId: "test-user", user: { name: "Tester", role: 1 },
    async doc() { return []; },
    async upload(...args) { uploads.push(args); return "images/uploads/portrait.png"; }
  };
  const valid = await handleTool(session, {
    name: "upload_file", arguments: { filename: "portrait.png", base64: PNG.toString("base64") }
  });
  assert.equal(valid.isError, undefined);
  assert.equal(JSON.parse(valid.content[0].text).chemin, "images/uploads/portrait.png");
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0][3], "image/png");

  const invalid = await handleTool(session, {
    name: "upload_file", arguments: { filename: "../../evil.png", base64: PNG.toString("base64") }
  });
  assert.equal(invalid.isError, true);
  assert.equal(uploads.length, 1);
});
