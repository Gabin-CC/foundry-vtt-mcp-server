/**
 * Identifiants invalides dans les données d'objets (Foundry v14 exige 16 caractères alphanumériques).
 * Un seul identifiant invalide (avancement, activité, effet) suffit pour que le navigateur rejette tout
 * l'objet : il disparaît de la fiche alors que le serveur le garde (ex. don « Résilient »).
 *
 * - fixId : remplace un identifiant invalide par un identifiant valide DÉTERMINISTE (même ancien
 *   identifiant -> même nouvel identifiant), pour que compendium et fiches restent cohérents.
 * - sanitizeItemData : corrige un objet avant sa création (import, avancement).
 * - scanAndRepair : outil MJ, contrôle (et corrige sur demande) compendiums du monde, objets du monde et fiches.
 */
import crypto from "node:crypto";

export const VALID_ID = /^[A-Za-z0-9]{16}$/;

export function fixId(id) {
  if (id == null || VALID_ID.test(id)) return id;
  const alnum = String(id).replace(/[^A-Za-z0-9]/g, "");
  const hash = crypto.createHash("sha1").update(String(id)).digest("hex");
  return alnum.length >= 16 ? alnum.slice(0, 12) + hash.slice(0, 4) : (alnum + hash).slice(0, 16);
}

/** Collections indexées par identifiant (clé = _id) d'un objet dnd5e. */
const KEYED = ["advancement", "activities"];

/** Problèmes d'identifiants d'un objet (source). */
export function idIssues(item) {
  const out = [];
  for (const coll of KEYED) {
    for (const [k, v] of Object.entries(item.system?.[coll] || {})) {
      if (!VALID_ID.test(k) || (v?._id && !VALID_ID.test(v._id))) out.push({ coll, id: k });
    }
  }
  for (const e of item.effects || []) if (e?._id && !VALID_ID.test(e._id)) out.push({ coll: "effects", id: e._id });
  for (const p of item.pages || []) if (p?._id && !VALID_ID.test(p._id)) out.push({ coll: "pages", id: p._id });
  return out;
}

/** Corrige en place les données d'un objet avant création. Renvoie la liste des identifiants changés. */
export function sanitizeItemData(d) {
  const changed = [];
  for (const coll of KEYED) {
    const obj = d.system?.[coll];
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) continue;
    let dirty = false;
    const next = {};
    for (const [k, v] of Object.entries(obj)) {
      const nk = fixId(k);
      if (nk !== k || (v?._id && v._id !== nk)) dirty = true;
      if (nk !== k) changed.push(`${coll}:${k}→${nk}`);
      next[nk] = v && typeof v === "object" ? { ...v, _id: nk } : v;
    }
    if (dirty) d.system[coll] = next;
  }
  const effMap = {};   // ancien identifiant -> nouvel identifiant (effets)
  const remap = (v) => {
    if (Array.isArray(v)) return v.map(remap);
    if (!v || typeof v !== "object") return v;
    const o = { ...v };
    if (o._id && effMap[o._id]) o._id = effMap[o._id];
    for (const k of Object.keys(o)) if (o[k] && typeof o[k] === "object") o[k] = remap(o[k]);
    return o;
  };
  // les références peuvent être préfixées du UUID de l'objet (« Item.x.ActiveEffect.y ») : on ne garde que la fin
  const keyOf = v => { const s = String(v ?? ""); return effMap[s] ? s : s.split(".").pop(); };
  for (const e of d.effects || []) if (e?._id && !VALID_ID.test(e._id)) effMap[e._id] = fixId(e._id);
  if (Object.keys(effMap).length) {
    changed.push(...Object.entries(effMap).map(([o, n]) => `effects:${o}→${n}`));
    for (const e of d.effects || []) if (e?._id && effMap[e._id]) e._id = effMap[e._id];
    for (const act of Object.values(d.system?.activities || {})) {
      if (!act?.effects) continue;
      act.effects = remap(act.effects);
      for (const r of act.effects) {
        const k = keyOf(r._id);
        if (effMap[k]) r._id = effMap[k];
        if (r.riders?.effect) r.riders.effect = r.riders.effect.map(x => effMap[keyOf(x)] || x);
      }
    }
    for (const e of d.effects || []) {
      if (e?.origin) { const k = keyOf(e.origin); if (k !== e.origin) e.origin = effMap[k]; }
      if (e?.system?.origin) e.system.origin = remap(e.system.origin);
    }
  }
  for (const p of d.pages || []) if (p?._id && !VALID_ID.test(p._id)) p._id = fixId(p._id);
  return changed;
}

