/**
 * Cibles de use_item : jetons (UUID Scene.x.Token.y, _id ou nom sur la scène active) ou acteurs.
 * use_item calcule une proposition par cible (touché selon la CA, jet de sauvegarde de la cible, dégâts avec
 * résistances / immunités / vulnérabilités, soins, effets / états de l'activité) ; rien n'est appliqué avant
 * validation par apply_damage (proposition entière, sous-ensemble de cibles ou valeurs corrigées).
 */
import crypto from "node:crypto";
import { message } from "./i18n.mjs";
import { sheet, checkBonus, rollFormula, ABIL } from "./dnd5e.mjs";
import { norm } from "./texts.mjs";

const TTL = 60 * 60 * 1000;
const proposals = new Map();   // id -> { owner, at, ... }
const num = v => Number.isFinite(Number(v)) ? Number(v) : 0;
const isObj = v => v && typeof v === "object" && !Array.isArray(v);
function merge(base, over) {
  if (!isObj(over)) return over === undefined ? base : over;
  const r = isObj(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(over)) r[k] = isObj(v) ? merge(r[k], v) : v;
  return r;
}

/** Acteur effectif d'un jeton (acteur de base + delta pour un jeton non lié). */
function syntheticActor(base, token) {
  if (!token || token.actorLink || !token.delta) return base;
  const d = token.delta;
  const a = { ...base, name: d.name || token.name || base.name, system: merge(base.system, d.system || {}) };
  if (Array.isArray(d.items) && d.items.length) { const ids = new Set(d.items.map(i => i._id)); a.items = [...(base.items || []).filter(i => !ids.has(i._id)), ...d.items]; }
  if (Array.isArray(d.effects) && d.effects.length) { const ids = new Set(d.effects.map(e => e._id)); a.effects = [...(base.effects || []).filter(e => !ids.has(e._id)), ...d.effects]; }
  return a;
}

/** Résout une cible → { label, uuid, actor, token, scene, write: {type, parentUuid, _id, prefix} }. */
export async function resolveTarget(fs, ref) {
  ref = String(ref || "").trim();
  let m = /^Scene\.([A-Za-z0-9]{16})\.Token\.([A-Za-z0-9]{16})$/.exec(ref);
  let scene, token;
  if (m) {
    scene = (await fs.doc("get", "Scene", { query: { _id: m[1] } })).find(s => s._id === m[1]);
    token = scene && (await fs.doc("get", "Token", { parentUuid: `Scene.${m[1]}`, query: {} })).find(t => t._id === m[2]);
    if (!token) throw new Error(message(`Token not found: ${ref}`, `Jeton introuvable : ${ref}`));
  } else if ((m = /^Actor\.([A-Za-z0-9]{16})$/.exec(ref))) {
    const actor = (await fs.doc("get", "Actor", { query: { _id: m[1] } })).find(a => a._id === m[1]);
    if (!actor) throw new Error(message(`Actor not found: ${ref}`, `Acteur introuvable : ${ref}`));
    return { label: actor.name, uuid: ref, actor, write: { type: "Actor", _id: actor._id, parentUuid: null } };
  } else {
    // jeton de la scène active par _id ou nom
    const scenes = await fs.doc("get", "Scene", { query: {} });
    scene = scenes.find(s => s.active);
    if (!scene) throw new Error(message(`No active scene to find token "${ref}": provide its UUID (Scene.x.Token.y)`, `Aucune scène active pour trouver le jeton « ${ref} » : donner son UUID (Scene.x.Token.y)`));
    const tokens = await fs.doc("get", "Token", { parentUuid: `Scene.${scene._id}`, query: {} });
    const hits = tokens.filter(t => t._id === ref).concat(tokens.filter(t => norm(t.name) === norm(ref)));
    if (!hits.length) throw new Error(message(`Token "${ref}" not found on the active scene (${scene.name})`, `Jeton « ${ref} » introuvable sur la scène active (${scene.name})`));
    if (hits.length > 1 && hits[0]._id !== ref) throw new Error(message(`Multiple tokens match "${ref}": ${hits.map(t => `Scene.${scene._id}.Token.${t._id}`).join(", ")}`, `Plusieurs jetons « ${ref} » : ${hits.map(t => `Scene.${scene._id}.Token.${t._id}`).join(", ")}`));
    token = hits[0];
  }
  const base = token.actorId ? (await fs.doc("get", "Actor", { query: { _id: token.actorId } })).find(a => a._id === token.actorId) : null;
  if (!base) throw new Error(message(`Token ${token.name} has no actor`, `Le jeton ${token.name} n'a pas d'acteur`));
  const actor = syntheticActor(base, token);
  const tokenUuid = `Scene.${scene._id}.Token.${token._id}`;
  const write = token.actorLink ? { type: "Actor", _id: base._id, parentUuid: null }
    : { type: "ActorDelta", _id: token.delta?._id || token._id, parentUuid: tokenUuid, effectsParent: `${tokenUuid}.ActorDelta.${token.delta?._id || token._id}` };
  return { label: token.name || actor.name, uuid: tokenUuid, actor, token, scene, write };
}

