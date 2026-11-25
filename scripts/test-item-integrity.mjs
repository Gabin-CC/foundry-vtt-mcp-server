import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { message } from "../src/i18n.mjs";

// Snapshot directory setup must happen before importing modules that capture it.
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "foundry-item-integrity-"));
const blocker = path.join(temporary, "not-a-directory");
fs.writeFileSync(blocker, "block snapshot creation");
process.env.SNAPSHOT_DIR = path.join(blocker, "snapshots");
process.env.NO_LISTEN = "1";
after(() => fs.rmSync(temporary, { recursive: true, force: true }));

const [{ itemDiff, syncUpdate, syncItems }, { applyPatches }, { patchItems }, { useItem }, { fixId, scanAndRepair }, { handleTool }] =
  await Promise.all([
    import("../src/sync.mjs"), import("../src/patches.mjs"), import("../src/patchrun.mjs"),
    import("../src/dnd5e.mjs"), import("../src/repair.mjs"), import("../src/server.mjs")
  ]);

const ITEM_ID = "aaaaaaaaaaaaaaaa";
const ACTIVITY_ID = "bbbbbbbbbbbbbbbb";
const EFFECT_ID = "cccccccccccccccc";
const ACTOR_ID = "dddddddddddddddd";

function weaponCantrip() {
  return {
    _id: ITEM_ID, name: "Lame retentissante", type: "spell", effects: [],
    system: { level: 0, activities: { [ACTIVITY_ID]: {
      _id: ACTIVITY_ID, type: "damage", sort: 0,
      damage: { parts: [{ custom: { enabled: true, formula: "1d8[on hit]" }, types: ["thunder"] }] }
    } } }
  };
}

test("weapon cantrip patches are idempotent", () => {
  const original = weaponCantrip();
  const first = applyPatches(original);
  assert.deepEqual(first.appliques, ["booming-blade-attack"]);
  const second = applyPatches(first.doc);
  assert.deepEqual(second.appliques, []);
  assert.deepEqual(second.doc, first.doc);
  assert.deepEqual(original, weaponCantrip(), "the input document must not be mutated");
});

test("weapon-classified spell attacks use the equipped weapon's bonus and base damage", () => {
  const weapon = {
    _id: "eeeeeeeeeeeeeeee", name: "Longsword", type: "weapon",
    system: { equipped: true, type: { value: "martialM" }, damage: {
      base: { number: 1, denomination: 8, types: ["slashing"] }
    } }
  };
  const abilities = Object.fromEntries(["str", "dex", "con", "int", "wis", "cha"]
    .map(ability => [ability, { value: ability === "str" ? 16 : ability === "int" ? 8 : 10 }]));
  const actor = {
    _id: ACTOR_ID, type: "character", items: [weapon], effects: [],
    system: { abilities, attributes: { spellcasting: "int" } }
  };
  const item = applyPatches(weaponCantrip()).doc;
  const attack = Object.values(item.system.activities).find(a => a.type === "attack");
  assert.equal(attack.attack.type.classification, "weapon");
  const result = useItem(actor, item, { activityId: attack._id, consume: false });
  assert.equal(result.attack.arme, "Longsword");
  assert.equal(result.attack.total - result.attack.nat, 5); // STR +3, proficiency +2
  assert.ok(result.damage?.some(d => d.types.includes("slashing")), "base weapon damage must be included");
});

test("sync treats activity references as dangling when embedded effects are absent", () => {
  const activity = { _id: ACTIVITY_ID, type: "attack", effects: [{ _id: EFFECT_ID }] };
  const source = { system: { activities: { [ACTIVITY_ID]: activity }, advancement: {} },
    effects: [{ _id: EFFECT_ID, name: "Blessed", changes: [] }] };
  const target = { _id: ITEM_ID, system: { activities: { [ACTIVITY_ID]: activity }, advancement: {} }, effects: [] };
  const diff = itemDiff(target, source);
  assert.deepEqual(diff.missingEff.map(e => e.id), [EFFECT_ID]);
  const update = syncUpdate(target, source, diff);
  assert.equal(update.effects.length, 1);
  assert.equal(update.effects[0]._id, EFFECT_ID);
});

