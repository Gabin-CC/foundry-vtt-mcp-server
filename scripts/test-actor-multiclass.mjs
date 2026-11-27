import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { planMulticlass } from "../src/actor-multiclass.mjs";
import { planMulticlassSpells } from "../src/actor-multiclass-spells.mjs";
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
  let failItemCreate = false;
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
        if (failItemCreate && opts.data.some(i => i.type === "spell")) {
          failItemCreate = false;
          throw new Error("Simulated spell import failure");
        }
        const added = opts.data.map((d, index) => ({ ...structuredClone(d), _id: opts.keepId ? d._id : `newMulticlass${writes.length}_${index}` }));
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
  return { fs, actor, writes, failUpdate() { failUpdate = true; },
    failItemCreate() { failItemCreate = true; } };
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

test("blank spell slot overrides defer to automatic class and Pact Magic tables", () => {
  const paladin = classDoc(PALADIN, "paladin", 8);
  paladin.system.spellcasting.progression = "half";
  const actor = { items: [paladin], system: { spells: {
    spell1: { override: "" }, spell2: { override: "" }
  } } };
  assert.deepEqual(slotMax(actor), { spell1: 4, spell2: 3 });

  actor.system.spells.spell1.override = 0;
  assert.equal(slotMax(actor).spell1, undefined, "Numeric zero is an intentional override");
  actor.system.spells.spell1.override = 5;
  assert.equal(slotMax(actor).spell1, 5, "Explicit numeric overrides still take priority");

  const warlock = classDoc("warlockClass2024", "warlock", 3);
  warlock.system.spellcasting.progression = "pact";
  actor.items = [warlock];
  actor.system.spells = { pact: { override: "" } };
  assert.deepEqual(slotMax(actor), { pact: 2, pactLevel: 2 });
  actor.system.spells.pact.override = 1;
  assert.deepEqual(slotMax(actor), { pact: 1, pactLevel: 2 });
  actor.system.spells.pact.override = 0;
  assert.deepEqual(slotMax(actor), { pact: 0, pactLevel: 2 }, "Numeric Pact Magic zero stays explicit");
});

test("Pact Magic does not turn the only Spellcasting class into a multiclass spellcaster", () => {
  const fighter = classDoc(FIGHTER, "fighter", 4);
  const knight = { type: "subclass", system: { classIdentifier: "fighter",
    spellcasting: { progression: "third" } } };
  const warlock = classDoc("warlockClass2024", "warlock", 3);
  warlock.system.spellcasting.progression = "pact";
  const actor = { items: [fighter, knight, warlock], system: { spells: {} } };
  assert.deepEqual(slotMax(actor), { spell1: 3, pact: 2, pactLevel: 2 },
    "An Eldritch Knight 4 keeps its single-class 3 spell slots alongside Pact Magic");

  const paladin = classDoc(PALADIN, "paladin", 3);
  paladin.system.spellcasting.progression = "half";
  paladin.system.source.rules = "2014";
  actor.items = [paladin, warlock];
  assert.deepEqual(slotMax(actor), { spell1: 3, pact: 2, pactLevel: 2 },
    "A 2014 Paladin 3 still follows its single-class slot table with a Warlock");

  const wizard = classDoc(WIZARD, "wizard", 3);
  wizard.system.spellcasting.progression = "full";
  actor.items = [fighter, knight, warlock, wizard];
  assert.deepEqual(slotMax(actor), { spell1: 4, spell2: 3, pact: 2, pactLevel: 2 },
    "Two actual Spellcasting classes use the shared multiclass table; Pact Magic stays separate");
});

// Exact official spell-list fixtures. Each candidate is identifiable only by
// a 2024 compendium UUID, never by a model-generated spell name.
const spellId = name => (name + "0000000000000000").slice(0, 16);
const spellUuid = name => `Compendium.dnd5e.spells24.Item.${spellId(name)}`;
const casters = Object.fromEntries([
  ["sorcerer", "full", 2, 2], ["wizard", "full", 2, 4],
  ["warlock", "pact", 2, 2], ["ranger", "half", 0, 2]
].map(([id, progression, cantrips, prepared]) => [id, {
  ...classDoc(spellId(id), id, 0),
  system: { ...classDoc(spellId(id), id, 0).system,
    spellcasting: { progression }, advancement: [
      { _id: spellId(`${id}cantrip`), type: "ScaleValue", configuration: {
        identifier: "cantrips-known", scale: { 1: { value: cantrips }, 2: { value: cantrips } } } },
      { _id: spellId(`${id}prepared`), type: "ScaleValue", configuration: {
        identifier: "max-prepared", scale: { 1: { value: prepared }, 2: { value: prepared + 1 } } } }
    ] }
}]));