const DMG_FR = { acid: "acide", bludgeoning: "contondant", cold: "froid", fire: "feu", force: "force", lightning: "foudre", necrotic: "nécrotique",
  piercing: "perforant", poison: "poison", psychic: "psychique", radiant: "radiant", slashing: "tranchant", thunder: "tonnerre" };
const traitSet = (actor, k) => new Set([...(actor.system?.traits?.[k]?.value || [])]);

/** Proposition pour chaque cible à partir du résultat de useItem. */
export async function propose(fs, { attacker, item, res, targets, mode }) {
  const rows = [], saveRolls = [];
  const effectsData = (res.activity?.effects || []).map(id => (item.effects || []).find(e => e._id === id)).filter(Boolean);
  for (const t of targets) {
    const A = t.actor, sh = sheet(A);
    const row = { cible: t.label, uuid: t.uuid, pv: `${num(A.system?.attributes?.hp?.value)}/${sh.pv.max}`, ca: sh.ca_estimee };
    let mult = 1, landed = true;
    if (res.attack) {
      const hit = res.attack.crit || (res.attack.nat !== 1 && res.attack.total >= sh.ca_estimee);
      row.attaque = `${res.attack.total} contre CA ${sh.ca_estimee} : ${res.attack.crit ? "critique" : hit ? "touché" : "raté"}`;
      if (!hit) { mult = 0; landed = false; }
    }
    if (res.save) {
      const ab = res.save.abilities[0];
      const { bonus } = checkBonus(A, "save", ab);
      const r = rollFormula(`1d20${bonus >= 0 ? "+" : ""}${bonus}`, { flavor: `${t.label} — sauvegarde de ${ABIL[ab] || ab}` });
      saveRolls.push(r);
      const ok = r.total >= res.save.dc;
      row.sauvegarde = `${ABIL[ab] || ab} ${r.total} contre DD ${res.save.dc} : ${ok ? "réussie" : "ratée"}`;
      if (ok) { mult = res.save.onSave === "half" ? 0.5 : 0; landed = false; }
    }
    if (res.damage?.length) {
      const di = traitSet(A, "di"), dr = traitSet(A, "dr"), dv = traitSet(A, "dv");
      let total = 0; const detail = [];
      for (const p of res.damage) {
        const type = p.types[0];
        const k = !type ? 1 : di.has(type) ? 0 : dv.has(type) ? 2 : dr.has(type) ? 0.5 : 1;
        const v = Math.floor(p.total * mult * k);
        total += v;
        detail.push(`${v} ${DMG_FR[type] || type || ""}${k !== 1 ? ` (${k === 0 ? "immunité" : k === 2 ? "vulnérabilité" : "résistance"})` : ""}`.trim());
      }
      row.degats = total; row.detail_degats = detail.join(" + ");
    }
    if (res.healing) row[res.healing.temp ? "pv_temporaires" : "soins"] = res.healing.total;
    if (effectsData.length && (landed || (!res.attack && !res.save))) row.effets = effectsData.map(e => e.name);
    rows.push(row);
  }
  const id = crypto.randomBytes(5).toString("hex");
  const now = Date.now();
  for (const [k, p] of proposals) if (now - p.at > TTL) proposals.delete(k);
  proposals.set(id, { owner: fs.userId, at: now, item: item.name, itemUuid: `Actor.${attacker._id}.Item.${item._id}`, effects: effectsData, rows });
  return { id, rows, saveRolls };
}

/** Jeton non lié jamais modifié : pas encore de delta (null) — on le crée via le jeton, comme le client. */
async function ensureDelta(fs, t) {
  if (t.write.type !== "ActorDelta" || t.token.delta) return;
  await fs.doc("update", "Token", { parentUuid: `Scene.${t.scene._id}`, updates: [{ _id: t.token._id, delta: { _id: t.token._id, system: {} } }], modifiedTime: Date.now() });
  t.token.delta = { _id: t.token._id, system: {} };
}

async function applyHp(fs, t, { damage = 0, healing = 0, temp = 0 }) {
  const hp = t.actor.system?.attributes?.hp || {};
  const max = sheet(t.actor).pv.max;
  let value = num(hp.value), tmp = num(hp.temp);
  const before = { pv: value, temp: tmp };
  if (damage > 0) { const fromTemp = Math.min(tmp, damage); tmp -= fromTemp; value = Math.max(0, value - (damage - fromTemp)); }
  if (healing > 0) value = Math.min(max, value + healing);
  if (temp > 0) tmp = Math.max(tmp, temp);   // les PV temporaires ne se cumulent pas
  await ensureDelta(fs, t);
  const upd = { _id: t.write._id, "system.attributes.hp.value": value, "system.attributes.hp.temp": tmp };
  await fs.doc("update", t.write.type, { updates: [upd], diff: true, modifiedTime: Date.now(), ...(t.write.parentUuid ? { parentUuid: t.write.parentUuid } : {}) });
  return { avant: before, apres: { pv: value, temp: tmp, max } };
}

