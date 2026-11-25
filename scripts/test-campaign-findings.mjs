// Tests des correctifs issus d'une partie de test (Foundry v14, dnd5e 6) : droits de lecture des joueurs,
// traductions Babele des acteurs de compendium, localize_actor, import par nom, mode des messages, poids
// métriques, combat, cibles hors scène active, index de synchronisation. Données fictives uniquement.
import assert from "node:assert/strict";
import fsys from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { message } from "../src/i18n.mjs";

const temporary = fsys.mkdtempSync(path.join(os.tmpdir(), "foundry-campaign-findings-"));
process.env.SNAPSHOT_DIR = path.join(temporary, "snapshots");
process.env.NO_LISTEN = "1";
after(() => fsys.rmSync(temporary, { recursive: true, force: true }));

// Traductions Babele fictives servies par un faux Foundry (fetch des fichiers <pack>.json).
const TRANSLATIONS = {};
globalThis.fetch = async url => {
  const m = /\/modules\/.+\/([^/]+)\.json$/.exec(String(url));
  const file = m && TRANSLATIONS[decodeURIComponent(m[1])];
  return file ? { ok: true, json: async () => structuredClone(file) } : { ok: false, json: async () => ({}) };
};

const [{ handleTool }, access, dnd, { resolveImportEntry }, { resolveTarget }, { handleGm }, { syncItems, resetSyncIndex }] = await Promise.all([
  import("../src/server.mjs"), import("../src/access.mjs"), import("../src/dnd5e.mjs"), import("../src/edition.mjs"),
  import("../src/targets.mjs"), import("../src/gm.mjs"), import("../src/sync.mjs")
]);
const { lootWeight } = await import("../src/server.mjs");

const id = (prefix) => (prefix + "0000000000000000").slice(0, 16);
const GM = id("gmuser"), PLAYER = id("player");
const COLL = access.COLLECTIONS;

/** Faux monde Foundry : documents du monde, compendiums, écritures enregistrées. */
function fakeWorld({ role = 1, userId = PLAYER, docs = {}, packs = [], packDocs = {}, settings = [] } = {}) {
  const writes = [];
  let counter = 0;
  const filterQuery = (list, q = {}) => list.filter(d => Object.entries(q).every(([k, v]) => d[k] === v));
  const session = {
    userId, user: { id: userId, name: role >= 3 ? "GM" : "Player", role }, world: { id: "test-world" },
    async worldData() { return { packs: structuredClone(packs) }; },
    async doc(action, type, op = {}) {
      if (action === "get") {
        if (type === "Setting") return settings.filter(s => !op.query?.key || s.key === op.query.key);
        if (op.pack) return structuredClone(filterQuery(packDocs[op.pack] || [], op.query));
        if (op.parentUuid) {
          const [t, pid] = op.parentUuid.split(".");
          const parent = (docs[t] || []).find(d => d._id === pid);
          return structuredClone(parent?.[COLL[type]] || []);
        }
        return structuredClone(filterQuery(docs[type] || [], op.query));
      }
      writes.push({ action, type, op });
      if (action === "create") return op.data.map(d => ({ _id: d._id || id(`new${++counter}`), ...structuredClone(d) }));
      if (action === "update") return op.updates;
      return op.ids || [];
    }
  };
  return { session, writes };
}
const call = async (session, name, args) => {
  const r = await handleTool(session, { name, arguments: args });
  const text = r.content[0].text;
  try { return { error: r.isError, body: JSON.parse(text), text }; } catch { return { error: r.isError, body: null, text }; }
};

