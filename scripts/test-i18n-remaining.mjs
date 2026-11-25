import assert from "node:assert/strict";
import { test } from "node:test";
import { searchText, findReferences } from "../src/corpus.mjs";
import { resolveImportEntry } from "../src/edition.mjs";
import { FoundrySession } from "../src/foundry.mjs";
import { message } from "../src/i18n.mjs";
import { applyDamage } from "../src/targets.mjs";

process.env.NO_LISTEN = "1";
const { handleTool } = await import("../src/server.mjs");

const actorId = "abcdefghijklmnop";
const actor = () => ({ _id: actorId, name: "Hero <test>", type: "character", items: [], effects: [],
  system: { attributes: { hp: { value: 10, max: 20, temp: 0 } }, currency: {}, abilities: {} } });

test("corpus input errors are localized before reading world documents", async () => {
  await assert.rejects(searchText({}, { query: "x" }, { packsOf: async () => [] }), {
    message: message("Query too short (minimum 2 characters)", "Requête trop courte (2 caractères min.)")
  });
  await assert.rejects(findReferences({}, {}, { packsOf: async () => [] }), {
    message: message("Specify 'uuid'", "Préciser 'uuid'")
  });
});

test("edition-import validation localizes errors while retaining pack identifiers", async () => {
  await assert.rejects(resolveImportEntry({}, [], { pack: "world.missing" }, async () => []), {
    message: message("Unknown compendium: world.missing", "Compendium inconnu : world.missing")
  });
});

test("Foundry login without a session cookie gives a localized diagnostic", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ headers: { getSetCookie: () => [] } });
  try {
    await assert.rejects(FoundrySession.login("Gamemaster", null), {
      message: message("No session cookie (is a world active?)", "Pas de cookie de session (aucun monde actif ?)")
    });
  } finally { globalThis.fetch = originalFetch; }
});

test("unknown tool and unknown compendium responses keep their MCP content shape", async () => {
  const fs = { userId: "tester", user: { role: 4 }, worldData: async () => ({ packs: [] }),
    doc: async () => [] };
  const unknown = await handleTool(fs, { name: "not_a_tool" });
  assert.deepEqual(unknown.content.map(c => c.type), ["text"]);
  assert.equal(unknown.content[0].text, message("Unknown tool: not_a_tool", "Outil inconnu : not_a_tool"));
  const entry = await handleTool(fs, { name: "get_compendium_entry", arguments: { pack: "world.missing", id: actorId } });
  assert.equal(entry.content[0].text, message("Unknown compendium: world.missing", "Compendium inconnu : world.missing"));
});

test("loot chat is bilingual and escapes actor names without changing response keys", async () => {
  let chat;
  const fs = { userId: "tester", user: { name: "GM", role: 4 }, doc: async (action, type, options) => {
    if (action === "get" && type === "Actor") return [actor()];
    if (action === "create" && type === "ChatMessage") { chat = options.data[0]; return [{ _id: actorId }]; }
    return [];
  } };
  const result = await handleTool(fs, { name: "give_loot", arguments: { actor: actorId } });
  assert.ok(result.content[0].text.includes("recu"));
  assert.equal(chat.flavor, message("Loot", "Butin"));
  assert.ok(chat.content.includes(message("receives:", "reçoit :")));
  assert.ok(chat.content.includes("Hero &lt;test&gt;"));
  assert.ok(!chat.content.includes("<test>"));
});

test("rest feedback and chat are localized, but the rest enum stays stable", async () => {
  let chat;
  const fs = { userId: "tester", user: { name: "GM", role: 4 }, doc: async (action, type, options) => {
    if (action === "get" && type === "Actor") return [actor()];
    if (action === "create" && type === "ChatMessage") { chat = options.data[0]; return [{ _id: actorId }]; }
    return [];
  } };
  const result = await handleTool(fs, { name: "rest", arguments: { actor: actorId, type: "long" } });
  assert.ok(result.content[0].text.includes('"repos": "long"'));
  assert.ok(result.content[0].text.includes(message("HP restored to 20", "PV restaurés à 20")));
  assert.equal(chat.flavor, message("Long rest", "Repos long"));
  assert.ok(chat.content.includes(message("takes a long rest", "prend un repos long")));
  assert.ok(chat.content.includes("Hero &lt;test&gt;"));
});

test("manual damage chat is bilingual and does not rename HP report fields", async () => {
  let chat;
  const fs = { userId: "tester", doc: async (action, type) => {
    if (action === "get" && type === "Actor") return [actor()];
    return [];
  } };
  const result = await applyDamage(fs, { manual: [{ target: `Actor.${actorId}`, damage: 3 }] }, {
    postChat: async (_fs, data) => { chat = data; }
  });
  assert.deepEqual(result.applique[0].degats, 3);
  assert.equal(result.applique[0].pv, "10 → 7/20");
  assert.equal(chat.flavor, message("Damage / healing", "Dégâts / soins"));
  assert.ok(chat.content.includes(message("3 damage", "3 dégâts")));
  assert.ok(chat.content.includes("Hero &lt;test&gt;"));
});
