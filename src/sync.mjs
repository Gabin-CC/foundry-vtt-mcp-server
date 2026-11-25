/**
 * Synchronisation des objets d'une fiche avec leur compendium d'origine (`_stats.compendiumSource`) :
 * repère les objets auxquels il manque des effets, des activités ou des avancements (fiche écrite à la main,
 * ou créée avant que le serveur ne recopie tout) et les complète comme le ferait un import.
 * dry_run par défaut ; apply=true écrit (un instantané de restauration est gardé, outil snapshots).
 */
import { fixId, sanitizeItemData, itemWarnings, keyedCollection } from "./repair.mjs";
import { diffUpdates, saveSnapshot } from "./snapshots.mjs";

const VALID = /^[A-Za-z0-9]{16}$/;
const splitSource = src => {
  const m = String(src || "").match(/^Compendium\.(.+)\.Item\.([^.]+)$/);
  return m ? { pack: m[1], id: m[2] } : null;
};
const srcOf = it => it._stats?.compendiumSource || it.flags?.dnd5e?.sourceId || null;

/** Comparaison d'un objet de fiche avec sa source de compendium : ce qui manque. */
export function itemDiff(item, source) {
  const acts = keyedCollection(item.system?.activities || {}), sActs = keyedCollection(source.system?.activities || {});
  const adv = keyedCollection(item.system?.advancement || {}), sAdv = keyedCollection(source.system?.advancement || {});
  // activités manquantes, ou présentes mais à identifiant invalide (Foundry les ignore)
  const missingActs = Object.entries(sActs).filter(([k]) => {
    const current = acts[fixId(k)];
    return !current || (current._id && !VALID.test(current._id));
  }).map(([k, v]) => ({ id: k, name: v.name || v.type }));
  const effIds = new Set((item.effects || []).map(e => e._id));
  // An activity can reference an effect whose embedded document is missing.
  const missingEff = (source.effects || []).filter(e => !effIds.has(e._id)).map(e => ({ id: e._id, name: e.name, type: e.type }));
  // absent, à identifiant invalide, ou réduit à sa valeur (type/configuration perdus) : à compléter depuis la source
  const missingAdv = Object.keys(sAdv).filter(k => !adv[fixId(k)] || !adv[fixId(k)].type)
    .map(k => ({ id: k, name: sAdv[k]?.title || sAdv[k]?.type, keepValue: adv[fixId(k)]?.value ?? adv[k]?.value }));
  const changed = [];
  if (missingActs.length) changed.push(`${missingActs.length} activité(s) : ${missingActs.map(a => a.name).join(", ")}`);
  if (missingEff.length) changed.push(`${missingEff.length} effet(s) : ${missingEff.map(e => e.name).join(", ")}`);
  if (missingAdv.length) changed.push(`${missingAdv.length} avancement(s) : ${missingAdv.map(a => a.name).join(", ")}`);
  return { changed, missingActs, missingEff, missingAdv };
}

