/**
 * Sorts des activités « Lancer un sort » (cast) — équivalent de CastActivity#getCachedSpellData de dnd5e.
 * Dans Foundry, quand un objet doté d'une activité « cast » est ajouté à un acteur, le système crée une copie
 * du sort sur l'acteur (drapeau flags.dnd5e.cachedFor, enchantement « Modifications de Sort »). Ce traitement
 * tourne dans le navigateur ; le MCP, sans navigateur, le reproduit ici.
 */
import { fetchUuid } from "./advancement.mjs";
import { sanitizeItemData } from "./repair.mjs";

const FOUNDRY = process.env.FOUNDRY_URL || "http://127.0.0.1:30000";
const LANG_FILES = (process.env.LANG_FILES || "dnd5e_fr-FR/fr.json").split(",").map(s => s.trim()).filter(Boolean);
let lang = null;
export async function loc(key, fallback) {
  if (!lang) {
    lang = {};
    for (const f of LANG_FILES) { try { const r = await fetch(`${FOUNDRY}/modules/${f}`); if (r.ok) lang = { ...(await r.json()), ...lang }; } catch { /* absent */ } }
  }
  const v = key in lang ? lang[key] : key.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), lang);
  return typeof v === "string" ? v : fallback;
}

const ENCHANTMENT_ID = "dnd5espellchange";   // staticID("dnd5espellchanges") : 16 caractères

function spellChanges(act) {
  const changes = [{ key: "system.method", type: "override", value: "spell" }];
  for (const type of ["activation", "duration", "range", "target"]) {
    const data = act[type]; if (!data?.override) continue;
    const d = { ...data }; delete d.override;
    changes.push({ key: `system.${type}`, type: "override", value: JSON.stringify(d) });
    if (type === "duration") changes.push({ key: "system.properties", type: d.concentration ? "add" : "subtract", value: "concentration" });
  }
  if (act.spell?.ability) changes.push({ key: "system.ability", type: "override", value: act.spell.ability });
  for (const p of act.spell?.properties || []) changes.push({ key: "system.properties", type: "add", value: `-${p}` });
  const ch = act.spell?.challenge || {};
  if (ch.override && ch.attack) changes.push(
    { key: "activities[attack].attack.bonus", type: "override", value: ch.attack },
    { key: "activities[attack].attack.flat", type: "override", value: true },
    { key: "activities[summon].flat.attack", type: "override", value: ch.attack });
  if (ch.override && ch.save) changes.push(
    { key: "activities[save].save.dc.calculation", type: "override", value: "" },
    { key: "activities[save].save.dc.formula", type: "override", value: ch.save },
    { key: "activities[summon].flat.save", type: "override", value: ch.save });
  return changes;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const castNeeds = items => {
  const cached = new Set(items.map(i => i.flags?.dnd5e?.cachedFor).filter(Boolean));
  return items.filter(it => it.type !== "spell").flatMap(it => Object.entries(it.system?.activities || {})
    .filter(([aid, act]) => act.type === "cast" && act.spell?.uuid && !cached.has(`.Item.${it._id}.Activity.${aid}`)));
};

/** Crée les sorts manquants des activités « cast » des objets de l'acteur. Renvoie les noms créés.
 *  Si le joueur a Foundry ouvert, c'est son navigateur qui crée ces sorts (comme dans Foundry) : on lui laisse
 *  quelques secondes, on ne crée que ce qui manque encore, et on supprime les doublons éventuels. */
export async function ensureCastSpells(fs, actorId) {
  let items = await fs.doc("get", "Item", { parentUuid: `Actor.${actorId}`, query: {} });
  for (let i = 0; i < 4 && castNeeds(items).length; i++) { await sleep(2000); items = await fs.doc("get", "Item", { parentUuid: `Actor.${actorId}`, query: {} }); }
  // doublons (navigateur + MCP) : on garde la copie la plus ancienne
  const seen = new Map(), dup = [];
  for (const i of items.filter(i => i.flags?.dnd5e?.cachedFor).sort((a, b) => (a._stats?.createdTime || 0) - (b._stats?.createdTime || 0))) {
    if (seen.has(i.flags.dnd5e.cachedFor)) dup.push(i._id); else seen.set(i.flags.dnd5e.cachedFor, i._id);
  }
  if (dup.length) await fs.doc("delete", "Item", { parentUuid: `Actor.${actorId}`, ids: dup, modifiedTime: Date.now() });
  const cached = new Set(seen.keys());
  const data = [];
  for (const it of items) {
    if (it.type === "spell") continue;
    for (const [aid, act] of Object.entries(it.system?.activities || {})) {
      if (act.type !== "cast" || !act.spell?.uuid) continue;
      const rel = `.Item.${it._id}.Activity.${aid}`;
      if (cached.has(rel)) continue;
      let spell; try { spell = await fetchUuid(fs, act.spell.uuid); } catch { continue; }
      if (!spell) continue;
      const d = structuredClone(spell); delete d._id; delete d.folder; delete d.sort; delete d.ownership; delete d.__pack;
      d.effects = [...(d.effects || []), { _id: ENCHANTMENT_ID, type: "enchantment", name: await loc("DND5E.CAST.Enchantment.Name", "Spell Changes"),
        img: "systems/dnd5e/icons/svg/activity/cast.svg", system: { changes: spellChanges(act), origin: { activity: `Actor.${actorId}${rel}` } }, transfer: true }];
      d.flags = { ...(d.flags || {}), dnd5e: { ...(d.flags?.dnd5e || {}), cachedFor: rel } };
      d.system = { ...(d.system || {}), sourceItem: `${it.type}:${it.system?.identifier || ""}` };
      d._stats = { ...(d._stats || {}), compendiumSource: act.spell.uuid };
      sanitizeItemData(d);
      data.push(d);
    }
  }
  if (!data.length) return [];
  const res = await fs.doc("create", "Item", { parentUuid: `Actor.${actorId}`, data, modifiedTime: Date.now() });
  return res.map(r => r.name);
}
