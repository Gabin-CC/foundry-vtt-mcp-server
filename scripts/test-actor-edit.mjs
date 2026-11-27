import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.NO_LISTEN = "1";
process.env.SNAPSHOT_DIR = await mkdtemp(path.join(os.tmpdir(), "foundry-edit-tests-"));
const { handleTool } = await import("../src/server.mjs");
const { captureActorState } = await import("../src/actor-progress.mjs");

const AID = "editActor2024ZZZ";
const CID = "editClass2024ZZZ";
const id = name => (name + "Z".repeat(16)).slice(0, 16);
const ARMOR = id("chainMail"), SHIELD = id("shield"), SWORD = id("longsword"), GREAT = id("greatsword");
const BLESS = id("bless"), CURE = id("cureWounds"), COMMAND = id("command"), GRANTED = id("grantedSpell");

function fixture() {
  const item = (_id, name, type, system) => ({ _id, name, type, system: { ...system }, flags: {} });
  const spell = (_id, name, prepared, level = 1) => item(_id, name, "spell", {
    identifier: name.toLowerCase(), level, sourceClass: "paladin", prepared,
    source: { rules: "2024" } });
  const actor = { _id: AID, name: "Live Test Paladin", type: "character", flags: {},
    system: { traits: { armorProf: { value: ["hvy", "shl"] }, weaponProf: { value: ["mar"] } },
      spells: { spell1: { value: 4 }, spell2: { value: 3 } }, attributes: { hp: { value: 68 } },
      abilities: { str: { value: 18 }, dex: { value: 12 }, con: { value: 14 },
        int: { value: 8 }, wis: { value: 10 }, cha: { value: 16 } } },
    items: [item(CID, "Paladin", "class", { identifier: "paladin", levels: 8,
      spellcasting: { progression: "half" }, source: { rules: "2024" },
      advancement: { scale: { type: "ScaleValue", configuration: { identifier: "max-prepared",
        scale: { 8: { value: 2 } } } } } }),
    item(ARMOR, "Chain Mail", "equipment", { type: { value: "heavy" }, armor: { value: 16 }, equipped: true }),
    item(SHIELD, "Shield", "equipment", { type: { value: "shield" }, equipped: true }),
    item(SWORD, "Longsword", "weapon", { type: { value: "martialM", baseItem: "longsword" },
      properties: [], equipped: true }),
    item(GREAT, "Greatsword", "weapon", { type: { value: "martialM", baseItem: "greatsword" },
      properties: ["two"], equipped: false }),
    spell(BLESS, "Bless", 1), spell(CURE, "Cure Wounds", 1), spell(COMMAND, "Command", 0),
    item(GRANTED, "Divine Smite", "spell", { level: 1, prepared: 2, source: { rules: "2024" } })] };
  const writes = [];
  const setPath = (root, key, val) => {
    const path = key.split("."); let cursor = root;
    for (const k of path.slice(0, -1)) cursor = cursor[k] ??= {};
    if (path.at(-1).startsWith("-=")) delete cursor[path.at(-1).slice(2)];
    else cursor[path.at(-1)] = structuredClone(val);
  };
  const fs = { userId: "editTestOwnerGM01", user: { role: 4, name: "GM" },
    world: { id: "test", title: "Test", system: "dnd5e", coreVersion: "14.370" },
    async worldData() { return { packs: [] }; },
    async doc(action, type, opts = {}) {
      if (action === "get") {
        if (type === "Setting") return [];
        if (type === "Actor") return !opts.query?._id || opts.query._id === AID ? [structuredClone(actor)] : [];
        if (type === "Item" && opts.parentUuid) return structuredClone(actor.items);
        return [];
      }
      writes.push({ action, type, opts: structuredClone(opts) });
      if (action === "update") {
        const rows = type === "Item" ? actor.items : [actor];
        for (const update of opts.updates) {
          const doc = rows.find(x => x._id === update._id);
          assert.ok(doc);
          for (const [key, value] of Object.entries(update)) if (key !== "_id") setPath(doc, key, value);
        }
        return [];
      }
      if (action === "delete" && type === "Item") {
        actor.items = actor.items.filter(i => !opts.ids.includes(i._id)); return [];
      }
      if (action === "create" && type === "Item") {
        actor.items.push(...structuredClone(opts.data)); return [];
      }
      throw new Error(`Unexpected ${action} ${type}`);
    }
  };
  return { actor, fs, writes };
}