const spellSpecs = [
  ["light", "Light", 0, ["sorcerer", "wizard"]],
  ["ray", "Ray of Frost", 0, ["wizard"]],
  ["spark", "Sorcerous Spark", 0, ["sorcerer"]],
  ["shield", "Shield", 1, ["sorcerer", "wizard"]],
  ["missile", "Magic Missile", 1, ["sorcerer", "wizard"]],
  ["burning", "Burning Hands", 1, ["wizard"]],
  ["sleep", "Sleep", 1, ["wizard"]],
  ["detect", "Detect Magic", 1, ["wizard"]],
  ["feather", "Feather Fall", 1, ["wizard"]],
  ["armor", "Mage Armor", 1, ["wizard"]],
  ["grease", "Grease", 1, ["wizard"]],
  ["blast", "Eldritch Blast", 0, ["warlock"]],
  ["magehand", "Mage Hand", 0, ["warlock", "wizard"]],
  ["hex", "Hex", 1, ["warlock"]],
  ["agathys", "Armor of Agathys", 1, ["warlock"]],
  ["cure", "Cure Wounds", 1, ["ranger"]],
  ["hunter", "Hunter's Mark", 1, ["ranger"]],
  ["fireball", "Fireball", 3, ["sorcerer", "wizard"]]
];

function casterFixture() {
  const f = fixture();
  f.actor.system.abilities.int.value = 14;
  f.actor.system.abilities.dex.value = 14;
  f.actor.system.abilities.wis.value = 14;
  f.actor.items[0].system.spellcasting.progression = "half";
  const spells = spellSpecs.map(([key, name, level]) => ({
    _id: spellId(key), name, type: "spell", flags: {},
    system: { identifier: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), level,
      prepared: 0, method: "spell", source: { rules: "2024" } }
  }));
  const oldDoc = f.fs.doc.bind(f.fs);
  f.fs.worldData = async () => ({ packs: [
    { id: "dnd5e.classes24", type: "Item", packageName: "dnd5e" },
    { id: "dnd5e.spells24", type: "Item", packageName: "dnd5e" },
    { id: "dnd5e.content24", type: "JournalEntry", packageName: "dnd5e" }
  ] });
  f.fs.doc = async (action, type, opts = {}) => {
    if (action === "get" && type === "JournalEntry" && opts.pack === "dnd5e.content24")
      return [{ pages: Object.keys(casters).map(id => ({ type: "spells", system: {
        type: "class", identifier: id, spells: spellSpecs.filter(([, , , ids]) => ids.includes(id))
          .map(([key]) => spellUuid(key)) } })) }];
    if (action === "get" && type === "Item" && opts.pack === "dnd5e.spells24")
      return structuredClone(spells.filter(s => !opts.query?._id || opts.query._id === s._id));
    if (action === "get" && type === "Item" && opts.pack === "dnd5e.classes24" && !opts.index)
      return structuredClone([...(Object.values(casters)), classDoc(FIGHTER, "fighter", 0)]
        .filter(c => !opts.query?._id || opts.query._id === c._id));
    return oldDoc(action, type, opts);
  };
  return { ...f, sources: Object.fromEntries(spellSpecs.map(([key]) => [key, spellUuid(key)])) };
}

