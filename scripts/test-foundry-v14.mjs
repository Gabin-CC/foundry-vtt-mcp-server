#!/usr/bin/env node
/**
 * Real Foundry v14 integration tests. Deliberately NOT run by npm check/CI:
 * they require an active, explicitly identified disposable dnd5e world.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertTestWorld, parseFoundryAuth, protectSessionDocuments, TEST_WORLD_PREFIX } from "./integration-guard.mjs";

const writes = process.argv.includes("--write");
if (process.argv.slice(2).some(a => a !== "--write"))
  throw new Error("Only the --write argument is supported");
if (!process.env.FOUNDRY_URL) throw new Error("Set FOUNDRY_URL explicitly (the harness has no default target)");
const { username, password } = parseFoundryAuth(process.env.FOUNDRY_AUTH);
const { FoundrySession } = await import("../src/foundry.mjs");

async function run() {
  let session, temporary, state;
  const fixtureName = `${TEST_WORLD_PREFIX} Actor ${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  const step = description => console.log(`  ✓ ${description}`);
  try {
    session = await FoundrySession.login(username, password);
    if (!session) throw new Error("Foundry login failed (check the dedicated test account)");
    assertTestWorld(process.env, session.world, { writes, role: session.user?.role });
    console.log(`Foundry v14 / dnd5e: ${session.world.id} — ${writes ? "disposable writes" : "read-only"}`);
    state = protectSessionDocuments(session, { writes, fixtureName });

    // Use a temporary snapshot directory, never the production MCP snapshots.
    temporary = await mkdtemp(path.join(tmpdir(), "foundry-mcp-v14-"));
    process.env.SNAPSHOT_DIR = path.join(temporary, "snapshots");
    process.env.NO_LISTEN = "1";
    const { handleTool } = await import("../src/server.mjs");

    const call = async (name, args = {}) => {
      const answer = await handleTool(session, { name, arguments: args });
      if (answer.isError) throw new Error(`${name}: ${answer.content?.[0]?.text || "unknown error"}`);
      const value = answer.content?.[0]?.text;
      try { return JSON.parse(value); }
      catch { throw new Error(`${name} returned non-JSON content (unexpected for this scenario)`); }
    };
    const actor = async id => call("get_document", { type: "Actor", id });
    const readHp = async id => Number((await actor(id)).system?.attributes?.hp?.value);

    process.env.MCP_LOCALE = "fr";
    const fr = await call("world_info");
    assert.equal(fr.world.id, session.world.id);
    assert.equal(fr.world.coreVersion, session.world.coreVersion);
    assert.ok(Array.isArray(fr.utilisateurs));
    assert.equal(Object.hasOwn(fr, "users"), false);
    process.env.MCP_LOCALE = "en";
    const en = await call("world_info");
    assert.deepEqual(en.users, en.utilisateurs);
    assert.deepEqual(en.connected_as, en.connecte_en_tant_que);
    process.env.MCP_LOCALE = "fr";
    step("world_info: real socket, world identity, FR and EN JSON compatibility");

    const listing = await call("list_documents", { type: "Actor", limit: 2 });
    assert.ok(Array.isArray(listing.documents));
    if (listing.documents.length) {
      const existing = await actor(listing.documents[0]._id);
      assert.equal(existing._id, listing.documents[0]._id);
      const sheet = await call("actor_sheet", { actor: existing._id });
      assert.equal(typeof sheet.nom, "string");
      const preview = await call("update_documents", { type: "Actor", dry_run: true,
        updates: [{ _id: existing._id, name: `${existing.name} (integration preview only)` }] });
      assert.equal(preview.simulation, true);
      assert.equal((await actor(existing._id)).name, existing.name);
      step("document listing, real actor sheet, non-mutating update preview");
    } else step("actor listing (no existing actor; sheet preview skipped)");
    assert.ok(Array.isArray(await call("list_packs")));
    step("compendium discovery");

    if (process.env.FOUNDRY_TEST_SEARCH_QUERY) {
      const search = await call("search_compendium", { query: process.env.FOUNDRY_TEST_SEARCH_QUERY, limit: 5 });
      assert.ok(Array.isArray(search.resultats));
      step("real compendium search (opt-in query)");
    }
    if (!writes) {
      step("no Foundry document writes permitted in read-only mode");
      return;
    }

    const fixture = await call("create_documents", { type: "Actor", warn_packs: [], data: [{
      name: fixtureName, type: "character",
      system: {
        abilities: Object.fromEntries(["str", "dex", "con", "int", "wis", "cha"].map(k => [k, { value: 10 }])),
        attributes: { hp: { value: 12, max: 20, temp: 0 } }
      }
    }] });
    const id = fixture.crees?.[0]?._id;
    assert.ok(/^[A-Za-z0-9]{16}$/.test(id || ""));
    assert.equal(id, state.actorId);
    assert.equal((await actor(id)).name, fixtureName);
    assert.equal((await call("actor_sheet", { actor: id })).nom, fixtureName);
    step("created and read isolated dnd5e actor fixture");

    const itemName = `${fixtureName} Cantrip`;
    const activityId = crypto.randomBytes(8).toString("hex");
    const createdItem = await call("create_documents", { type: "Item", parent: `Actor.${id}`, warn_packs: [], data: [{
      name: itemName, type: "spell", system: { level: 0, preparation: { mode: "atwill" },
        activities: { [activityId]: { _id: activityId, name: "Integration roll", type: "utility",
          roll: { formula: "1d4" } } } }
    }] });
    const itemId = createdItem.crees?.[0]?._id;
    assert.ok(state.itemIds.has(itemId));
    step("created a v14 spell/activity in the isolated actor");

    const hpBefore = await readHp(id);
    assert.ok(Number.isFinite(hpBefore));
    const dry = await call("update_documents", { type: "Actor",
      updates: [{ _id: id, "system.attributes.hp.value": Math.max(0, hpBefore - 2) }], dry_run: true });
    assert.equal(dry.simulation, true);
    assert.equal(await readHp(id), hpBefore);
    const update = await call("update_documents", { type: "Actor",
      updates: [{ _id: id, "system.attributes.hp.value": Math.max(0, hpBefore - 2) }] });
    assert.ok(update.instantane);
    assert.equal(await readHp(id), Math.max(0, hpBefore - 2));
    const snapshot = await call("snapshots", { action: "show", id: update.instantane });
    assert.equal(snapshot.id, update.instantane);
    const restorePreview = await call("snapshots", { action: "restore", id: update.instantane, dry_run: true });
    assert.equal(restorePreview.simulation, true);
    assert.equal(await readHp(id), Math.max(0, hpBefore - 2));
    await call("snapshots", { action: "restore", id: update.instantane });
    assert.equal(await readHp(id), hpBefore);
    step("update dry-run, snapshot, restore dry-run, and actual rollback");

    const roll = await call("roll", { formula: "2d6+3", actor: id, mode: "prive" });
    assert.ok(roll.total >= 5 && roll.total <= 15);
    const check = await call("check", { actor: id, kind: "ability", key: "str", mode: "prive" });
    assert.ok(Number.isFinite(check.total));
    const used = await call("use_item", { actor: id, item: itemId, consume: false, mode: "prive" });
    assert.ok(Array.isArray(used.resultats));
    assert.ok(state.chatIds.size >= 3);
    step("dice, ability check and cantrip activity through real Foundry chat");

    const damage = await call("apply_damage", { manual: [{ target: `Actor.${id}`, damage: 3 }], chat: false });
    assert.equal(damage.applique?.[0]?.uuid, `Actor.${id}`);
    assert.equal(damage.applique?.[0]?.erreur, undefined);
    assert.equal(await readHp(id), Math.max(0, hpBefore - 3));
    await call("rest", { actor: id, type: "long" });
    const afterRest = await actor(id);
    assert.equal(Number(afterRest.system.attributes.hp.value), Number(afterRest.system.attributes.hp.max));
    step("manual damage, HP persistence, and long-rest recovery");

    const permissions = await call("gm_permissions", { uuid: `Actor.${id}` });
    assert.equal(permissions.nom, fixtureName);
    const sync = await call("gm_sync_items", { actor: id });
    assert.equal(sync.simulation, true);
    step("GM permissions and non-mutating synchronization diagnostics");

    const deletionPreview = await call("delete_documents", { type: "Actor", ids: [id], dry_run: true });
    assert.equal(deletionPreview.simulation, true);
    assert.equal((await actor(id))._id, id);
    await call("delete_documents", { type: "Actor", ids: [id] });
    assert.equal((await session.doc("get", "Actor", { query: { _id: id } })).some(a => a._id === id), false);
    step("deletion preview and isolated fixture deletion");
  } finally {
    if (session && state) {
      // Never delete a different actor even if the world changes during a run.
      if (state.actorId) {
        try {
          const current = (await session.doc("get", "Actor", { query: { _id: state.actorId } }))
            .find(a => a._id === state.actorId);
          if (current && current.name === fixtureName)
            await session.doc("delete", "Actor", { ids: [state.actorId], modifiedTime: Date.now() });
          else if (current) console.error("Fixture actor name changed; manual cleanup required:", state.actorId);
        } catch (e) { console.error("Fixture actor cleanup failed:", e.message, "ID:", state.actorId); process.exitCode = 1; }
      }
      if (state.chatIds.size) {
        try { await session.doc("delete", "ChatMessage", { ids: [...state.chatIds], modifiedTime: Date.now() }); }
        catch (e) { console.error("Test chat cleanup failed:", e.message); process.exitCode = 1; }
      }
    }
    session?.close();
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}

try { await run(); }
catch (error) { console.error("Foundry v14 integration failed:", error.message); process.exitCode = 1; }
