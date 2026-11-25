import assert from "node:assert/strict";
import { test } from "node:test";
import { assertTestWorld, parseFoundryAuth, protectSessionDocuments } from "./integration-guard.mjs";

const id = "foundry-mcp-v14-test";
const title = "[MCP TEST] D&D5e integration";
const world = { id, title, coreVersion: "14.327", system: "dnd5e" };
const env = { FOUNDRY_TEST_WORLD_ID: id, FOUNDRY_TEST_WORLD_TITLE: title };
const writeEnv = { ...env, FOUNDRY_TEST_WRITE: "yes", FOUNDRY_TEST_CONFIRM_WORLD_ID: id };
const fixtureName = "[MCP TEST] Actor sample";
const actorId = "aaaaaaaaaaaaaaaa", itemId = "bbbbbbbbbbbbbbbb", chatId = "cccccccccccccccc";

test("requires exact world ID and title before any read-only integration", () => {
  assert.deepEqual(assertTestWorld(env, world), { id, title, writes: false });
  assert.throws(() => assertTestWorld({}, world), /FOUNDRY_TEST_WORLD_ID/);
  assert.throws(() => assertTestWorld({ ...env, FOUNDRY_TEST_WORLD_ID: "different" }, world), /does not match/);
  assert.throws(() => assertTestWorld(env, { ...world, title: "Production" }), /does not match/);
  assert.throws(() => assertTestWorld({ ...env, FOUNDRY_TEST_WORLD_TITLE: "Production" }, { ...world, title: "Production" }), /begin/);
});

test("rejects non-v14 worlds and non-dnd5e systems", () => {
  assert.throws(() => assertTestWorld(env, { ...world, coreVersion: "13.349" }), /v14/);
  assert.throws(() => assertTestWorld(env, { ...world, coreVersion: undefined }), /v14/);
  assert.throws(() => assertTestWorld(env, { ...world, system: "pf2e" }), /dnd5e/);
});

test("write mode needs two explicit confirmations and a GM", () => {
  assert.throws(() => assertTestWorld(env, world, { writes: true, role: 4 }), /FOUNDRY_TEST_WRITE/);
  assert.throws(() => assertTestWorld({ ...writeEnv, FOUNDRY_TEST_CONFIRM_WORLD_ID: "wrong" }, world,
    { writes: true, role: 4 }), /CONFIRM_WORLD_ID/);
  assert.throws(() => assertTestWorld(writeEnv, world, { writes: true, role: 3 }), /GM account/);
  assert.deepEqual(assertTestWorld(writeEnv, world, { writes: true, role: 4 }), { id, title, writes: true });
});

test("Basic credentials are validated without disclosing their content", () => {
  const authorization = Buffer.from("GM:secret:with:colons").toString("base64");
  assert.deepEqual(parseFoundryAuth("Basic " + authorization), { username: "GM", password: "secret:with:colons" });
  assert.throws(() => parseFoundryAuth(""), /FOUNDRY_AUTH/);
  assert.throws(() => parseFoundryAuth(Buffer.from("no-colon").toString("base64")), /FOUNDRY_AUTH/);
});

test("read-only guard rejects all document mutations at the socket boundary", async () => {
  const history = [];
  const session = { async doc(action, type) { history.push([action, type]); return []; } };
  protectSessionDocuments(session);
  await session.doc("get", "Actor");
  await assert.rejects(session.doc("create", "Actor", { data: [{ name: fixtureName }] }), /blocked/);
  await assert.rejects(session.doc("delete", "Actor", { ids: [actorId] }), /blocked/);
  assert.deepEqual(history, [["get", "Actor"]]);
});

test("write guard permits only its own actor, embedded item and recorded chats", async () => {
  const history = [];
  const session = {
    userId: "gm",
    async doc(action, type, options) {
      history.push([action, type, options]);
      if (action === "create" && type === "Actor") return [{ _id: actorId, name: fixtureName }];
      if (action === "create" && type === "Item") return [{ _id: itemId, name: fixtureName + " Cantrip" }];
      if (action === "create" && type === "ChatMessage") return [{ _id: chatId }];
      return [];
    }
  };
  const state = protectSessionDocuments(session, { writes: true, fixtureName });
  await assert.rejects(session.doc("update", "Actor", { updates: [{ _id: actorId }] }), /blocked/);
  await session.doc("create", "Actor", { data: [{ name: fixtureName, type: "character" }] });
  assert.equal(state.actorId, actorId);
  await assert.rejects(session.doc("create", "Actor", { data: [{ name: "Production", type: "character" }] }), /blocked/);
  await session.doc("update", "Actor", { updates: [{ _id: actorId, name: fixtureName }] });
  await assert.rejects(session.doc("update", "Actor", { updates: [{ _id: "other", name: "Oops" }] }), /blocked/);
  await assert.rejects(session.doc("delete", "Actor", { ids: [actorId, "other"] }), /blocked/);
  await assert.rejects(session.doc("create", "Item", { parentUuid: "Actor.other",
    data: [{ name: fixtureName + " Cantrip" }] }), /blocked/);
  await session.doc("create", "Item", { parentUuid: "Actor." + actorId,
    data: [{ name: fixtureName + " Cantrip" }] });
  assert.ok(state.itemIds.has(itemId));
  await session.doc("update", "Item", { parentUuid: "Actor." + actorId, updates: [{ _id: itemId }] });
  await assert.rejects(session.doc("delete", "Item", { parentUuid: "Actor." + actorId, ids: ["other"] }), /blocked/);
  await assert.rejects(session.doc("create", "ChatMessage", { data: [{ author: "gm",
    speaker: { actor: "other" } }] }), /blocked/);
  await session.doc("create", "ChatMessage", { data: [{ author: "gm", speaker: { actor: actorId } }] });
  assert.ok(state.chatIds.has(chatId));
  await assert.rejects(session.doc("delete", "ChatMessage", { ids: [chatId, "someone-else"] }), /blocked/);
  await session.doc("delete", "ChatMessage", { ids: [chatId] });
  await session.doc("delete", "Actor", { ids: [actorId] });
  assert.equal(history.filter(([, type]) => type === "Actor").length, 3);
});
