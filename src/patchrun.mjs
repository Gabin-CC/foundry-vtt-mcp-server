/**
 * Correctifs de données (src/patches.mjs) appliqués à un acteur, à un compendium du monde ou à tous les acteurs.
 * dry_run par défaut ; apply=true écrit (un instantané de restauration est gardé, outil snapshots).
 */
import { applyPatches } from "./patches.mjs";
import { sanitizeItemData } from "./repair.mjs";
import { diffUpdates, saveSnapshot } from "./snapshots.mjs";

/** Applique les correctifs aux objets d'une liste (acteur ou compendium). */
export async function patchItems(fs, { actor = null, parentUuid = null, pack = null, items, apply = false, itemRef = null }) {
  const list = itemRef ? items.filter(i => i._id === itemRef || i.name.toLowerCase() === String(itemRef).toLowerCase()) : items;
  if (itemRef && !list.length) throw new Error(`Objet introuvable : ${itemRef}`);
  const where = actor ? actor.name : pack;
  const updates = [], detail = [];
  for (const it of list) {
    const { doc, appliques } = applyPatches(it);
    if (!appliques.length) continue;
    sanitizeItemData(doc);
    const up = { _id: it._id };
    up.system = { ...doc.system };
    up.effects = doc.effects;
    updates.push(up);
    detail.push({ nom: it.name, _id: it._id, correctifs: appliques });
  }
  let instantane = null;
  if (apply && updates.length) {
    try {
      const diff = diffUpdates(list.filter(i => updates.some(u => u._id === i._id)), updates);
      instantane = await saveSnapshot(fs, "gm_patch_items", `correctifs de ${where}`, [{ action: "update", type: "Item", ...(parentUuid ? { parent: parentUuid } : {}), ...(pack ? { pack } : {}), entries: diff.entries }]);
    } catch { /* instantané impossible : on écrit quand même */ }
    await fs.doc("update", "Item", { ...(parentUuid ? { parentUuid } : {}), ...(pack ? { pack } : {}), updates, diff: true, recursive: true, modifiedTime: Date.now(), render: true });
  }
  return {
    ou: where, objets: list.length, a_corriger: detail.length, modifies: apply ? updates.length : 0,
    simulation: !apply, ...(detail.length ? { detail } : {}),
    ...(instantane ? { instantane } : {}),
    ...(!apply && detail.length ? { note: "Simulation : relancer avec apply=true pour écrire (un instantané de restauration est gardé)." } : {}),
  };
}

/** Correctifs sur un acteur (tous ses objets, ou un seul). */
export async function patchActor(fs, actor, { item = null, apply = false } = {}) {
  const items = actor.items?.length ? actor.items : await fs.doc("get", "Item", { parentUuid: `Actor.${actor._id}`, query: {} });
  return patchItems(fs, { actor, parentUuid: `Actor.${actor._id}`, items, itemRef: item, apply });
}

/** Correctifs sur un compendium du monde. */
export async function patchPack(fs, packId, { item = null, apply = false } = {}) {
  const items = await fs.doc("get", "Item", { pack: packId, query: {} });
  return patchItems(fs, { pack: packId, items, itemRef: item, apply });
}