const call = async (fs, name, args) => {
  const r = await handleTool(fs, { name, arguments: args });
  assert.equal(r.isError, undefined, r.content?.[0]?.text);
  return JSON.parse(r.content[0].text);
};
const request = () => ({ actor: AID,
  equipment: { [SHIELD]: false, [SWORD]: false, [GREAT]: true },
  prepared_spells: { [BLESS]: false, [COMMAND]: true } });

test("equipment/spell changes preview without writing and rollback restores the exact item state", async () => {
  const f = fixture(), initial = captureActorState(f.actor);
  const preview = await call(f.fs, "edit_actor", request());
  assert.equal(preview.simulation, true);
  assert.equal(preview.preparation.utilises, 2);
  assert.equal(preview.changements.equipement.length, 3);
  assert.equal(preview.changements.sorts_prepares.length, 2);
  assert.deepEqual(f.writes, []);
  const applied = await call(f.fs, "edit_actor", { ...request(), apply: true });
  assert.equal(applied.objets_modifies, 5);
  assert.equal(f.actor.items.find(i => i._id === GREAT).system.equipped, true);
  assert.equal(f.actor.items.find(i => i._id === SHIELD).system.equipped, false);
  assert.equal(f.actor.items.find(i => i._id === COMMAND).system.prepared, 1);
  const dry = await call(f.fs, "snapshots", { action: "restore", id: applied.instantane, dry_run: true });
  assert.equal(dry.simulation, true);
  await call(f.fs, "snapshots", { action: "restore", id: applied.instantane });
  assert.deepEqual(captureActorState(f.actor), initial);
});

test("two-handed weapon with shield is refused; multiple or untrained weapons warn instead", async () => {
  const f = fixture();
  const invalid = await handleTool(f.fs, { name: "edit_actor", arguments: {
    actor: AID, equipment: { [SWORD]: false, [GREAT]: true }
  } });
  assert.equal(invalid.isError, true);
  const multi = await call(f.fs, "edit_actor", { actor: AID,
    equipment: { [SHIELD]: false, [GREAT]: true } });
  assert.match(multi.avertissements.join(" "), /Multiple weapons/);
  f.actor.system.traits.armorProf.value = ["hvy"];
  f.actor.system.traits.weaponProf.value = [];
  const untrained = await call(f.fs, "edit_actor", { actor: AID,
    equipment: { [GREAT]: false }
  });
  assert.match(untrained.avertissements.join(" "), /shield without training/);
  assert.match(untrained.avertissements.join(" "), /without weapon proficiency/);
  f.actor.system.traits.armorProf.value = [];
  const noArmorTraining = await call(f.fs, "edit_actor", { actor: AID, equipment: { [GREAT]: false } });
  assert.match(noArmorTraining.avertissements.join(" "), /armor without training/);
  assert.deepEqual(f.writes, []);
});

test("prepared spells cannot exceed class scale, use old rules or change always-granted spells", async () => {
  const f = fixture();
  const reject = async prepared_spells => {
    const r = await handleTool(f.fs, { name: "edit_actor", arguments: { actor: AID, prepared_spells } });
    assert.equal(r.isError, true);
  };
  await reject({ [COMMAND]: true }); // two already prepared
  await reject({ [GRANTED]: false }); // granted by class feature
  f.actor.items.find(i => i._id === COMMAND).system.source.rules = "2014";
  await reject({ [BLESS]: false, [COMMAND]: true });
  assert.deepEqual(f.writes, []);
});

test("no-op edits and invalid inventory IDs cause no snapshots or writes", async () => {
  const f = fixture();
  const noOp = await call(f.fs, "edit_actor", { actor: AID, equipment: { [SWORD]: true }, apply: true });
  assert.equal(noOp.modifications.length, 0);
  assert.equal(noOp.instantane, undefined);
  const invalid = await handleTool(f.fs, { name: "edit_actor", arguments: {
    actor: AID, equipment: { NotOwnedAtAll000: true }
  } });
  assert.equal(invalid.isError, true);
  assert.deepEqual(f.writes, []);
});

test("a later edit blocks restoring a past equipment/spell snapshot", async () => {
  const f = fixture();
  const applied = await call(f.fs, "edit_actor", { ...request(), apply: true });
  f.actor.system.attributes.hp.value -= 1;
  const result = await handleTool(f.fs, { name: "snapshots", arguments: {
    action: "restore", id: applied.instantane
  } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /changed since this progression/);
  assert.equal(f.actor.items.find(i => i._id === GREAT).system.equipped, true);
});

after(async () => { await rm(process.env.SNAPSHOT_DIR, { recursive: true, force: true }); });