test("multiclass selected Sorcerer spells are class-level-bounded, exact, and preview-only", async () => {
  const f = casterFixture();
  const src = `Compendium.dnd5e.classes24.Item.${casters.sorcerer._id}`;
  const preview = await call(f.fs, "multiclass_actor", { actor: ACTOR, class_source: src, spells: "selected" });
  assert.equal(preview.pret, false);
  assert.deepEqual(preview.choix_requis.filter(x => x.id.startsWith("spells:")).map(x => [x.id, x.nombre]),
    [["spells:cantrips", 2], ["spells:prepared", 2]]);
  assert.ok(!preview.choix_requis.some(x => x.options?.some(v => v.includes(f.sources.fireball))));
  assert.equal(preview.sorts.niveau_max_classe, 1, "Paladin's combined slots must not unlock Fireball");
  assert.equal(preview.emplacements_apres.spell3, 2, "combined slots can exceed new class spell level");
  assert.deepEqual(f.writes, []);
  const choices = { "spells:cantrips": [f.sources.light, f.sources.spark],
    "spells:prepared": [f.sources.shield, f.sources.missile] };
  await rejected(f.fs, { actor: ACTOR, class_source: src, spells: "selected", choices: {
    ...choices, "spells:prepared": [f.sources.shield, f.sources.fireball]
  } }, /not a verified, eligible/);
  await rejected(f.fs, { actor: ACTOR, class_source: src, spells: "selected", choices: {
    ...choices, "spells:prepared": [f.sources.shield, f.sources.shield]
  } }, /distinct/);
  assert.deepEqual(f.writes, []);
  const applied = await call(f.fs, "multiclass_actor", { actor: ACTOR, class_source: src,
    spells: "selected", choices, apply: true });
  assert.equal(applied.simulation, false, JSON.stringify(applied));
  const owned = f.actor.items.filter(i => i.type === "spell" && i.system?.sourceClass === "sorcerer");
  assert.deepEqual(owned.map(i => i.name).sort(), ["Light", "Magic Missile", "Shield", "Sorcerous Spark"].sort());
  assert.ok(owned.filter(i => Number(i.system?.level) === 1).every(i => i.system.prepared === 1));
  await call(f.fs, "snapshots", { action: "restore", id: applied.instantane });
  assert.equal(f.actor.items.filter(i => i.type === "spell").length, 0);
});

test("Warlock Pact Magic is independent of shared Spellcasting slots", async () => {
  const f = casterFixture();
  const src = `Compendium.dnd5e.classes24.Item.${casters.warlock._id}`;
  const preview = await call(f.fs, "multiclass_actor", { actor: ACTOR, class_source: src, spells: "selected" });
  assert.equal(preview.sorts.niveau_max_classe, 1);
  assert.equal(preview.emplacements_apres.pact, 1);
  assert.equal(preview.emplacements_apres.pactLevel, 1);
  const choices = { "spells:cantrips": [f.sources.blast, f.sources.magehand],
    "spells:prepared": [f.sources.hex, f.sources.agathys] };
  const applied = await call(f.fs, "multiclass_actor", { actor: ACTOR, class_source: src,
    spells: "selected", choices, apply: true });
  assert.equal(applied.pret, true, JSON.stringify(applied));
  assert.equal(f.actor.items.filter(i => i.type === "spell" && i.system.sourceClass === "warlock").length, 4);
});

test("Wizard spellbook requires six class-level-eligible entries and independent prepared choices", async () => {
  const f = casterFixture();
  const src = `Compendium.dnd5e.classes24.Item.${casters.wizard._id}`;
  const preview = await call(f.fs, "multiclass_actor", { actor: ACTOR, class_source: src, spells: "selected" });
  assert.deepEqual(preview.choix_requis.filter(x => x.id.startsWith("spells:")).map(x => [x.id, x.nombre]),
    [["spells:cantrips", 2], ["spells:spellbook", 6], ["spells:prepared", 4]]);
  const book = ["shield", "missile", "burning", "sleep", "detect", "feather"].map(k => f.sources[k]);
  const choices = { "spells:cantrips": [f.sources.light, f.sources.magehand],
    "spells:spellbook": book, "spells:prepared": book.slice(0, 4) };
  const applied = await call(f.fs, "multiclass_actor", { actor: ACTOR, class_source: src,
    spells: "selected", choices, apply: true });
  assert.equal(applied.pret, true, JSON.stringify(applied));
  const wizardSpells = f.actor.items.filter(i => i.type === "spell" && i.system?.sourceClass === "wizard");
  assert.equal(wizardSpells.filter(i => Number(i.system?.level) === 1).length, 6,
    JSON.stringify(wizardSpells.map(i => [i.name, i.system?.level])));
  assert.equal(wizardSpells.filter(i => Number(i.system?.level) === 1 && i.system.prepared === 1).length, 4);
  assert.ok(wizardSpells.every(i => i.system.sourceClass === "wizard"));

  const classItem = f.actor.items.find(i => i.type === "class" && i.system.identifier === "wizard");
  const next = await call(f.fs, "multiclass_actor", { actor: ACTOR, item: classItem._id, spells: "selected" });
  assert.deepEqual(next.choix_requis.filter(x => x.id.startsWith("spells:")).map(x => [x.id, x.nombre]),
    [["spells:spellbook", 2], ["spells:prepared", 1]]);
  const again = await call(f.fs, "multiclass_actor", { actor: ACTOR, item: classItem._id,
    spells: "selected", choices: { "spells:spellbook": [f.sources.armor, f.sources.grease],
      "spells:prepared": [f.sources.grease] }, apply: true });
  assert.equal(again.pret, true, JSON.stringify(again));
  assert.equal(f.actor.items.filter(i => i.type === "spell" && i.system.sourceClass === "wizard" && i.system.level === 1).length, 8);
  assert.equal(f.actor.items.filter(i => i.type === "spell" && i.system.sourceClass === "wizard" && i.system.prepared === 1).length, 5);
});