test("sync repairs invalid activity and advancement IDs and keeps chosen advancement values", () => {
  const source = {
    system: { activities: { "bad-id": { _id: "bad-id", type: "attack" } },
      advancement: [{ _id: "bad-adv", type: "HitPoints", value: {} }] }, effects: []
  };
  const chosen = { 1: "avg", 2: "max" };
  const target = { _id: ITEM_ID, system: { activities: { "bad-id": { _id: "bad-id" } },
    advancement: { "bad-adv": { value: chosen } } }, effects: [] };
  const diff = itemDiff(target, source);
  assert.equal(diff.missingActs.length, 1);
  assert.equal(diff.missingAdv.length, 1);
  const update = syncUpdate(target, source, diff);
  const activityId = fixId("bad-id"), advancementId = fixId("bad-adv");
  assert.equal(update[`system.activities.${activityId}`]._id, activityId);
  assert.equal(update[`system.advancement.${advancementId}`]._id, advancementId);
  assert.deepEqual(update[`system.advancement.${advancementId}`].value, chosen);
  assert.equal(update["system.activities.-=bad-id"], null);
  assert.equal(update["system.advancement.-=bad-adv"], null);
  assert.equal(update["system.activities.bad-id"], undefined);
  assert.equal(update["system.advancement.bad-adv"], undefined);
});

test("gm_patch_items never writes if its recovery snapshot fails", async () => {
  const writes = [];
  const session = { userId: "gm", user: { name: "GM" },
    async doc(action, type, options) { if (action === "update") writes.push(options); return []; } };
  await assert.rejects(patchItems(session, {
    actor: { name: "Hero" }, parentUuid: `Actor.${ACTOR_ID}`, items: [weaponCantrip()], apply: true
  }), /ENOTDIR/);
  assert.equal(writes.length, 0);
});

test("gm_sync_items never writes if its recovery snapshot fails", async () => {
  const source = { _id: ITEM_ID, name: "Feature", type: "feat",
    system: { activities: { [ACTIVITY_ID]: { _id: ACTIVITY_ID, type: "attack" } }, advancement: {} }, effects: [] };
  const item = { _id: ITEM_ID, name: "Feature", type: "feat", effects: [],
    _stats: { compendiumSource: `Compendium.world.features.Item.${ITEM_ID}` },
    system: { activities: {}, advancement: {} } };
  const writes = [];
  const session = { userId: "gm", user: { name: "GM" },
    async worldData() { return { packs: [{ id: "world.features", type: "Item" }] }; },
    async doc(action, type, options) {
      if (action === "update") writes.push(options);
      if (action === "get" && options.pack) return [source];
      if (action === "get") return [item];
      return [];
    } };
  await assert.rejects(syncItems(session, { actor: { _id: ACTOR_ID, name: "Hero", items: [item] }, apply: true }), /ENOTDIR/);
  assert.equal(writes.length, 0);
});

test("source fallback rejects an unrelated item with the same compendium ID", async () => {
  const target = { _id: ITEM_ID, name: "Heroic Feature", type: "feat", effects: [],
    _stats: { compendiumSource: `Compendium.absent.features.Item.${ITEM_ID}` },
    system: { activities: {}, advancement: {} } };
  const unrelated = { _id: ITEM_ID, name: "Completely Different", type: "feat", effects: [],
    system: { activities: { [ACTIVITY_ID]: { _id: ACTIVITY_ID, type: "attack" } }, advancement: {} } };
  const session = {
    async worldData() { return { packs: [{ id: "world.unrelated", type: "Item" }] }; },
    async doc(action, type, options) {
      if (options.index) return [{ _id: ITEM_ID }];
      if (options.pack) return [unrelated];
      return [];
    }
  };
  const report = await syncItems(session, { actor: { _id: ACTOR_ID, name: "Hero", items: [target] } });
  assert.equal(report.detail[0].probleme, message("source not found", "source introuvable"));
  assert.equal(report.modifies, 0);
});

