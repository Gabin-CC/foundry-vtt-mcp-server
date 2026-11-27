import assert from "node:assert/strict";
import { test } from "node:test";
import { advancementBlueprint, compareAdvancementSheets } from "../src/advancement-replay.mjs";

const classId = "sourceClass000001";
const official = "Compendium.dnd5e.classes24.Item.phbclcCleric0000";
const clone = v => structuredClone(v);
const asi = (id, level, value) => ({ _id: id, type: "AbilityScoreImprovement", level, value });
const feat = (id, name, origin, advancement) => ({
  _id: id, name, type: "feat", flags: { dnd5e: { advancementRoot: origin } },
  system: { advancement }
});

function sourceActor() {
  return {
    _id: "originalActor001", name: "Original Cleric", type: "character",
    system: { abilities: { str: { value: 8 }, dex: { value: 14 }, con: { value: 16 },
      int: { value: 10 }, wis: { value: 20 }, cha: { value: 10 } } },
    items: [
      { _id: "sourceBackground1", name: "Sage", type: "background", system: { advancement: [
        asi("backgroundASI000", 0, { type: "asi", assignments: { con: 1, wis: 2 } })
      ] } },
      { _id: classId, name: "Cleric", type: "class", _stats: { compendiumSource: official },
        system: { identifier: "cleric", levels: 12, advancement: [
          { _id: "hitPoints0000001", type: "HitPoints", value: { 1: "max", ...Object.fromEntries(
            Array.from({ length: 11 }, (_, i) => [i + 2, "avg"])) } },
          asi("classASI40000001", 4, { type: "feat", feat: { warFeatId0000001: "Compendium.world.dons.Item.warCasterFeat001" } }),
          asi("classASI80000001", 8, { type: "asi", assignments: { wis: 2 } }),
          asi("classASI12000001", 12, { type: "feat", feat: { resilientFeat001: "Compendium.world.dons.Item.resilientFeat001" } }),
          { _id: "classSubclass001", type: "Subclass", level: 3, value: { uuid: "Compendium.world.classes.Item.lightDomain00001" } },
          { _id: "classSkills000001", type: "Trait", level: 1, value: { chosen: ["skills:ins", "skills:rel"] } }
        ] } },
      feat("warFeatId0000001", "War Caster", classId + ".classASI40000001",
        [asi("warCasterASI0001", 0, { type: "asi", assignments: { wis: 1 } })]),
      feat("resilientFeat001", "Resilient", classId + ".classASI12000001",
        [asi("resilientASI0001", 0, { type: "asi", assignments: { con: 1 } }),
          { _id: "resilientSave001", type: "Trait", value: { chosen: ["saves:con"] } }]),
      feat("divineOrder00001", "Divine Order", classId + ".classGrant000001", [
        { _id: "divineItemChoice1", type: "ItemChoice",
          configuration: { choices: { 1: { count: 1 } } },
          value: { added: { 0: { "choiceItem000001": "Compendium.dnd5e.classes24.Item.phbDivineOrderTh" } } } }
      ]),
      { _id: "nestedFeature0001", name: "Nested feature", type: "feat",
        flags: { dnd5e: { advancementOrigin: "divineOrder00001.choice000000001" } },
        system: { advancement: [
          { _id: "nestedFeatureItem", type: "ItemChoice",
            configuration: { choices: { 1: { count: 1 } } },
            value: { added: { 0: { "nestedItem000001": "Compendium.dnd5e.feats24.Item.nestedFeat000001" } } } }
        ] } }
    ]
  };
}

test("replay gathers recorded class, nested feat, subclass, trait and ItemChoice decisions", () => {
  const source = sourceActor(), before = clone(source);
  const p = advancementBlueprint(source);
  assert.equal(p.class_source, official);
  assert.equal(p.level, 12);
  assert.deepEqual(p.base_abilities, { str: 8, dex: 14, con: 15, int: 10, wis: 17, cha: 10 });
  assert.deepEqual(p.pre_origin_abilities, { str: 8, dex: 14, con: 14, int: 10, wis: 15, cha: 10 });
  assert.equal(p.hp_mode, "avg");
  assert.deepEqual(p.choices["classASI40000001@4"], { feat: "Compendium.world.dons.Item.warCasterFeat001" });
  assert.deepEqual(p.choices["classASI80000001@8"], { wis: 2 });
  assert.equal(p.choices["classSubclass001@3"], "Compendium.world.classes.Item.lightDomain00001");
  assert.deepEqual(p.choices["classSkills000001@1"], ["skills:ins", "skills:rel"]);
  assert.deepEqual(p.choices["divineItemChoice1@1"], ["Compendium.dnd5e.classes24.Item.phbDivineOrderTh"]);
  assert.deepEqual(p.choices["nestedFeatureItem@1"], ["Compendium.dnd5e.feats24.Item.nestedFeat000001"]);
  assert.deepEqual(p.choices["resilientASI0001"], { con: 1 });
  assert.deepEqual(p.choices["resilientSave001"], ["saves:con"]);
  assert.deepEqual(source, before, "inspection must not mutate the original actor");
});