// ------------------------------------------------------------------ 1. confidentialité
const SECRET = id("secretactor"), LIMITED = id("limitedactor"), OWN = id("ownactor");
const JOURNAL = id("journal"), PAGE_OPEN = id("pageopen"), PAGE_HIDDEN = id("pagehidden");
function privacyWorld(role = 1) {
  const abilities = Object.fromEntries(["str", "dex", "con", "int", "wis", "cha"].map(k => [k, { value: 10 }]));
  const actor = (_id, name, ownership) => ({ _id, name, type: "npc", img: "x.webp", folder: null, ownership,
    system: { abilities, attributes: { hp: { value: 7, max: 7 } }, details: { biography: { value: "<p>secret text</p>" } } }, items: [] });
  return fakeWorld({ role, userId: role >= 3 ? GM : PLAYER, docs: {
    Actor: [actor(SECRET, "Hidden Villain", { default: 0, [GM]: 3 }), actor(LIMITED, "Distant Figure", { default: 1 }),
      actor(OWN, "My Hero", { default: 0, [PLAYER]: 3 })],
    JournalEntry: [{ _id: JOURNAL, name: "Private Notes", ownership: { default: 0 }, pages: [
      { _id: PAGE_OPEN, name: "Handout", type: "text", ownership: { default: -1, [PLAYER]: 2 }, text: { content: "<p>clue</p>" } },
      { _id: PAGE_HIDDEN, name: "Plot", type: "text", ownership: { default: -1 }, text: { content: "<p>twist</p>" } }] }],
    Scene: [{ _id: id("scene"), name: "Map", active: true, ownership: { default: 0 }, tokens: [
      { _id: id("tokvisible"), name: "Guard", hidden: false }, { _id: id("tokhidden"), name: "Ambusher", hidden: true }], notes: [], tiles: [], drawings: [] }],
    ChatMessage: [{ _id: id("msgpublic"), content: "hello", whisper: [] }, { _id: id("msgwhisper"), content: "gm only", whisper: [GM], author: GM }],
    Folder: [{ _id: id("folderopen"), name: "Heroes", type: "Actor" }, { _id: id("foldersecret"), name: "Final Boss", type: "Actor" }],
    Item: [] },
  packs: [{ id: "world.public", type: "Item", label: "Public" }, { id: "world.gmonly", type: "Item", label: "GM", ownership: { PLAYER: "NONE", ASSISTANT: "OWNER" } },
    { id: "world.titles", type: "Item", label: "Titles", ownership: { PLAYER: "LIMITED", ASSISTANT: "OWNER" } }],
  packDocs: {
    "world.public": [{ _id: id("pubitem"), name: "Rope", type: "loot", system: { description: { value: "<p>rope</p>" } } }],
    "world.gmonly": [{ _id: id("gmitem"), name: "Artifact of Doom", type: "loot", system: { description: { value: "<p>doom</p>" } } }],
    "world.titles": [{ _id: id("titleitem"), name: "Mystery Box", type: "loot", system: { description: { value: "<p>inside</p>" } } }]
  } });
}

test("confidentialité : list_documents masque les acteurs sans droit et réduit les acteurs LIMITÉ au titre", async () => {
  const { session } = privacyWorld(1);
  const { body } = await call(session, "list_documents", { type: "Actor", fields: ["name", "system.details.biography.value"] });
  const names = body.documents.map(d => d.name);
  assert.deepEqual(names.sort(), ["Distant Figure", "My Hero"]);
  const limited = body.documents.find(d => d.name === "Distant Figure");
  assert.equal(limited["system.details.biography.value"], undefined, "un acteur LIMITÉ ne montre que son titre");
  assert.equal(body.total, 2);
});

test("confidentialité : get_document refuse un document sans droit, et le contenu d'un document LIMITÉ", async () => {
  const { session } = privacyWorld(1);
  const hidden = await call(session, "get_document", { type: "Actor", id: SECRET });
  assert.match(hidden.text, new RegExp(message("Not found", "Introuvable")));
  assert.doesNotMatch(hidden.text, /Hidden Villain|secret text/);
  const limited = await call(session, "get_document", { type: "Actor", id: LIMITED, path: "system.details.biography" });
  assert.equal(limited.error, true);
  assert.doesNotMatch(limited.text, /secret text/);
  const title = await call(session, "get_document", { type: "Actor", id: LIMITED });
  assert.equal(title.body.name, "Distant Figure");
  assert.equal(title.body.system, undefined);
  const own = await call(session, "get_document", { type: "Actor", id: OWN, path: "system.details.biography.value" });
  assert.match(own.text, /secret text/);
});