test("source fallback accepts a uniquely verified item by name and type", async () => {
  const target = { _id: ITEM_ID, name: "Heroic Feature", type: "feat", effects: [],
    _stats: { compendiumSource: `Compendium.absent.features.Item.${ITEM_ID}` },
    system: { activities: {}, advancement: {} } };
  const candidate = { _id: ITEM_ID, name: "Heroic Feature", type: "feat", effects: [],
    system: { activities: { [ACTIVITY_ID]: { _id: ACTIVITY_ID, type: "attack" } }, advancement: {} } };
  const session = {
    async worldData() { return { packs: [{ id: "world.verified", type: "Item" }] }; },
    async doc(action, type, options) {
      if (options.index) return [{ _id: ITEM_ID }];
      if (options.pack) return [candidate];
      return [];
    }
  };
  const report = await syncItems(session, { actor: { _id: ACTOR_ID, name: "Hero", items: [target] } });
  assert.equal(report.a_completer, 1);
  assert.match(report.detail[0].manque[0], new RegExp(message("activity", "activité")));
});

test("source fallback refuses ambiguous equal-name matches across compendiums", async () => {
  const target = { _id: ITEM_ID, name: "Heroic Feature", type: "feat", effects: [],
    _stats: { compendiumSource: `Compendium.absent.features.Item.${ITEM_ID}` },
    system: { activities: {}, advancement: {} } };
  const candidate = { _id: ITEM_ID, name: "Heroic Feature", type: "feat", effects: [],
    system: { activities: { [ACTIVITY_ID]: { _id: ACTIVITY_ID, type: "attack" } }, advancement: {} } };
  const session = {
    async worldData() { return { packs: ["world.a", "world.b"].map(id => ({ id, type: "Item" })) }; },
    async doc(action, type, options) {
      if (options.index) return [{ _id: ITEM_ID }];
      if (options.pack) return [candidate];
      return [];
    }
  };
  const report = await syncItems(session, { actor: { _id: ACTOR_ID, name: "Hero", items: [target] } });
  assert.match(report.detail[0].probleme, /Ambiguous compendium source/);
});

test("gm_check_ids never begins bulk repairs if its combined snapshot fails", async () => {
  const broken = { _id: ITEM_ID, name: "Broken ID", type: "feat",
    system: { activities: { "bad-id": { _id: "bad-id", type: "attack" } }, advancement: {} } };
  const writes = [];
  const session = { userId: "gm", user: { name: "GM" },
    async doc(action, type, options) {
      if (action === "update") { writes.push(options); return []; }
      if (type === "Actor") return [{ _id: ACTOR_ID, name: "Hero" }];
      return [broken];
    }
  };
  await assert.rejects(scanAndRepair(session, { apply: true, actors: true, items: false, packs: false }), /ENOTDIR/);
  assert.equal(writes.length, 0);
});

test("generic document updates/deletions fail closed when preimages are unavailable", async () => {
  const writes = [];
  const session = { userId: "gm", user: { role: 4, name: "GM" },
    async doc(action, type, options) {
      if (action !== "get") writes.push({ action, type, options });
      return [];
    } };
  const update = await handleTool(session, { name: "update_documents", arguments: {
    type: "Actor", updates: [{ _id: ACTOR_ID, "system.attributes.hp.value": 10 }]
  } });
  assert.equal(update.isError, true);
  const deletion = await handleTool(session, { name: "delete_documents", arguments: {
    type: "Actor", ids: [ACTOR_ID]
  } });
  assert.equal(deletion.isError, true);
  assert.deepEqual(writes, []);
});

test("generic document updates/deletions fail closed when snapshots cannot be stored", async () => {
  const original = { _id: ACTOR_ID, name: "Hero", system: { attributes: { hp: { value: 20 } } } };
  const writes = [];
  const session = { userId: "gm", user: { role: 4, name: "GM" },
    async doc(action, type, options) {
      if (action !== "get") writes.push({ action, type, options });
      return [original];
    } };
  const update = await handleTool(session, { name: "update_documents", arguments: {
    type: "Actor", updates: [{ _id: ACTOR_ID, "system.attributes.hp.value": 10 }]
  } });
  assert.equal(update.isError, true);
  const deletion = await handleTool(session, { name: "delete_documents", arguments: {
    type: "Actor", ids: [ACTOR_ID]
  } });
  assert.equal(deletion.isError, true);
  assert.deepEqual(writes, []);
});
