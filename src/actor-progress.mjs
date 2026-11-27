/** Preview-first, reversible level progression for an existing single-class 2024 actor. */

const copy = value => structuredClone(value);
const FIELDS = ["name", "img", "system", "flags", "effects"];
const unsafe = new Set(["__proto__", "constructor", "prototype"]);
const obj = v => v !== null && typeof v === "object" && !Array.isArray(v);

/** A small, stable state: omit Foundry modification timestamps and derived-only fields. */
export function captureActorState(actor) {
  const fields = doc => Object.fromEntries(FIELDS.filter(k => doc[k] !== undefined)
    .map(k => [k, copy(doc[k])]));
  // Preserve immutable compendium provenance for items that must be recreated
  // during rollback (notably a spell removed by a class-level replacement).
  // Do not record volatile _stats timestamps, which would block safe restores.
  const itemFields = item => ({ ...fields(item),
    ...(item._stats?.compendiumSource ? { _stats: { compendiumSource: item._stats.compendiumSource } } : {}) });
  return { actor_id: actor._id, actor: fields(actor),
    items: (actor.items || []).map(i => ({ _id: i._id, ...itemFields(i), type: i.type }))
      .sort((a, b) => a._id.localeCompare(b._id)) };
}

export const sameActorState = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function diff(current, wanted, prefix = "", patch = {}) {
  if (JSON.stringify(current) === JSON.stringify(wanted)) return patch;
  if (obj(current) && obj(wanted)) {
    for (const k of new Set([...Object.keys(current), ...Object.keys(wanted)])) {
      if (unsafe.has(k) || k.includes(".")) throw new Error(`Unsupported Foundry field: ${k}`);
      const p = prefix ? `${prefix}.${k}` : k;
      if (!(k in wanted)) {
        const components = p.split(".");
        components[components.length - 1] = `-=${k}`;
        patch[components.join(".")] = null;
      } else diff(current[k], wanted[k], p, patch);
    }
  } else if (wanted !== undefined) patch[prefix] = copy(wanted);
  return patch;
}

/** The preview is non-mutating, including when advancement choices are unresolved. */
export function summarizeLevelPlan(actor, level, preview) {
  const classes = (actor.items || []).filter(i => i.type === "class");
  if (actor.type !== "character" || classes.length !== 1)
    throw new Error("progress_actor currently requires a character with exactly one existing class.");
  const cls = classes[0];
  const current = Number(cls.system?.levels) || 0;
  if (!Number.isInteger(level) || level <= current || level > 20)
    throw new Error(`Target class level must be an integer from ${current + 1} to 20.`);
  if (cls.system?.source?.rules !== "2024")
    throw new Error("progress_actor requires an existing D&D 2024 class.");
  return { simulation: true, pret: !!preview.pret, acteur: { id: actor._id, name: actor.name },
    classe: { id: cls._id, name: cls.name }, niveau_actuel: current, niveau_cible: level,
    choix_requis: preview.choix_requis || [], etapes: preview.etapes || [],
    avertissements: preview.avertissements || [],
    rappel: "Provide all requested choices, then call progress_actor with apply=true. No changes were made." };
}

export function actorStateRestorePlan(current, previous) {
  if (current.actor_id !== previous.actor_id) throw new Error("Snapshot belongs to a different actor.");
  const oldIds = new Set(previous.items.map(i => i._id));
  const nowIds = new Set(current.items.map(i => i._id));
  const added = current.items.filter(i => !oldIds.has(i._id));
  const missing = previous.items.filter(i => !nowIds.has(i._id));
  const modified = previous.items.filter(i => nowIds.has(i._id) &&
    !sameActorState(i, current.items.find(x => x._id === i._id)));
  return { actor_update: diff(current.actor, previous.actor),
    item_updates: modified.map(i => ({ _id: i._id,
      ...diff(current.items.find(x => x._id === i._id), i) })),
    added, missing, modified: modified.map(i => i._id) };
}

/** Restore only if the character still exactly matches the state recorded after progression. */
export async function restoreActorState(fs, expectedAfter, previous, { dryRun = false } = {}) {
  const docs = await fs.doc("get", "Actor", { query: { _id: previous.actor_id } });
  const actor = docs.find(a => a._id === previous.actor_id);
  if (!actor) throw new Error("Character missing; cannot restore progression snapshot.");
  const current = captureActorState(actor);
  if (!sameActorState(current, expectedAfter))
    throw new Error("Character has changed since this progression. Restore refused to protect later edits.");
  const plan = actorStateRestorePlan(current, previous);
  const report = { acteur: previous.actor_id, simulation: dryRun,
    objets_a_supprimer: plan.added.map(i => i._id),
    objets_a_recreer: plan.missing.map(i => i._id),
    objets_a_restaurer: plan.modified,
    proprietes_acteur: Object.keys(plan.actor_update) };
  if (dryRun) return report;
  const parentUuid = `Actor.${previous.actor_id}`;
  // Remove the newly granted items before restoring the original items, abilities and class level.
  if (plan.added.length) await fs.doc("delete", "Item", { parentUuid,
    ids: plan.added.map(i => i._id), modifiedTime: Date.now() });
  if (plan.missing.length) await fs.doc("create", "Item", { parentUuid,
    data: plan.missing, keepId: true, keepEmbeddedIds: true, modifiedTime: Date.now() });
  if (plan.item_updates.length) await fs.doc("update", "Item", { parentUuid,
    updates: plan.item_updates, diff: true, modifiedTime: Date.now() });
  if (Object.keys(plan.actor_update).length) await fs.doc("update", "Actor", { updates: [
    { _id: previous.actor_id, ...plan.actor_update }
  ], diff: true, modifiedTime: Date.now() });
  return report;
}
