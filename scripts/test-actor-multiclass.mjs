import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { planMulticlass } from "../src/actor-multiclass.mjs";
import { slotMax } from "../src/dnd5e.mjs";

process.env.NO_LISTEN = "1";
process.env.SNAPSHOT_DIR = await mkdtemp(path.join(os.tmpdir(), "foundry-multiclass-tests-"));
const { handleTool } = await import("../src/server.mjs");
const { captureActorState } = await import("../src/actor-progress.mjs");

const ACTOR = "multiclassActor1";
const PALADIN = "paladinClass2024";
const FIGHTER = "fighterClass2024";
const WIZARD = "wizardClass2024Z";
const FIGHTER_SOURCE = `Compendium.dnd5e.classes24.Item.${FIGHTER}`;
const WIZARD_SOURCE = `Compendium.dnd5e.classes24.Item.${WIZARD}`;
const classDoc = (id, identifier, levels, advancement = {}) => ({
  _id: id, name: identifier[0].toUpperCase() + identifier.slice(1), type: "class", flags: {},
  system: { identifier, levels, hitDice: identifier === "wizard" ? "d6" : "d10",
    source: { rules: "2024" }, spellcasting: { progression: "none" }, advancement }
});

function fixture() {
  const fighter = classDoc(FIGHTER, "fighter", 0, {
    firstHitPoints1: { _id: "firstHitPoints1", type: "HitPoints", level: 1 },
    primarySkills1: { _id: "primarySkills1", type: "Trait", level: 1, classRestriction: "primary",
      configuration: { grants: ["saves:str"], choices: [] } },
    secondarySkills1: { _id: "secondarySkills1", type: "Trait", level: 1, classRestriction: "secondary",
      configuration: { grants: ["skills:ath"], choices: [] } }
  });
  const wizard = classDoc(WIZARD, "wizard", 0);
  const actor = { _id: ACTOR, name: "Paladin 8", type: "character", flags: {},
    system: { abilities: { str: { value: 16 }, dex: { value: 12 }, con: { value: 14 },
      int: { value: 10 }, wis: { value: 10 }, cha: { value: 15 } },
    attributes: { hp: { value: 76 } }, traits: {}, skills: {}, tools: {}, spells: {},
    details: { originalClass: PALADIN } },
    items: [classDoc(PALADIN, "paladin", 8)] };
  let failUpdate = false;
  const writes = [];
  const setPath = (target, key, value) => {
    const path = key.split(".");
    let cur = target;
    for (const segment of path.slice(0, -1)) cur = cur[segment] ??= {};
    if (path.at(-1).startsWith("-=")) delete cur[path.at(-1).slice(2)];
    else cur[path.at(-1)] = structuredClone(value);
  };
  const fs = { userId: "foundryGMMultic1", user: { role: 4, name: "GM" },
    world: { id: "test", title: "Test", system: "dnd5e", coreVersion: "14.370" },
    async worldData() { return { packs: [{ id: "dnd5e.classes24", type: "Item", packageName: "dnd5e" }] }; },
    async doc(action, type, opts = {}) {
      if (action === "get") {
        if (type === "Setting") return [];
        if (type === "Actor") return !opts.query?._id || opts.query._id === ACTOR ? [structuredClone(actor)] : [];
        if (type === "Item" && opts.pack) {
          const data = [fighter, wizard];
          return structuredClone(data.filter(i => !opts.query?._id || opts.query._id === i._id));
        }
        if (type === "Item" && opts.parentUuid) return structuredClone(actor.items.filter(i =>
          !opts.query?.type || opts.query.type === i.type));
        return [];
      }
      writes.push({ action, type, opts: structuredClone(opts) });
      if (action === "create" && type === "Item") {
        const added = opts.data.map((d, index) => ({ ...structuredClone(d), _id: opts.keepId ? d._id : `newMulticlassI${index}` }));
        actor.items.push(...added);
        return structuredClone(added);
      }
      if (action === "update") {
        if (failUpdate && type === "Actor") { failUpdate = false; throw new Error("Simulated multiclass write failure"); }
        for (const update of opts.updates) {
          const target = type === "Actor" ? actor : actor.items.find(i => i._id === update._id);
          if (!target) throw new Error(`Unknown update target ${update._id}`);
          for (const [key, val] of Object.entries(update)) if (key !== "_id") setPath(target, key, val);
        }
        return [];
      }
      if (action === "delete" && type === "Item") {
        actor.items = actor.items.filter(i => !opts.ids.includes(i._id));
        return [];
      }
      throw new Error(`Unexpected ${action} ${type}`);
    }
  };
  return { fs, actor, writes, failUpdate() { failUpdate = true; } };
}

