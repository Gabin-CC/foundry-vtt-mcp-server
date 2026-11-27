import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NO_LISTEN = "1";
const { TOOLS, handleTool } = await import("../src/server.mjs");

const id = name => (name + "0000000000000000").slice(0, 16);
const spellUuid = name => `Compendium.dnd5e.spells24.Item.${id(name)}`;
const classUuid = name => `Compendium.dnd5e.classes24.Item.${id(name)}`;
const ACTOR = id("validateCharacter");
const classItem = (name, level) => ({ _id: id(`embedded${name}`), name, type: "class", flags: {},
  _stats: { compendiumSource: classUuid(name) },
  system: { identifier: name, levels: level, spellcasting: { progression: name === "paladin" ? "half" : "full" },
    source: { rules: "2024" }, advancement: [] } });
const officialClass = (name, cantrips, prepared) => ({ ...classItem(name, 0), _id: id(name),
  system: { ...classItem(name, 0).system, advancement: [
    { type: "ScaleValue", configuration: { identifier: "cantrips-known", scale: { 1: { value: cantrips }, 8: { value: cantrips } } } },
    { type: "ScaleValue", configuration: { identifier: "max-prepared", scale: { 1: { value: prepared }, 8: { value: prepared } } } }
  ] } });
const classes = [officialClass("paladin", 0, 6), officialClass("sorcerer", 4, 2), officialClass("wizard", 0, 4)];
const specs = [
  ["acid", "Acid Splash", 0], ["light", "Light", 0], ["magehand", "Mage Hand", 0], ["firebolt", "Fire Bolt", 0],
  ["shieldspell", "Shield", 1], ["missile", "Magic Missile", 1], ["burning", "Burning Hands", 1],
  ["fireball", "Fireball", 3], ["cure", "Cure Wounds", 1],
  ["feather", "Feather Fall", 1], ["magearmor", "Mage Armor", 1],
  ["sleep", "Sleep", 1], ["detect", "Detect Magic", 1], ["grease", "Grease", 1]
];
const compendiumSpells = specs.map(([key, name, level]) => ({ _id: id(key), name, type: "spell", flags: {},
  system: { identifier: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), level, source: { rules: "2024" }, prepared: 0 } }));
const makeSpell = (key, prepared, sourceClass = "sorcerer") => {
  const source = compendiumSpells.find(s => s._id === id(key));
  assert.ok(source, key);
  return { ...structuredClone(source), _id: id(`owned${key}`), system: { ...source.system, sourceClass, prepared },
    _stats: { compendiumSource: spellUuid(key) } };
};

function fixture() {
  const actor = { _id: ACTOR, name: "Validation fixture", type: "character", flags: {},
    system: { abilities: { str: { value: 18 }, dex: { value: 14 }, con: { value: 14 },
      int: { value: 10 }, wis: { value: 12 }, cha: { value: 16 } },
    spells: {}, traits: { armorProf: { value: ["hvy", "shl"] } } },
    items: [classItem("paladin", 8), classItem("sorcerer", 1),
      ...["acid", "light", "magehand", "firebolt"].map(k => makeSpell(k, 0)),
      makeSpell("shieldspell", 1), makeSpell("missile", 1),
      { _id: id("armor"), name: "Plate", type: "equipment",
        system: { type: { value: "heavy" }, equipped: true } },
      { _id: id("shieldgear"), name: "Shield", type: "equipment",
        system: { type: { value: "shield" }, equipped: true } }] };
  const writes = [];
  const fs = { user: { role: 4 }, userId: id("testGM"),
    async worldData() { return { packs: [
      { id: "dnd5e.classes24", type: "Item", packageName: "dnd5e" },
      { id: "dnd5e.spells24", type: "Item", packageName: "dnd5e" },
      { id: "dnd5e.content24", type: "JournalEntry", packageName: "dnd5e" }
    ] }; },
    async doc(action, type, opts = {}) {
      if (action !== "get") { writes.push({ action, type }); throw new Error("Audit attempted to write"); }
      if (type === "Setting") return [];
      if (type === "Actor") return !opts.query?._id || opts.query._id === ACTOR ? [structuredClone(actor)] : [];
      if (type === "JournalEntry") return [{ pages: [
        { type: "spells", system: { type: "class", identifier: "sorcerer",
          spells: specs.filter(([key]) => key !== "cure").map(([key]) => spellUuid(key)) } },
        { type: "spells", system: { type: "class", identifier: "paladin", spells: [spellUuid("cure")] } },
        { type: "spells", system: { type: "class", identifier: "wizard", spells:
          ["shieldspell", "missile", "burning", "feather", "magearmor", "sleep", "detect", "grease"].map(spellUuid) } }
      ] }];
      if (type === "Item" && opts.pack === "dnd5e.classes24")
        return structuredClone(classes.filter(c => !opts.query?._id || opts.query._id === c._id));
      if (type === "Item" && opts.pack === "dnd5e.spells24")
        return structuredClone(compendiumSpells.filter(c => !opts.query?._id || opts.query._id === c._id));
      return [];
    }
  };
  return { actor, fs, writes };
}

