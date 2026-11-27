import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.NO_LISTEN = "1";
process.env.SNAPSHOT_DIR = await mkdtemp(path.join(os.tmpdir(), "foundry-progress-tests-"));
const { handleTool } = await import("../src/server.mjs");
const { captureActorState } = await import("../src/actor-progress.mjs");

const AID = "progressActor24Z";
const CID = "progressClass24Z";
const FID = "progressFeat2024";
const TID = "progressTrait24Z";
const GID = "progressGrant24Z";
const FEAT_UUID = `Compendium.dnd5e.feats24.Item.${FID}`;

const fixture = () => {
  const actor = { _id: AID, name: "Existing Level 1 Paladin", type: "character",
    system: { abilities: { str: { value: 16 }, dex: { value: 12 }, con: { value: 14 },
      int: { value: 8 }, wis: { value: 10 }, cha: { value: 14 } },
    attributes: { hp: { value: 12 } }, traits: {}, skills: {}, tools: {}, spells: {},
    details: { originalClass: CID } },
    items: [
      { _id: CID, name: "Paladin", type: "class", flags: {},
        system: { identifier: "paladin", levels: 1, hitDice: "d10", source: { rules: "2024" },
          advancement: {
            [TID]: { _id: TID, type: "Trait", level: 2, configuration: {
              grants: [], choices: [{ count: 1, pool: ["skills:ath", "skills:ins"] }]
            } },
            [GID]: { _id: GID, type: "ItemGrant", level: 2, configuration: { items: [{ uuid: FEAT_UUID }] } }
          } } },
      { _id: "previousFeat2024", name: "Existing Feat", type: "feat", system: {},
        flags: { dnd5e: { advancementOrigin: `${CID}.oldFeatGrant` } } }
    ] };
  const feat = { _id: FID, name: "Level 2 Feature", type: "feat", flags: {},
    system: { identifier: "level-2-feature", advancement: [], source: { rules: "2024" } } };
  const writes = [];
  let failActorUpdateOnce = false;
  const setPath = (target, key, value) => {
    const fields = key.split(".");
    let cursor = target;
    for (const field of fields.slice(0, -1)) cursor = cursor[field] ??= {};
    const last = fields.at(-1);
    if (last.startsWith("-=")) delete cursor[last.slice(2)];
    else cursor[last] = structuredClone(value);
  };
  const fs = { userId: "testOwnerGM00001", user: { role: 4, name: "GM" },
    world: { id: "test", title: "Test", system: "dnd5e", coreVersion: "14.370" },
    async worldData() { return { packs: [{ id: "dnd5e.feats24", type: "Item", packageName: "dnd5e" }] }; },
    async doc(action, type, opts = {}) {
      if (action === "get") {
        if (type === "Setting") return [];
        if (type === "Actor") return !opts.query?._id || opts.query._id === actor._id ? [structuredClone(actor)] : [];
        if (type === "Item" && opts.pack) return opts.query?._id === FID ? [structuredClone(feat)] : [];
        if (type === "Item" && opts.parentUuid) return structuredClone(actor.items.filter(i =>
          !opts.query?.type || i.type === opts.query.type));
        return [];
      }
      writes.push({ action, type, opts: structuredClone(opts) });
      if (action === "create" && type === "Item") {
        const out = opts.data.map((d, n) => ({ ...structuredClone(d), _id: opts.keepId ? d._id : `newFeature${n}1234` }));
        actor.items.push(...out);
        return structuredClone(out);
      }
      if (action === "update") {
        if (type === "Actor" && failActorUpdateOnce) {
          failActorUpdateOnce = false;
          throw new Error("Simulated Foundry actor update failure");
        }
        const target = type === "Actor" ? [actor] : actor.items;
        for (const update of opts.updates) {
          const doc = target.find(x => x._id === update._id);
          if (!doc) throw new Error(`Missing update target: ${update._id}`);
          for (const [k, v] of Object.entries(update)) if (k !== "_id") setPath(doc, k, v);
        }
        return [];
      }
      if (action === "delete" && type === "Item") {
        actor.items = actor.items.filter(i => !opts.ids.includes(i._id));
        return [];
      }
      throw new Error(`Unexpected operation ${action} ${type}`);
    }
  };
  return { actor, fs, writes, failActorUpdate() { failActorUpdateOnce = true; } };
};

const call = async (fs, name, args) => {
  const result = await handleTool(fs, { name, arguments: args });
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};