test("confidentialité : le MJ garde l'accès à tout", async () => {
  const { session } = privacyWorld(4);
  const { body } = await call(session, "list_documents", { type: "Actor" });
  assert.equal(body.total, 3);
  const packs = await call(session, "list_packs", {});
  assert.equal(packs.body.length, 3);
});

test("confidentialité : pages de journal à droit propre, scène, chat et dossiers", async () => {
  const { session } = privacyWorld(1);
  const journal = await call(session, "get_document", { type: "JournalEntry", id: JOURNAL });
  assert.deepEqual(journal.body.pages.map(p => p.name), ["Handout"], "seule la page accordée explicitement est visible");
  const pages = await call(session, "list_documents", { type: "JournalEntryPage", parent: `JournalEntry.${JOURNAL}`, fields: ["name"] });
  assert.deepEqual(pages.body.documents.map(p => p.name), ["Handout"]);
  const tokens = await call(session, "list_documents", { type: "Token", parent: `Scene.${id("scene")}`, fields: ["name"] });
  assert.deepEqual(tokens.body.documents.map(t => t.name), ["Guard"], "les jetons cachés n'apparaissent pas");
  const chat = await call(session, "list_documents", { type: "ChatMessage", fields: ["content"] });
  assert.deepEqual(chat.body.documents.map(m => m.content), ["hello"]);
  // aucun acteur visible dans ces dossiers : ils sont masqués (« Final Boss » ne doit pas fuiter)
  const { session: s2 } = privacyWorld(1);
  const folders = await call(s2, "list_documents", { type: "Folder" });
  assert.equal(folders.body.total, 0);
});

test("confidentialité : compendiums selon le rôle (absent, titre seul, contenu)", async () => {
  const { session } = privacyWorld(1);
  const packs = await call(session, "list_packs", {});
  assert.deepEqual(packs.body.map(p => p.id).sort(), ["world.public", "world.titles"]);
  const search = await call(session, "search_compendium", { query: "Artifact" });
  assert.equal(search.body.total, 0);
  const denied = await call(session, "get_compendium_entry", { pack: "world.gmonly", id: id("gmitem") });
  assert.doesNotMatch(denied.text, /doom/);
  const titleOnly = await call(session, "get_compendium_entry", { pack: "world.titles", id: id("titleitem"), path: "system.description" });
  assert.equal(titleOnly.error, true);
  const open = await call(session, "get_compendium_entry", { pack: "world.public", id: id("pubitem"), path: "system.description.value" });
  assert.match(open.text, /<p>rope<\/p>/);
});

test("confidentialité : search_text, actor_sheet et find_references ne révèlent rien sans droit", async () => {
  const { session } = privacyWorld(1);
  const text = await call(session, "search_text", { query: "secret text", scope: "world" });
  assert.deepEqual([...new Set(text.body.resultats.map(r => r.document))], ["My Hero"]);
  const villain = await call(session, "search_text", { query: "Villain", scope: "world" });
  assert.equal(villain.body.total, 0);
  const doom = await call(session, "search_text", { query: "doom", scope: "packs" });
  assert.equal(doom.body.total, 0);
  const sheet = await call(session, "actor_sheet", { actor: "Distant Figure" });
  assert.equal(sheet.error, true);
  const hiddenSheet = await call(session, "actor_sheet", { actor: "Hidden Villain" });
  assert.equal(hiddenSheet.error, true);
  assert.doesNotMatch(hiddenSheet.text, /secret text/);
  const refs = await call(session, "find_references", { uuid: `Actor.${SECRET}` });
  assert.equal(refs.body.total, 0);
});

