/**
 * Fail-closed guard for the opt-in, real-world Foundry integration harness.
 * Only a deliberately named, explicitly identified disposable world is usable.
 */
export const TEST_WORLD_PREFIX = "[MCP TEST]";

export function assertTestWorld(env, world, { writes = false, role = 0 } = {}) {
  const id = String(env.FOUNDRY_TEST_WORLD_ID || "").trim();
  const title = String(env.FOUNDRY_TEST_WORLD_TITLE || "").trim();
  if (!id || !title) throw new Error("Set FOUNDRY_TEST_WORLD_ID and FOUNDRY_TEST_WORLD_TITLE explicitly");
  if (!world || world.id !== id || world.title !== title)
    throw new Error("Connected Foundry world does not match the exact test-world ID and title");
  if (!title.startsWith(TEST_WORLD_PREFIX))
    throw new Error(`Disposable world title must begin with ${TEST_WORLD_PREFIX}`);
  if (!/^14(?:\.|$)/.test(String(world.coreVersion || "")))
    throw new Error("Test world must have a Foundry v14 coreVersion");
  if (world.system !== "dnd5e")
    throw new Error("Test world must use the dnd5e system");
  if (writes) {
    if (env.FOUNDRY_TEST_WRITE !== "yes" || env.FOUNDRY_TEST_CONFIRM_WORLD_ID !== id)
      throw new Error("Writes require FOUNDRY_TEST_WRITE=yes and FOUNDRY_TEST_CONFIRM_WORLD_ID=<exact world ID>");
    if (Number(role) !== 4) throw new Error("Write tests require a GM account (role 4)");
  }
  return { id, title, writes };
}

/** Parse existing MCP Basic credentials without ever putting them in an error. */
export function parseFoundryAuth(value) {
  const encoded = String(value || "").replace(/^Basic\s+/i, "").trim();
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
    throw new Error("Set FOUNDRY_AUTH to base64(username:password)");
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon <= 0 || colon === decoded.length - 1)
    throw new Error("FOUNDRY_AUTH must encode a non-empty username and password");
  return { username: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

/**
 * A last line of defense at the Foundry socket boundary. The harness can only
 * mutate its own actor and embedded items, or create/delete chat messages that
 * it directly recorded. This guard is active even if a tool is called by mistake.
 */
export function protectSessionDocuments(session, { writes = false, fixtureName = "" } = {}) {
  const original = session.doc.bind(session);
  const state = { actorId: null, itemIds: new Set(), chatIds: new Set() };
  const deny = () => { throw new Error("Integration write blocked: outside the test fixture"); };
  const matchingIds = (ids, allowed) => Array.isArray(ids) && ids.length > 0 && ids.every(id => allowed.has(id));
  session.doc = async (action, type, operation = {}) => {
    if (action !== "get") {
      if (!writes) deny();
      const actorIds = new Set(state.actorId ? [state.actorId] : []);
      const actorParent = `Actor.${state.actorId}`;
      const noOtherLocation = !operation.pack && !operation.parentUuid;
      let allowed = false;
      if (type === "Actor" && action === "create") {
        allowed = !state.actorId && noOtherLocation && operation.data?.length === 1
          && operation.data[0].name === fixtureName && operation.data[0].type === "character"
          && !operation.data[0]._id && fixtureName.startsWith(TEST_WORLD_PREFIX);
      } else if (type === "Actor" && action === "update") {
        allowed = noOtherLocation && matchingIds(operation.updates?.map(u => u._id), actorIds);
      } else if (type === "Actor" && action === "delete") {
        allowed = noOtherLocation && matchingIds(operation.ids, actorIds);
      } else if (type === "Item" && operation.parentUuid === actorParent && state.actorId && !operation.pack) {
        if (action === "create")
          allowed = operation.data?.length === 1 && operation.data[0].name?.startsWith(`${fixtureName} `)
            && !operation.data[0]._id;
        if (action === "update") allowed = matchingIds(operation.updates?.map(u => u._id), state.itemIds);
        if (action === "delete") allowed = matchingIds(operation.ids, state.itemIds);
      } else if (type === "ChatMessage" && noOtherLocation) {
        if (action === "create")
          allowed = operation.data?.length === 1 && operation.data[0].author === session.userId
            && operation.data[0].speaker?.actor === state.actorId && !!state.actorId;
        if (action === "delete") allowed = matchingIds(operation.ids, state.chatIds);
      }
      if (!allowed) deny();
    }
    const result = await original(action, type, operation);
    if (action === "create" && type === "Actor") {
      const actor = result?.[0];
      if (actor?._id && actor.name === fixtureName) state.actorId = actor._id;
      else throw new Error("Fixture actor was created but its returned ID/name could not be verified; inspect the test world");
    }
    if (action === "create" && type === "Item")
      for (const item of result || []) if (item?._id) state.itemIds.add(item._id);
    if (action === "create" && type === "ChatMessage")
      for (const message of result || []) if (message?._id) state.chatIds.add(message._id);
    return result;
  };
  return state;
}