const call = async (fs, name, args) => {
  const r = await handleTool(fs, { name, arguments: args });
  assert.equal(r.isError, undefined, r.content?.[0]?.text);
  return JSON.parse(r.content[0].text);
};
const rejected = async (fs, args, pattern) => {
  const r = await handleTool(fs, { name: "multiclass_actor", arguments: args });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, pattern);
};

test("2024 prerequisites include every existing class and the new class", () => {
  const f = fixture();
  const fighter = classDoc(FIGHTER, "fighter", 0);
  const plan = planMulticlass(f.actor, { incoming: fighter });
  assert.equal(plan.totalBefore, 8);
  assert.equal(plan.totalAfter, 9);
  assert.equal(plan.requirements.filter(r => r.satisfait).length, 3);
  f.actor.system.abilities.cha.value = 12;
  assert.throws(() => planMulticlass(f.actor, { incoming: fighter }), /paladin \(cha >= 13\)/);
  f.actor.system.abilities.cha.value = 15;
  f.actor.system.abilities.str.value = 12;
  assert.throws(() => planMulticlass(f.actor, { incoming: fighter }), /paladin \(str >= 13\)/);
  f.actor.system.abilities.dex.value = 13;
  assert.throws(() => planMulticlass(f.actor, { incoming: fighter }), /paladin \(str >= 13\)/);
  f.actor.items[0] = classDoc(PALADIN, "rogue", 8);
  assert.equal(planMulticlass(f.actor, { incoming: fighter }).requirements.at(-1).satisfait, true);
});

test("preflight refuses invalid edition, class, score, source, and level without writes", async () => {
  const f = fixture();
  await rejected(f.fs, { actor: ACTOR, class_source: WIZARD_SOURCE }, /wizard \(int >= 13\)/);
  await rejected(f.fs, { actor: ACTOR, class_source: FIGHTER_SOURCE, level: 2 }, /one class level at a time/);
  await rejected(f.fs, { actor: ACTOR, class_source: FIGHTER_SOURCE, item: PALADIN }, /exactly one/);
  await rejected(f.fs, { actor: ACTOR, item: PALADIN }, /Use progress_actor/);
  await rejected(f.fs, { actor: ACTOR, class_source: "Item.fighterClass2024" }, /exact Item UUID/);
  f.actor.items[0].system.source.rules = "2014";
  await rejected(f.fs, { actor: ACTOR, class_source: FIGHTER_SOURCE }, /D&D 2024/);
  assert.deepEqual(f.writes, []);
});

test("secondary class preview has no writes; apply grants only secondary proficiency, no gear; rollback", async () => {
  const f = fixture();
  const before = captureActorState(f.actor);
  const args = { actor: ACTOR, class_source: FIGHTER_SOURCE };
  const preview = await call(f.fs, "multiclass_actor", args);
  assert.equal(preview.simulation, true);
  assert.equal(preview.pret, true, JSON.stringify(preview));
  assert.equal(preview.niveau_total_apres, 9);
  assert.ok(preview.etapes.some(step => step.type === "trait"));
  assert.deepEqual(f.writes, []);
  const applied = await call(f.fs, "multiclass_actor", { ...args, apply: true });
  assert.equal(applied.simulation, false, JSON.stringify(applied));
  assert.ok(applied.instantane);
  assert.equal(f.actor.items.filter(i => i.type === "class").length, 2);
  assert.equal(f.actor.items.find(i => i.type === "class" && i.system.identifier === "fighter").system.levels, 1);
  assert.equal(f.actor.system.skills.ath.value, 1);
  assert.equal(f.actor.system.abilities.str.proficient, undefined, "primary Fighter save proficiency not granted");
  assert.equal(f.actor.items.filter(i => i.type === "equipment").length, 0);
  assert.equal(f.actor.system.details.originalClass, PALADIN);
  const dry = await call(f.fs, "snapshots", { action: "restore", id: applied.instantane, dry_run: true });
  assert.equal(dry.simulation, true);
  await call(f.fs, "snapshots", { action: "restore", id: applied.instantane });
  assert.deepEqual(captureActorState(f.actor), before);
});