test("confidentialité : niveau d'accès (héritage, compendium par rôle, pack privé)", () => {
  const user = { _id: PLAYER, role: 1 };
  assert.equal(access.levelFor({ ownership: { default: -1 } }, user, 2), 2);
  assert.equal(access.levelFor({ ownership: { default: 0, [PLAYER]: 1 } }, user), 1);
  assert.equal(access.levelFor({ ownership: {} }, { _id: GM, role: 4 }), 3);
  assert.equal(access.packLevel({ id: "x" }, user), 2, "défaut Foundry : PLAYER = OBSERVER");
  assert.equal(access.packLevel({ id: "x", ownership: { PLAYER: "NONE", TRUSTED: "LIMITED" } }, { role: 2 }), 1);
  assert.equal(access.packLevel({ id: "x", private: true }, user), 0);
});

// ------------------------------------------------------------------ 2. import d'un acteur de compendium
test("import d'un acteur de compendium : nom, biographie, objets intégrés et nom du jeton traduits", async () => {
  const MON = id("monster"), CLAW = id("claw"), BITE = id("bite");
  TRANSLATIONS["world.beasts"] = { mapping: { description: "system.details.biography.value", items: { path: "items", converter: "document" } },
    entries: { "Cave Bear": { name: "Ours des cavernes", description: "<p>Un ours.</p>", items: {
      [CLAW]: { name: "Griffes", description: "<p>Attaque de griffes.</p>" },
      "Bite": { name: "Morsure", activities: { [id("biteact")]: { name: "Mordre" } } } } } } };
  const monster = { _id: MON, name: "Cave Bear", type: "npc", prototypeToken: { name: "Cave Bear" },
    system: { details: { biography: { value: "<p>A bear.</p>" } }, attributes: {} },
    items: [{ _id: CLAW, name: "Claws", type: "weapon", system: { description: { value: "<p>Claw attack.</p>" }, activities: {} } },
      { _id: BITE, name: "Bite", type: "weapon", system: { description: { value: "<p>Bite.</p>" },
        activities: { [id("biteact")]: { _id: id("biteact"), type: "attack", name: "Bite" } } } }] };
  const { session, writes } = fakeWorld({ role: 4, userId: GM, packs: [{ id: "world.beasts", type: "Actor" }], packDocs: { "world.beasts": [monster] } });
  const r = await call(session, "add_from_compendium", { entries: [{ uuid: `Compendium.world.beasts.Actor.${MON}` }] });
  assert.equal(r.error, undefined, r.text);
  const created = writes.find(w => w.action === "create" && w.type === "Actor").op.data[0];
  assert.equal(created.name, "Ours des cavernes");
  assert.equal(created.prototypeToken.name, "Ours des cavernes");
  assert.equal(created.system.details.biography.value, "<p>Un ours.</p>");
  assert.equal(created.items.find(i => i.name === "Griffes")?.system.description.value, "<p>Attaque de griffes.</p>");
  const bite = created.items.find(i => i.name === "Morsure");
  assert.ok(bite, "objet intégré traduit par son nom anglais");
  assert.equal(Object.values(bite.system.activities)[0].name, "Mordre");

  // surcharge du nom : le jeton suit le nom final
  const { session: s2, writes: w2 } = fakeWorld({ role: 4, userId: GM, packs: [{ id: "world.beasts", type: "Actor" }], packDocs: { "world.beasts": [monster] } });
  await call(s2, "add_from_compendium", { entries: [{ uuid: `Compendium.world.beasts.Actor.${MON}`, overrides: { name: "Ours borgne" } }] });
  const c2 = w2.find(w => w.action === "create" && w.type === "Actor").op.data[0];
  assert.equal(c2.name, "Ours borgne");
  assert.equal(c2.prototypeToken.name, "Ours borgne");
});

test("traductions Babele au format tableau (id = nom d'origine) acceptées", () => {
  const e = dnd.normalizeEntries([{ id: "Goblin", name: "Gobelin" }]);
  assert.equal(e.Goblin.name, "Gobelin");
});

