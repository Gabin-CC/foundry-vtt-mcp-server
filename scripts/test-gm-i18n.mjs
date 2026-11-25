import assert from "node:assert/strict";
import { test } from "node:test";
import { currentLocale, message } from "../src/i18n.mjs";
import { itemWarnings, scanAndRepair } from "../src/repair.mjs";
import { itemDiff, syncItems } from "../src/sync.mjs";
import { patchItems } from "../src/patchrun.mjs";
import { handleGm } from "../src/gm.mjs";

process.env.NO_LISTEN = "1";
const { handleTool } = await import("../src/server.mjs");

const english = currentLocale() === "en";
const tr = (en, fr) => english ? en : fr;
const ID = "abcdefghijklmnop";
const ACT = "bbbbbbbbbbbbbbbb";

test("item-repair warnings switch language and leave item data untouched", () => {
  const item = { _id: ID, name: "Heroic Feature", type: "feat", system: { activities: {}, advancement: {} }, effects: [] };
  const source = { _id: "cccccccccccccccc", name: "Source Feature", type: "feat", effects: [{ _id: ACT }],
    system: { activities: { [ACT]: { _id: ACT, type: "attack" } }, advancement: { [ACT]: { _id: ACT, type: "Trait" } } } };
  const before = structuredClone(item);
  const warnings = itemWarnings(item, [source]);
  assert.deepEqual(warnings, [
    tr("no activity (feat)", "aucune activité (feat)"),
    tr('1 activity in source "Source Feature", 0 here', "1 activité(s) dans la source « Source Feature », 0 ici"),
    tr('1 effect in source "Source Feature", 0 here', "1 effet(s) dans la source « Source Feature », 0 ici"),
    tr("1 advancement in source, 0 here", "1 avancement(s) dans la source, 0 ici")
  ]);
  assert.deepEqual(item, before);
});

test("synchronization diff text is bilingual but IDs and update plans are stable", () => {
  const item = { _id: ID, type: "feat", system: { activities: {}, advancement: {} }, effects: [] };
  const source = { _id: "cccccccccccccccc", type: "feat", system: {
    activities: { [ACT]: { _id: ACT, type: "attack", name: "Strike" } },
    advancement: { [ACT]: { _id: ACT, type: "Trait", title: "Choice" } }
  }, effects: [{ _id: ACT, name: "Glow", type: "base" }] };
  const diff = itemDiff(item, source);
  assert.deepEqual(diff.changed, [
    tr("1 activity: Strike", "1 activité(s) : Strike"),
    tr("1 effect: Glow", "1 effet(s) : Glow"),
    tr("1 advancement: Choice", "1 avancement(s) : Choice")
  ]);
  assert.deepEqual(diff.missingActs.map(x => x.id), [ACT]);
  assert.deepEqual(diff.missingEff.map(x => x.id), [ACT]);
  assert.deepEqual(diff.missingAdv.map(x => x.id), [ACT]);
});

test("gm_sync_items dry-run explains changes without writing or changing JSON keys", async () => {
  const source = { _id: ID, name: "Feature", type: "feat", effects: [],
    system: { activities: { [ACT]: { _id: ACT, type: "attack", name: "Strike" } }, advancement: {} } };
  const item = { _id: ID, name: "Feature", type: "feat", effects: [],
    _stats: { compendiumSource: `Compendium.world.features.Item.${ID}` },
    system: { activities: {}, advancement: {} } };
  const session = {
    async worldData() { return { packs: [{ id: "world.features", type: "Item" }] }; },
    async doc(action, type, options) {
      assert.equal(action, "get"); assert.equal(type, "Item");
      return options?.pack ? [source] : [item];
    }
  };
  const result = await syncItems(session, { actor: { _id: ID, name: "Hero", items: [item] } });
  assert.deepEqual(Object.keys(result), ["acteur", "objets", "complets", "sans_source", "a_completer", "modifies", "simulation", "detail", "note"]);
  assert.equal(result.simulation, true);
  assert.equal(result.modifies, 0);
  assert.equal(result.detail[0].manque[0], tr("1 activity: Strike", "1 activité(s) : Strike"));
  assert.equal(result.detail[0].a_verifier[0], tr("no activity (feat)", "aucune activité (feat)"));
  assert.equal(result.note, tr("Dry run: call again with apply=true to complete the items (a recovery snapshot will be kept).",
    "Simulation : relancer avec apply=true pour compléter (un instantané de restauration est gardé)."));
});