test("existing secondary class can be advanced once, with an exact class item ID", async () => {
  const f = fixture();
  f.actor.items.push(classDoc(FIGHTER, "fighter", 1));
  const preview = await call(f.fs, "multiclass_actor", { actor: ACTOR, item: FIGHTER });
  assert.equal(preview.pret, true);
  assert.equal(preview.niveau_classe_apres, 2);
  const applied = await call(f.fs, "multiclass_actor", { actor: ACTOR, item: FIGHTER, apply: true });
  assert.equal(applied.niveau_total_apres, 10);
  assert.equal(f.actor.items.find(i => i._id === FIGHTER).system.levels, 2);
  await rejected(f.fs, { actor: ACTOR, item: FIGHTER, level: 5 }, /one class level at a time/);
});

test("species and background level milestones use total character level, not the new class level", async () => {
  const f = fixture();
  f.actor.items.push({ _id: "testSpecies2024A", name: "Test species", type: "race", flags: {},
    system: { advancement: {
      speciesAtNine24: { _id: "speciesAtNine24", type: "Trait", level: 9,
        configuration: { grants: ["skills:per"], choices: [] } },
      speciesAtTen2024: { _id: "speciesAtTen2024", type: "Trait", level: 10,
        configuration: { grants: ["skills:ins"], choices: [] } }
    } } });
  const newClass = await call(f.fs, "multiclass_actor", { actor: ACTOR, class_source: FIGHTER_SOURCE });
  assert.ok(newClass.etapes.some(s => s.niveau === 9 && s.type === "trait"));
  await call(f.fs, "multiclass_actor", { actor: ACTOR, class_source: FIGHTER_SOURCE, apply: true });
  assert.equal(f.actor.system.skills.per.value, 1);
  assert.equal(f.actor.system.skills.ins?.value, undefined);
  const fid = f.actor.items.find(i => i.type === "class" && i.system.identifier === "fighter")._id;
  const preview = await call(f.fs, "multiclass_actor", { actor: ACTOR, item: fid });
  assert.ok(preview.etapes.some(s => s.niveau === 10 && s.type === "trait"));
  await call(f.fs, "multiclass_actor", { actor: ACTOR, item: fid, apply: true });
  assert.equal(f.actor.system.skills.ins.value, 1);
});

test("partial multiclass write failure creates recoverable snapshot and guards later changes", async () => {
  const f = fixture();
  const original = captureActorState(f.actor);
  f.failUpdate();
  const partial = await call(f.fs, "multiclass_actor", { actor: ACTOR, class_source: FIGHTER_SOURCE, apply: true });
  assert.match(partial.erreur, /Simulated multiclass write failure/);
  assert.equal(partial.restauration_disponible, true);
  await call(f.fs, "snapshots", { action: "restore", id: partial.instantane });
  assert.deepEqual(captureActorState(f.actor), original);
  const applied = await call(f.fs, "multiclass_actor", { actor: ACTOR, class_source: FIGHTER_SOURCE, apply: true });
  f.actor.system.currency = { gp: 99 };
  const rejectedRestore = await handleTool(f.fs, { name: "snapshots", arguments: { action: "restore", id: applied.instantane } });
  assert.equal(rejectedRestore.isError, true);
  assert.match(rejectedRestore.content[0].text, /changed since this progression/);
});

test("PHB 2024 half-caster multiclass slots round up, while 2014 still rounds down", () => {
  const actor = { system: { spells: {} }, items: [
    { ...classDoc(PALADIN, "paladin", 3), system: { ...classDoc(PALADIN, "paladin", 3).system, spellcasting: { progression: "half" } } },
    { ...classDoc(WIZARD, "wizard", 2), system: { ...classDoc(WIZARD, "wizard", 2).system, spellcasting: { progression: "full" } } }
  ] };
  assert.equal(slotMax(actor).spell2, 3, "Paladin 3 + Wizard 2 = 4th-level multiclass caster");
  actor.items[0].system.source.rules = "2014";
  assert.equal(slotMax(actor).spell2, 2, "2014 rounds half-caster levels down in multiclassing");
});

after(async () => { await rm(process.env.SNAPSHOT_DIR, { recursive: true, force: true }); });