test("progress_actor preflight never writes and requests missing 2024 choices", async () => {
  const f = fixture();
  const preview = await call(f.fs, "progress_actor", { actor: AID, level: 2 });
  assert.equal(preview.simulation, true);
  assert.equal(preview.pret, false);
  assert.ok(preview.choix_requis.some(c => c.id === `${TID}@2`));
  assert.deepEqual(f.writes, [], "Even an old missing advancementRoot must not be updated during preview");
  assert.equal(f.actor.items[1].flags.dnd5e.advancementRoot, undefined);
});

test("progress_actor applies only after choices and creates a restorable snapshot", async () => {
  const f = fixture();
  const original = captureActorState(f.actor);
  const args = { actor: AID, level: 2, choices: { [`${TID}@2`]: ["skills:ath"] } };
  const preview = await call(f.fs, "progress_actor", args);
  assert.equal(preview.pret, true, JSON.stringify(preview));
  assert.ok(preview.etapes.some(s => s.type === "grant"));
  assert.deepEqual(f.writes, []);
  const outcome = await call(f.fs, "progress_actor", { ...args, apply: true });
  assert.equal(outcome.niveau_apres, 2, JSON.stringify(outcome));
  assert.ok(outcome.instantane);
  assert.equal(f.actor.items[0].system.levels, 2);
  assert.equal(f.actor.system.skills.ath.value, 1);
  assert.ok(f.actor.items.find(i => i.name === "Level 2 Feature"));
  const rollback = await call(f.fs, "snapshots", { action: "restore", id: outcome.instantane, dry_run: true });
  assert.equal(rollback.simulation, true);
  assert.equal(f.actor.items[0].system.levels, 2);
  await call(f.fs, "snapshots", { action: "restore", id: outcome.instantane });
  assert.deepEqual(captureActorState(f.actor), original);
});

test("restore has a separate undo snapshot and can undo the rollback", async () => {
  const f = fixture();
  const applied = await call(f.fs, "progress_actor", { actor: AID, level: 2,
    choices: { [`${TID}@2`]: ["skills:ins"] }, apply: true });
  const advancedState = captureActorState(f.actor);
  const restored = await call(f.fs, "snapshots", { action: "restore", id: applied.instantane });
  assert.ok(restored.instantane_de_la_restauration);
  assert.equal(f.actor.items[0].system.levels, 1);
  await call(f.fs, "snapshots", { action: "restore", id: restored.instantane_de_la_restauration });
  assert.deepEqual(captureActorState(f.actor), advancedState);
});

test("failed mid-advancement leaves a labeled partial actor and a recoverable snapshot", async () => {
  const f = fixture();
  const original = captureActorState(f.actor);
  f.failActorUpdate();
  const outcome = await call(f.fs, "progress_actor", { actor: AID, level: 2,
    choices: { [`${TID}@2`]: ["skills:ath"] }, apply: true });
  assert.match(outcome.erreur, /Simulated Foundry actor update failure/);
  assert.equal(outcome.restauration_disponible, true);
  assert.ok(f.actor.items.find(i => i.name === "Level 2 Feature"));
  await call(f.fs, "snapshots", { action: "restore", id: outcome.instantane });
  assert.deepEqual(captureActorState(f.actor), original);
});

test("progression rollback refuses to overwrite character edits made after advancing", async () => {
  const f = fixture();
  const outcome = await call(f.fs, "progress_actor", { actor: AID, level: 2,
    choices: { [`${TID}@2`]: ["skills:ins"] }, apply: true });
  assert.ok(outcome.instantane);
  f.actor.system.currency = { gp: 9 }; // A later player/GM edit.
  const result = await handleTool(f.fs, { name: "snapshots", arguments: {
    action: "restore", id: outcome.instantane
  } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /changed since this progression/);
  assert.equal(f.actor.items[0].system.levels, 2);
});

test("progress_actor refuses non-2024 and multiclass characters without writing", async () => {
  const f = fixture();
  f.actor.items[0].system.source.rules = "2014";
  const old = await handleTool(f.fs, { name: "progress_actor", arguments: { actor: AID, level: 2 } });
  assert.equal(old.isError, true);
  f.actor.items[0].system.source.rules = "2024";
  f.actor.items.push({ _id: "extraClassForTest", type: "class", name: "Rogue",
    system: { levels: 1, source: { rules: "2024" } } });
  const multi = await handleTool(f.fs, { name: "progress_actor", arguments: { actor: AID, level: 2 } });
  assert.equal(multi.isError, true);
  assert.deepEqual(f.writes, []);
});

after(async () => { await rm(process.env.SNAPSHOT_DIR, { recursive: true, force: true }); });