test("source diagnostics translate prose but keep stable status values", async () => {
  const item = { _id: ID, name: "Feature", type: "feat", effects: [],
    _stats: { compendiumSource: `Compendium.world.features.Item.${ID}` },
    system: { activities: {}, advancement: {} } };
  const missing = await syncItems({
    async worldData() { return { packs: [{ id: "world.features", type: "Item" }] }; },
    async doc() { return []; }
  }, { actor: { _id: ID, name: "Hero", items: [item] } });
  assert.equal(missing.detail[0].probleme, tr("source not found", "source introuvable"));

  const handmade = { ...item, _stats: {} };
  const result = await syncItems({}, { actor: { _id: ID, name: "Hero", items: [handmade] }, item: ID });
  assert.equal(result.detail[0].statut, "sans source (créé à la main)"); // unchanged protocol value
  await assert.rejects(syncItems({}, { actor: { _id: ID, name: "Hero", items: [item] }, item: "missing" }),
    error => error.message === tr("Item not found on Hero: missing", "Objet introuvable sur Hero : missing"));
});

test("gm_patch_items keeps patch IDs and offers localized dry-run guidance", async () => {
  const item = { _id: ID, name: "Lame retentissante", type: "spell", effects: [],
    system: { activities: { [ACT]: { _id: ACT, type: "damage", damage: { parts: [] } } } } };
  const result = await patchItems({}, { actor: { name: "Hero" }, items: [item] });
  assert.equal(result.a_corriger, 1);
  assert.equal(result.modifies, 0);
  assert.equal(result.simulation, true);
  assert.deepEqual(result.detail[0].correctifs, ["booming-blade-attack"]);
  assert.equal(result.note, tr("Dry run: call again with apply=true to write changes (a recovery snapshot will be kept).",
    "Simulation : relancer avec apply=true pour écrire (un instantané de restauration est gardé)."));
  await assert.rejects(patchItems({}, { items: [item], itemRef: "missing" }),
    error => error.message === tr("Item not found: missing", "Objet introuvable : missing"));
});

test("gm_check_ids dry-run retains issue IDs and report fields", async () => {
  const broken = { _id: ID, name: "Broken", type: "feat", effects: [],
    system: { activities: { "bad-id": { _id: "bad-id", type: "attack" } }, advancement: {} } };
  const result = await scanAndRepair({ async doc() { return [broken]; } }, { apply: false, actors: false, packs: false, items: true });
  assert.equal(result.total, 1);
  assert.equal(result.simulation, true);
  assert.equal(result.corriges, 0);
  assert.deepEqual(result.objets_du_monde[0].ids, ["activities:bad-id"]);
  assert.deepEqual(Object.keys(result), ["compendiums", "objets_du_monde", "fiches", "effets_a_refaire", "corriges", "total", "simulation"]);
});

test("gm_permissions preserves legacy level enums and translates explanatory notes", async () => {
  const scene = { _id: ID, name: "Ancient Crypt", active: true, navigation: true, ownership: { default: 2 }, tokens: [] };
  const player = { _id: "cccccccccccccccc", name: "Alice", role: 1 };
  const session = { async doc(action, type) {
    assert.equal(action, "get"); return type === "User" ? [player] : type === "Scene" ? [scene] : [];
  } };
  const result = await handleGm(session, "gm_permissions", { uuid: `Scene.${ID}` });
  assert.equal(result.utilisateurs[0].niveau, "observateur"); // enum, not free text
  assert.equal(result.utilisateurs[0].contenu_lisible, true);
  assert.equal(result.note, tr("A player can see the active scene and, in the navigation bar, scenes marked for navigation where they have at least Limited permission.",
    "Un joueur voit la scène active, et dans la navigation les scènes marquées « navigation » dont il a au moins le droit limité."));
  assert.ok(Object.hasOwn(result, "jetons_caches"));
});

