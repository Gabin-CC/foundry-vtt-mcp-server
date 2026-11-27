import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dir = await mkdtemp(path.join(os.tmpdir(), "foundry-rules-mcp-tests-"));
const indexPath = path.join(dir, "rules-index.json");
const accessPath = path.join(dir, "access.json");
process.env.NO_LISTEN = "1";
process.env.RULES_INDEX_PATH = indexPath;
process.env.RULES_ACCESS_FILE = accessPath;
const { SOURCE, SOURCE_SHA256 } = await import("../src/rules/rules.mjs");
const { rulesQuery, effectiveRulesRole } = await import("../src/rules-api.mjs");
const { handleTool, TOOLS } = await import("../src/server.mjs");

const known = "D&D combat Grappled condition reduces Speed to zero and stops movement.";
const publicBook = "A fighter choosing Weapon Mastery can select a weapon category they can use.";
const secret = "Vecna secret encounter in the Black Vault beneath the forgotten chapel.";
const privateSources = ["Player Handbook.pdf", "The Secret Campaign.pdf"];
const index = {
  version: "5.2.1", pdf_sha256: SOURCE_SHA256,
  private_sources: privateSources.map((name, i) => ({ name, sha256: String(i + 1).repeat(64) })),
  pages: [
    { source: "srd", page: 42, language: "en", text: known },
    { source: privateSources[0], page: 88, language: "en", text: publicBook },
    { source: privateSources[1], page: 99, language: "en", text: secret }
  ]
};
await writeFile(indexPath, JSON.stringify(index));
await writeFile(accessPath, JSON.stringify({ version: 1, rules_for_all: [privateSources[0]] }));
const query = (name, args, role = 2, audience = null) => rulesQuery(name, args,
  { foundryRole: role, audience, indexPath, accessPath });

test("the MCP exposes three shared rules tools with complete English metadata", () => {
  assert.equal(TOOLS.length, 49);
  for (const name of ["rules_list_sources", "rules_search", "rules_read_page"])
    assert.ok(TOOLS.find(t => t.name === name), name);
});

test("player and GM see different indexed books; direct player cannot elevate scope", async () => {
  assert.equal(effectiveRulesRole(2, "gm"), "player");
  assert.equal(effectiveRulesRole(3, "player"), "player");
  assert.equal(effectiveRulesRole(4), "gm");
  const players = await query("rules_list_sources", {}, 2, "gm");
  assert.deepEqual(players.map(s => s.id), ["srd", privateSources[0]]);
  const downgraded = await query("rules_list_sources", {}, 4, "player");
  assert.deepEqual(downgraded, players);
  const gm = await query("rules_list_sources", {}, 4);
  assert.deepEqual(gm.map(s => s.id), ["srd", ...privateSources]);
  assert.equal(gm.find(s => s.id === privateSources[1]).url, null);
});

test("GM-only campaign pages never leak through search, explicit source or page reads", async () => {
  assert.deepEqual(await query("rules_search", { query: "Vecna secret" }), []);
  await assert.rejects(query("rules_search", { query: "Vecna secret", source: privateSources[1] }),
    /Unknown rule source/);
  assert.equal((await query("rules_read_page", { source: privateSources[1], page: 99 })).available, false);
  const gm = await query("rules_search", { query: "Vecna secret", limit: 2 }, 4);
  assert.equal(gm[0].source_id, privateSources[1]);
  assert.equal(gm[0].page, 99);
  assert.equal(gm[0].url, null, "Commercial PDF pages never receive fabricated public links");
});

test("BM25 search returns excerpts and real PDF page identifiers without loading every page", async () => {
  const official = await query("rules_search", { query: "grappled condition", limit: 4 });
  assert.equal(official.length, 1);
  assert.equal(official[0].source_id, "srd");
  assert.equal(official[0].page, 42);
  assert.equal(official[0].url, `${SOURCE}#page=42`);
  const handbook = await query("rules_search", { query: "fighter Weapon Mastery" });
  assert.equal(handbook[0].source_id, privateSources[0]);
  assert.equal(handbook[0].page, 88);
  assert.equal(handbook[0].url, null);
  assert.equal(handbook[0].text, publicBook);
});

test("PDF page windows have bounded text and a next_offset", async () => {
  const original = index.pages[0].text;
  try {
    index.pages[0].text = known.repeat(220);
    await writeFile(indexPath, JSON.stringify(index));
    const first = await query("rules_read_page", { page: 42 }, 2);
    assert.equal(first.text.length, 6000);
    assert.equal(first.next_offset, 6000);
    const second = await query("rules_read_page", { page: 42, offset: first.next_offset }, 2);
    assert.equal(second.text, index.pages[0].text.slice(6000, 12000));
    assert.equal(second.total_characters, index.pages[0].text.length);
  } finally {
    index.pages[0].text = original;
    await writeFile(indexPath, JSON.stringify(index));
  }
});

test("invalid arguments, missing indexes and missing policy fail closed", async () => {
  await assert.rejects(query("rules_search", { query: "x" }), /Invalid rules search/);
  await assert.rejects(query("rules_read_page", { page: -1 }), /Invalid rules page/);
  await assert.rejects(rulesQuery("rules_search", { query: "grappled" }, {
    foundryRole: 4, indexPath: path.join(dir, "missing.json"), accessPath
  }), /ENOENT/);
  await writeFile(accessPath, JSON.stringify({ version: 1, rules_for_all: ["../escape.pdf"] }));
  try { await assert.rejects(query("rules_list_sources", {}), /Invalid rules access policy/); }
  finally { await writeFile(accessPath, JSON.stringify({ version: 1, rules_for_all: [privateSources[0]] })); }
});

test("the real MCP tool dispatcher respects a downgraded Assistant GM audience", async () => {
  const account = { userId: "gmTestUser2024", user: { role: 3 }, world: {} };
  const reply = await handleTool(account, { name: "rules_list_sources", arguments: {} },
    { rulesAudience: "player" });
  assert.equal(reply.isError, undefined, reply.content?.[0]?.text);
  const sources = JSON.parse(reply.content[0].text);
  assert.deepEqual(sources.map(s => s.id), ["srd", privateSources[0]]);
  const privatePage = await handleTool(account, { name: "rules_read_page", arguments: {
    source: privateSources[1], page: 99
  } }, { rulesAudience: "player" });
  assert.equal(JSON.parse(privatePage.content[0].text).available, false);
});

after(async () => { await rm(dir, { recursive: true, force: true }); });
