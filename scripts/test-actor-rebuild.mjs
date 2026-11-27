import assert from "node:assert/strict";
import { test } from "node:test";
import { planActorRebuild, reconcileActorItems, copyResidualItems, copyResidualActorEffects,
  syncRebuiltItemState, compareRebuiltItemDetails } from "../src/actor-rebuild.mjs";
import { recordedActorChoices } from "../src/advancement-replay.mjs";

process.env.NO_LISTEN = "1";
globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });
const CLS = "phbclcCleric0000", RACE = "phbspHuman000000", BG = "phbbgSage0000000";
const VERSATILE = "phbsptVersatile0", ALERT = "phbftAlert000000";
const sourceOf = (pack, id) => `Compendium.${pack}.Item.${id}`;
const uid = (v, ch = "A") => (v + ch.repeat(16)).slice(0, 16);
const item = (id, name, type, uuid, advancement = [], extra = {}) => ({
  _id: id, name, type, _stats: { compendiumSource: uuid },
  system: { advancement }, ...extra
});
const asi = (id, level, points, saved = {}) => ({ _id: id, type: "AbilityScoreImprovement", level,
  configuration: { points }, value: saved });

function fixture() {
  const clsUuid = sourceOf("dnd5e.classes24", CLS);
  const raceUuid = sourceOf("dnd5e.origins24", RACE);
  const bgUuid = sourceOf("dnd5e.origins24", BG);
  const versatileUuid = sourceOf("dnd5e.origins24", VERSATILE);
  const alertUuid = sourceOf("dnd5e.feats24", ALERT);
  const rootClass = item(uid("rootClass"), "Cleric", "class", clsUuid, [
    { _id: uid("hitPoints"), type: "HitPoints", value: { 1: "max", 2: "avg" } },
    asi(uid("classWis"), 2, 2, { type: "asi", assignments: { wis: 2 } })
  ], { system: { levels: 2, identifier: "cleric", advancement: [
    { _id: uid("hitPoints"), type: "HitPoints", value: { 1: "max", 2: "avg" } },
    asi(uid("classWis"), 2, 2, { type: "asi", assignments: { wis: 2 } })
  ] } });
  const rootRace = item(uid("rootRace"), "Human", "race", raceUuid, [
    { _id: uid("sizeChoice"), type: "Size", value: { size: "med" } },
    { _id: uid("humanGrant"), type: "ItemGrant", value: { added: { [uid("verseItem")]: versatileUuid } } }
  ]);
  const rootBackground = item(uid("rootBackground"), "Sage", "background", bgUuid, [
    asi(uid("backgroundWis"), 0, 3, { type: "asi", assignments: { wis: 2, con: 1 } })
  ]);
  const versatile = item(uid("verseItem"), "Versatile", "feat", versatileUuid, [
    { _id: uid("featChoice"), type: "ItemChoice", configuration: { choices: { 0: { count: 1 } }, restriction: { type: "feat", subtype: "origin" } },
      value: { added: {}, replaced: {} } }
  ], { flags: { dnd5e: { advancementOrigin: `${rootRace._id}.${uid("humanGrant")}` } } });
  const alert = item(uid("alertItem"), "Alert", "feat", alertUuid, [], {
    flags: { dnd5e: { advancementOrigin: `${versatile._id}.${uid("featChoice")}` } }
  });
  const actor = {
    _id: uid("sourceActor"), name: "Original", type: "character", items: [rootClass, rootRace, rootBackground, versatile, alert],
    system: { abilities: { str: { value: 8 }, dex: { value: 14 }, con: { value: 13 },
      int: { value: 10 }, wis: { value: 16 }, cha: { value: 10 } } }
  };
  const sourceDocs = [
    item(CLS, "Cleric", "class", clsUuid, [
      { _id: uid("hitPoints"), type: "HitPoints", configuration: {}, value: {} },
      asi(uid("classWis"), 2, 2)
    ], { system: { identifier: "cleric", advancement: [
      { _id: uid("hitPoints"), type: "HitPoints", configuration: {}, value: {} },
      asi(uid("classWis"), 2, 2)
    ], startingEquipment: [
      { _id: uid("classEq"), type: "OR", group: "" },
      { _id: uid("coinA"), type: "currency", group: uid("classEq"), key: "gp", count: 50 },
      { _id: uid("coinB"), type: "currency", group: uid("classEq"), key: "gp", count: 100 }
    ] } }),
    item(RACE, "Human", "race", raceUuid, [
      { _id: uid("sizeChoice"), type: "Size", configuration: { sizes: ["med","sm"] }, value: {} },
      { _id: uid("humanGrant"), type: "ItemGrant", configuration: { items: [{ uuid: versatileUuid }] }, value: {} }
    ]),
    item(BG, "Sage", "background", bgUuid, [
      asi(uid("backgroundWis"), 0, 3)
    ], { system: { advancement: [asi(uid("backgroundWis"), 0, 3)], startingEquipment: [
      { _id: uid("bgEq"), type: "OR", group: "" },
      { _id: uid("bgCoinA"), type: "currency", group: uid("bgEq"), key: "gp", count: 50 },
      { _id: uid("bgCoinB"), type: "currency", group: uid("bgEq"), key: "gp", count: 100 }
    ] } }),
    item(VERSATILE, "Versatile", "feat", versatileUuid, [
      { _id: uid("featChoice"), type: "ItemChoice", configuration: {
        choices: { 0: { count: 1 } }, restriction: { type: "feat", subtype: "origin" }
      }, value: {} }
    ]),
    item(ALERT, "Alert", "feat", alertUuid)
  ];
  const packs = ["dnd5e.classes24", "dnd5e.origins24", "dnd5e.feats24"];
  const writes = [];
  const session = {
    userId: uid("gm"), user: { role: 4, name: "GM" }, world: { id: "rebuild-test" },
    async worldData() { return { packs: packs.map(id => ({ id, type: "Item", packageName: "dnd5e" })) }; },
    async doc(action, type, opts = {}) {
      if (action !== "get") { writes.push({ action, type, opts }); return []; }
      if (type === "Setting") return [];
      if (type === "Actor") return [structuredClone(actor)].filter(x => !opts.query?._id || x._id === opts.query._id);
      if (type === "Item" && opts.pack) return structuredClone(sourceDocs.filter(x =>
        x._id === opts.query?._id && x._stats.compendiumSource.startsWith(`Compendium.${opts.pack}.`)));
      return [];
    }
  };
  return { actor, sourceDocs, session, writes, rootClass, rootRace, rootBackground, versatile, alert };
}