test("server refuses GM-only calls with a bilingual message", async () => {
  const response = await handleTool({ user: { role: 2 } }, { name: "gm_pause", arguments: { paused: true } });
  assert.match(response.content[0].text, new RegExp(tr(
    "This tool is restricted to Gamemaster or Assistant Gamemaster accounts\\.",
    "Outil réservé aux comptes MJ ou assistant MJ\\.")));
});

test("create_documents still emits no-activity warnings in either locale", async () => {
  const newItem = { _id: ID, name: "Feature", type: "feat", system: { activities: {}, advancement: {} }, effects: [] };
  const session = { user: { role: 4 }, async doc(action) {
    if (action === "create") return [newItem];
    if (action === "get") return [];
    throw new Error(`Unexpected action ${action}`);
  } };
  const response = await handleTool(session, { name: "create_documents", arguments: { type: "Item", data: [structuredClone(newItem)] } });
  assert.equal(response.isError, undefined);
  const result = JSON.parse(response.content[0].text);
  assert.deepEqual(result.a_verifier, [`Feature (feat) : ${tr("no activity (feat)", "aucune activité (feat)")}`]);
  assert.deepEqual(result.crees, [{ _id: ID, name: "Feature" }]);
});

test("ambiguous sync source is bilingual without changing source pack IDs", async () => {
  const item = { _id: ID, name: "Duplicate Feature", type: "feat", effects: [],
    _stats: { compendiumSource: `Compendium.premium.missing.Item.${ID}` },
    system: { activities: {}, advancement: {} } };
  const packs = ["world.first", "world.second"];
  const session = {
    async worldData() { return { packs: packs.map(id => ({ id, type: "Item" })) }; },
    async doc(action, type, options) {
      assert.equal(action, "get");
      assert.equal(type, "Item");
      if (options.index) return [{ _id: ID }];
      return [{ _id: ID, name: "Duplicate Feature", type: "feat", system: {} }];
    }
  };
  const result = await syncItems(session, { actor: { _id: ACT, name: "Hero", items: [item] } });
  assert.equal(result.detail[0].source, `Compendium.premium.missing.Item.${ID}`);
  assert.equal(result.detail[0].probleme, tr(
    "Ambiguous compendium source: world.first, world.second",
    "Source de compendium ambiguë : world.first, world.second"));
  assert.equal(result.modifies, 0);
  assert.equal(result.simulation, true);
});

test("document update/delete snapshot safeguards are bilingual and never mutate", async () => {
  let writes = 0;
  const session = { user: { role: 4 }, async doc(action) {
    if (action === "get") return [];
    writes++;
    throw new Error("Unexpected write");
  } };
  const cases = [
    ["update_documents", { type: "Item", updates: [{ _id: ID, name: "Changed" }] },
      "Document update aborted: original document unavailable for snapshot",
      "Mise à jour des documents interrompue : document d'origine introuvable pour l'instantané"],
    ["delete_documents", { type: "Item", ids: [ID] },
      "Document deletion aborted: original document unavailable for snapshot",
      "Suppression des documents interrompue : document d'origine introuvable pour l'instantané"]
  ];
  for (const [name, args, en, fr] of cases) {
    const result = await handleTool(session, { name, arguments: args });
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes(tr(en, fr)), result.content[0].text);
  }
  assert.equal(writes, 0, "A failed snapshot precondition must never write to Foundry");
});

test("no-op document update has bilingual note and preserves response field names", async () => {
  const doc = { _id: ID, name: "Unchanged" };
  const session = { user: { role: 4 }, async doc(action) {
    assert.equal(action, "get");
    return [doc];
  } };
  const result = await handleTool(session, {
    name: "update_documents", arguments: { type: "Item", updates: [{ _id: ID, name: doc.name }] }
  });
  assert.equal(result.isError, undefined);
  const value = JSON.parse(result.content[0].text);
  assert.equal(value.note, tr("No changes necessary", "Aucune modification nécessaire"));
  assert.equal(value.modifies, 0);
  assert.deepEqual(value.resultat, []);
});

test("upload parameter validation is bilingual while parameter names remain stable", async () => {
  const result = await handleTool({ user: { role: 4 } }, {
    name: "upload_file", arguments: { filename: "portrait.png" }
  });
  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.includes(tr(
    "Provide exactly one of 'url' or 'base64'",
    "Fournir exactement l'un des paramètres « url » ou « base64 »")));
});
