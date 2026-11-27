import assert from "node:assert/strict";
import { test } from "node:test";
import { planActorBuild } from "../src/actor-build.mjs";

process.env.NO_LISTEN = "1";
const id = text => (text + "Z".repeat(16)).slice(0, 16);
const source = (pack, suffix) => `Compendium.${pack}.Item.${id(suffix)}`;
const CLASS = source("dnd5e.classes24", "cleric24");
const SPECIES = source("dnd5e.origins24", "human24");
const BACKGROUND = source("dnd5e.origins24", "sage24");
const ABILITIES = { str: 8, dex: 14, con: 12, int: 10, wis: 15, cha: 10 };
const CHOICES = {
  [id("backgroundASI")]: { con: 1, wis: 2 },
  [`equip:${id("classEquipment")}`]: id("takeGold")
};
const request = (overrides = {}) => ({
  name: "New 2024 Cleric", level: 2,
  class_source: CLASS, species_source: SPECIES, background_source: BACKGROUND,
  abilities: ABILITIES, choices: CHOICES, ...overrides
});

function fixture() {
  const doc = (uuid, name, type, system) => ({
    _id: uuid.split(".").at(-1), name, type, _stats: { compendiumSource: uuid },
    system: { source: { rules: "2024" }, advancement: [], ...system }
  });
  const cls = doc(CLASS, "Cleric", "class", { identifier: "cleric", levels: 0,
    hitDice: "d8", advancement: [
      { _id: id("classHP"), type: "HitPoints", configuration: {}, value: {} }
    ], startingEquipment: [
      { _id: id("classEquipment"), type: "OR", group: "" },
      { _id: id("takeGold"), type: "currency", key: "gp", count: 50, group: id("classEquipment") },
      { _id: id("takeMoreGold"), type: "currency", key: "gp", count: 100, group: id("classEquipment") }
    ] });
  const species = doc(SPECIES, "Human", "race", { advancement: [] });
  const background = doc(BACKGROUND, "Sage", "background", { advancement: [
    { _id: id("backgroundASI"), type: "AbilityScoreImprovement", level: 0,
      configuration: { points: 3, cap: 20 }, value: {} }
  ] });
  const sources = [cls, species, background];
  const actors = [], writes = [];
  let failOnItemCreate = false;
  const setPath = (obj, dotted, value) => {
    const keys = dotted.split(".");
    let p = obj;
    for (const key of keys.slice(0, -1)) p = p[key] ??= {};
    p[keys.at(-1)] = structuredClone(value);
  };
  const session = {
    userId: id("gm"), user: { role: 4, name: "GM" }, world: { id: "build-test" },
    async worldData() { return { packs: ["dnd5e.classes24", "dnd5e.origins24"].map(id =>
      ({ id, type: "Item", packageName: "dnd5e" })) }; },
    async doc(action, type, opts = {}) {
      if (action === "get") {
        if (type === "Setting") return [];
        if (type === "Actor") return structuredClone(actors.filter(x => !opts.query?._id || x._id === opts.query._id));
        if (type === "Item" && opts.pack) return structuredClone(sources.filter(x =>
          x._id === opts.query?._id && x._stats.compendiumSource.startsWith(`Compendium.${opts.pack}.`)));
        if (type === "Item" && opts.parentUuid) {
          const actor = actors.find(x => `Actor.${x._id}` === opts.parentUuid);
          return structuredClone((actor?.items || []).filter(x => !opts.query?.type || x.type === opts.query.type));
        }
        return [];
      }
      writes.push({ action, type, opts: structuredClone(opts) });
      if (action === "create") {
        if (type === "Actor") {
          const rows = opts.data.map((data, n) => ({
            _id: id(`actor${actors.length + n}`), ...structuredClone(data), items: [],
            system: { attributes: { hp: { value: 0 } }, spells: {}, details: {},
              currency: {}, abilities: {}, skills: {}, tools: {}, traits: {}, ...structuredClone(data.system) }
          }));
          actors.push(...rows); return structuredClone(rows);
        }
        if (type === "Item") {
          if (failOnItemCreate) throw new Error("Mocked item-create failure");
          const actor = actors.find(x => `Actor.${x._id}` === opts.parentUuid);
          const rows = opts.data.map((data, n) => ({ ...structuredClone(data),
            _id: opts.keepId && data._id ? data._id : id(`item${writes.length}_${n}`) }));
          actor.items.push(...rows); return structuredClone(rows);
        }
      }
      if (action === "update") {
        const rows = type === "Actor" ? actors : actors.find(x => `Actor.${x._id}` === opts.parentUuid)?.items || [];
        for (const update of opts.updates || []) {
          const row = rows.find(x => x._id === update._id);
          for (const [key, value] of Object.entries(update)) if (key !== "_id") setPath(row, key, value);
        }
        return structuredClone((opts.updates || []).map(u => rows.find(x => x._id === u._id)));
      }
      throw new Error(`Unexpected ${action} ${type}`);
    }
  };
  return { session, actors, writes, sources, set failOnItemCreate(value) { failOnItemCreate = value; } };
}

test("build preflight lists missing origins and ability scores without fetching or writing", async () => {
  const f = fixture();
  const p = await planActorBuild(f.session, { name: "New character" });
  assert.equal(p.pret, false);
  assert.equal(p.parametres_requis.length, 9);
  assert.deepEqual(f.writes, []);
});

test("2024 compendium source verification rejects 2014 and mismatched item types", async () => {
  const f = fixture();
  f.sources[1].system.source.rules = "2014";
  await assert.rejects(planActorBuild(f.session, request()), /D&D 2024/);
  f.sources[1].system.source.rules = "2024";
  f.sources[2].type = "race";
  await assert.rejects(planActorBuild(f.session, request()), /expected background/);
  assert.deepEqual(f.writes, []);
});