// ------------------------------------------------------------------ 3. localize_actor
test("localize_actor : un objet ne reçoit pas la traduction d'un autre type portant le même nom", async () => {
  const SPELL = id("shieldspell"), ARMOR = id("shieldarmor");
  TRANSLATIONS["world.spellsfr"] = { entries: { Shield: { name: "Bouclier (sort)", description: "<p>Sort.</p>" } } };
  TRANSLATIONS["world.gearfr"] = { entries: { Shield: { name: "Bouclier", description: "<p>Armure.</p>" } } };
  const plut = { hash: "shield_test", source: "TEST" };
  const { session } = fakeWorld({ role: 4, userId: GM,
    packs: [{ id: "world.spellsfr", type: "Item" }, { id: "world.gearfr", type: "Item" }],
    packDocs: {
      "world.spellsfr": [{ _id: SPELL, name: "Shield", type: "spell", flags: { plutonium: plut } }],
      "world.gearfr": [{ _id: ARMOR, name: "Shield", type: "equipment", flags: { plutonium: plut } }] } });
  const armor = { _id: id("npcshield"), name: "Shield", type: "equipment", flags: { plutonium: plut }, system: { description: { value: "<p>A shield.</p>" } } };
  const up = await dnd.localizeItem(armor, session);
  assert.equal(up.name, "Bouclier");
  // source déclarée vers le sort, mais objet de type armure : aucune traduction
  const wrong = { ...armor, flags: {}, _stats: { compendiumSource: `Compendium.world.spellsfr.Item.${SPELL}` } };
  const none = await dnd.localizeItem(wrong, session);
  assert.equal(none.name, undefined);
  assert.equal(none["system.description.value"], undefined);
});

test("localize_actor : objets d'un monstre traduits par l'entrée de l'acteur source", async () => {
  const MON = id("wolfsource"), ACT = id("wolfworld"), BITE = id("wolfbite");
  TRANSLATIONS["world.pack-wolves"] = { mapping: { items: { path: "items", converter: "document" } },
    entries: { Wolf: { name: "Loup", items: { Bite: { name: "Morsure de loup", description: "<p>Crocs.</p>" } } } } };
  // un compendium d'objets propose une autre traduction de « Bite » : elle ne doit pas être utilisée
  TRANSLATIONS["world.generic-items"] = { entries: { Bite: { name: "Morsure générique" } } };
  const item = { _id: BITE, name: "Bite", type: "weapon", effects: [], system: { description: { value: "<p>Fangs.</p>" }, activities: {} },
    _stats: { compendiumSource: `Compendium.world.generic-items.Item.${id("genericbite")}` } };
  const actor = { _id: ACT, name: "Loup", type: "npc", items: [item], system: { attributes: {} }, prototypeToken: {},
    _stats: { compendiumSource: `Compendium.world.pack-wolves.Actor.${MON}` }, ownership: { default: 0 } };
  const { session } = fakeWorld({ role: 4, userId: GM, docs: { Actor: [actor] },
    packs: [{ id: "world.pack-wolves", type: "Actor" }, { id: "world.generic-items", type: "Item" }],
    packDocs: { "world.pack-wolves": [{ _id: MON, name: "Wolf", type: "npc", items: [{ _id: BITE, name: "Bite", type: "weapon" }] }],
      "world.generic-items": [{ _id: id("genericbite"), name: "Bite", type: "weapon" }] } });
  const r = await call(session, "localize_actor", { actor: ACT, dry_run: true });
  assert.equal(r.error, undefined, r.text);
  const flat = JSON.stringify(r.body.objets);
  assert.match(flat, /Morsure de loup/);
  assert.doesNotMatch(flat, /Morsure générique/);
});

