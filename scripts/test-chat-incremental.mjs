import assert from "node:assert/strict";
import { test } from "node:test";
import { chatTimestamp } from "../src/chat-history.mjs";
import { FoundrySession } from "../src/foundry.mjs";

process.env.NO_LISTEN = "1";
const { handleTool } = await import("../src/server.mjs");

const record = (_id, timestamp, extra = {}) => ({ _id, timestamp, user: "gm", whisper: [],
  content: `message ${_id}`, ...extra });

class SocketMock {
  constructor(documents = []) {
    this.documents = documents;
    this.listeners = new Map();
    this.calls = [];
    this.connected = true;
  }
  on(event, listener) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(listener);
  }
  off(event, listener) { this.listeners.get(event)?.delete(listener); }
  broadcast(event) {
    for (const listener of this.listeners.get("modifyDocument") || []) listener(event);
  }
  emit(event, request, reply) {
    assert.equal(event, "modifyDocument");
    this.calls.push(request);
    if (request.action === "get") reply({ result: [...this.documents] });
    else reply({ result: request.operation.data || request.operation.ids || [] });
  }
  close() { this.connected = false; }
}

function makeSession(documents) {
  const session = new FoundrySession();
  session.socket = new SocketMock(documents);
  return session;
}

const readSince = (session, threshold) => session.doc("get", "ChatMessage",
  { query: { timestamp: { $gte: threshold } } });

test("the first chat read is complete; later inclusive reads use the cache and deterministic order", async () => {
  const full = [record("z", 120), record("b", 100), record("a", 100), record("old", 99)];
  const session = makeSession(full);
  assert.deepEqual(await session.doc("get", "ChatMessage", { query: {} }), full);
  assert.deepEqual((await readSince(session, 100)).map(x => x._id), ["a", "b", "z"]);
  assert.deepEqual((await readSince(session, 120)).map(x => x._id), ["z"]);
  assert.equal(session.socket.calls.length, 1, "no repeated full Foundry socket transfer");
  assert.deepEqual(await readSince(session, 121), []);
  session.close();
});

test("chat broadcasts add messages at the same millisecond and apply edits and deletes", async () => {
  const session = makeSession([record("b", 100)]);
  await session.doc("get", "ChatMessage", { query: {} });
  session.socket.broadcast({ type: "ChatMessage", action: "create", result: [record("a", 100)] });
  assert.deepEqual((await readSince(session, 100)).map(x => x._id), ["a", "b"]);
  session.socket.broadcast({ type: "ChatMessage", action: "update", result: [{ _id: "b", timestamp: 200 }] });
  assert.deepEqual((await readSince(session, 100)).map(x => [x._id, x.timestamp]), [["a", 100], ["b", 200]]);
  session.socket.broadcast({ type: "ChatMessage", action: "delete", result: ["a"] });
  assert.deepEqual((await readSince(session, 100)).map(x => x._id), ["b"]);
  assert.equal(session.socket.calls.length, 1);
  session.close();
});

test("a full read corrects missed broadcasts after the cache expires", async () => {
  const session = makeSession([record("old", 80)]);
  assert.deepEqual(await readSince(session, 100), []);
  session.socket.documents.push(record("late", 150));
  session._chatHistory.refreshedAt = Date.now() - 16000;
  assert.deepEqual((await readSince(session, 100)).map(x => x._id), ["late"]);
  assert.equal(session.socket.calls.length, 2);
  session.close();
});

test("an incomplete update broadcast invalidates the cache and triggers a fresh read", async () => {
  const session = makeSession([record("old", 80)]);
  await readSince(session, 0);
  session.socket.broadcast({ type: "ChatMessage", action: "update", result: [{ _id: "missing" }] });
  session.socket.documents.push(record("new", 120));
  assert.deepEqual((await readSince(session, 100)).map(x => x._id), ["new"]);
  assert.equal(session.socket.calls.length, 2);
  session.close();
});

test("broadcasts arriving during a full read are replayed after its snapshot", async () => {
  const session = makeSession([]);
  let finish;
  session.socket.emit = (event, request, callback) => { finish = callback; };
  const reading = session.doc("get", "ChatMessage", { query: {} });
  session.socket.broadcast({ type: "ChatMessage", action: "create", result: [record("now", 210)] });
  finish({ result: [record("previous", 100)] });
  await reading;
  assert.deepEqual((await readSince(session, 100)).map(x => x._id), ["previous", "now"]);
  session.close();
});

test("chat cache falls back to creationTime and preserves other Foundry document queries", async () => {
  const session = makeSession([record("fallback", null, { _stats: { createdTime: 250 } })]);
  assert.equal(chatTimestamp(session.socket.documents[0]), 250);
  assert.deepEqual((await readSince(session, 250)).map(x => x._id), ["fallback"]);
  await session.doc("get", "Actor", { query: { _id: "hero" } });
  assert.equal(session.socket.calls.length, 2);
  assert.equal(session.socket.calls[1].type, "Actor");
  session.close();
  assert.equal(session.socket.listeners.get("modifyDocument").size, 0);
});

const invoke = async (docs, args) => {
  const session = { userId: "gm", user: { role: 4, name: "GM" }, world: {},
    async doc(action, type, options) {
      assert.equal(action, "get");
      return [...docs]; // Deliberately ignore query to simulate Foundry v14.
    } };
  const reply = await handleTool(session, { name: "list_documents", arguments: args });
  return reply.isError ? reply : JSON.parse(reply.content[0].text);
};

test("list_documents filters inclusively and paginates chat by timestamp then ID", async () => {
  const docs = [record("d", 200), record("c", 100), record("a", 100), record("b", 99)];
  const base = { type: "ChatMessage", since_timestamp: 100, limit: 2 };
  const first = await invoke(docs, base);
  assert.equal(first.total, 3);
  assert.equal(first.latest_timestamp, 200);
  assert.deepEqual(first.documents.map(x => x._id), ["a", "c"]);
  assert.equal(first.next_cursor, "t:100:c");
  const second = await invoke([...docs, record("x", 100)], { ...base, cursor: first.next_cursor });
  assert.deepEqual(second.documents.map(x => x._id), ["x", "d"]);
  assert.equal(second.next_cursor, null);
});

test("list_documents without a timestamp keeps full history and legacy ID cursors", async () => {
  const result = await invoke([record("z", 200), record("a", 100)],
    { type: "ChatMessage", limit: 1 });
  assert.equal(result.total, 2);
  assert.deepEqual(result.documents.map(x => x._id), ["a"]);
  assert.equal(result.next_cursor, "a");
  assert.equal(result.latest_timestamp, undefined);
});

test("list_documents rejects invalid timestamp requests without invoking Foundry", async () => {
  for (const args of [{ type: "Actor", since_timestamp: 100 },
    { type: "ChatMessage", since_timestamp: -1 }, { type: "ChatMessage", since_timestamp: "100" }]) {
    const result = await invoke([], args);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /since_timestamp/);
  }
  const empty = await invoke([], { type: "ChatMessage", since_timestamp: 0 });
  assert.equal(empty.latest_timestamp, null);
});