/** Mise à jour (notation pointée) qui ajoute ce qui manque, avec des identifiants valides. */
export function syncUpdate(item, source, diff) {
  const up = { _id: item._id };
  const sourceActivities = keyedCollection(source.system?.activities || {});
  const sourceAdvancements = keyedCollection(source.system?.advancement || {});
  const fragment = { system: { activities: {}, advancement: {} } };
  for (const a of diff.missingActs) {
    fragment.system.activities[a.id] = structuredClone(sourceActivities[a.id]);
  }
  for (const a of diff.missingAdv) {
    const d = structuredClone(sourceAdvancements[a.id]);
    if (a.keepValue != null && (typeof a.keepValue !== "object" || Object.keys(a.keepValue).length)) {
      d.value = structuredClone(a.keepValue); // Preserve already selected advancement choices.
    }
    fragment.system.advancement[a.id] = d;
  }
  sanitizeItemData(fragment);
  for (const a of diff.missingActs) {
    const id = fixId(a.id);
    if (id !== a.id && Object.hasOwn(item.system?.activities || {}, a.id)) up[`system.activities.-=${a.id}`] = null;
    up[`system.activities.${id}`] = fragment.system.activities[id];
  }
  for (const a of diff.missingAdv) {
    const id = fixId(a.id);
    if (id !== a.id && Object.hasOwn(item.system?.advancement || {}, a.id)) up[`system.advancement.-=${a.id}`] = null;
    up[`system.advancement.${id}`] = fragment.system.advancement[id];
  }
  // effets manquants : identifiant valide et unique, origine = la source, _stats retiré
  const effMap = {};
  if (diff.missingEff.length) {
    const taken = new Set((item.effects || []).map(e => e._id));
    const added = [];
    for (const e of diff.missingEff) {
      const src = (source.effects || []).find(x => x._id === e.id);
      const d = structuredClone(src);
      let id = fixId(e.id);
      if (!VALID.test(id) || taken.has(id)) {
        const base = (String(e.id).replace(/[^A-Za-z0-9]/g, "") + "sync").slice(0, 12);
        do { id = (base + Math.random().toString(36).slice(2, 6)).padEnd(16, "0").slice(0, 16); } while (taken.has(id));
      }
      effMap[e.id] = id; taken.add(id);
      d._id = id;
      d.origin = srcOf(item) || srcOf(source) || d.origin || null;
      delete d._stats; delete d.folder; delete d.sort;
      d.flags = { ...(d.flags || {}), dnd5e: { ...(d.flags?.dnd5e || {}), syncedFrom: srcOf(source) } };
      added.push(d);
    }
    up.effects = [...(item.effects || []), ...added];
    // activités (existantes ou ajoutées) : références d'effet à re-pointer
    const allActs = { ...(item.system?.activities || {}) };
    for (const a of diff.missingActs) {
      if (fixId(a.id) !== a.id) delete allActs[a.id];
      allActs[fixId(a.id)] = up[`system.activities.${fixId(a.id)}`];
    }
    for (const [k, a] of Object.entries(allActs)) {
      if (!a?.effects?.length) continue;
      let dirty = false;
      const list = a.effects.map(r => {
        const nid = effMap[String(r._id)] || effMap[String(r._id).split(".").pop()];
        if (!nid) return r;
        dirty = true; return { ...r, _id: nid };
      });
      if (dirty) up[`system.activities.${k}.effects`] = list;
    }
    // effets déjà présents dont l'identifiant est invalide : même chose
    for (const e of item.effects || []) {
      if (VALID.test(e._id)) continue;
      const nid = fixId(e._id);
      up[`effects.-=${e._id}`] = null;
      up.effects = [...(up.effects || item.effects || []).filter(x => x._id !== e._id), { ...e, _id: nid }];
      for (const [k, a] of Object.entries(allActs)) {
        if (!a?.effects) continue;
        const list = a.effects.map(r => (String(r._id) === e._id ? { ...r, _id: nid } : r));
        if (list.some((r, i) => r._id !== a.effects[i]._id)) up[`system.activities.${k}.effects`] = list;
      }
    }
  }
  return up;
}

/** Document source brut. Compendium absent du serveur (ex. module premium « dnd-players-handbook » que les
 *  compendiums dnd5e citent comme origine) : même _id cherché dans les compendiums d'objets installés. */
