import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "foundry-snapshot-order-"));
process.env.SNAPSHOT_DIR = temporary;
process.env.NO_LISTEN = "1";
after(() => fs.rmSync(temporary, { recursive: true, force: true }));

const [{ handleTool }, { patchItems }, { syncItems }] = await Promise.all([
  import("../src/server.mjs"), import("../src/patchrun.mjs"), import("../src/sync.mjs")
]);

const ACTOR_ID = "aaaaaaaaaaaaaaaa";
const ITEM_ID = "bbbbbbbbbbbbbbbb";
const ACTIVITY_ID = "cccccccccccccccc";
const snapshots = () => fs.readdirSync(temporary).filter(f => f.endsWith(".json"));

test("update_documents snapshots original values before writing to Foundry", async () => {
  const original = { _id: ACTOR_ID, name: "Hero", system: { attributes: { hp: { value: 20 } } } };
  let foundryWrites = 0;
  const session = { userId: "gm", user: { role: 4, name: "GM" },
    async doc(action, type, options) {
      if (action === "get") return [original];
      assert.equal(action, "update");
      foundryWrites++;
      assert.ok(snapshots().length, "a snapshot must exist before the first write");
      return options.updates;
    } };
  const result = await handleTool(session, { name: "update_documents", arguments: {
    type: "Actor", updates: [{ _id: ACTOR_ID, "system.attributes.hp.value": 12 }]
  } });
  assert.equal(result.isError, undefined);
  assert.equal(foundryWrites, 1);
  const payload = JSON.parse(result.content[0].text);
  const snapshot = JSON.parse(fs.readFileSync(path.join(temporary, `${payload.instantane}.json`)));
  assert.equal(snapshot.ops[0].entries[0].avant["system.attributes.hp.value"], 20);
});

test("delete_documents saves full originals before deletion", async () => {
  const original = { _id: ACTOR_ID, name: "Hero", system: { attributes: { hp: { value: 20 } } } };
  let deletes = 0;
  const session = { userId: "gm", user: { role: 4, name: "GM" },
    async doc(action, type, options) {
      if (action === "get") return [original];
      assert.equal(action, "delete");
      deletes++;
      assert.ok(snapshots().length >= 2, "the deletion snapshot must exist before deleting");
      return options.ids;
    } };
  const result = await handleTool(session, { name: "delete_documents", arguments: {
    type: "Actor", ids: [ACTOR_ID]
  } });
  assert.equal(result.isError, undefined);
  assert.equal(deletes, 1);
  const payload = JSON.parse(result.content[0].text);
  const snapshot = JSON.parse(fs.readFileSync(path.join(temporary, `${payload.instantane}.json`)));
  assert.deepEqual(snapshot.ops[0].docs, [original]);
});

test("gm_patch_items records an original snapshot before applying a patch", async () => {
  const item = { _id: ITEM_ID, name: "Lame retentissante", type: "spell", effects: [],
    system: { activities: { [ACTIVITY_ID]: { _id: ACTIVITY_ID, type: "damage", damage: { parts: [] } } } } };
  let savedBeforeWrite = false;
  const session = { userId: "gm", user: { role: 4, name: "GM" },
    async doc(action) {
      if (action === "update") savedBeforeWrite = snapshots().length >= 3;
      return [];
    } };
  const result = await patchItems(session, {
    actor: { name: "Hero" }, parentUuid: `Actor.${ACTOR_ID}`, items: [item], apply: true
  });
  assert.ok(result.instantane);
  assert.ok(savedBeforeWrite);
});

test("gm_sync_items records an original snapshot before applying a synchronization", async () => {
  const source = { _id: ITEM_ID, name: "Feature", type: "feat", effects: [],
    system: { activities: { [ACTIVITY_ID]: { _id: ACTIVITY_ID, type: "attack" } }, advancement: {} } };
  const item = { _id: ITEM_ID, name: "Feature", type: "feat", effects: [],
    _stats: { compendiumSource: `Compendium.world.features.Item.${ITEM_ID}` },
    system: { activities: {}, advancement: {} } };
  let savedBeforeWrite = false;
  const session = { userId: "gm", user: { role: 4, name: "GM" },
    async worldData() { return { packs: [{ id: "world.features", type: "Item" }] }; },
    async doc(action, type, options) {
      if (action === "get" && options.pack) return [source];
      if (action === "update") savedBeforeWrite = snapshots().length >= 4;
      return [];
    } };
  const result = await syncItems(session, {
    actor: { _id: ACTOR_ID, name: "Hero", items: [item] }, apply: true
  });
  assert.ok(result.instantane);
  assert.ok(savedBeforeWrite);
});
