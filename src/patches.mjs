/**
 * Correctifs de données de compendium : entrées dont la structure ne correspond pas à ce que le système
 * dnd5e 5/6 attend (dégâts « on hit » sans jet d'attaque, classification d'attaque absente).
 * S'applique à la source (compendium du monde) et aux copies déjà posées sur les fiches (gm_patch_items).
 *
 * Correctif = { id, raison, match(doc), patch(doc) } — patch() modifie la copie et renvoie true si changée.
 */
const clone = o => structuredClone(o);
const AID = n => (n + "0000000000000").slice(0, 16);   // identifiant valide 16 alphanumériques
const isWeaponCantrip = name => /^(booming blade|lame retentissante|green-flame blade|lame des flammes vertes)$/i.test(String(name || "").trim());
const hasWeaponAttack = doc => Object.values(doc.system?.activities || {}).some(a => a.type === "attack"
  && (a.attack?.type?.classification === "weapon" || a.attack?.classification === "weapon"));
const hasDamage = doc => Object.values(doc.system?.activities || {}).some(a => a.type === "damage");

/** Un cantrip d'arme : dégâts « on hit » sans attaque → activité d'attaque (arme de mêlée) + dégâts de l'arme. */
function weaponCantrip(doc, attackId) {
  if (hasWeaponAttack(doc) || !hasDamage(doc)) return false;
  const acts = doc.system.activities;
  const [id, act] = Object.entries(acts).find(([, a]) => a.type === "damage");
  const attack = {
    _id: AID(attackId), type: "attack", name: "", sort: -1,
    activation: clone(act.activation || { type: "action", override: false }),
    consumption: clone(act.consumption || { spellSlot: true, targets: [], scaling: { allowed: false } }),
    description: {}, duration: clone(act.duration || { units: "inst", concentration: false, override: false }),
    effects: [], range: { units: "self", override: false },
    target: { affects: { count: "1", type: "creature", choice: false }, template: { units: "ft", contiguous: false }, override: false, prompt: true },
    uses: { spent: 0, recovery: [] },
    attack: { type: { value: "melee", classification: "weapon" }, ability: "", bonus: "", critical: { threshold: 20 }, flat: false },
    damage: { critical: { allow: false }, includeBase: true, parts: clone(act.damage?.parts || []) },
    flags: {}, visibility: { level: {} },
  };
  for (const p of attack.damage.parts) {
    p.scaling = { mode: "whole", number: p.scaling?.number || 1 };
    if (p.custom?.enabled && /\[\s*on hit\s*\]/i.test(p.custom.formula || "")) p.custom.formula = p.custom.formula.replace(/\[\s*on hit\s*\]/i, "").trim();
  }
  acts[attack._id] = attack;   // l'attaque passe avant les dégâts de zone éventuels
  act.sort = (act.sort || 0) + 1;
  doc.system.activities = acts;
  return true;
}

export const PATCHES = [
  {
    id: "booming-blade-attack",
    raison: "Lame retentissante : dégâts « on hit » sans jet d'attaque → attaque d'arme (mêlée) + dégâts de l'arme.",
    match: doc => doc.type === "spell" && isWeaponCantrip(doc.name) && /booming|retentissante/i.test(String(doc.name)),
    patch: doc => weaponCantrip(doc, "bbAttack"),
  },
  {
    id: "green-flame-blade-attack",
    raison: "Lame des flammes vertes : dégâts « on hit » sans jet d'attaque → attaque d'arme (mêlée) + dégâts de l'arme.",
    match: doc => doc.type === "spell" && isWeaponCantrip(doc.name) && /green-flame|flammes vertes/i.test(String(doc.name)),
    patch: doc => weaponCantrip(doc, "gfbAttack"),
  },
];

/** Correctifs applicables à un document. */
export const patchesFor = doc => PATCHES.filter(p => { try { return p.match(doc); } catch { return false; } });

/** Applique les correctifs à une copie du document. Renvoie { doc, appliques: [id…] }. */
export function applyPatches(doc) {
  const d = clone(doc);
  const appliques = [];
  for (const p of patchesFor(d)) if (p.patch(d)) appliques.push(p.id);
  // ordre stable : activités par sort croissant (l'attaque d'arme avant les dégâts de zone)
  const acts = d.system?.activities;
  if (acts) {
    const sorted = {};
    for (const [k, v] of Object.entries(acts).sort((a, b) => (a[1].sort || 0) - (b[1].sort || 0))) sorted[k] = v;
    d.system.activities = sorted;
  }
  return { doc: d, appliques };
}
