import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NO_LISTEN = "1";
const { TOOLS, handleTool } = await import("../src/server.mjs");

const id = name => (name + "0000000000000000").slice(0, 16);
const spellUuid = name => `Compendium.dnd5e.spells24.Item.${id(name)}`;
const classUuid = name => `Compendium.dnd5e.classes24.Item.${id(name)}`;
const originUuid = name => `Compendium.dnd5e.origins24.Item.${id(name)}`;
const featUuid = name => `Compendium.dnd5e.feats24.Item.${id(name)}`;
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
          ["light", "magehand", "shieldspell", "missile", "burning", "fireball", "feather", "magearmor", "sleep", "detect", "grease"].map(spellUuid) } }
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

function subclassFixture() {
  const f = fixture();
  const source = classUuid("subclassOath");
  const featureSource = classUuid("domainSpells");
  const thirdSource = classUuid("eldritchKnight");
  const oath = { _id: id("subclassOath"), type: "subclass", name: "Official Oath",
    system: { identifier: "test-oath", classIdentifier: "paladin", source: { rules: "2024" },
      advancement: [{ type: "ItemGrant", level: 3, configuration: { items: [{ uuid: featureSource }] } }] } };
  const feature = { _id: id("domainSpells"), type: "feat", name: "Oath Spells",
    system: { source: { rules: "2024" }, advancement: [
      { type: "ItemGrant", level: 3, configuration: { spell: { prepared: 2 }, items: [{ uuid: spellUuid("cure") }] } },
      { type: "ItemGrant", level: 5, configuration: { spell: { prepared: 2 }, items: [{ uuid: spellUuid("feather") }] } }
    ] } };
  const eldritch = { _id: id("eldritchKnight"), type: "subclass", name: "Eldritch Knight",
    system: { identifier: "eldritch-knight", classIdentifier: "fighter", source: { rules: "2024" },
      spellcasting: { progression: "third" }, advancement: [
        { type: "ScaleValue", configuration: { identifier: "max-prepared", scale: { 3: { value: 3 }, 4: { value: 4 } } } },
        { type: "ScaleValue", configuration: { identifier: "cantrips-known", scale: { 3: { value: 2 } } } }
      ] } };
  const fighter = { ...officialClass("fighter", 0, 0),
    system: { ...officialClass("fighter", 0, 0).system, spellcasting: { progression: "none" } } };
  const orig = f.fs.doc.bind(f.fs);
  f.fs.doc = async (action, type, opts = {}) => {
    if (action === "get" && type === "Item" && opts.pack === "dnd5e.classes24") {
      const extra = [oath, feature, eldritch, fighter].filter(i => !opts.query?._id || opts.query._id === i._id);
      return [...extra, ...(await orig(action, type, opts))];
    }
    return orig(action, type, opts);
  };
  return { ...f, source, thirdSource };
}

function classSpellGrantFixture() {
  const f = fixture();
  const feature = classUuid("magicFeature");
  const choice = { _id: id("classMagicGrant"), type: "ItemGrant", level: 2,
    configuration: { spell: { prepared: 2 }, items: [{ uuid: feature, optional: false }] },
    value: { added: { [id("ownedMagicFeature")]: feature } } };
  const child = { _id: id("magicFeature"), name: "Official Magic Feature", type: "feat",
    system: { source: { rules: "2024" }, advancement: [{ _id: id("grantMagicSpell"),
      type: "ItemGrant", level: 2,
      configuration: { spell: { prepared: 2 }, items: [{ uuid: spellUuid("cure"), optional: false }] } }] } };
  f.actor.items[0].system.advancement.push(structuredClone(choice));
  f.actor.items.push({ _id: id("ownedMagicFeature"), name: "Official Magic Feature", type: "feat",
    _stats: { compendiumSource: feature }, system: { source: { rules: "2024" } } });
  f.actor.items.push(makeSpell("cure", 2, ""));
  const oldDoc = f.fs.doc.bind(f.fs);
  f.fs.doc = async (action, type, opts = {}) => {
    const docs = await oldDoc(action, type, opts);
    if (action !== "get" || type !== "Item" || opts.pack !== "dnd5e.classes24") return docs;
    for (const doc of docs) if (doc._id === id("paladin"))
      doc.system.advancement.push(structuredClone(choice));
    return !opts.query?._id || opts.query._id === child._id ? [...docs, structuredClone(child)] : docs;
  };
  return f;
}

// The generic compendium loader may find an item with the same 16-character ID
// in a different pack. An audit must not certify it as the requested source.
function shadowOfficialSource(f, pack, missingId, shadowDoc) {
  const oldData = f.fs.worldData.bind(f.fs);
  f.fs.worldData = async () => ({ ...await oldData(), packs: [
    ...(await oldData()).packs, { id: "world.shadow", type: "Item", packageName: "world" }
  ] });
  const oldDoc = f.fs.doc.bind(f.fs);
  f.fs.doc = async (action, type, opts = {}) => {
    if (action === "get" && type === "Item" && opts.pack === "world.shadow")
      return !opts.query?._id || opts.query._id === missingId ? [structuredClone(shadowDoc)] : [];
    const docs = await oldDoc(action, type, opts);
    return action === "get" && type === "Item" && opts.pack === pack ?
      docs.filter(doc => doc._id !== missingId) : docs;
  };
}

function advancementFixture() {
  const f = fixture();
  const feature = classUuid("wardFeature");
  const feat = classUuid("toughFeat");
  const sub = classUuid("oathSubclass");
  const ids = { grant: id("grantAtThree"), asi: id("asiAtFour"), feat: id("featAtEight"),
    subclass: id("subAtThree"), future: id("asiAtTwelve") };
  const adv = [
    { _id: ids.grant, type: "ItemGrant", level: 3, configuration: { items: [{ uuid: feature, optional: false }] }, value: {} },
    { _id: ids.asi, type: "AbilityScoreImprovement", level: 4, configuration: { points: 2, cap: 2, locked: ["wis"] }, value: {} },
    { _id: ids.feat, type: "AbilityScoreImprovement", level: 8, configuration: { points: 2, cap: 2 }, value: {} },
    { _id: ids.subclass, type: "Subclass", level: 3, configuration: {}, value: {} },
    { _id: ids.future, type: "AbilityScoreImprovement", level: 12, configuration: { points: 2, cap: 2 }, value: {} }
  ];
  const saved = structuredClone(adv);
  saved[0].value = { added: { [id("ownedWard")]: feature } };
  saved[1].value = { type: "asi", assignments: { str: 1, cha: 1 } };
  saved[2].value = { type: "feat", feat: { [id("ownedFeat")]: feat } };
  saved[3].value = { document: id("ownedSub"), uuid: sub };
  f.actor.items[0].system.advancement = saved;
  f.actor.items.push(
    { _id: id("ownedWard"), name: "Official Ward", type: "feat", _stats: { compendiumSource: feature }, system: {} },
    { _id: id("ownedFeat"), name: "Tough", type: "feat", _stats: { compendiumSource: feat }, system: {} },
    { _id: id("ownedSub"), name: "Test Oath", type: "subclass", _stats: { compendiumSource: sub },
      system: { identifier: "test-oath", classIdentifier: "paladin", source: { rules: "2024" }, advancement: {} } }
  );
  const official = { ...officialClass("paladin", 0, 6), system: {
    ...officialClass("paladin", 0, 6).system,
    advancement: [...officialClass("paladin", 0, 6).system.advancement, ...adv] } };
  const featDoc = { _id: id("toughFeat"), name: "Tough", type: "feat",
    system: { source: { rules: "2024" }, prerequisites: { level: 4 } } };
  const subDoc = { _id: id("oathSubclass"), name: "Test Oath", type: "subclass", system: {
    identifier: "test-oath", classIdentifier: "paladin", source: { rules: "2024" }, advancement: {} } };
  const originalDoc = f.fs.doc.bind(f.fs);
  f.fs.doc = async (action, type, opts = {}) => {
    if (action === "get" && type === "Item" && opts.pack === "dnd5e.classes24") {
      const added = [official, featDoc, subDoc].filter(x => !opts.query?._id || opts.query._id === x._id);
      const earlier = await originalDoc(action, type, opts);
      return structuredClone([...added, ...earlier.filter(x => !added.some(y => y._id === x._id))]);
    }
    return originalDoc(action, type, opts);
  };
  return { ...f, ids, source: { feature, feat, sub }, featDoc };
}