test("same official spell can belong independently to two multiclass spell lists", async () => {
  const f = casterFixture();
  f.actor.items.push({ ...structuredClone(casters.sorcerer), _id: "sorcererEmbedded", system: {
    ...structuredClone(casters.sorcerer.system), levels: 1 } });
  f.actor.items.push({ _id: "sorcererShield1A", name: "Shield", type: "spell", flags: {},
    system: { identifier: "shield", sourceClass: "sorcerer", level: 1,
      prepared: 1, source: { rules: "2024" } }, _stats: { compendiumSource: f.sources.shield } });
  const src = `Compendium.dnd5e.classes24.Item.${casters.wizard._id}`;
  const book = ["shield", "missile", "burning", "sleep", "detect", "feather"].map(k => f.sources[k]);
  const result = await call(f.fs, "multiclass_actor", { actor: ACTOR, class_source: src,
    spells: "selected", choices: { "spells:cantrips": [f.sources.light, f.sources.magehand],
      "spells:spellbook": book, "spells:prepared": book.slice(0, 4) }, apply: true });
  assert.equal(result.pret, true, JSON.stringify(result));
  assert.equal(f.actor.items.filter(i => i.type === "spell" && i.name === "Shield").length, 2);
  assert.equal(f.actor.items.find(i => i._id === "sorcererShield1A").system.sourceClass, "sorcerer");
});

test("failed import preserves a recoverable partial advancement snapshot", async () => {
  const f = casterFixture();
  const before = captureActorState(f.actor);
  const src = `Compendium.dnd5e.classes24.Item.${casters.sorcerer._id}`;
  f.failItemCreate();
  const result = await call(f.fs, "multiclass_actor", { actor: ACTOR, class_source: src,
    spells: "selected", choices: { "spells:cantrips": [f.sources.light, f.sources.spark],
      "spells:prepared": [f.sources.shield, f.sources.missile] }, apply: true });
  assert.match(result.erreur, /Simulated spell import failure/);
  assert.equal(result.restauration_disponible, true);
  await call(f.fs, "snapshots", { action: "restore", id: result.instantane });
  assert.deepEqual(captureActorState(f.actor), before);
});

test("multiclass spell selection rejects unsupported third-caster and 2014 spellbook choices", async () => {
  const f = casterFixture();
  const src = `Compendium.dnd5e.classes24.Item.${casters.sorcerer._id}`;
  await rejected(f.fs, { actor: ACTOR, class_source: src, choices: { "spells:prepared": [] } }, /spells=selected/);
  await rejected(f.fs, { actor: ACTOR, class_source: FIGHTER_SOURCE, spells: "selected" }, /supported 2024 Spellcasting/);
  await rejected(f.fs, { actor: ACTOR, class_source: src, spells: "selected",
    choices: { "spells:spellbook": [f.sources.shield] } }, /Wizard/);
  assert.deepEqual(f.writes, []);
});