async function applyEffects(fs, t, effects, originUuid) {
  const parentUuid = t.write.type === "Actor" ? `Actor.${t.write._id}` : t.write.effectsParent;
  const existing = (t.actor.effects || []).map(e => `${e.name}|${e.origin}`);
  const data = effects.filter(e => !existing.includes(`${e.name}|${originUuid}`)).map(e => {
    const d = structuredClone(e); delete d._id; delete d._stats;
    return { ...d, disabled: false, transfer: false, origin: originUuid };
  });
  await ensureDelta(fs, t);
  if (data.length) await fs.doc("create", "ActiveEffect", { parentUuid, data, modifiedTime: Date.now() });
  return data.map(d => d.name);
}

/**
 * Applique une proposition (ou des valeurs données) aux cibles.
 * a = { proposal, targets?: [ref], overrides?: [{target, damage, healing, temp, multiplier, effects}], manual?: [{target, damage, healing, temp}] }
 */
export async function applyDamage(fs, a, { postChat }) {
  const lines = [], report = [];
  let rows = [], effects = [], origin = null, label = "";
  if (a.proposal) {
    const p = proposals.get(a.proposal);
    if (!p || p.owner !== fs.userId) throw new Error(message("Unknown or expired proposal (1 hour): run use_item with targets again", "Proposition inconnue ou expirée (1 h) : relancer use_item avec targets"));
    if (p.applied && !a.force) throw new Error(message("Proposal already applied (use force=true to apply again)", "Proposition déjà appliquée (force=true pour recommencer)"));
    rows = p.rows; effects = p.effects; origin = p.itemUuid; label = p.item;
    if (a.targets?.length) rows = rows.filter(r => a.targets.some(x => x === r.uuid || norm(x) === norm(r.cible)));
    p.applied = true;
  }
  const manual = a.manual || [];
  if (!rows.length && !manual.length) throw new Error(message("Nothing to apply: provide a 'proposal' from use_item or use 'manual'", "Rien à appliquer : préciser 'proposal' (issue de use_item) ou 'manual'"));
  const todo = [
    ...rows.map(r => ({ ref: r.uuid, damage: r.degats || 0, healing: r.soins || 0, temp: r.pv_temporaires || 0, effects: !!r.effets?.length })),
    ...manual.map(m => ({ ref: m.target, damage: num(m.damage), healing: num(m.healing), temp: num(m.temp), effects: false })),
  ];
  for (const o of a.overrides || []) {
    const row = todo.find(x => x.ref === o.target) || todo.find(x => norm(rows.find(r => r.uuid === x.ref)?.cible) === norm(o.target));
    if (!row) throw new Error(message(`Unknown override target: ${o.target}`, `Cible de correction inconnue : ${o.target}`));
    if (o.multiplier != null) row.damage = Math.floor(row.damage * Number(o.multiplier));
    for (const k of ["damage", "healing", "temp"]) if (o[k] != null) row[k] = num(o[k]);
    if (o.effects != null) row.effects = !!o.effects;
  }
  for (const x of todo) {
    try {
      const t = await resolveTarget(fs, x.ref);
      const r = { cible: t.label, uuid: t.uuid };
      if (x.damage || x.healing || x.temp) {
        const hp = await applyHp(fs, t, x);
        Object.assign(r, { degats: x.damage || undefined, soins: x.healing || undefined, pv_temporaires: x.temp || undefined, pv: `${hp.avant.pv} → ${hp.apres.pv}/${hp.apres.max}${hp.apres.temp ? ` (+${hp.apres.temp} temp.)` : ""}` });
        lines.push(`${t.label} : ${x.damage ? `${x.damage} dégâts` : ""}${x.healing ? `${x.healing} PV rendus` : ""}${x.temp ? `${x.temp} PV temporaires` : ""} (PV ${hp.avant.pv} → ${hp.apres.pv})`);
      }
      if (x.effects && effects.length) {
        r.effets = await applyEffects(fs, t, effects, origin);
        if (r.effets.length) lines.push(`${t.label} : ${r.effets.join(", ")}`);
      }
      report.push(r);
    } catch (e) { report.push({ cible: x.ref, erreur: e.message }); }
  }
  if (a.chat !== false && lines.length)
    await postChat(fs, { flavor: label ? `${label} — effets appliqués` : "Dégâts / soins", content: `<ul>${lines.map(l => `<li>${l.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]))}</li>`).join("")}</ul>`, mode: a.mode });
  return { applique: report };
}