async function sourceDoc(fs, src) {
  const packs = (fs._packs2 ??= ((await fs.worldData()).packs || []));
  if (packs.some(p => p.id === src.pack)) {
    const d = (await fs.doc("get", "Item", { pack: src.pack, query: { _id: src.id } })).find(x => x._id === src.id);
    if (d) return d;
  }
  fs._syncIdx ??= new Map();
  for (const p of packs.filter(p => p.type === "Item")) {
    if (!fs._syncIdx.has(p.id)) {
      let ids = [];
      try { ids = (await fs.doc("get", "Item", { pack: p.id, query: {}, index: true, indexFields: ["_id"] })).map(x => x._id); } catch { /* */ }
      fs._syncIdx.set(p.id, new Set(ids));
    }
    if (fs._syncIdx.get(p.id).has(src.id)) {
      const d = (await fs.doc("get", "Item", { pack: p.id, query: { _id: src.id } })).find(x => x._id === src.id);
      if (d) return d;
    }
  }
  return null;
}

/** Synchronise les objets d'un acteur avec leur source de compendium (résumé compact : le détail par page). */
export async function syncItems(fs, { actor, item: itemRef, apply = false, only, pack: onlyPack } = {}) {
  const items = actor.items?.length ? actor.items : await fs.doc("get", "Item", { parentUuid: `Actor.${actor._id}`, query: {} });
  const wanted = only?.length ? only.map(o => String(o).toLowerCase()) : null;
  const chosen = itemRef ? items.filter(it => it._id === itemRef || it.name.toLowerCase() === String(itemRef).toLowerCase()) : items;
  if (itemRef && !chosen.length) throw new Error(`Objet introuvable sur ${actor.name} : ${itemRef}`);
  const ups = [], detail = [];
  let complet = 0, sansSource = 0;
  for (const it of chosen) {
    const ref = srcOf(it);
    const src = splitSource(ref);
    if (!src) { sansSource++; if (itemRef) detail.push({ nom: it.name, statut: "sans source (créé à la main)" }); continue; }
    if (onlyPack && src.pack !== onlyPack) continue;
    let source;
    try { source = await sourceDoc(fs, src); }
    catch (e) { detail.push({ nom: it.name, source: ref, probleme: e.message }); continue; }
    if (!source) { detail.push({ nom: it.name, source: ref, probleme: "source introuvable" }); continue; }
    const diff = itemDiff(it, source);
    if (!diff.changed.length) { complet++; continue; }
    const w = itemWarnings(it, [source]);
    detail.push({ nom: it.name, _id: it._id, source: ref, manque: diff.changed, ...(w.length ? { a_verifier: w } : {}) });
    if (apply) ups.push(syncUpdate(it, source, diff));
  }
  const todo = wanted ? ups.filter(u => wanted.includes((chosen.find(i => i._id === u._id)?.name || "").toLowerCase())) : ups;
  let modifies = 0, instantane = null;
  if (todo.length) {
    const cur = todo.length === 1 ? chosen.filter(i => i._id === todo[0]._id) : await fs.doc("get", "Item", { parentUuid: `Actor.${actor._id}`, query: {} });
    const diff = diffUpdates(cur, todo);
    if (diff.entries.length !== todo.length) throw new Error("Item synchronization aborted: cannot snapshot every requested change");
    instantane = await saveSnapshot(fs, "gm_sync_items", `synchronisation de ${actor.name}`, [{ action: "update", type: "Item", parent: `Actor.${actor._id}`, entries: diff.entries }]);
    if (!instantane) throw new Error("Item synchronization aborted: no recovery snapshot was created");
    for (let i = 0; i < todo.length; i += 50) {
      const r = await fs.doc("update", "Item", { parentUuid: `Actor.${actor._id}`, updates: todo.slice(i, i + 50), diff: true, recursive: true, modifiedTime: Date.now(), render: true });
      modifies += Array.isArray(r) ? r.length : 1;
    }
  }
  return {
    acteur: actor.name, objets: chosen.length, complets: complet, sans_source: sansSource,
    a_completer: detail.length, modifies, simulation: !apply,
    ...(instantane ? { instantane } : {}),
    ...(detail.length ? { detail } : {}),
    ...(!apply && detail.length ? { note: "Simulation : relancer avec apply=true pour compléter (un instantané de restauration est gardé)." } : {}),
  };
}