test("official 2024 third-caster can add and explicitly replace its own spells with preview and rollback", async () => {
  const f = casterFixture();
  const subId = spellId("eldritchKnight");
  const subUuid = `Compendium.dnd5e.classes24.Item.${subId}`;
  const third = { _id: subId, name: "Eldritch Knight", type: "subclass", system: {
    identifier: "eldritch-knight", classIdentifier: "fighter", source: { rules: "2024" },
    spellcasting: { progression: "third" }, advancement: [
      { type: "ScaleValue", configuration: { identifier: "cantrips-known", scale: { 3: { value: 2 } } } },
      { type: "ScaleValue", configuration: { identifier: "max-prepared", scale: { 3: { value: 3 }, 4: { value: 4 } } } }
    ] } };
  const orig = f.fs.doc.bind(f.fs);
  f.fs.doc = async (action, type, opts = {}) =>
    action === "get" && type === "Item" && opts.pack === "dnd5e.classes24" && opts.query?._id === subId
      ? [structuredClone(third)] : orig(action, type, opts);
  const fighter = classDoc(FIGHTER, "fighter", 3);
  fighter.system.spellcasting.progression = "none";
  f.actor.items.push(fighter, { _id: spellId("ownedEK"), name: "Eldritch Knight", type: "subclass",
    _stats: { compendiumSource: subUuid }, system: {
      identifier: "eldritch-knight", classIdentifier: "fighter", source: { rules: "2024" },
      spellcasting: { progression: "third" } } });
  const item = (key, prepared) => ({ _id: spellId(`ek${key}`), name: spellSpecs.find(x => x[0] === key)[1],
    type: "spell", _stats: { compendiumSource: f.sources[key] }, system: {
      identifier: key, level: spellSpecs.find(x => x[0] === key)[2], sourceClass: "fighter", prepared,
      source: { rules: "2024" } } });
  f.actor.items.push(item("light", 0), item("magehand", 0), item("shield", 1), item("missile", 1), item("burning", 1));
  const before = captureActorState(f.actor);
  const replacement = [{ kind: "cantrip", from: spellId("eklight"), to: f.sources.ray },
    { kind: "prepared", from: spellId("ekshield"), to: f.sources.armor }];
  const choices = { "spells:prepared": [f.sources.grease], "spells:replace": replacement };
  const preview = await call(f.fs, "multiclass_actor", { actor: ACTOR, item: FIGHTER, spells: "selected", choices });
  assert.equal(preview.pret, true, JSON.stringify(preview));
  assert.equal(preview.sorts.niveau_max_classe, 1);
  assert.deepEqual(f.writes, []);
  await rejected(f.fs, { actor: ACTOR, item: FIGHTER, spells: "selected", choices: {
    ...choices, "spells:replace": [{ kind: "prepared", from: spellId("ekshield"), to: f.sources.fireball }]
  } }, /distinct, eligible/);
  await rejected(f.fs, { actor: ACTOR, item: FIGHTER, spells: "selected", choices: {
    ...choices, "spells:replace": [...replacement, replacement[0]]
  } }, /at most one/);
  const applied = await call(f.fs, "multiclass_actor", {
    actor: ACTOR, item: FIGHTER, spells: "selected", choices, apply: true });
  assert.equal(applied.pret, true, JSON.stringify(applied));
  const owned = f.actor.items.filter(i => i.type === "spell" && i.system?.sourceClass === "fighter");
  assert.ok(owned.some(i => i._stats?.compendiumSource === f.sources.ray && i.system.prepared === 0));
  assert.ok(owned.some(i => i._stats?.compendiumSource === f.sources.armor && i.system.prepared === 1));
  assert.ok(owned.some(i => i._stats?.compendiumSource === f.sources.grease && i.system.prepared === 1));
  assert.ok(!owned.some(i => [spellId("ekshield"), spellId("eklight")].includes(i._id)));
  await call(f.fs, "snapshots", { action: "restore", id: applied.instantane });
  assert.deepEqual(captureActorState(f.actor), before);
  const healthyDoc = f.fs.doc.bind(f.fs);
  let failDeleteOnce = true;
  f.fs.doc = async (action, type, opts = {}) => {
    if (failDeleteOnce && action === "delete" && type === "Item") {
      failDeleteOnce = false;
      throw new Error("Simulated replacement deletion failure");
    }
    return healthyDoc(action, type, opts);
  };
  const partial = await call(f.fs, "multiclass_actor", {
    actor: ACTOR, item: FIGHTER, spells: "selected", choices, apply: true });
  assert.match(partial.erreur, /Simulated replacement deletion failure/);
  assert.equal(partial.restauration_disponible, true);
  await call(f.fs, "snapshots", { action: "restore", id: partial.instantane });
  assert.deepEqual(captureActorState(f.actor), before);
});

after(async () => { await rm(process.env.SNAPSHOT_DIR, { recursive: true, force: true }); });