test("item-origin reference recovers an origin feat missing from ItemChoice.value.added", () => {
  const { actor, versatile, alert, rootRace } = fixture();
  const r = recordedActorChoices(actor, [rootRace._id]);
  assert.deepEqual(r.choices[uid("featChoice")], [alert._stats.compendiumSource]);
  assert.ok(r.recorded.some(x => x.key === uid("featChoice") && x.recovered_from_item_origin));
  assert.equal(versatile.system.advancement[0].value.added && Object.keys(versatile.system.advancement[0].value.added).length, 0);
});

test("full rebuild plans class, species and background without prompting for starting equipment", async () => {
  const { actor, session, writes } = fixture();
  const plan = await planActorRebuild(session, actor);
  assert.equal(plan.ready, true, JSON.stringify(plan.pending));
  assert.deepEqual(plan.stages.map(x => x.type), ["class", "race", "background"]);
  assert.deepEqual(plan.blueprint.pre_origin_abilities, { str: 8, dex: 14, con: 12, int: 10, wis: 12, cha: 10 });
  assert.equal(plan.choices[uid("featChoice")][0], sourceOf("dnd5e.feats24", ALERT));
  assert.deepEqual(writes, [], "preflight must not modify Foundry");
});

test("unrecorded origin choice remains a blocker: no invented feat", async () => {
  const { actor, session, writes, alert } = fixture();
  actor.items = actor.items.filter(i => i._id !== alert._id);
  const plan = await planActorRebuild(session, actor);
  assert.equal(plan.ready, false);
  assert.ok(plan.pending.some(x => x.type === "ItemChoice"));
  assert.deepEqual(writes, []);
});