async function audit(fs) {
  const result = await handleTool(fs, { name: "validate_actor", arguments: { actor: ACTOR } });
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
}

test("validate_actor is registered, read-only and distinguishes scoped success from global certification", async () => {
  assert.ok(TOOLS.some(t => t.name === "validate_actor" && t.inputSchema.required.includes("actor")));
  const f = fixture();
  const report = await audit(f.fs);
  assert.equal(report.read_only, true);
  assert.equal(report.status, "passed_scoped_checks", JSON.stringify(report.diagnostics));
  assert.deepEqual(report.summary, { errors: 0, warnings: 0, unverified: 0 });
  assert.equal(report.actor.total_level, 9);
  assert.equal(report.expected_spell_slots.spell3, 2, "Paladin 8/Sorcerer 1 has shared 3rd-level slots");
  assert.deepEqual(report.verified_sources.classes.sort(), [classUuid("paladin"), classUuid("sorcerer")].sort());
  assert.equal(report.verified_sources.spells.length, 6);
  assert.match(report.limits.join(" "), /not full D&D 2024 legality/);
  assert.deepEqual(f.writes, []);
});

test("class-level spell ceiling rejects Fireball even though shared slots reach level 3", async () => {
  const f = fixture();
  f.actor.items.push(makeSpell("fireball", 0));
  const report = await audit(f.fs);
  assert.equal(report.status, "issues");
  assert.ok(report.diagnostics.some(d => d.code === "spell_above_class_level" && d.subject === id("ownedfireball")));
  assert.equal(report.expected_spell_slots.spell3, 2);
  assert.deepEqual(f.writes, []);
});

test("excess class prepared spells, cantrips and duplicate classes are proven errors", async () => {
  const f = fixture();
  f.actor.items.push(makeSpell("burning", 1));
  f.actor.items.push({ ...makeSpell("acid", 0), _id: id("extraCantrip") });
  f.actor.items.push({ ...classItem("paladin", 1), _id: id("duplicatedPala") });
  const report = await audit(f.fs);
  assert.equal(report.status, "issues");
  assert.ok(["too_many_prepared", "too_many_cantrips", "duplicate_class"].every(code => report.diagnostics.some(d => d.code === code)));
  assert.deepEqual(f.writes, []);
});

test("missing compendium provenance and historic ability prerequisites never become unsupported legality claims", async () => {
  const f = fixture();
  delete f.actor.items[1]._stats;
  f.actor.system.abilities.cha.value = 11;
  const report = await audit(f.fs);
  assert.equal(report.status, "incomplete");
  assert.ok(report.diagnostics.some(d => d.code === "class_source_missing" && d.severity === "unverified"));
  assert.ok(report.diagnostics.some(d => d.code === "multiclass_score_now_below_13" && d.severity === "warning"));
  assert.ok(!report.diagnostics.some(d => d.code === "class_source_mismatch"));
  assert.deepEqual(f.writes, []);
});

test("always-granted feature spells are not overcounted as selected prepared spells", async () => {
  const f = fixture();
  const granted = makeSpell("burning", 2);
  f.actor.items.push(granted);
  const report = await audit(f.fs);
  assert.equal(report.status, "passed_scoped_checks", JSON.stringify(report.diagnostics));
  assert.ok(!report.diagnostics.some(d => d.code === "too_many_prepared"));
  assert.deepEqual(f.writes, []);
});

test("equipment conflicts and unknown class spell lists are reported without mutations", async () => {
  const f = fixture();
  f.actor.system.traits.armorProf.value = [];
  f.actor.items.push({ _id: id("secondPlate"), type: "equipment", name: "Second plate",
    system: { type: { value: "heavy" }, equipped: true } });
  const report = await audit(f.fs);
  assert.equal(report.status, "issues");
  assert.ok(report.diagnostics.some(d => d.code === "multiple_armors" && d.severity === "error"));
  assert.ok(report.diagnostics.some(d => d.code === "armor_without_training" && d.severity === "warning"));
  assert.deepEqual(f.writes, []);
});

test("Wizard can have additional copied spellbook entries without a false six-plus-two cap", async () => {
  const f = fixture();
  f.actor.system.abilities.int.value = 14;
  f.actor.items.push(classItem("wizard", 1));
  const book = ["shieldspell", "missile", "burning", "feather", "magearmor", "sleep", "detect", "grease"];
  f.actor.items.push(...book.map((key, i) => ({ ...makeSpell(key, i < 4 ? 1 : 0, "wizard"),
    _id: id(`wizard${key}`) })));
  const report = await audit(f.fs);
  assert.equal(report.status, "incomplete");
  assert.ok(report.diagnostics.some(d => d.code === "wizard_spellbook_provenance" && d.severity === "unverified"));
  assert.ok(!report.diagnostics.some(d => d.code === "too_many_prepared" || d.code === "spell_above_class_level"));
  assert.deepEqual(f.writes, []);
});
