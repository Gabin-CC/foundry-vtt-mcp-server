// Full-character reconstruction orchestration for dnd5e.
// Progression is replayed from compendium data; remaining spell, equipment and
// campaign items are copied from the source, with explicit provenance.
import crypto from "node:crypto";
import { advancementBlueprint, recordedActorChoices } from "./advancement-replay.mjs";
import { fetchUuid, plan as advancementPlan } from "./advancement.mjs";
import { sanitizeItemData } from "./repair.mjs";
import { applyPatches } from "./patches.mjs";

const ORIGIN_TYPES = new Set(["class", "race", "background"]);
const sourceUuid = item => item?._stats?.compendiumSource || item?.flags?.dnd5e?.sourceId || null;
const id16 = () => crypto.randomBytes(12).toString("base64url").replace(/[^a-zA-Z0-9]/g, "").padEnd(16, "0").slice(0, 16);

/** Plan every import before creating anything. Never fill missing choices by name. */
export async function planActorRebuild(fs, sourceActor, options = {}) {
  const blueprint = advancementBlueprint(sourceActor);
  const origins = sourceActor.items.filter(i => ORIGIN_TYPES.has(i.type));
  if (origins.filter(i => i.type === "race").length > 1 || origins.filter(i => i.type === "background").length > 1)
    throw new Error("Cannot safely replay multiple species or backgrounds from one actor.");
  const { choices: recordedChoices, recorded } = recordedActorChoices(sourceActor);
  const choices = { ...recordedChoices, ...(options.choices || {}) };
  const pending = [], warnings = [];
  const stages = [];
  // Apply the class first so subsequent origins see the final character level.
  // Starting equipment is skipped here: we restore the exact source inventory.
  const ordered = [
    ...origins.filter(i => i.type === "class"),
    ...origins.filter(i => i.type === "race"),
    ...origins.filter(i => i.type === "background")
  ];
  const virtualActor = { _id: "PreviewOnly000001", name: "MCP rebuild preview", type: "character",
    system: { abilities: Object.fromEntries(Object.entries(blueprint.pre_origin_abilities).map(([k, v]) => [k, { value: v }])) },
    items: [] };
  for (const origin of ordered) {
    const uuid = sourceUuid(origin);
    if (!/^Compendium\.[^.]+\.[^.]+\.Item\.[A-Za-z0-9]{16}$/.test(uuid || ""))
      throw new Error(`No verifiable compendium source for ${origin.type} "${origin.name}".`);
    const doc = await fetchUuid(fs, uuid);
    if (doc.type !== origin.type)
      throw new Error(`Source ${uuid} is ${doc.type}, not the expected ${origin.type}.`);
    const isClass = origin.type === "class";
    const p = await advancementPlan(fs, virtualActor, doc, {
      fromLevel: isClass ? 1 : 0, toLevel: blueprint.level,
      choices, isFirstClass: isClass, skipStartingEquipment: true
    });
    pending.push(...p.pending.map(x => ({ ...x, origine: origin.name })));
    warnings.push(...p.warnings.map(x => `${origin.name}: ${x}`));
    stages.push({ type: origin.type, name: origin.name, source: uuid, level: blueprint.level,
      step_count: p.steps.length });
  }
  if (!blueprint.hp_mode && blueprint.level > 1 && !options.hp)
    pending.push({ id: "hp", type: "HitPoints", titre: "Choose HP progression mode", options: ["avg", "max"] });
  return {
    blueprint, choices, recorded, stages, pending, warnings,
    items_to_reconcile: sourceActor.items.length,
    ready: pending.length === 0,
    notes: [
      "The class, species and background advancements will be replayed from their original compendiums.",
      "Existing inventory, prepared spells and non-advancement campaign rewards will be reconciled by source UUID and copied when not generated.",
      "No source document is modified. A failed application may leave an explicitly identified partial target for review."
    ]
  };
}

const itemKey = item => {
  const src = sourceUuid(item);
  return `${item.type}| ${src ? "uuid:" + src : "name:" + String(item.name || "").toLowerCase()}`;
};