function originFixture() {
  const f = fixture();
  const ids = { size: id("originSize"), speciesGrant: id("originGrant"),
    bgAsi: id("backgroundAsi"), bgTrait: id("backgroundTrait"),
    bgGrant: id("backgroundGrant") };
  const human = originUuid("human");
  const soldier = originUuid("soldier");
  const speciesFeature = originUuid("resourceful");
  const backgroundFeat = featUuid("savageAttacks");
  const speciesAdv = {
    [ids.size]: { _id: ids.size, type: "Size", level: 0, configuration: { sizes: ["sm", "med"] }, value: {} },
    [ids.speciesGrant]: { _id: ids.speciesGrant, type: "ItemGrant", level: 0,
      configuration: { items: [{ uuid: speciesFeature, optional: false }] }, value: {} }
  };
  const backgroundAdv = {
    [ids.bgAsi]: { _id: ids.bgAsi, type: "AbilityScoreImprovement", level: 0,
      configuration: { cap: 2, points: 3, fixed: { str: 0 }, locked: ["int", "wis", "cha"] }, value: {} },
    [ids.bgTrait]: { _id: ids.bgTrait, type: "Trait", level: 0,
      configuration: { grants: ["skills:ath"], choices: [{ count: 1, pool: ["tool:game:*"] }] }, value: {} },
    [ids.bgGrant]: { _id: ids.bgGrant, type: "ItemGrant", level: 0,
      configuration: { items: [{ uuid: backgroundFeat, optional: false }] }, value: {} }
  };
  const race = { _id: id("ownedHuman"), name: "Human", type: "race",
    _stats: { compendiumSource: human }, system: { identifier: "human", source: { rules: "2024" },
      advancement: { [ids.size]: { value: { size: "med" } },
        [ids.speciesGrant]: { value: { added: { [id("ownedResource")]: speciesFeature } } } } } };
  const background = { _id: id("ownedSoldier"), name: "Soldier", type: "background",
    _stats: { compendiumSource: soldier }, system: { identifier: "soldier", source: { rules: "2024" },
      advancement: { [ids.bgAsi]: { value: { type: "asi", assignments: { str: 2, con: 1 } } },
        [ids.bgTrait]: { value: { chosen: ["skills:ath", "tool:game:dice"] } },
        [ids.bgGrant]: { value: { added: { [id("ownedSavage")]: backgroundFeat } } } } } };
  f.actor.items.push(race, background,
    { _id: id("ownedResource"), name: "Resourceful", type: "feat",
      _stats: { compendiumSource: speciesFeature }, system: {} },
    { _id: id("ownedSavage"), name: "Savage Attacker", type: "feat",
      _stats: { compendiumSource: backgroundFeat }, system: {} });
  const official = [
    { _id: id("human"), type: "race", system: { identifier: "human", source: { rules: "2024" }, advancement: speciesAdv } },
    { _id: id("soldier"), type: "background", system: { identifier: "soldier", source: { rules: "2024" }, advancement: backgroundAdv } }
  ];
  const originalData = f.fs.worldData.bind(f.fs);
  f.fs.worldData = async () => ({ ...await originalData(), packs: [...(await originalData()).packs,
    { id: "dnd5e.origins24", type: "Item", packageName: "dnd5e" }] });
  const originalDoc = f.fs.doc.bind(f.fs);
  f.fs.doc = async (action, type, opts = {}) => action === "get" && type === "Item" &&
    opts.pack === "dnd5e.origins24" ? structuredClone(official.filter(i =>
      !opts.query?._id || opts.query._id === i._id)) : originalDoc(action, type, opts);
  return { ...f, race, background, ids, origin: { human, soldier, speciesFeature, backgroundFeat }, official };
}

function nestedFeatChoiceFixture() {
  const f = originFixture();
  const ids = { style: id("styleItemChoice"), versatile: id("originItemChoice"),
    defense: id("ownedDefense"), alert: id("ownedAlert") };
  const sources = { style: classUuid("fightingStyle"), versatile: originUuid("versatile"),
    defense: featUuid("defense"), alert: featUuid("alert") };
  const styleAdv = { _id: ids.style, type: "ItemChoice", configuration: {
    choices: { "2": { count: 1, replacement: false } }, allowDrops: true,
    type: "feat", pool: [{ uuid: classUuid("blessedStyle") }],
    restriction: { type: "feat", subtype: "fightingStyle", list: [], school: [] } }, value: {} };
  const versatileAdv = { _id: ids.versatile, type: "ItemChoice", configuration: {
    choices: { "0": { count: 1, replacement: false } }, allowDrops: true,
    type: "feat", pool: [{ uuid: featUuid("skilled") }],
    restriction: { type: "feat", subtype: "origin", list: [], school: [] } }, value: {} };
  const featureDocs = [
    { _id: id("fightingStyle"), name: "Fighting Style", type: "feat",
      system: { source: { rules: "2024" }, advancement: { [ids.style]: styleAdv } } },
    { _id: id("versatile"), name: "Versatile", type: "feat",
      system: { source: { rules: "2024" }, advancement: { [ids.versatile]: versatileAdv } } }
  ];
  const featDocs = [
    { _id: id("defense"), name: "Defense", type: "feat", system: {
      source: { rules: "2024" }, type: { value: "feat", subtype: "fightingStyle" },
      prerequisites: { level: null, repeatable: false } } },
    { _id: id("alert"), name: "Alert", type: "feat", system: {
      source: { rules: "2024" }, type: { value: "feat", subtype: "origin" },
      prerequisites: { level: null, repeatable: false } } }
  ];
  const style = { _id: id("ownedStyle"), name: "Fighting Style", type: "feat",
    _stats: { compendiumSource: sources.style }, system: { source: { rules: "2024" },
      advancement: { [ids.style]: { ...structuredClone(styleAdv),
        value: { added: { "2": { [ids.defense]: sources.defense } } } } } } };
  const versatile = { _id: id("ownedVersatile"), name: "Versatile", type: "feat",
    _stats: { compendiumSource: sources.versatile }, system: { source: { rules: "2024" },
      advancement: { [ids.versatile]: { ...structuredClone(versatileAdv),
        value: { added: { "0": { [ids.alert]: sources.alert } } } } } } };
  f.actor.items.push(style, versatile,
    { _id: ids.defense, name: "Defense", type: "feat", _stats: { compendiumSource: sources.defense }, system: {} },
    { _id: ids.alert, name: "Alert", type: "feat", _stats: { compendiumSource: sources.alert }, system: {} });
  const originalData = f.fs.worldData.bind(f.fs);
  f.fs.worldData = async () => { const data = await originalData(); return { ...data, packs: [
    ...data.packs, { id: "dnd5e.feats24", type: "Item", packageName: "dnd5e" }] }; };
  const originalDoc = f.fs.doc.bind(f.fs);
  f.fs.doc = async (action, type, opts = {}) => {
    if (action === "get" && type === "Item" && ["dnd5e.origins24", "dnd5e.classes24", "dnd5e.feats24"].includes(opts.pack)) {
      const extras = (opts.pack === "dnd5e.feats24" ? featDocs : featureDocs.filter(d =>
        opts.pack === (d._id === id("versatile") ? "dnd5e.origins24" : "dnd5e.classes24")))
        .filter(d => !opts.query?._id || d._id === opts.query._id);
      const earlier = await originalDoc(action, type, opts);
      return structuredClone([...extras, ...earlier.filter(d => !extras.some(e => e._id === d._id))]);
    }
    return originalDoc(action, type, opts);
  };
  return { ...f, ids, sources, style, versatile, featureDocs, featDocs };
}

function proveFightingStyleGrant(f) {
  f.featureDocs[0].system.identifier = "fighting-style";
  f.featDocs[0].system.prerequisites.items = ["fighting-style"];
  const grant = { _id: id("recordedStyleGrant"), type: "ItemGrant", level: 2,
    configuration: { items: [{ uuid: f.sources.style, optional: false }] },
    value: { added: { [f.style._id]: f.sources.style } } };
  f.actor.items[0].system.advancement.push(structuredClone(grant));
  const originalDoc = f.fs.doc.bind(f.fs);
  f.fs.doc = async (action, type, opts = {}) => {
    const docs = await originalDoc(action, type, opts);
    if (action === "get" && type === "Item" && opts.pack === "dnd5e.classes24") {
      const paladin = docs.find(d => d._id === id("paladin"));
      if (paladin) paladin.system.advancement.push(structuredClone(grant));
    }
    return docs;
  };
  return grant;
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
  assert.equal(report.official_base_spell_slots.spell3, 2, "Verified official classes prove the base slots");
  assert.deepEqual(report.verified_sources.classes.sort(), [classUuid("paladin"), classUuid("sorcerer")].sort());
  assert.equal(report.verified_sources.spells.length, 6);
  assert.match(report.limits.join(" "), /not full D&D 2024 legality/);
  assert.deepEqual(f.writes, []);
});