test("localize_actor ne retraduit jamais un parchemin de sort", async () => {
  const GENERIC = id("genericscroll");
  TRANSLATIONS["world.scrolls"] = { entries: { [GENERIC]: { name: "Parchemin de sort (3e niveau)", description: "<p>Générique.</p>" } } };
  const { session } = fakeWorld({ role: 4, userId: GM, packs: [{ id: "world.scrolls", type: "Item" }],
    packDocs: { "world.scrolls": [{ _id: GENERIC, name: "Spell Scroll 3rd Level", type: "consumable" }] } });
  const scroll = { _id: id("myscroll"), name: "Parchemin de sort : Boule de feu", type: "consumable",
    _stats: { compendiumSource: `Compendium.world.scrolls.Item.${GENERIC}` },
    system: { description: { value: "<p>@Embed[Compendium.x.y.Item.z inline]</p>" },
      activities: { dnd5escrollspell: { _id: "dnd5escrollspell", type: "cast", spell: { uuid: "Compendium.x.y.Item.z" } } } } };
  assert.equal(dnd.isSpellScroll(scroll), true);
  const up = await dnd.localizeItem(scroll, session);
  assert.equal(up.name, undefined);
  assert.equal(up["system.description.value"], undefined);
  // marqueur seul (sans activité reconnue) : toujours protégé
  assert.equal(dnd.isSpellScroll({ type: "consumable", flags: { mcp: { spellScroll: "Compendium.x.y.Item.z" } } }), true);
  assert.equal(dnd.isSpellScroll({ type: "consumable", system: { activities: {} } }), false);
});

// ------------------------------------------------------------------ 4. add_from_compendium {name} sans pack
test("import par nom sans compendium : priorité monde, puis dnd5e 2024, puis les autres", async () => {
  const packs = [
    { id: "othermod.items", type: "Item", packageName: "othermod" },
    { id: "dnd5e.items", type: "Item", packageName: "dnd5e" },
    { id: "dnd5e.equipment24", type: "Item", packageName: "dnd5e" },
    { id: "world.gear", type: "Item", packageName: "world" }];
  const docs = {
    "othermod.items": [{ _id: id("otherrope"), name: "Rope", type: "loot" }],
    "dnd5e.items": [{ _id: id("oldrope"), name: "Rope", type: "loot" }],
    "dnd5e.equipment24": [{ _id: id("newrope"), name: "Rope", type: "loot", system: { source: { rules: "2024" } } }],
    "world.gear": [{ _id: id("lantern"), name: "Lantern", type: "loot", name_fr: "Lanterne" }] };
  const fs = { async doc(action, type, op) { return (docs[op.pack] || []).filter(d => !op.query?._id || d._id === op.query._id); } };
  const indexOf = p => docs[p.id];
  const rope = await resolveImportEntry(fs, packs, { name: "rope" }, indexOf);
  assert.equal(rope.pack.id, "dnd5e.equipment24");
  const lantern = await resolveImportEntry(fs, packs, { name: "Lanterne" }, indexOf);
  assert.equal(lantern.pack.id, "world.gear");
  const old = await resolveImportEntry(fs, packs, { name: "Rope", rules: "2014" }, indexOf);
  assert.equal(old.pack.id, "othermod.items", "2014 : dnd5e 2024 écarté, les modules restent possibles");
  const missing = await resolveImportEntry(fs, packs, { name: "Unknown thing" }, indexOf);
  assert.equal(missing.missing, "Unknown thing");
});

test("import par nom sans compendium : types ambigus → message listant les candidats", async () => {
  const packs = [{ id: "world.mixed", type: "Item" }];
  const docs = { "world.mixed": [{ _id: id("spellshield"), name: "Shield", type: "spell" }, { _id: id("armorshield"), name: "Shield", type: "equipment" }] };
  const fs = { async doc(action, type, op) { return docs[op.pack].filter(d => !op.query?._id || d._id === op.query._id); } };
  await assert.rejects(resolveImportEntry(fs, packs, { name: "Shield" }, p => docs[p.id]),
    err => /world\.mixed\/spellshield.*spell/.test(err.message) && /item_type/.test(err.message));
  const armor = await resolveImportEntry(fs, packs, { name: "Shield", item_type: "equipment" }, p => docs[p.id]);
  assert.equal(armor.id, id("armorshield"));
});