test("inventory reconciliation preserves duplicate counts and distinguishes generated from missing", () => {
  const spell = sourceOf("dnd5e.spells24", uid("bless"));
  const a = item(uid("spellA"), "Bless", "spell", spell);
  const b = item(uid("spellB"), "Bless", "spell", spell);
  const generated = item(uid("genSpell"), "Bless", "spell", spell);
  const { mapping, toCopy, additional } = reconcileActorItems([a, b], [generated]);
  assert.equal(mapping.get(a._id), generated._id);
  assert.deepEqual(toCopy.map(x => x._id), [b._id]);
  assert.deepEqual(additional, []);
});

test("residual copy keeps container references, marks provenance and leaves the source unchanged", async () => {
  const lootUuid = sourceOf("dnd5e.items", uid("bag"));
  const container = item(uid("bagSource"), "Bag", "container", lootUuid);
  const gem = item(uid("gemSource"), "Gem", "loot", null, [], {
    system: { container: container._id, quantity: 2, advancement: [] }
  });
  const source = { _id: uid("sourceActor"), items: [container, gem] };
  const target = { _id: uid("targetActor"), items: [] };
  const original = structuredClone(source);
  const writes = [];
  const fs = { async doc(action, type, opts) {
    writes.push({ action, type, opts });
    return opts.data.map(x => ({ _id: x._id, name: x.name, type: x.type }));
  } };
  const res = await copyResidualItems(fs, source, target);
  assert.equal(res.copied.length, 2);
  assert.equal(writes[0].opts.data[1].system.container, container._id);
  assert.equal(writes[0].opts.data[1].flags.mcp.rebuildCopiedFrom, `Actor.${source._id}.Item.${gem._id}`);
  assert.deepEqual(source, original);
});

test("actor-level effects are copied with their item origin remapped", async () => {
  const src = uid("sourceActor"), dst = uid("targetActor"), oldItem = uid("oldFeat"), newItem = uid("newFeat");
  const source = { _id: src, effects: [
    { _id: uid("effect"), name: "Blessing", changes: [{ key: "system.attributes.ac.bonus", value: "1" }],
      origin: `Actor.${src}.Item.${oldItem}` }
  ] };
  const writes = [];
  const fs = { async doc(action, type, opts) { writes.push({ action, type, opts }); return opts.data; } };
  const count = await copyResidualActorEffects(fs, source, { _id: dst, effects: [] }, new Map([[oldItem, newItem]]));
  assert.equal(count, 1);
  assert.equal(writes[0].type, "ActiveEffect");
  assert.equal(writes[0].opts.data[0].origin, `Actor.${dst}.Item.${newItem}`);
  assert.equal(writes[0].opts.data[0]._id, undefined);
});

test("rebuilt item states are restored and compared beyond their names", async () => {
  const srcId = uid("sourceSpell"), dstId = uid("newSpell");
  const src = item(srcId, "Bless", "spell", sourceOf("dnd5e.spells24", uid("bless")), [], {
    system: { advancement: [], prepared: 2, method: "spell", uses: { spent: 1, max: "2" } }
  });
  const dst = item(dstId, "Bless", "spell", sourceOf("dnd5e.spells24", uid("bless")), [], {
    system: { advancement: [], prepared: 0, method: "spell", uses: { spent: 0, max: "2" } }
  });
  const a = { _id: uid("sourceActor"), items: [src] }, b = { _id: uid("targetActor"), items: [dst] };
  assert.equal(compareRebuiltItemDetails(a, b).conforme, false);
  const writes = [];
  const fs = { async doc(action, type, opts) { writes.push({ action, type, opts }); return opts.updates; } };
  const n = await syncRebuiltItemState(fs, a, b, new Map([[srcId, dstId]]));
  assert.equal(n, 1);
  assert.equal(writes[0].opts.updates[0]["system.prepared"], 2);
  assert.deepEqual(writes[0].opts.updates[0]["system.uses"], { spent: 1, max: "2" });
  dst.system.prepared = 2; dst.system.uses = { spent: 1, max: "2" };
  assert.equal(compareRebuiltItemDetails(a, b).conforme, true);
});