/** Exact multiset matching: duplicate spells/items are not collapsed. */
export function reconcileActorItems(sourceItems, targetItems) {
  const available = new Map(), mapping = new Map(), toCopy = [];
  for (const item of targetItems) {
    const key = itemKey(item);
    const list = available.get(key) || [];
    list.push(item); available.set(key, list);
  }
  for (const item of sourceItems) {
    const match = available.get(itemKey(item))?.shift();
    if (match) mapping.set(item._id, match._id);
    else if (ORIGIN_TYPES.has(item.type)) throw new Error(`Rebuilt actor is missing the root ${item.type}: ${item.name}`);
    else toCopy.push(item);
  }
  return { mapping, toCopy, additional: [...available.values()].flat() };
}

function mappedOrigin(ref, mapping) {
  if (typeof ref !== "string") return ref;
  const [id, ...suffix] = ref.split(".");
  return mapping.has(id) ? [mapping.get(id), ...suffix].join(".") : null;
}

/**
 * Copy residual embedded items while preserving container references and
 * resolving advancement origins against the newly generated target items.
 */
export async function copyResidualItems(fs, sourceActor, targetActor) {
  const { mapping, toCopy, additional } = reconcileActorItems(sourceActor.items || [], targetActor.items || []);
  const used = new Set((targetActor.items || []).map(i => i._id));
  for (const item of toCopy) {
    let id = item._id;
    while (!/^[A-Za-z0-9]{16}$/.test(id || "") || used.has(id)) id = id16();
    mapping.set(item._id, id); used.add(id);
  }
  const data = toCopy.map(item => {
    const d = structuredClone(item);
    d._id = mapping.get(item._id);
    delete d.folder; delete d.sort; delete d.ownership;
    if (d.system?.container) d.system.container = mapping.get(d.system.container) || null;
    if (d.flags?.dnd5e) {
      const f = d.flags.dnd5e;
      if (f.advancementOrigin) {
        const mapped = mappedOrigin(f.advancementOrigin, mapping);
        if (mapped) f.advancementOrigin = mapped;
        else delete f.advancementOrigin;
      }
      if (f.advancementRoot) {
        const mapped = mappedOrigin(f.advancementRoot, mapping);
        if (mapped) f.advancementRoot = mapped;
        else delete f.advancementRoot;
      }
    }
    d.flags ??= {};
    d.flags.mcp = { ...(d.flags.mcp || {}), rebuildCopiedFrom: `Actor.${sourceActor._id}.Item.${item._id}` };
    // Effects may refer to the source actor/item. Rewrite only references for
    // which there is a definite target correspondence.
    for (const effect of d.effects || []) {
      if (typeof effect.origin !== "string") continue;
      const m = /^Actor\.([A-Za-z0-9]{16})\.Item\.([A-Za-z0-9]{16})(.*)$/.exec(effect.origin);
      if (m && m[1] === sourceActor._id && mapping.has(m[2]))
        effect.origin = `Actor.${targetActor._id}.Item.${mapping.get(m[2])}${m[3]}`;
    }
    const corrected = applyPatches(d).doc;
    sanitizeItemData(corrected);
    return corrected;
  });
  const copied = [];
  for (let i = 0; i < data.length; i += 20) {
    const part = data.slice(i, i + 20);
    const rows = await fs.doc("create", "Item", { parentUuid: `Actor.${targetActor._id}`, data: part, keepId: true, modifiedTime: Date.now() });
    copied.push(...rows.map(x => ({ id: x._id, name: x.name, type: x.type })));
  }
  return { copied, mapping, additional: additional.map(x => ({ name: x.name, type: x.type })),
    counts: copied.reduce((o, item) => { o[item.type] = (o[item.type] || 0) + 1; return o; }, {}) };
}