test("official slot baseline is independent of a recorded spell slot override", async () => {
  const f = fixture();
  f.actor.system.spells.spell1 = { value: 6, override: 8 };
  const report = await audit(f.fs);
  assert.equal(report.status, "incomplete");
  assert.equal(report.expected_spell_slots.spell1, 8, "Existing sheet-specific output remains compatible");
  assert.equal(report.official_base_spell_slots.spell1, 4, "The official class table is not overwritten");
  assert.ok(report.diagnostics.some(d => d.code === "spell_slot_override_unverified" &&
    d.severity === "unverified"));
  assert.ok(!report.diagnostics.some(d => d.code === "invalid_spell_slot_value"));
  assert.deepEqual(f.writes, []);
});

test("an override equal to the official slot table does not cause a spurious warning", async () => {
  const f = fixture();
  f.actor.system.spells.spell1 = { value: 2, override: 4 };
  const report = await audit(f.fs);
  assert.equal(report.status, "passed_scoped_checks", JSON.stringify(report.diagnostics));
  assert.equal(report.official_base_spell_slots.spell1, 4);
  assert.deepEqual(f.writes, []);
});

test("blank spell slot overrides preserve the verified expected table without diagnostics", async () => {
  const f = fixture();
  f.actor.system.spells.spell1 = { value: 3, override: "" };
  f.actor.system.spells.spell3 = { value: 1, override: "" };
  const report = await audit(f.fs);
  assert.equal(report.status, "passed_scoped_checks", JSON.stringify(report.diagnostics));
  assert.deepEqual(report.expected_spell_slots, report.official_base_spell_slots);
  assert.equal(report.expected_spell_slots.spell1, 4);
  assert.equal(report.expected_spell_slots.spell3, 2);
  assert.deepEqual(f.writes, []);
});

test("an official Eldritch Knight with Pact Magic retains its single-Spellcasting-class slot table", async () => {
  const f = subclassFixture();
  const fighter = classItem("fighter", 4);
  fighter.system.spellcasting.progression = "none";
  const warlock = classItem("warlock", 3);
  warlock.system.spellcasting.progression = "pact";
  f.actor.items = [fighter, warlock, {
    _id: id("ownedEldritchKnight"), name: "Eldritch Knight", type: "subclass",
    _stats: { compendiumSource: f.thirdSource },
    system: { identifier: "eldritch-knight", classIdentifier: "fighter", source: { rules: "2024" },
      spellcasting: { progression: "third" }, advancement: [] }
  }];
  const oldDoc = f.fs.doc.bind(f.fs);
  f.fs.doc = async (action, type, opts = {}) => {
    const docs = await oldDoc(action, type, opts);
    if (action === "get" && type === "Item" && opts.pack === "dnd5e.classes24" &&
        (!opts.query?._id || opts.query._id === id("warlock"))) {
      const official = officialClass("warlock", 2, 2);
      official.system.spellcasting.progression = "pact";
      return [...docs, official];
    }
    return docs;
  };
  const report = await audit(f.fs);
  assert.equal(report.expected_spell_slots.spell1, 3, "Fighter 4 has three first-level spell slots");
  assert.equal(report.expected_spell_slots.pact, 2);
  assert.equal(report.official_base_spell_slots?.spell1, 3);
  assert.deepEqual(f.writes, []);
});

test("spell slot resource values cannot be negative, and unexplained excess stays unverified", async () => {
  const f = fixture();
  f.actor.system.spells.spell1 = { value: -1 };
  const wrong = await audit(f.fs);
  assert.ok(wrong.diagnostics.some(d => d.code === "invalid_spell_slot_value" &&
    d.severity === "error"));
  f.actor.system.spells.spell1.value = 5;
  const excess = await audit(f.fs);
  assert.ok(excess.diagnostics.some(d => d.code === "spell_slots_above_official_base" &&
    d.severity === "unverified"));
  assert.ok(!excess.diagnostics.some(d => d.code === "invalid_spell_slot_value"));
  f.actor.system.spells.spell1.value = 0;
  const spent = await audit(f.fs);
  assert.equal(spent.status, "passed_scoped_checks", JSON.stringify(spent.diagnostics));
  assert.deepEqual(f.writes, []);
});