// ------------------------------------------------------------------ 5/6. rest et give_loot
function restWorld() {
  const abilities = Object.fromEntries(["str", "dex", "con", "int", "wis", "cha"].map(k => [k, { value: 10 }]));
  const actor = { _id: OWN, name: "My Hero", type: "character", ownership: { default: 0, [PLAYER]: 3 },
    system: { abilities, attributes: { hp: { value: 3, max: 10 } }, currency: { gp: 0 }, spells: {} }, items: [], effects: [] };
  return fakeWorld({ role: 1, docs: { Actor: [actor], User: [{ _id: GM, name: "GM", role: 4 }, { _id: PLAYER, name: "Player", role: 1 }] } });
}
test("rest et give_loot : mode du message (privé, MJ), public par défaut", async () => {
  let { session, writes } = restWorld();
  await call(session, "rest", { actor: "My Hero", type: "court", mode: "prive" });
  let chat = writes.find(w => w.type === "ChatMessage").op.data[0];
  assert.deepEqual(chat.whisper, [PLAYER]);
  ({ session, writes } = restWorld());
  await call(session, "give_loot", { actor: "My Hero", currency: { gp: 5 }, mode: "mj" });
  chat = writes.find(w => w.type === "ChatMessage").op.data[0];
  assert.deepEqual(chat.whisper.sort(), [GM, PLAYER].sort());
  ({ session, writes } = restWorld());
  await call(session, "rest", { actor: "My Hero", type: "court" });
  chat = writes.find(w => w.type === "ChatMessage").op.data[0];
  assert.equal(chat.whisper, undefined);
});

test("give_loot : poids en kg si l'option métrique est active (lb converties ÷ 2)", async () => {
  assert.deepEqual(lootWeight(3, undefined, true), { value: 3, units: "kg" });
  assert.deepEqual(lootWeight(3, "lb", true), { value: 1.5, units: "kg" });
  assert.deepEqual(lootWeight(2, "kg", false), { value: 4, units: "lb" });
  assert.deepEqual(lootWeight(undefined, undefined, false), { value: 0, units: "lb" });
  const { session, writes } = restWorld();
  const before = { ...dnd.UNITS };
  Object.assign(dnd.UNITS, { weight: true, at: Date.now() });
  try {
    await call(session, "give_loot", { actor: "My Hero", weight_unit: "lb", items: [{ name: "Gem", weight: 1 }] });
  } finally { Object.assign(dnd.UNITS, before); }
  const item = writes.find(w => w.type === "Item" && w.action === "create").op.data[0];
  assert.deepEqual(item.system.weight, { value: 0.5, units: "kg" });
});

// ------------------------------------------------------------------ 7. mineurs
test("gm_combat status : noms des combattants (jeton, puis acteur) au lieu des _id", async () => {
  const SC = id("combatscene"), A1 = id("actorone"), A2 = id("actortwo");
  const { session } = fakeWorld({ role: 4, userId: GM, docs: {
    Scene: [{ _id: SC, name: "Arena", tokens: [{ _id: id("tokone"), name: "Orc Captain" }] }],
    Actor: [{ _id: A1, name: "Orc" }, { _id: A2, name: "Wolf" }],
    Combat: [{ _id: id("combat"), scene: SC, active: true, round: 1, turn: 0, combatants: [
      { _id: id("cbone"), actorId: A1, tokenId: id("tokone"), sceneId: SC, initiative: 15 },
      { _id: id("cbtwo"), actorId: A2, tokenId: id("missing"), sceneId: SC, initiative: 10 }] }] } });
  const r = await handleGm(session, "gm_combat", { action: "status" });
  assert.deepEqual(r.ordre, ["Orc Captain (15)", "Wolf (10)"]);
});