test("rebuild_actor preview is read-only and apply builds a separate character", async () => {
  const { actor, sourceDocs, session } = fixture();
  actor.system.attributes = { hp: { value: 15 } };
  actor.system.currency = { gp: 123 };
  const original = structuredClone(actor);
  const actors = [actor], writes = [];
  let failOnItemCreate = false;
  const setPath = (obj, dotted, value) => {
    const keys = dotted.split(".");
    let p = obj;
    for (const key of keys.slice(0, -1)) p = p[key] ??= {};
    p[keys.at(-1)] = structuredClone(value);
  };
  const mutableSession = { ...session, async doc(action, type, opts = {}) {
    if (action === "get") {
      if (type === "Setting") return [];
      if (type === "Actor") return structuredClone(actors.filter(x => !opts.query?._id || x._id === opts.query._id));
      if (type === "Item" && opts.pack) return structuredClone(sourceDocs.filter(x =>
        x._id === opts.query?._id && x._stats.compendiumSource.startsWith(`Compendium.${opts.pack}.`)));
      if (type === "Item" && opts.parentUuid) {
        const owner = actors.find(x => `Actor.${x._id}` === opts.parentUuid);
        return structuredClone((owner?.items || []).filter(x => !opts.query?.type || x.type === opts.query.type));
      }
      return [];
    }
    writes.push({ action, type, opts: structuredClone(opts) });
    if (action === "create") {
      if (type === "Actor") {
        const created = opts.data.map((data, i) => ({
          ...structuredClone(data), _id: uid("createdActor" + i), items: [],
          system: { attributes: { hp: { value: 0 } }, currency: {}, spells: {},
            skills: {}, traits: {}, tools: {}, details: {}, ...structuredClone(data.system) }
        }));
        actors.push(...created); return structuredClone(created);
      }
      if (type === "Item") {
        if (failOnItemCreate) throw new Error("Simulated item-creation failure");
        const owner = actors.find(x => `Actor.${x._id}` === opts.parentUuid);
        const created = opts.data.map((data, i) => ({
          ...structuredClone(data), _id: opts.keepId && data._id ? data._id : uid("newItem" + writes.length + i)
        }));
        owner.items.push(...created); return structuredClone(created);
      }
    }
    if (action === "update") {
      const docs = type === "Actor" ? actors : actors.find(x => `Actor.${x._id}` === opts.parentUuid)?.items || [];
      for (const u of opts.updates || []) {
        const row = docs.find(x => x._id === u._id);
        for (const [path, value] of Object.entries(u)) if (path !== "_id") setPath(row, path, value);
      }
      return structuredClone((opts.updates || []).map(u => docs.find(x => x._id === u._id)));
    }
    throw new Error(`Unexpected ${action} ${type}`);
  } };
  const { handleTool } = await import("../src/server.mjs");
  const preview = await handleTool(mutableSession, { name: "rebuild_actor",
    arguments: { source: actor._id, name: "Aurel rebuilt test" } });
  assert.equal(preview.isError, undefined, JSON.stringify(preview));
  const p = JSON.parse(preview.content[0].text);
  assert.equal(p.simulation, true);
  assert.deepEqual(p.choix_requis, []);
  assert.equal(writes.length, 0);
  const applied = await handleTool(mutableSession, { name: "rebuild_actor",
    arguments: { source: actor._id, name: "Aurel rebuilt test", apply: true } });
  assert.equal(applied.isError, undefined, JSON.stringify(applied));
  const result = JSON.parse(applied.content[0].text);
  assert.equal(result.simulation, false, JSON.stringify(result));
  assert.ok(result.acteur?.id, JSON.stringify(result));
  assert.equal(result.niveau, 2);
  assert.equal(actors.length, 2);
  assert.deepEqual(actors[0], original, "the source actor must remain unchanged");
  assert.equal(actors[1].system.abilities.wis.value, 16);
  assert.equal(actors[1].system.abilities.con.value, 13);
  assert.ok(writes.some(x => x.action === "create" && x.type === "Item"));
  failOnItemCreate = true;
  const failed = await handleTool(mutableSession, { name: "rebuild_actor",
    arguments: { source: actor._id, name: "Aurel failed rebuild", apply: true } });
  const errorBody = JSON.parse(failed.content[0].text);
  assert.match(errorBody.erreur, /Simulated item-creation failure/);
  assert.ok(errorBody.acteur_partiel.id);
  assert.equal(actors.length, 3, "partial targets are explicitly retained for inspection");
  assert.deepEqual(actors[0], original);
});