test("an unverified class source cannot certify a universal slot baseline", async () => {
  const f = fixture();
  delete f.actor.items[1]._stats;
  f.actor.system.spells.spell1 = { value: 7, override: 8 };
  const report = await audit(f.fs);
  assert.equal(report.official_base_spell_slots, null);
  assert.ok(report.diagnostics.some(d => d.code === "class_source_missing"));
  assert.ok(!report.diagnostics.some(d => d.code === "spell_slot_override_unverified"),
    "The audit cannot compare against an official multiclass table without all classes");
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

test("a copied spell with a forged lower level cannot bypass its official spell ceiling", async () => {
  const f = fixture();
  const fireball = makeSpell("fireball", 0);
  fireball.system.level = 1; // its exact official 2024 source is level 3
  f.actor.items.push(fireball);
  const report = await audit(f.fs);
  assert.ok(report.diagnostics.some(d => d.code === "spell_level_source_mismatch" &&
    d.severity === "error" && d.subject === fireball._id));
  assert.ok(!report.diagnostics.some(d => d.code === "spell_above_class_level" &&
    d.subject === fireball._id), "The separate level ceiling still sees the forged owned level");
  fireball.system.level = 3;
  const restored = await audit(f.fs);
  assert.ok(restored.diagnostics.some(d => d.code === "spell_above_class_level" &&
    d.subject === fireball._id));
  assert.ok(!restored.diagnostics.some(d => d.code === "spell_level_source_mismatch"));
  assert.deepEqual(f.writes, []);
});

test("a cantrip disguised as a leveled spell is contradicted by its exact source", async () => {
  const f = fixture();
  const acid = f.actor.items.find(i => i._id === id("ownedacid"));
  acid.system.level = 1; // official Acid Splash remains a cantrip
  const report = await audit(f.fs);
  assert.ok(report.diagnostics.some(d => d.code === "spell_level_source_mismatch" &&
    d.severity === "error" && d.subject === acid._id));
  assert.deepEqual(f.writes, []);
});

test("official class spell levels use one pack index lookup per audit", async () => {
  const f = fixture();
  const oldDoc = f.fs.doc.bind(f.fs);
  let lookups = 0;
  f.fs.doc = async (action, type, opts = {}) => {
    if (action === "get" && type === "Item" && opts.pack === "dnd5e.spells24" && opts.index)
      lookups++;
    return oldDoc(action, type, opts);
  };
  const report = await audit(f.fs);
  assert.equal(report.status, "passed_scoped_checks", JSON.stringify(report.diagnostics));
  assert.equal(lookups, 1, "The audit should not fetch every owned spell as a full document");
  assert.deepEqual(f.writes, []);
});

test("a same-ID world fallback never proves the official level of an owned class spell", async () => {
  const f = fixture();
  shadowOfficialSource(f, "dnd5e.spells24", id("missile"),
    compendiumSpells.find(s => s._id === id("missile")));
  const spell = f.actor.items.find(i => i._id === id("ownedmissile"));
  const report = await audit(f.fs);
  assert.ok(report.diagnostics.some(d => d.code === "spell_source_index_unavailable" &&
    d.severity === "unverified" && d.subject === spell._id));
  assert.ok(!report.diagnostics.some(d => d.code === "spell_level_source_mismatch" &&
    d.subject === spell._id));
  assert.deepEqual(f.writes, []);
});

test("a spell index lacking a usable 2024 level stays unverified, never a false contradiction", async () => {
  const f = fixture();
  const oldDoc = f.fs.doc.bind(f.fs);
  f.fs.doc = async (action, type, opts = {}) => {
    const docs = await oldDoc(action, type, opts);
    if (action === "get" && type === "Item" && opts.pack === "dnd5e.spells24" && opts.index)
      for (const doc of docs) if (doc._id === id("acid")) doc.system.level = null;
    return docs;
  };
  const report = await audit(f.fs);
  assert.ok(report.diagnostics.some(d => d.code === "spell_source_level_unavailable" &&
    d.severity === "unverified" && d.subject === id("ownedacid")));
  assert.ok(!report.diagnostics.some(d => d.code === "spell_level_source_mismatch" &&
    d.subject === id("ownedacid")));
  assert.deepEqual(f.writes, []);
});

test("an owned cantrip cannot use a null level as if it were zero", async () => {
  const f = fixture();
  const acid = f.actor.items.find(i => i._id === id("ownedacid"));
  acid.system.level = null;
  const report = await audit(f.fs);
  assert.ok(report.diagnostics.some(d => d.code === "spell_level_source_mismatch" &&
    d.severity === "error" && d.subject === acid._id));
  assert.deepEqual(f.writes, []);
});

test("class spells with mixed-case sourceClass still count toward official spell limits", async () => {
  const f = fixture();
  for (const spell of f.actor.items.filter(i => i.type === "spell"))
    spell.system.sourceClass = "SoRcErEr";
  f.actor.items.push({ ...makeSpell("acid", 0, "SORCERER"), _id: id("caseCantrip") });
  const report = await audit(f.fs);
  assert.ok(report.diagnostics.some(d => d.code === "too_many_cantrips" && d.severity === "error"));
  assert.ok(!report.diagnostics.some(d => d.code === "orphan_spell_class"),
    "Capitalization alone must not orphan a spell or hide it from its class");
  assert.deepEqual(f.writes, []);
});

test("a noncaster class's attributed spell needs feature evidence, not a false scoped pass", async () => {
  const f = subclassFixture();
  const fighter = classItem("fighter", 3);
  fighter.system.spellcasting.progression = "none";
  f.actor.items = [fighter, makeSpell("shieldspell", 0, "FIGHTER")];
  const report = await audit(f.fs);
  assert.equal(report.status, "incomplete");
  assert.ok(report.diagnostics.some(d => d.code === "noncaster_class_spell_origin" &&
    d.severity === "unverified" && d.subject === fighter._id));
  assert.ok(!report.diagnostics.some(d => d.code === "spell_above_class_level"),
    "An unexplained class attribution does not prove an illegal feat-granted spell");
  assert.deepEqual(f.writes, []);
});

test("a spell with no sourceClass cannot silently pass class spell limits", async () => {
  const f = fixture();
  const unexplained = makeSpell("fireball", 0, "");
  f.actor.items.push(unexplained);
  const report = await audit(f.fs);
  assert.equal(report.status, "incomplete");
  assert.ok(report.diagnostics.some(d => d.code === "unattributed_spell_origin" &&
    d.severity === "unverified" && d.subject === unexplained._id));
  assert.ok(!report.diagnostics.some(d => d.code === "spell_above_class_level"),
    "Missing class attribution is not proof that a feat-granted spell is illegal");
  assert.deepEqual(f.writes, []);
});

test("whitespace-only sourceClass is also treated as unrecorded provenance", async () => {
  const f = fixture();
  const unexplained = makeSpell("detect", 0, "  ");
  f.actor.items.push(unexplained);
  const report = await audit(f.fs);
  assert.ok(report.diagnostics.some(d => d.code === "unattributed_spell_origin" &&
    d.subject === unexplained._id));
  assert.deepEqual(f.writes, []);
});

test("official always-prepared subclass grants do not trigger a noncaster spell-origin warning", async () => {
  const f = subclassFixture();
  const paladin = classItem("paladin", 8);
  paladin.system.spellcasting.progression = "none";
  const oath = { _id: id("oathOwned"), type: "subclass", name: "Official Oath",
    _stats: { compendiumSource: f.source }, system: {
      identifier: "test-oath", classIdentifier: "paladin", source: { rules: "2024" } } };
  f.actor.items = [paladin, oath, makeSpell("cure", 2, "paladin"), makeSpell("feather", 2, "paladin")];
  const oldDoc = f.fs.doc.bind(f.fs);
  f.fs.doc = async (action, type, opts = {}) => {
    const docs = await oldDoc(action, type, opts);
    if (action === "get" && type === "Item" && opts.pack === "dnd5e.classes24")
      for (const doc of docs) if (doc._id === id("paladin")) doc.system.spellcasting.progression = "none";
    return docs;
  };
  const report = await audit(f.fs);
  assert.equal(report.status, "passed_scoped_checks", JSON.stringify(report.diagnostics));
  assert.deepEqual(report.verified_sources.subclass_spells.sort(),
    [spellUuid("cure"), spellUuid("feather")].sort());
  assert.ok(!report.diagnostics.some(d => d.code === "noncaster_class_spell_origin"));
  assert.deepEqual(f.writes, []);
});

test("a forged noncaster class field cannot skip official class spell checks", async () => {
  const f = fixture();
  f.actor.items[1].system.spellcasting.progression = "none"; // official sorcerer is full
  f.actor.items.push({ ...makeSpell("acid", 0), _id: id("extraCantrip") });
  const report = await audit(f.fs);
  assert.ok(report.diagnostics.some(d => d.code === "class_spellcasting_progression_mismatch" &&
    d.severity === "error" && d.subject === f.actor.items[1]._id));
  assert.ok(report.diagnostics.some(d => d.code === "too_many_cantrips" && d.severity === "error"),
    "The official sorcerer progression must still check its cantrip limit");
  assert.ok(report.verified_sources.classes.includes(classUuid("sorcerer")));
  assert.equal(report.expected_spell_slots.spell3, 2,
    "Expected multiclass slots must use the official sorcerer full-caster progression");
  assert.deepEqual(f.writes, []);
});

test("a forged caster progression on an official noncaster class is a source mismatch", async () => {
  const f = subclassFixture();
  const fighter = classItem("fighter", 3);
  fighter.system.spellcasting.progression = "full"; // official fighter is none
  f.actor.items = [fighter];
  const report = await audit(f.fs);
  assert.ok(report.diagnostics.some(d => d.code === "class_spellcasting_progression_mismatch" &&
    d.severity === "error"));
  assert.ok(!report.diagnostics.some(d => d.code === "prepared_scale_unavailable"),
    "A forged caster field must not force a noncaster spell audit");
  assert.deepEqual(report.expected_spell_slots, {},
    "Forging a full-caster fighter must not generate spell slots");
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

test("world class provenance cannot certify an otherwise plausible 2024 class", async () => {
  const f = fixture();
  f.actor.items[0]._stats.compendiumSource = `Compendium.world.classes.Item.${id("paladin")}`;
  const report = await audit(f.fs);
  assert.ok(report.diagnostics.some(d => d.code === "class_source_unverified" && d.severity === "unverified"));
  assert.ok(!report.verified_sources.classes.includes(classUuid("paladin")));
  assert.ok(report.diagnostics.some(d => d.code === "spell_progression_unavailable"));
  assert.deepEqual(f.writes, []);
});

test("a class found by ID in another pack cannot replace the missing official class source", async () => {
  const f = fixture();
  shadowOfficialSource(f, "dnd5e.classes24", id("paladin"), officialClass("paladin", 0, 6));
  const report = await audit(f.fs);
  assert.ok(report.diagnostics.some(d => d.code === "class_source_unavailable" && d.severity === "unverified"));
  assert.ok(!report.diagnostics.some(d => d.code === "class_source_mismatch"));
  assert.ok(!report.verified_sources.classes.includes(classUuid("paladin")));
  assert.ok(report.diagnostics.some(d => d.code === "spell_progression_unavailable"));
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

test("exact official class feature grants prove always-prepared spells without sourceClass", async () => {
  const f = classSpellGrantFixture();
  const report = await audit(f.fs);
  assert.equal(report.status, "passed_scoped_checks", JSON.stringify(report.diagnostics));
  assert.deepEqual(report.verified_sources.class_granted_spells, [spellUuid("cure")]);
  assert.ok(!report.diagnostics.some(d => d.code === "unattributed_spell_origin"));
  f.actor.items.find(i => i._id === id("ownedcure")).system.prepared = 1;
  const wrong = await audit(f.fs);
  assert.ok(wrong.diagnostics.some(d => d.code === "class_granted_spell_not_always_prepared"));
  f.actor.items = f.actor.items.filter(i => i._id !== id("ownedcure"));
  const missing = await audit(f.fs);
  assert.ok(missing.diagnostics.some(d => d.code === "missing_class_granted_spell"));
  assert.deepEqual(f.writes, []);
});

test("a class-granted spell from the wrong pack stays unverified without duplicate attribution warning", async () => {
  const f = classSpellGrantFixture();
  shadowOfficialSource(f, "dnd5e.spells24", id("cure"), compendiumSpells.find(s => s._id === id("cure")));
  const report = await audit(f.fs);
  assert.equal(report.status, "incomplete");
  assert.deepEqual(report.verified_sources.class_granted_spells, []);
  assert.ok(report.diagnostics.some(d => d.code === "class_grant_unverified" &&
    /different compendium/.test(d.detail)));
  assert.ok(!report.diagnostics.some(d => d.code === "unattributed_spell_origin"),
    "The existing official class-grant source warning already covers this same spell");
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

test("official subclass ItemGrant chains prove always-prepared spells without consuming class preparation", async () => {
  const f = subclassFixture();
  f.actor.items.push({ _id: id("oathOwned"), type: "subclass", name: "Official Oath",
    _stats: { compendiumSource: f.source }, system: { identifier: "test-oath", classIdentifier: "paladin", source: { rules: "2024" } } });
  f.actor.items.push(makeSpell("cure", 2, "paladin"));
  f.actor.items.push(makeSpell("feather", 2, "paladin"));
  const report = await audit(f.fs);
  assert.equal(report.status, "passed_scoped_checks", JSON.stringify(report.diagnostics));
  assert.deepEqual(report.verified_sources.subclasses, [f.source]);
  assert.deepEqual(report.verified_sources.subclass_spells.sort(), [spellUuid("cure"), spellUuid("feather")].sort());
  assert.ok(!report.diagnostics.some(d => d.code === "too_many_prepared"));
  f.actor.items.find(i => i._id === id("ownedcure")).system.sourceClass = "";
  f.actor.items.find(i => i._id === id("ownedfeather")).system.sourceClass = "  ";
  const noClass = await audit(f.fs);
  assert.equal(noClass.status, "passed_scoped_checks", JSON.stringify(noClass.diagnostics));
  assert.ok(!noClass.diagnostics.some(d => d.code === "unattributed_spell_origin"),
    "Exact always-prepared subclass spell provenance is already established");
  f.actor.items.find(i => i._id === id("ownedcure")).system.prepared = 1;
  const wrong = await audit(f.fs);
  assert.ok(wrong.diagnostics.some(d => d.code === "subclass_spell_not_always_prepared"));
  f.actor.items = f.actor.items.filter(i => i._id !== id("ownedcure"));
  const missing = await audit(f.fs);
  assert.ok(missing.diagnostics.some(d => d.code === "missing_subclass_spell"));
  assert.deepEqual(f.writes, []);
});

test("world-imported subclass is not mistaken for official PHB 2024 evidence", async () => {
  const f = subclassFixture();
  f.actor.items.push({ _id: id("oathOwned"), type: "subclass", name: "Unknown Oath",
    _stats: { compendiumSource: `Compendium.world.classes.Item.${id("subclassOath")}` },
    system: { identifier: "test-oath", classIdentifier: "paladin", source: { rules: "2024" } } });
  const report = await audit(f.fs);
  assert.equal(report.status, "incomplete");
  assert.ok(report.diagnostics.some(d => d.code === "subclass_source_unverified"));
  assert.deepEqual(report.verified_sources.subclasses, []);
  assert.deepEqual(f.writes, []);
});

test("a subclass from an ID-match fallback cannot certify its official source or grants", async () => {
  const f = subclassFixture();
  const shadow = (await f.fs.doc("get", "Item", { pack: "dnd5e.classes24",
    query: { _id: id("subclassOath") } }))[0];
  shadowOfficialSource(f, "dnd5e.classes24", id("subclassOath"), shadow);
  f.actor.items.push({ _id: id("oathOwned"), type: "subclass", name: "Unproven Oath",
    _stats: { compendiumSource: f.source }, system: {
      identifier: "test-oath", classIdentifier: "paladin", source: { rules: "2024" } } });
  f.actor.items.push(makeSpell("cure", 2, "paladin"));
  const report = await audit(f.fs);
  assert.ok(report.diagnostics.some(d => d.code === "subclass_source_unverified" && d.severity === "unverified"));
  assert.deepEqual(report.verified_sources.subclasses, []);
  assert.deepEqual(report.verified_sources.subclass_spells, []);
  assert.ok(!report.diagnostics.some(d => d.code === "missing_subclass_spell"));
  assert.deepEqual(f.writes, []);
});

test("a subclass's nested grant must resolve from the exact official feature pack", async () => {
  const f = subclassFixture();
  const shadow = (await f.fs.doc("get", "Item", { pack: "dnd5e.classes24",
    query: { _id: id("domainSpells") } }))[0];
  shadowOfficialSource(f, "dnd5e.classes24", id("domainSpells"), shadow);
  f.actor.items.push({ _id: id("oathOwned"), type: "subclass", name: "Official Oath",
    _stats: { compendiumSource: f.source }, system: {
      identifier: "test-oath", classIdentifier: "paladin", source: { rules: "2024" } } });
  const report = await audit(f.fs);
  assert.deepEqual(report.verified_sources.subclasses, [f.source]);
  assert.deepEqual(report.verified_sources.subclass_spells, []);
  assert.ok(report.diagnostics.some(d => d.code === "subclass_grant_unverified" &&
    /different compendium/.test(d.detail)));
  assert.ok(!report.diagnostics.some(d => d.code === "missing_subclass_spell"));
  assert.deepEqual(f.writes, []);
});

test("a subclass spell with only a same-ID world fallback is not a proven mandatory spell", async () => {
  const f = subclassFixture();
  const shadow = compendiumSpells.find(spell => spell._id === id("cure"));
  shadowOfficialSource(f, "dnd5e.spells24", id("cure"), shadow);
  f.actor.items.push({ _id: id("oathOwned"), type: "subclass", name: "Official Oath",
    _stats: { compendiumSource: f.source }, system: {
      identifier: "test-oath", classIdentifier: "paladin", source: { rules: "2024" } } });
  f.actor.items.push(makeSpell("feather", 2, "paladin"));
  const report = await audit(f.fs);
  assert.deepEqual(report.verified_sources.subclasses, [f.source]);
  assert.deepEqual(report.verified_sources.subclass_spells, [spellUuid("feather")]);
  assert.ok(report.diagnostics.some(d => d.code === "subclass_grant_unverified" &&
    d.references.includes(f.source) && /different compendium/.test(d.detail)));
  assert.ok(!report.diagnostics.some(d => d.code === "missing_subclass_spell"));
  assert.deepEqual(f.writes, []);
});

test("known but unverified subclass spell grants do not duplicate missing-class attribution diagnostics", async () => {
  const f = subclassFixture();
  const shadow = compendiumSpells.find(spell => spell._id === id("cure"));
  shadowOfficialSource(f, "dnd5e.spells24", id("cure"), shadow);
  f.actor.items.push({ _id: id("oathOwned"), type: "subclass", name: "Official Oath",
    _stats: { compendiumSource: f.source }, system: {
      identifier: "test-oath", classIdentifier: "paladin", source: { rules: "2024" } } });
  f.actor.items.push(makeSpell("cure", 2, ""));
  f.actor.items.push(makeSpell("feather", 2, ""));
  const report = await audit(f.fs);
  assert.ok(report.diagnostics.some(d => d.code === "subclass_grant_unverified" &&
    /different compendium/.test(d.detail)));
  assert.ok(!report.diagnostics.some(d => d.code === "unattributed_spell_origin"),
    "The official declared subclass grant and its explicit source warning explain the blank sourceClass");
  assert.deepEqual(f.writes, []);
});

test("official third-caster subclass uses the Wizard list and its own 2024 scales, not shared slots", async () => {
  const f = subclassFixture();
  const fighter = classItem("fighter", 3);
  fighter.system.spellcasting.progression = "none";
  const sub = { _id: id("eldritchOwned"), type: "subclass", name: "Eldritch Knight",
    _stats: { compendiumSource: f.thirdSource }, system: {
      identifier: "eldritch-knight", classIdentifier: "fighter", source: { rules: "2024" },
      spellcasting: { progression: "third" } } };
  f.actor.items = [fighter, sub, makeSpell("light", 0, "fighter"), makeSpell("magehand", 0, "fighter"),
    makeSpell("shieldspell", 1, "fighter"), makeSpell("missile", 1, "fighter"), makeSpell("burning", 1, "fighter")];
  const good = await audit(f.fs);
  assert.equal(good.status, "passed_scoped_checks", JSON.stringify(good.diagnostics));
  assert.equal(good.expected_spell_slots.spell1, 2);
  assert.ok(!good.diagnostics.some(d => d.code === "third_caster_features"));
  assert.ok(!good.diagnostics.some(d => d.code === "noncaster_class_spell_origin"),
    "A verified third-caster subclass has an official casting progression");
  f.actor.items.push(makeSpell("fireball", 1, "fighter"));
  const bad = await audit(f.fs);
  assert.equal(bad.status, "issues");
  assert.ok(bad.diagnostics.some(d => d.code === "spell_above_class_level"));
  assert.ok(bad.diagnostics.some(d => d.code === "too_many_prepared"));
  assert.deepEqual(f.writes, []);
});

test("a third-caster's owned subclass cannot disable verified official magic progression", async () => {
  const f = subclassFixture();
  const fighter = classItem("fighter", 3);
  fighter.system.spellcasting.progression = "none";
  const sub = { _id: id("eldritchOwned"), type: "subclass", name: "Eldritch Knight",
    _stats: { compendiumSource: f.thirdSource }, system: {
      identifier: "eldritch-knight", classIdentifier: "fighter", source: { rules: "2024" },
      spellcasting: { progression: "none" } } };
  f.actor.items = [fighter, sub, makeSpell("light", 0, "fighter"), makeSpell("magehand", 0, "fighter"),
    makeSpell("shieldspell", 1, "fighter"), makeSpell("missile", 1, "fighter")];
  const report = await audit(f.fs);
  assert.ok(report.diagnostics.some(d => d.code === "subclass_spellcasting_progression_mismatch" &&
    d.severity === "error" && d.subject === sub._id));
  assert.ok(!report.diagnostics.some(d => d.code === "third_caster_features"),
    "The official third-caster progression must still be recognized");
  assert.ok(!report.diagnostics.some(d => d.code === "class_spellcasting_progression_mismatch"));
  assert.equal(report.expected_spell_slots.spell1, 2,
    "Verified Eldritch Knight must still have its third-caster slots at level 3");
  assert.deepEqual(f.writes, []);
});

test("recorded official ASI, subclass, mandatory feature and feat source are verifiable without writes", async () => {
  const f = advancementFixture();
  const report = await audit(f.fs);
  assert.equal(report.status, "passed_scoped_checks", JSON.stringify(report.diagnostics));
  assert.deepEqual(report.verified_sources.feats, [f.source.feat]);
  assert.deepEqual(report.verified_sources.subclasses, [f.source.sub]);
  assert.deepEqual(f.writes, []);
});

test("official ASI limits and saved future choices are proven errors", async () => {
  const f = advancementFixture();
  const adv = f.actor.items[0].system.advancement;
  adv.find(a => a._id === f.ids.asi).value.assignments.str = 3;
  adv.find(a => a._id === f.ids.future).value = { type: "asi", assignments: { dex: 2 } };
  const report = await audit(f.fs);
  assert.equal(report.status, "issues");
  assert.ok(report.diagnostics.some(d => d.code === "invalid_asi_allocation"));
  assert.ok(report.diagnostics.some(d => d.code === "future_advancement_recorded"));
  assert.deepEqual(f.writes, []);
});

test("missing mandatory feature is a warning; forged official advancement grants are errors", async () => {
  const f = advancementFixture();
  f.actor.items = f.actor.items.filter(i => i._id !== id("ownedWard"));
  const missing = await audit(f.fs);
  assert.ok(missing.diagnostics.some(d => d.code === "mandatory_feature_missing" && d.severity === "warning"));
  f.actor.items[0].system.advancement.find(a => a._id === f.ids.grant).value.added = {
    [id("fakeGrant")]: classUuid("notGranted") };
  const forged = await audit(f.fs);
  assert.ok(forged.diagnostics.some(d => d.code === "unexpected_recorded_grant" && d.severity === "error"));
  assert.deepEqual(f.writes, []);
});

test("a stale ItemGrant item ID cannot borrow evidence from another matching feature copy", async () => {
  const f = advancementFixture();
  const ward = f.actor.items.find(i => i._id === id("ownedWard"));
  f.actor.items = f.actor.items.filter(i => i !== ward);
  f.actor.items.push({ ...structuredClone(ward), _id: id("replacementWard") });
  const report = await audit(f.fs);
  assert.equal(report.status, "incomplete");
  assert.ok(report.diagnostics.some(d => d.code === "stale_grant_item_id" &&
    d.severity === "unverified" && d.subject === ward._id));
  assert.ok(!report.diagnostics.some(d => d.code === "mandatory_feature_missing"),
    "The official feature is present, but its recorded grant relationship is no longer proven");
  assert.deepEqual(f.writes, []);
});

test("a reused ItemGrant ID cannot borrow proof from a separate official copy", async () => {
  const f = advancementFixture();
  const ward = f.actor.items.find(i => i._id === id("ownedWard"));
  f.actor.items.push({ ...structuredClone(ward), _id: id("copyOfWard") });
  ward._stats.compendiumSource = classUuid("unrelatedFeat");
  const report = await audit(f.fs);
  assert.equal(report.status, "incomplete");
  assert.ok(report.diagnostics.some(d => d.code === "grant_item_source_mismatch" &&
    d.severity === "unverified" && d.subject === ward._id));
  assert.ok(!report.diagnostics.some(d => d.code === "mandatory_feature_missing"));
  assert.deepEqual(f.writes, []);
});

test("optional and origin grants verify saved item IDs without inventing missing mandatory features", async () => {
  const f = originFixture();
  const granted = f.actor.items.find(i => i._id === id("ownedSavage"));
  f.actor.items = f.actor.items.filter(i => i !== granted);
  f.actor.items.push({ ...structuredClone(granted), _id: id("newSavage") });
  f.official[1].system.advancement[f.ids.bgGrant].configuration.items[0].optional = true;
  const report = await audit(f.fs);
  assert.ok(report.diagnostics.some(d => d.code === "stale_grant_item_id" &&
    d.severity === "unverified" && d.subject === granted._id));
  assert.ok(!report.diagnostics.some(d => d.code === "mandatory_feature_missing"));
  assert.deepEqual(f.writes, []);
});

test("feat level requirement can be proved but historical ability prerequisites remain unverifiable", async () => {
  const f = advancementFixture();
  f.featDoc.system.prerequisites.level = 15;
  const originalDoc = f.fs.doc.bind(f.fs);
  f.fs.doc = async (action, type, opts = {}) => action === "get" && type === "Item" &&
    opts.pack === "dnd5e.classes24" && opts.query?._id === id("toughFeat")
    ? [structuredClone(f.featDoc)] : originalDoc(action, type, opts);
  const invalid = await audit(f.fs);
  assert.ok(invalid.diagnostics.some(d => d.code === "feat_level_prerequisite_unmet" && d.severity === "error"));
  f.featDoc.system.prerequisites = { level: 4, ability: { con: 13 } };
  const unknown = await audit(f.fs);
  assert.ok(unknown.diagnostics.some(d => d.code === "feat_historical_prerequisite" && d.severity === "unverified"));
  assert.ok(!unknown.diagnostics.some(d => d.code === "feat_level_prerequisite_unmet"));
  assert.deepEqual(f.writes, []);
});

test("fixed ability bonuses are not falsely counted as invalid selectable ASI points", async () => {
  const f = advancementFixture();
  f.actor.items[0].system.advancement.find(a => a._id === f.ids.asi).value.assignments.str = 2;
  const originalDoc = f.fs.doc.bind(f.fs);
  f.fs.doc = async (action, type, opts = {}) => {
    const docs = await originalDoc(action, type, opts);
    if (action === "get" && type === "Item" && opts.pack === "dnd5e.classes24" &&
        (!opts.query?._id || opts.query._id === id("paladin"))) {
      const src = docs.find(i => i._id === id("paladin"));
      if (src) src.system.advancement.find(a => a._id === f.ids.asi).configuration.fixed = { str: 1 };
    }
    return docs;
  };
  const report = await audit(f.fs);
  assert.ok(report.diagnostics.some(d => d.code === "asi_fixed_allocation_unverified"));
  assert.ok(!report.diagnostics.some(d => d.code === "invalid_asi_allocation"));
  assert.deepEqual(f.writes, []);
});

test("official 2024 species and background keyed value-only choices pass without writes", async () => {
  const f = originFixture();
  const report = await audit(f.fs);
  assert.equal(report.status, "passed_scoped_checks", JSON.stringify(report.diagnostics));
  assert.deepEqual(report.verified_sources.species, [f.origin.human]);
  assert.deepEqual(report.verified_sources.backgrounds, [f.origin.soldier]);
  assert.deepEqual(f.writes, []);
});

test("official origin ASI locks, species size, trait pool and grant violations are detected", async () => {
  const f = originFixture();
  f.background.system.advancement[f.ids.bgAsi].value.assignments.cha = 1;
  f.race.system.advancement[f.ids.size].value.size = "lg";
  f.background.system.advancement[f.ids.bgTrait].value.chosen.push("tool:smith");
  f.background.system.advancement[f.ids.bgGrant].value.added[id("forgedGrant")] = featUuid("unlistedFeat");
  const report = await audit(f.fs);
  for (const code of ["invalid_asi_allocation", "invalid_origin_size", "invalid_origin_trait_choice", "unexpected_recorded_grant"])
    assert.ok(report.diagnostics.some(d => d.code === code && d.severity === "error"), code);
  assert.deepEqual(f.writes, []);
});

test("missing origin choices and feature grants remain reviewable without invented decisions", async () => {
  const f = originFixture();
  delete f.background.system.advancement[f.ids.bgTrait].value;
  f.actor.items = f.actor.items.filter(i => i._id !== id("ownedResource"));
  const report = await audit(f.fs);
  assert.ok(report.diagnostics.some(d => d.code === "origin_trait_choice_missing" && d.severity === "unverified"));
  assert.ok(report.diagnostics.some(d => d.code === "mandatory_feature_missing" && d.severity === "warning"));
  assert.deepEqual(f.writes, []);
});

test("origin sources absent or claiming the wrong rules edition cannot certify advancement", async () => {
  const f = originFixture();
  f.race._stats.compendiumSource = "Compendium.world.characters.Item." + id("human");
  const missing = await audit(f.fs);
  assert.ok(missing.diagnostics.some(d => d.code === "origin_source_unverified"));
  assert.deepEqual(missing.verified_sources.species, []);
  f.race._stats.compendiumSource = f.origin.human;
  f.official[0].system.source.rules = "2014";
  const mismatch = await audit(f.fs);
  assert.ok(mismatch.diagnostics.some(d => d.code === "origin_source_mismatch" && d.severity === "error"));
  assert.deepEqual(f.writes, []);
});

test("complex origin trait choice pools are not falsely rejected as illegal", async () => {
  const f = originFixture();
  f.official[1].system.advancement[f.ids.bgTrait].configuration.choices = [
    { count: 1, pool: ["tool:game:*"] }, { count: 1, pool: ["skills:*"] } ];
  const report = await audit(f.fs);
  assert.ok(report.diagnostics.some(d => d.code === "origin_trait_complex_choice" && d.severity === "unverified"));
  assert.ok(!report.diagnostics.some(d => d.code === "invalid_origin_trait_choice"));
  assert.deepEqual(f.writes, []);
});

test("species advancement choices recorded above current character level are errors", async () => {
  const f = originFixture();
  const future = id("futureOriginSize");
  f.official[0].system.advancement[future] = { _id: future, type: "Size", level: 12,
    configuration: { sizes: ["sm", "med"] }, value: {} };
  f.race.system.advancement[future] = { value: { size: "med" } };
  const report = await audit(f.fs);
  assert.ok(report.diagnostics.some(d => d.code === "future_advancement_recorded" && d.severity === "error"));
  assert.deepEqual(f.writes, []);
});

test("official open feat choices accept allowed subtypes beyond the suggested compendium pool", async () => {
  const f = nestedFeatChoiceFixture();
  const report = await audit(f.fs);
  assert.equal(report.status, "passed_scoped_checks", JSON.stringify(report.diagnostics));
  assert.deepEqual(report.verified_sources.feats.sort(), [f.sources.defense, f.sources.alert].sort());
  assert.deepEqual(f.writes, []);
});

test("feat choice subtype mismatch and excess selections are proven errors", async () => {
  const f = nestedFeatChoiceFixture();
  f.featDocs.find(d => d._id === id("alert")).system.type.subtype = "general";
  f.style.system.advancement[f.ids.style].value.added["2"][id("extraStyle")] = f.sources.defense;
  const report = await audit(f.fs);
  assert.ok(report.diagnostics.some(d => d.code === "feat_choice_restriction_mismatch" && d.severity === "error"));
  assert.ok(report.diagnostics.some(d => d.code === "too_many_recorded_feat_choices" && d.severity === "error"));
  assert.deepEqual(f.writes, []);
});

test("closed ItemChoice pools reject a feat outside the source recommendations", async () => {
  const f = nestedFeatChoiceFixture();
  f.featureDocs[1].system.advancement[f.ids.versatile].configuration.allowDrops = false;
  const report = await audit(f.fs);
  assert.ok(report.diagnostics.some(d => d.code === "feat_choice_not_in_pool" && d.severity === "error"));
  assert.deepEqual(f.writes, []);
});

test("missing feat choice provenance stays unverified and historic non-level prerequisites are not guessed", async () => {
  const f = nestedFeatChoiceFixture();
  f.featDocs[0].system.prerequisites.items = ["fighting-style"];
  f.versatile.system.advancement[f.ids.versatile].value.added["0"] = {
    [id("oldAlertItem")]: f.sources.alert };
  const report = await audit(f.fs);
  assert.ok(report.diagnostics.some(d => d.code === "feat_historical_prerequisite" && d.severity === "unverified"));
  assert.ok(report.diagnostics.some(d => d.code === "stale_feat_item_id" && d.severity === "unverified"));
  assert.ok(!report.diagnostics.some(d => d.code === "feat_choice_restriction_mismatch"));
  assert.deepEqual(f.writes, []);
});

test("future nested feat choices and malformed group formats cannot silently pass", async () => {
  const f = nestedFeatChoiceFixture();
  f.featureDocs[0].system.advancement[f.ids.style].configuration.choices = { "12": { count: 1 } };
  f.style.system.advancement[f.ids.style].value.added = { "12": { [f.ids.defense]: f.sources.defense } };
  const future = await audit(f.fs);
  assert.ok(future.diagnostics.some(d => d.code === "future_feat_choice_recorded" && d.severity === "error"));
  f.versatile.system.advancement[f.ids.versatile].value.added = { [f.ids.alert]: f.sources.alert };
  const malformed = await audit(f.fs);
  assert.ok(malformed.diagnostics.some(d => d.code === "feat_choice_record_format_unverified" && d.severity === "unverified"));
  assert.deepEqual(f.writes, []);
});

test("single-class feat ASI checks the actual acquisition level, not today's higher level", async () => {
  const f = advancementFixture();
  f.actor.items = f.actor.items.filter(i => i.type !== "class" || i.system?.identifier === "paladin");
  const saved = f.actor.items[0].system.advancement;
  saved.find(a => a._id === f.ids.asi).value = { type: "feat", feat: { [id("ownedFeat")]: f.source.feat } };
  saved.find(a => a._id === f.ids.feat).value = { type: "asi", assignments: { dex: 1, cha: 1 } };
  f.featDoc.system.prerequisites.level = 6;
  const report = await audit(f.fs);
  assert.ok(report.diagnostics.some(d => d.code === "feat_level_prerequisite_unmet_at_choice" && d.severity === "error"));
  assert.ok(!report.diagnostics.some(d => d.code === "feat_level_prerequisite_unmet"));
  assert.deepEqual(f.writes, []);
});

test("multiclass feat history is unverified when earlier total character level is unknown", async () => {
  const f = advancementFixture();
  const saved = f.actor.items[0].system.advancement;
  saved.find(a => a._id === f.ids.asi).value = { type: "feat", feat: { [id("ownedFeat")]: f.source.feat } };
  saved.find(a => a._id === f.ids.feat).value = { type: "asi", assignments: { dex: 1, cha: 1 } };
  f.featDoc.system.prerequisites.level = 6;
  const unknown = await audit(f.fs);
  assert.ok(unknown.diagnostics.some(d => d.code === "feat_level_at_choice_unverified" && d.severity === "unverified"));
  assert.ok(!unknown.diagnostics.some(d => d.code === "feat_level_prerequisite_unmet_at_choice"));
  f.featDoc.system.prerequisites.level = 4;
  const proven = await audit(f.fs);
  assert.ok(!proven.diagnostics.some(d => d.code === "feat_level_at_choice_unverified"));
  assert.deepEqual(f.writes, []);
});

test("origin-granted feat choices have an exact creation level even after multiclassing", async () => {
  const f = nestedFeatChoiceFixture();
  const grant = f.official[0].system.advancement[id("originGrant")];
  grant.configuration.items.push({ uuid: f.sources.versatile, optional: false });
  f.race.system.advancement[id("originGrant")].value.added[f.versatile._id] = f.sources.versatile;
  f.featDocs.find(d => d._id === id("alert")).system.prerequisites.level = 4;
  const report = await audit(f.fs);
  assert.ok(report.diagnostics.some(d => d.code === "feat_level_prerequisite_unmet_at_choice" && d.severity === "error"));
  assert.deepEqual(f.writes, []);
});

test("verified single-class feature grants date their nested feat choices", async () => {
  const f = nestedFeatChoiceFixture();
  f.actor.items = f.actor.items.filter(i => i.type !== "class" || i.system?.identifier === "paladin");
  const grant = { _id: id("styleGrantTwo"), type: "ItemGrant", level: 2,
    configuration: { items: [{ uuid: f.sources.style, optional: false }] },
    value: { added: { [f.style._id]: f.sources.style } } };
  f.actor.items[0].system.advancement.push(structuredClone(grant));
  const originalDoc = f.fs.doc.bind(f.fs);
  f.fs.doc = async (action, type, opts = {}) => {
    const docs = await originalDoc(action, type, opts);
    if (action === "get" && type === "Item" && opts.pack === "dnd5e.classes24") {
      const paladin = docs.find(d => d._id === id("paladin"));
      if (paladin) paladin.system.advancement.push(structuredClone(grant));
    }
    return docs;
  };
  f.featDocs.find(d => d._id === id("defense")).system.prerequisites.level = 4;
  const report = await audit(f.fs);
  assert.ok(report.diagnostics.some(d => d.code === "feat_level_prerequisite_unmet_at_choice" && d.severity === "error"));
  assert.deepEqual(f.writes, []);
});

test("nested feats without a proven parent grant do not invent an acquisition date", async () => {
  const f = nestedFeatChoiceFixture();
  f.featDocs.find(d => d._id === id("alert")).system.prerequisites.level = 4;
  const report = await audit(f.fs);
  assert.ok(report.diagnostics.some(d => d.code === "feat_level_at_choice_unverified" && d.severity === "unverified"));
  assert.ok(!report.diagnostics.some(d => d.code === "feat_level_prerequisite_unmet_at_choice"));
  assert.deepEqual(f.writes, []);
});

test("an official feature grant without saved item provenance cannot date a feat", async () => {
  const f = nestedFeatChoiceFixture();
  f.official[0].system.advancement[id("originGrant")].configuration.items.push({
    uuid: f.sources.versatile, optional: false });
  // Versatile is owned, but its exact ItemGrant association was never saved.
  f.featDocs.find(d => d._id === id("alert")).system.prerequisites.level = 4;
  const report = await audit(f.fs);
  assert.ok(report.diagnostics.some(d => d.code === "feat_level_at_choice_unverified" && d.severity === "unverified"));
  assert.ok(!report.diagnostics.some(d => d.code === "feat_level_prerequisite_unmet_at_choice"));
  assert.deepEqual(f.writes, []);
});

test("official Paladin without a base cantrip scale has no false unavailable-scale warning", async () => {
  const f = fixture();
  const originalDoc = f.fs.doc.bind(f.fs);
  f.fs.doc = async (action, type, opts = {}) => {
    const docs = await originalDoc(action, type, opts);
    if (action === "get" && type === "Item" && opts.pack === "dnd5e.classes24") {
      const paladin = docs.find(d => d._id === id("paladin"));
      if (paladin) paladin.system.advancement = paladin.system.advancement.filter(a =>
        a.configuration?.identifier !== "cantrips-known");
    }
    return docs;
  };
  const report = await audit(f.fs);
  assert.ok(!report.diagnostics.some(d => d.code === "cantrip_scale_unavailable" && d.subject === f.actor.items[0]._id));
  assert.deepEqual(f.writes, []);
});

test("missing cantrip scales remain unverified for casters that do learn class cantrips", async () => {
  const f = fixture();
  const originalDoc = f.fs.doc.bind(f.fs);
  f.fs.doc = async (action, type, opts = {}) => {
    const docs = await originalDoc(action, type, opts);
    if (action === "get" && type === "Item" && opts.pack === "dnd5e.classes24") {
      const sorcerer = docs.find(d => d._id === id("sorcerer"));
      if (sorcerer) sorcerer.system.advancement = sorcerer.system.advancement.filter(a =>
        a.configuration?.identifier !== "cantrips-known");
    }
    return docs;
  };
  const report = await audit(f.fs);
  assert.ok(report.diagnostics.some(d => d.code === "cantrip_scale_unavailable" && d.subject === f.actor.items[1]._id));
  assert.deepEqual(f.writes, []);
});

test("Paladin with a recorded ordinary class cantrip still needs verified scale or feature evidence", async () => {
  const f = fixture();
  // Inconsistent saved spell level, but an attributed official class-list UUID:
  // the absence of a baseline scale must still be flagged, not ignored.
  const suspicious = makeSpell("cure", 0, "paladin");
  suspicious.system.level = 0;
  f.actor.items.push(suspicious);
  const originalDoc = f.fs.doc.bind(f.fs);
  f.fs.doc = async (action, type, opts = {}) => {
    const docs = await originalDoc(action, type, opts);
    if (action === "get" && type === "Item" && opts.pack === "dnd5e.classes24") {
      const paladin = docs.find(d => d._id === id("paladin"));
      if (paladin) paladin.system.advancement = paladin.system.advancement.filter(a =>
        a.configuration?.identifier !== "cantrips-known");
    }
    return docs;
  };
  const report = await audit(f.fs);
  assert.ok(report.diagnostics.some(d => d.code === "cantrip_scale_unavailable" && d.subject === f.actor.items[0]._id));
  assert.deepEqual(f.writes, []);
});

test("Fighting Style prerequisite is proven by the exact official feature and saved grant", async () => {
  const f = nestedFeatChoiceFixture();
  proveFightingStyleGrant(f);
  const report = await audit(f.fs);
  assert.ok(!report.diagnostics.some(d => d.code === "feat_historical_prerequisite" && d.subject === f.style._id));
  assert.deepEqual(report.summary, { errors: 0, warnings: 0, unverified: 0 });
  assert.deepEqual(f.writes, []);
});

test("Fighting Style prerequisite remains unverified when the saved grant or another condition is missing", async () => {
  const f = nestedFeatChoiceFixture();
  const grant = proveFightingStyleGrant(f);
  f.actor.items[0].system.advancement.find(a => a._id === grant._id).value.added = {};
  const missing = await audit(f.fs);
  assert.ok(missing.diagnostics.some(d => d.code === "feat_historical_prerequisite" && d.subject === f.style._id));
  f.actor.items[0].system.advancement.find(a => a._id === grant._id).value.added = {
    [f.style._id]: f.sources.style };
  f.featDocs[0].system.prerequisites.items = ["fighting-style", "unverified-special-condition"];
  const extra = await audit(f.fs);
  assert.ok(extra.diagnostics.some(d => d.code === "feat_historical_prerequisite" && d.subject === f.style._id));
  assert.deepEqual(f.writes, []);
});

test("duplicate Fighting Style feature copies cannot borrow another item's saved grant proof", async () => {
  const f = nestedFeatChoiceFixture();
  proveFightingStyleGrant(f);
  const copy = structuredClone(f.style);
  copy._id = id("ungrantedStyleCopy");
  f.actor.items.push(copy);
  const report = await audit(f.fs);
  assert.ok(report.diagnostics.some(d => d.code === "feat_historical_prerequisite" && d.subject === copy._id));
  assert.ok(!report.diagnostics.some(d => d.code === "feat_historical_prerequisite" && d.subject === f.style._id));
  assert.deepEqual(f.writes, []);
});