/** Preserve actor-level active effects separately from effects embedded in items. */
export async function copyResidualActorEffects(fs, sourceActor, targetActor, itemMapping = new Map()) {
  const existing = (targetActor.effects || []).map(e => JSON.stringify([e.name, e.changes, e.statuses]));
  const remaining = [...existing], copies = [];
  for (const effect of sourceActor.effects || []) {
    const key = JSON.stringify([effect.name, effect.changes, effect.statuses]);
    const i = remaining.indexOf(key);
    if (i >= 0) { remaining.splice(i, 1); continue; }
    const copy = structuredClone(effect);
    delete copy._id; // Foundry assigns a distinct active-effect ID.
    if (typeof copy.origin === "string") {
      const oldActor = `Actor.${sourceActor._id}`;
      if (copy.origin === oldActor) copy.origin = `Actor.${targetActor._id}`;
      else if (copy.origin.startsWith(oldActor + ".Item.")) {
        const id = copy.origin.slice((oldActor + ".Item.").length).split(".")[0];
        if (itemMapping.has(id)) copy.origin = copy.origin.replace(
          `${oldActor}.Item.${id}`, `Actor.${targetActor._id}.Item.${itemMapping.get(id)}`);
      }
    }
    copies.push(copy);
  }
  if (copies.length) await fs.doc("create", "ActiveEffect", {
    parentUuid: `Actor.${targetActor._id}`, data: copies, modifiedTime: Date.now()
  });
  return copies.length;
}

/** Restore spent uses/equipment state on regenerated items without replacing rule definitions. */
export async function syncRebuiltItemState(fs, sourceActor, targetActor, mapping) {
  const byId = new Map((targetActor.items || []).map(i => [i._id, i]));
  const fields = ["quantity", "equipped", "attuned", "prepared", "method", "uses", "identified"];
  const updates = [];
  for (const item of sourceActor.items || []) {
    const targetId = mapping.get(item._id), target = byId.get(targetId);
    if (!target) continue;
    const update = { _id: targetId };
    for (const key of fields) {
      const from = item.system?.[key];
      if (from !== undefined && JSON.stringify(from) !== JSON.stringify(target.system?.[key]))
        update[`system.${key}`] = structuredClone(from);
    }
    if (item.system?.container) {
      const container = mapping.get(item.system.container);
      if (container && target.system?.container !== container) update["system.container"] = container;
    }
    if (Object.keys(update).length > 1) updates.push(update);
  }
  for (let i = 0; i < updates.length; i += 30)
    await fs.doc("update", "Item", { parentUuid: `Actor.${targetActor._id}`,
      updates: updates.slice(i, i + 30), diff: true, modifiedTime: Date.now() });
  return updates.length;
}

const stable = value => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
  return value;
};
function itemState(item, byId) {
  const s = item.system || {};
  const container = byId.get(s.container);
  return {
    name: item.name, type: item.type, source: sourceUuid(item),
    ...(item.type === "class" ? { level: s.levels } : {}),
    quantity: s.quantity ?? 1, equipped: !!s.equipped, attuned: !!s.attuned,
    prepared: s.prepared ?? null, method: s.method ?? null, uses: stable(s.uses || {}),
    container: container ? [container.name, container.type] : null,
    effects: (item.effects || []).map(e => [e.name, stable(e.changes || []), stable(e.statuses || [])])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  };
}

/** Compare item states after reconstruction; identical names alone are insufficient. */
export function compareRebuiltItemDetails(sourceActor, targetActor) {
  const sourceById = new Map((sourceActor.items || []).map(i => [i._id, i]));
  const targetById = new Map((targetActor.items || []).map(i => [i._id, i]));
  const groups = (items, byId) => {
    const map = new Map();
    for (const item of items) {
      const key = itemKey(item);
      const vals = map.get(key) || [];
      vals.push(itemState(item, byId)); map.set(key, vals);
    }
    for (const v of map.values()) v.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return map;
  };
  const a = groups(sourceActor.items || [], sourceById), b = groups(targetActor.items || [], targetById);
  const differences = [];
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const left = a.get(key) || [], right = b.get(key) || [];
    if (JSON.stringify(left) !== JSON.stringify(right)) differences.push({
      item: key, original: left, reconstruit: right
    });
  }
  return { conforme: differences.length === 0, differences };
}