test("create_documents Actor : pas d'avertissement « aucune activité » pour l'acteur lui-même", async () => {
  const { session } = fakeWorld({ role: 4, userId: GM });
  const r = await call(session, "create_documents", { type: "Actor", data: [{ name: "Hero", type: "character", system: {}, items: [] }] });
  assert.equal(r.error, undefined, r.text);
  assert.equal(r.body.a_verifier, undefined);
});

test("cible par _id de jeton : cherchée aussi hors de la scène active", async () => {
  const ACTIVE = id("activescene"), OTHER = id("otherscene"), TOKEN = id("faraway"), ACTOR = id("targetactor");
  const { session } = fakeWorld({ role: 4, userId: GM, docs: {
    Scene: [{ _id: ACTIVE, name: "Town", active: true, tokens: [] }, { _id: OTHER, name: "Dungeon", tokens: [{ _id: TOKEN, name: "Skeleton", actorId: ACTOR, actorLink: true }] }],
    Actor: [{ _id: ACTOR, name: "Skeleton", system: {} }], Combat: [] } });
  const t = await resolveTarget(session, TOKEN);
  assert.equal(t.uuid, `Scene.${OTHER}.Token.${TOKEN}`);
  // par nom : scène du combat en cours
  const { session: s2 } = fakeWorld({ role: 4, userId: GM, docs: {
    Scene: [{ _id: OTHER, name: "Dungeon", tokens: [{ _id: TOKEN, name: "Skeleton", actorId: ACTOR, actorLink: true }] }],
    Actor: [{ _id: ACTOR, name: "Skeleton", system: {} }], Combat: [{ _id: id("fight"), scene: OTHER, active: true }] } });
  const t2 = await resolveTarget(s2, "Skeleton");
  assert.equal(t2.scene._id, OTHER);
  await assert.rejects(resolveTarget(s2, "Nobody"), /Nobody/);
});

test("gm_sync_items : index de repli construit à la demande, en parallèle, une fois par processus", async () => {
  resetSyncIndex();
  const ITEM = id("syncitem");
  let indexCalls = 0, inFlight = 0, maxInFlight = 0;
  const makeSession = () => ({ userId: GM, user: { role: 4 }, world: { id: "sync-world" },
    async worldData() { return { packs: ["world.p1", "world.p2", "world.p3"].map(i => ({ id: i, type: "Item" })) }; },
    async doc(action, type, op) {
      if (op.index) {
        indexCalls++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(r => setTimeout(r, 5)); inFlight--;
        return op.pack === "world.p2" ? [{ _id: ITEM }] : [];
      }
      if (op.pack === "world.p2") return [{ _id: ITEM, name: "Feature", type: "feat", effects: [], system: { activities: {}, advancement: {} } }];
      return [];
    } });
  const item = (src) => ({ _id: ITEM, name: "Feature", type: "feat", effects: [], system: { activities: {}, advancement: {} }, _stats: { compendiumSource: src } });
  // source présente à l'endroit indiqué : aucun index construit
  await syncItems(makeSession(), { actor: { _id: id("syncactor"), name: "Hero", items: [item(`Compendium.world.p2.Item.${ITEM}`)] } });
  assert.equal(indexCalls, 0);
  // source absente : index construit en parallèle, puis réutilisé par une nouvelle session
  await syncItems(makeSession(), { actor: { _id: id("syncactor"), name: "Hero", items: [item(`Compendium.premium.gone.Item.${ITEM}`)] } });
  assert.equal(indexCalls, 3);
  assert.ok(maxInFlight > 1, "les compendiums sont indexés en parallèle");
  const r = await syncItems(makeSession(), { actor: { _id: id("syncactor"), name: "Hero", items: [item(`Compendium.premium.gone.Item.${ITEM}`)] } });
  assert.equal(indexCalls, 3, "index réutilisé d'une session à l'autre");
  assert.equal(r.complets, 1);
});