test("replay refuses missing or ambiguous class provenance", () => {
  const noSource = sourceActor(); delete noSource.items[1]._stats;
  assert.throws(() => advancementBlueprint(noSource), /no verifiable compendium source/);
  const multi = sourceActor(); multi.items.push({ type: "class", name: "Fighter", system: { levels: 1 } });
  assert.throws(() => advancementBlueprint(multi), /exactly one class/);
});

test("replay does not infer a choice missing from the saved advancement", () => {
  const source = sourceActor();
  source.items[1].system.advancement.find(x => x.level === 3).value = {};
  const p = advancementBlueprint(source);
  assert.equal(p.choices["classSubclass001@3"], undefined);
});

test("structural comparison reports missing spells, feats and inventory without relying on item IDs", () => {
  const a = { niveau: 12, classes: "Cleric 12", pv: { max: 99 }, caracs: { WIS: "20" },
    aptitudes: ["Light Domain", "War Caster"], objets: ["Shield (AAAAAAAAAAAAAAAA)", "Shield (BBBBBBBBBBBBBBBB)"],
    sorts_par_niveau: { 1: ["Bless", "Shield of Faith"] } };
  const b = { ...a, pv: { max: 95 }, aptitudes: ["War Caster"],
    objets: ["Shield (CCCCCCCCCCCCCCCC)"], sorts_par_niveau: { 1: ["Bless"] } };
  const diff = compareAdvancementSheets(a, b);
  assert.equal(diff.conforme, false);
  assert.deepEqual(diff.differences_de_contenu.aptitudes.manquants, ["Light Domain"]);
  assert.deepEqual(diff.differences_de_contenu.objets.manquants, ["Shield"]);
  assert.deepEqual(diff.differences_de_contenu.sorts_niveau_1.manquants, ["Shield of Faith"]);
  assert.equal(diff.differences_de_valeurs.pv.target.max, 95);
});

test("advance replays an ASI automatically and remains non-mutating while equipment choice is missing", async () => {
  process.env.NO_LISTEN = "1";
  const { handleTool } = await import("../src/server.mjs");
  const source = sourceActor();
  source.items = [source.items[1]];
  source.items[0].system.levels = 4;
  source.items[0].system.advancement = [
    { _id: "hitPoints0000001", type: "HitPoints", value: { 1: "max", 2: "avg", 3: "avg", 4: "avg" } },
    asi("classASI80000001", 4, { type: "asi", assignments: { wis: 2 } })
  ];
  const target = { _id: "blankTarget000001", name: "Test blank", type: "character", system: {
    abilities: { str: { value: 10 }, dex: { value: 10 }, con: { value: 10 },
      int: { value: 10 }, wis: { value: 10 }, cha: { value: 10 } }
  }, items: [] };
  const officialClass = { _id: "phbclcCleric0000", name: "Cleric", type: "class",
    system: { identifier: "cleric", levels: 1, advancement: [
      { _id: "hitPoints0000001", type: "HitPoints", configuration: {}, value: {} },
      asi("classASI80000001", 4, {}),
    ], startingEquipment: [
      { _id: "equipOR000000001", type: "OR", sort: 0 },
      { _id: "equipCurrency001", type: "currency", group: "equipOR000000001", key: "gp", count: 100 },
      { _id: "equipCurrency002", type: "currency", group: "equipOR000000001", key: "gp", count: 50 }
    ] } };
  const writes = [];
  const actors = [source, target];
  const session = {
    user: { role: 4, name: "GM" }, userId: "gmUser0000000001", world: { id: "test" },
    async worldData() { return { packs: [{ id: "dnd5e.classes24", type: "Item", packageName: "dnd5e" }] }; },
    async doc(action, type, opts = {}) {
      if (action !== "get") { writes.push({ action, type, opts }); return []; }
      if (type === "Setting") return [];
      if (type === "Actor") return clone(actors.filter(x => !opts.query?._id || x._id === opts.query._id));
      if (type === "Item" && opts.pack === "dnd5e.classes24") return [clone(officialClass)];
      if (type === "Item" && opts.parentUuid) return [];
      return [];
    }
  };
  const result = await handleTool(session, { name: "advance", arguments: {
    actor: target._id, replay_from: source._id
  } });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  const body = JSON.parse(result.content[0].text);
  assert.deepEqual(body.choix_requis.map(x => x.type), ["StartingEquipment"]);
  assert.equal(body.rejeu_depuis, source._id);
  assert.deepEqual(writes, [], "pending choices must not write anything");
  target.items.push({ _id: "badClericItem001", name: "Cleric", type: "class",
    _stats: { compendiumSource: "Compendium.world.classes.Item.badCleric000001" },
    system: { identifier: "cleric", levels: 1, advancement: [] } });
  const mismatch = await handleTool(session, { name: "advance", arguments: {
    actor: target._id, item: "badClericItem001", replay_from: source._id
  } });
  assert.equal(mismatch.isError, true, "replay must reject a different class compendium source");
  assert.match(mismatch.content[0].text, /original class source|classe d'origine/);
  assert.deepEqual(writes, [], "source mismatch must not write anything");
});