test("invalid base score, level or compendium UUID is refused before mutations", async () => {
  const f = fixture();
  await assert.rejects(planActorBuild(f.session, request({ abilities: { ...ABILITIES, wis: 20 } })), /3 to 18/);
  await assert.rejects(planActorBuild(f.session, request({ level: 21 })), /1 to 20/);
  await assert.rejects(planActorBuild(f.session, request({ class_source: "Cleric" })), /Compendium/);
  assert.deepEqual(f.writes, []);
});

test("equipment and background ASI choices are required in a write-free preview", async () => {
  const f = fixture();
  const p = await planActorBuild(f.session, request({ choices: {} }));
  assert.equal(p.pret, false);
  assert.ok(p.choix_requis.some(x => x.id === `equip:${id("classEquipment")}`));
  assert.ok(p.choix_requis.some(x => x.id === id("backgroundASI")));
  assert.deepEqual(f.writes, []);
});

test("full preview succeeds with exact 2024 sources, abilities and saved choices", async () => {
  const f = fixture();
  const p = await planActorBuild(f.session, request());
  assert.equal(p.pret, true, JSON.stringify(p.choix_requis));
  assert.deepEqual(p.etapes.map(x => x.type), ["class", "race", "background"]);
  assert.deepEqual(p.caracteristiques_initiales, ABILITIES);
  assert.deepEqual(f.writes, []);
});

test("spellcasting preflight requests spell choices only with explicit spells=all", async () => {
  const f = fixture();
  f.sources[0].system.spellcasting = { progression: "full", ability: "wis" };
  f.sources[0].system.advancement.push({ _id: id("cantripScale"), type: "ScaleValue",
    configuration: { identifier: "cantrips-known", scale: { 1: { value: 2 } } } });
  const without = await planActorBuild(f.session, request());
  assert.equal(without.pret, true);
  assert.ok(without.avertissements.some(x => x.includes("not requested")));
  const withAll = await planActorBuild(f.session, request({ spells: "all" }));
  assert.equal(withAll.pret, false);
  assert.ok(withAll.choix_requis.some(x => x.id === "spells:cantrips"));
  assert.deepEqual(f.writes, []);
});

test("spells:* choices with spells=none are disclosed as ignored, not applied implicitly", async () => {
  const f = fixture();
  const p = await planActorBuild(f.session, request({ choices: {
    ...CHOICES, "spells:cantrips": [source("dnd5e.spells24", "light")]
  } }));
  assert.equal(p.pret, true);
  assert.ok(p.avertissements.some(x => x.includes("ignored")));
  assert.deepEqual(f.writes, []);
});

test("build_actor applies to a new actor and preserves existing actors", async () => {
  const f = fixture();
  const original = { _id: id("original"), name: "Existing hero", type: "character", items: [],
    system: { abilities: { str: { value: 9 } } } };
  f.actors.push(original);
  const unchanged = structuredClone(original);
  const { handleTool } = await import("../src/server.mjs");
  const preview = await handleTool(f.session, { name: "build_actor", arguments: request() });
  assert.equal(preview.isError, undefined, JSON.stringify(preview));
  assert.equal(JSON.parse(preview.content[0].text).pret, true);
  assert.deepEqual(f.writes, []);
  const applied = await handleTool(f.session, { name: "build_actor", arguments: request({ apply: true }) });
  assert.equal(applied.isError, undefined, JSON.stringify(applied));
  const result = JSON.parse(applied.content[0].text);
  assert.equal(result.simulation, false, JSON.stringify(result));
  assert.equal(result.niveau, 2);
  assert.equal(f.actors.length, 2);
  assert.deepEqual(f.actors[0], unchanged);
  assert.equal(f.actors[1].system.abilities.con.value, 13);
  assert.equal(f.actors[1].system.abilities.wis.value, 17);
  assert.equal(f.actors[1].system.currency.gp, 50);
  assert.deepEqual(f.actors[1].items.filter(x => ["class", "race", "background"].includes(x.type))
    .map(x => x.type), ["class", "race", "background"]);
});

test("build_actor refuses to create while required equipment choice is unresolved", async () => {
  const f = fixture();
  const { handleTool } = await import("../src/server.mjs");
  const res = await handleTool(f.session, { name: "build_actor", arguments: request({ apply: true, choices: {} }) });
  const p = JSON.parse(res.content[0].text);
  assert.equal(p.simulation, true);
  assert.ok(p.choix_requis.length);
  assert.deepEqual(f.writes, []);
  assert.equal(f.actors.length, 0);
});

test("partial build failure identifies the recoverable target without deleting actors", async () => {
  const f = fixture();
  f.failOnItemCreate = true;
  const { handleTool } = await import("../src/server.mjs");
  const res = await handleTool(f.session, { name: "build_actor", arguments: request({ apply: true }) });
  const p = JSON.parse(res.content[0].text);
  assert.match(p.erreur, /Mocked item-create failure/);
  assert.equal(p.acteur_partiel.name, "New 2024 Cleric");
  assert.equal(f.actors.length, 1);
  assert.equal(f.writes.some(x => x.action === "delete"), false);
});

test("duplicate target names are rejected before applying any changes", async () => {
  const f = fixture();
  f.actors.push({ _id: id("existing"), name: "new 2024 cleric", type: "character", items: [] });
  const { handleTool } = await import("../src/server.mjs");
  const res = await handleTool(f.session, { name: "build_actor", arguments: request({ apply: true }) });
  assert.equal(res.isError, true);
  assert.deepEqual(f.writes, []);
});