/** Avertissements sur un objet (copie d'acteur ou source) : activité, effet ou avancement vide. */
export function itemWarnings(item, sources = []) {
  const warnings = [];
  const acts = Object.values(item.system?.activities || {});
  const advs = Object.values(item.system?.advancement || {});
  const desc = String(item.system?.description?.value || "");
  if (!acts.length && item.type !== "equipment" && item.type !== "container" && item.type !== "loot"
    && item.type !== "consumable" && item.type !== "tool" && item.type !== "weapon" && item.type !== "armor") {
    warnings.push(`aucune activité (${item.type})`);
  }
  for (const s of sources) {
    if (!s || s._id === item._id) continue;
    const sActs = Object.values(s.system?.activities || {}).length;
    const sEff = (s.effects || []).length, sAdv = Object.values(s.system?.advancement || {}).length;
    const eff = (item.effects || []).length, adv = advs.length;
    if (sActs > acts.length) warnings.push(`${sActs} activité(s) dans la source « ${s.name || s._id} », ${acts.length} ici`);
    if (sEff > eff) warnings.push(`${sEff} effet(s) dans la source « ${s.name || s._id} », ${eff} ici`);
    if (sAdv > adv) warnings.push(`${sAdv} avancement(s) dans la source, ${adv} ici`);
  }
  if (!acts.length && !(item.effects || []).length && desc.length > 80 && !warnings.length) warnings.push("objet sans activité ni effet : importable depuis un compendium");
  return [...new Set(warnings)];
}

/** Mise à jour Foundry (renommage des clés invalides : suppression + ajout) pour un objet existant. */
function repairUpdate(item) {
  const up = { _id: item._id };
  let n = 0;
  for (const coll of KEYED) {
    for (const [k, v] of Object.entries(item.system?.[coll] || {})) {
      const nk = fixId(k);
      if (nk === k && (!v?._id || v._id === k)) continue;
      if (nk !== k) up[`system.${coll}.-=${k}`] = null;
      up[`system.${coll}.${nk}`] = { ...v, _id: nk };
      n++;
    }
  }
  return n ? up : null;
}

/**
 * Contrôle les identifiants des objets : compendiums d'objets du monde, objets du monde, objets des fiches.
 * apply=true : corrige avancements et activités (les effets à identifiant invalide sont seulement signalés :
 * l'identifiant d'un document ne peut pas être modifié).
 */
export async function scanAndRepair(fs, { apply = false, actors = true, items = true, packs = true } = {}) {
  const report = { compendiums: [], objets_du_monde: [], fiches: [], effets_a_refaire: [], corriges: 0 };
  const handle = async (list, where, opts, bucket) => {
    const ups = [];
    for (const it of list) {
      const iss = idIssues(it);
      if (!iss.length) continue;
      bucket.push({ ou: where, objet: it.name, _id: it._id, ids: iss.map(i => `${i.coll}:${i.id}`) });
      for (const i of iss) if (i.coll === "effects") report.effets_a_refaire.push(`${where} / ${it.name} : ${i.id}`);
      const u = repairUpdate(it);
      if (u) ups.push(u);
    }
    if (apply && ups.length) {
      await fs.doc("update", "Item", { ...opts, updates: ups, diff: true, modifiedTime: Date.now() });
      report.corriges += ups.length;
    }
    return ups;
  };
  if (packs) {
    const world = ((await fs.worldData()).packs || []).filter(p => p.type === "Item" && String(p.id).startsWith("world."));
    for (const p of world) {
      const docs = await fs.doc("get", "Item", { pack: p.id, query: {} });
      await handle(docs, p.id, { pack: p.id }, report.compendiums);
    }
  }
  if (items) await handle(await fs.doc("get", "Item", { query: {} }), "monde", {}, report.objets_du_monde);
  if (actors) {
    for (const a of await fs.doc("get", "Actor", { query: {} })) {
      const its = await fs.doc("get", "Item", { parentUuid: `Actor.${a._id}`, query: {} });
      const ups = await handle(its, a.name, { parentUuid: `Actor.${a._id}` }, report.fiches);
      // références d'avancement des autres objets de la fiche (« objet.avancement ») renommées de la même façon
      if (apply && ups.length) {
        const refUps = [];
        for (const it of its) {
          const f = it.flags?.dnd5e || {}, u = { _id: it._id };
          for (const key of ["advancementOrigin", "advancementRoot"]) {
            const [iid, aid] = String(f[key] || "").split(".");
            if (aid && fixId(aid) !== aid) u[`flags.dnd5e.${key}`] = `${iid}.${fixId(aid)}`;
          }
          if (Object.keys(u).length > 1) refUps.push(u);
        }
        if (refUps.length) await fs.doc("update", "Item", { parentUuid: `Actor.${a._id}`, updates: refUps, diff: true, modifiedTime: Date.now() });
      }
    }
  }
  report.total = report.compendiums.length + report.objets_du_monde.length + report.fiches.length;
  report.simulation = !apply;
  return report;
}
