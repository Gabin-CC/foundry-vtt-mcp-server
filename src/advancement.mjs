// Moteur d'avancement dnd5e côté serveur : rejoue ce que fait l'assistant de montée de niveau
// de Foundry (AdvancementManager) à partir des "advancements" décrits dans les objets
// (classe, sous-classe, espèce, historique, dons). Les choix sont demandés à l'appelant.
import { translateDoc, SKILLS, ABIL } from "./dnd5e.mjs";
import { fixId, sanitizeItemData } from "./repair.mjs";
import { synthesize } from "./synth.mjs";

const advList = item => {
  const a = item?.system?.advancement;
  return Array.isArray(a) ? a : Object.values(a || {});
};
const LANGS = ["common", "sign", "draconic", "dwarvish", "elvish", "giant", "gnomish", "goblin", "halfling", "orc",
  "abyssal", "celestial", "deep", "infernal", "primordial", "sylvan", "undercommon", "druidic", "cant"];
const ARMOR = { lgt: "armures légères", med: "armures intermédiaires", hvy: "armures lourdes", shl: "boucliers" };

// ---------- accès compendium ----------
function parseUuid(uuid) {
  const m = /^Compendium\.([^.]+)\.([^.]+)\.(?:(\w+)\.)?([A-Za-z0-9]{16})$/.exec(uuid || "");
  return m ? { pack: `${m[1]}.${m[2]}`, type: m[3] || "Item", id: m[4] } : null;
}
export async function fetchUuid(fs, uuid) {
  // objets du monde : "Item.<id>" ou "Actor.<id>.Item.<id>"
  let m = /^Item\.([A-Za-z0-9]{16})$/.exec(uuid || "");
  if (m) { const d = (await fs.doc("get", "Item", { query: { _id: m[1] } })).find(x => x._id === m[1]); if (d) return synthesize(fs, d, structuredClone(d)); throw new Error(`Introuvable : ${uuid}`); }
  m = /^Actor\.([A-Za-z0-9]{16})\.Item\.([A-Za-z0-9]{16})$/.exec(uuid || "");
  if (m) { const d = (await fs.doc("get", "Item", { parentUuid: `Actor.${m[1]}`, query: {} })).find(x => x._id === m[2]); if (d) return d; throw new Error(`Introuvable : ${uuid}`); }
  const p = parseUuid(uuid);
  if (!p) throw new Error(`UUID de compendium invalide : ${uuid}`);
  const packs = (fs._packs2 ??= ((await fs.worldData()).packs || []));
  if (packs.some(x => x.id === p.pack)) {
    const d = (await fs.doc("get", p.type, { pack: p.pack, query: { _id: p.id } })).find(x => x._id === p.id);
    if (d) { const raw = structuredClone(d); return Object.assign(await synthesize(fs, await translateDoc(p.pack, d), raw), { __pack: p.pack }); }
  }
  // Ressource absente de ce compendium (ou compendium non installé) : on cherche la même
  // ressource (même _id) dans tous les compendiums installés du même type.
  const found = await findById(fs, p.type, p.id);
  if (found) { const raw = structuredClone(found.doc); return Object.assign(await synthesize(fs, await translateDoc(found.pack, found.doc), raw), { __pack: found.pack }); }
  throw new Error(`Ressource introuvable dans les compendiums installés : ${uuid}`);
}

async function findById(fs, type, id) {
  const packs = (fs._packs2 ??= ((await fs.worldData()).packs || [])).filter(x => x.type === type);
  fs._idIdx ??= new Map(); // pack -> Set(_id)
  for (const pk of packs) {
    if (!fs._idIdx.has(pk.id)) {
      let ids = [];
      try { ids = (await fs.doc("get", type, { pack: pk.id, query: {}, index: true, indexFields: ["_id"] })).map(x => x._id); } catch { /* ignore */ }
      fs._idIdx.set(pk.id, new Set(ids));
    }
    if (fs._idIdx.get(pk.id).has(id)) {
      const d = (await fs.doc("get", type, { pack: pk.id, query: { _id: id } })).find(x => x._id === id);
      if (d) return { pack: pk.id, doc: d };
    }
  }
  return null;
}

// ---------- listes de sorts de classe (pages de journal de type "spells") ----------
const spellListCache = new Map(); // "class:cleric" -> Set(uuid)
export async function spellLists(fs) {
  if (spellListCache.size) return spellListCache;
  const w = await fs.worldData();
  for (const p of (w.packs || []).filter(p => p.type === "JournalEntry" && p.packageName === "dnd5e")) {
    let docs = [];
    try { docs = await fs.doc("get", "JournalEntry", { pack: p.id, query: {} }); } catch { continue; }
    for (const j of docs) for (const pg of j.pages || []) {
      if (pg.type !== "spells" || !pg.system?.identifier) continue;
      const key = `${pg.system.type || "class"}:${pg.system.identifier}`;
      const set = spellListCache.get(key) || new Set();
      for (const u of pg.system.spells || []) set.add(u);
      spellListCache.set(key, set);
    }
  }
  return spellListCache;
}

// ---------- description lisible des options ----------
function traitLabel(k) {
  const [t, a, b] = k.split(":");
  if (t === "skills") return `${SKILLS[a]?.[1] || a} (${k})`;
  if (t === "saves") return `Sauvegarde ${ABIL[a] || a} (${k})`;
  if (t === "armor") return `${ARMOR[a] || a} (${k})`;
  return k;
}
function expandPool(pool) {
  const out = [];
  for (const p of pool || []) {
    if (p === "skills:*") out.push(...Object.keys(SKILLS).map(k => `skills:${k}`));
    else if (/^languages:(standard|exotic)?:?\*$/.test(p) || p === "languages:*") out.push(...LANGS.map(l => `languages:standard:${l}`));
    else if (p === "saves:*") out.push(...Object.keys(ABIL).map(k => `saves:${k}`));
    else out.push(p);
  }
  return out;
}
const matchPool = (k, pool) => pool.some(p => p === k || (p.endsWith("*") && k.startsWith(p.slice(0, -1))) || (p.endsWith(":*") && k.startsWith(p.slice(0, -2))));


// ---------- équipement de départ (system.startingEquipment) ----------
const idxCache = new Map();
async function packIdx(fs, pack, fields) {
  const k = pack + "|" + fields.join(",");
  if (!idxCache.has(k)) { let r = []; try { r = await fs.doc("get", "Item", { pack, query: {}, index: true, indexFields: ["_id", "name", ...fields] }); } catch { /* */ } idxCache.set(k, r); }
  return idxCache.get(k);
}
const FOCUS_NAMES = { holy: /holy symbol|symbole sacr|amulet|emblem|reliquar/i, arcane: /arcane focus|focaliseur arcan|crystal|orb|rod|staff|wand/i, druidic: /druidic focus|focaliseur druid|sprig|totem|yew|wooden staff/i };
async function categoryOptions(fs, entry) {
  const packs = ((fs._packs2 ??= ((await fs.worldData()).packs || []))).filter(p => p.type === "Item" && p.packageName === "dnd5e");
  const out = [];
  for (const pk of packs) {
    const idx = await packIdx(fs, pk.id, ["type", "system.type.value", "system.type.baseItem", "system.rarity", "system.properties"]);
    for (const e of idx) {
      if (e.system?.rarity && e.system.rarity !== "common" && e.system.rarity !== "") continue;
      const t = e.system?.type?.value;
      let ok = false;
      if (entry.type === "weapon" && e.type === "weapon") ok = entry.key === "sim" ? /^simple/.test(t) : entry.key === "mar" ? /^martial/.test(t) : (t === entry.key || e.system?.type?.baseItem === entry.key);
      else if (entry.type === "armor" && e.type === "equipment") ok = ({ lgt: "light", med: "medium", hvy: "heavy", shl: "shield" }[entry.key] || entry.key) === t;
      else if (entry.type === "tool" && e.type === "tool") ok = t === entry.key || e.system?.type?.baseItem === entry.key;
      else if (entry.type === "focus") ok = FOCUS_NAMES[entry.key]?.test(e.name) && ["loot", "equipment", "weapon"].includes(e.type) && !/[+]\\d/.test(e.name);
      if (ok) out.push(`${e.name} — Compendium.${pk.id}.Item.${e._id}`);
    }
  }
  return [...new Set(out)];
}
async function describeEntry(fs, e, kids) {
  if (e.type === "linked") { try { const d = await fetchUuid(fs, e.key); return `${e.count > 1 ? e.count + "× " : ""}${d.name}`; } catch { return e.key; } }
  if (e.type === "currency") return `${e.count} ${e.key}`;
  if (["AND", "OR"].includes(e.type)) { const parts = []; for (const k of kids(e._id)) parts.push(await describeEntry(fs, k, kids)); return parts.join(e.type === "AND" ? " + " : " OU "); }
  return `${e.count > 1 ? e.count + "× " : ""}${e.type}:${e.key} (au choix)`;
}
export async function planStartingEquipment(fs, item, choices) {
  const entries = item.system?.startingEquipment || [];
  const pending = [], warnings = [], items = [], currency = {};
  if (!entries.length) return { pending, warnings, step: null };
  const kids = g => entries.filter(e => (e.group || "") === g).sort((a, b) => (a.sort || 0) - (b.sort || 0));
  async function walk(e) {
    const key = `equip:${e._id}`;
    if (e.type === "AND") { for (const k of kids(e._id)) await walk(k); return; }
    if (e.type === "OR") {
      const opts = kids(e._id);
      const val = choices[key];
      const pick = opts.find(o => o._id === val);
      if (!pick) {
        const options = [];
        for (const o of opts) options.push(`${await describeEntry(fs, o, kids)} — ${o._id}`);
        pending.push({ id: key, objet: item.name, niveau: 1, type: "StartingEquipment", titre: "Équipement de départ (choix)", nombre: 1, options, aide: "Valeur = l'identifiant de l'option" });
        return;
      }
      await walk(pick); return;
    }
    if (e.type === "linked") { items.push({ uuid: e.key, count: e.count || 1 }); return; }
    if (e.type === "currency") { currency[e.key] = (currency[e.key] || 0) + Number(e.count || 0); return; }
    // catégorie (arme, armure, outil, focaliseur) : choix d'un objet
    const val = choices[key];
    if (!val) {
      pending.push({ id: key, objet: item.name, niveau: 1, type: "StartingEquipment", titre: `Équipement de départ : ${e.type} « ${e.key} »`, nombre: 1, options: (await categoryOptions(fs, e)).slice(0, 80), aide: "Valeur = l'UUID de l'objet" });
      return;
    }
    items.push({ uuid: val, count: e.count || 1 });
  }
  for (const root of kids("")) await walk(root);
  return { pending, warnings, step: { kind: "equipment", item, items, currency } };
}

// ---------- planification ----------
/**
 * Construit le plan d'avancement d'un objet (et récursivement des objets accordés).
 * @returns {steps, pending} — pending = choix manquants à demander.
 */
export async function plan(fs, actor, item, { fromLevel, toLevel, choices = {}, isFirstClass, depth = 0 }) {
  const steps = [], pending = [], warnings = [];
  const isClass = item.type === "class", isSub = item.type === "subclass";
  const lvlOk = adv => { const l = Number(adv.level ?? 0); return l >= fromLevel && l <= toLevel; };
  const key = (adv, l) => adv._id + (l > 0 ? `@${l}` : "");
  const choice = (adv, l) => choices[key(adv, l)] ?? choices[adv._id];

  // PHB 2024 (p. 38) : une espèce d'un ancien livre ne donne pas ses augmentations de caractéristique ;
  // seules celles de l'historique s'appliquent (monde en règles « modernes »).
  let legacySpecies = false;
  if (item.type === "race" && String(item.system?.source?.rules || "") !== "2024") {
    fs._rulesVersion ??= await fs.doc("get", "Setting", { query: { key: "dnd5e.rulesVersion" } }).then(r => { try { return JSON.parse(r?.[0]?.value ?? '"modern"'); } catch { return r?.[0]?.value || "modern"; } }).catch(() => "modern");
    legacySpecies = fs._rulesVersion !== "legacy";
  }
  for (const adv of advList(item)) {
    if (legacySpecies && adv.type === "AbilityScoreImprovement") {
      warnings.push(`${item.name} : espèce d'un ancien livre — augmentations de caractéristique ignorées (PHB 2024, p. 38)`);
      continue;
    }
    if (adv.type === "HitPoints" && isClass) {
      for (let l = Math.max(1, fromLevel); l <= toLevel; l++) steps.push({ kind: "hp", item, adv, level: l });
      continue;
    }
    if (!lvlOk(adv)) continue;
    const l = Number(adv.level ?? 0);
    if (adv.classRestriction === "primary" && isClass && !isFirstClass) continue;
    if (adv.classRestriction === "secondary" && isClass && isFirstClass) continue;
    const c = adv.configuration || {};
    switch (adv.type) {
      case "ItemGrant": {
        const docs = [], subSteps = [];
        for (const it of c.items || []) {
          const uuid = typeof it === "string" ? it : it.uuid;
          const skip = it.optional && Array.isArray(choice(adv, l)) && !choice(adv, l).includes(uuid);
          if (skip) continue;
          let d;
          try { d = await fetchUuid(fs, uuid); } catch (e) { warnings.push(`${item.name} niv. ${l} — ignoré : ${e.message}`); continue; }
          docs.push({ uuid, doc: d });
          if (depth < 3 && advList(d).length) {
            const sub = await plan(fs, actor, d, { fromLevel: 0, toLevel: Math.max(toLevel, 0), choices, isFirstClass, depth: depth + 1 });
            subSteps.push(...sub.steps); pending.push(...sub.pending); warnings.push(...sub.warnings);
          }
        }
        steps.push({ kind: "grant", item, adv, level: l, docs, spell: c.spell }, ...subSteps);
        break;
      }
      case "Trait": {
        const chosen = [...(c.grants || [])];
        let missing = false;
        for (const [i, ch] of (c.choices || []).entries()) {
          const pool = expandPool(ch.pool);
          const val = choice(adv, l);
          const picks = Array.isArray(val) ? val.filter(v => matchPool(v, ch.pool) || pool.includes(v)) : [];
          if (picks.length < ch.count) {
            missing = true;
            pending.push({ id: key(adv, l), objet: item.name, niveau: l, type: "Trait", titre: adv.title || adv.name || "Maîtrises",
              aide: strip(adv.hint), nombre: ch.count, options: pool.filter(o => !(c.grants || []).includes(o)).map(traitLabel) });
          } else chosen.push(...picks.slice(0, ch.count));
        }
        if (!missing) steps.push({ kind: "trait", item, adv, level: l, chosen, mode: c.mode });
        break;
      }
      case "AbilityScoreImprovement": {
        const val = choice(adv, l);
        const fixed = Object.entries(c.fixed || {}).filter(([, v]) => v).length;
        if (!val && !fixed) {
          pending.push({ id: key(adv, l), objet: item.name, niveau: l, type: "AbilityScoreImprovement", titre: adv.title || "Amélioration de caractéristique",
            aide: strip(adv.hint) || `Répartir ${c.points ?? 2} points (max +${c.cap ?? 2} par carac), ou { "feat": "<uuid du don>" }`,
            points: c.points ?? 2, max_par_carac: c.cap ?? 2, verrouillees: c.locked || [] });
          break;
        }
        let featDoc = null, featSub = null;
        if (val?.feat) {
          featDoc = await fetchUuid(fs, val.feat);
          if (depth < 3 && advList(featDoc).length) featSub = await plan(fs, actor, featDoc, { fromLevel: 0, toLevel: Math.max(toLevel, 0), choices, isFirstClass, depth: depth + 1 });
        } else if (val) {
          const pts = Object.values(val).reduce((a, b) => a + Number(b || 0), 0);
          if (pts > (c.points ?? 2) || Object.entries(val).some(([k, v]) => v > (c.cap ?? 2) || (c.locked || []).includes(k)))
            throw new Error(`Répartition invalide pour « ${adv.title || "ASI"} » : ${JSON.stringify(val)} (points ${c.points ?? 2}, max +${c.cap ?? 2}, verrouillées ${(c.locked || []).join(",") || "aucune"})`);
        }
        steps.push({ kind: "asi", item, adv, level: l, assignments: val?.feat ? {} : { ...(c.fixed || {}), ...(val || {}) }, featDoc, featUuid: val?.feat });
        if (featSub) { steps.push(...featSub.steps); pending.push(...featSub.pending); warnings.push(...featSub.warnings); }
        break;
      }
      case "ItemChoice": {
        const val = choice(adv, l);
        const count = Object.entries(c.choices || {}).filter(([lv]) => Number(lv) === l || (Number(lv) === 0 && l === 0)).reduce((a, [, v]) => a + Number(v.count ?? v), 0) || 1;
        if (!Array.isArray(val) || val.length < count) {
          let options = (c.pool || []).map(p => (typeof p === "string" ? p : p.uuid));
          if (!options.length && c.type === "spell" && c.restriction?.list?.length) {
            const lists = await spellLists(fs);
            const set = new Set();
            for (const ln of c.restriction.list) for (const u of lists.get(ln) || []) set.add(u);
            options = [...set];
            // filtre par niveau de sort
            if (c.restriction.level !== "" && c.restriction.level != null && options.length) {
              const lv = Number(c.restriction.level);
              const keep = [];
              for (const u of options) { const p = parseUuid(u); if (!p) continue; keep.push({ u, p }); }
              const byPack = {};
              keep.forEach(k => (byPack[k.p.pack] ??= []).push(k));
              options = [];
              for (const [pk, arr] of Object.entries(byPack)) {
                const idx = await fs.doc("get", "Item", { pack: pk, query: {}, index: true, indexFields: ["_id", "name", "system.level"] });
                const ok = new Set(idx.filter(x => x.system?.level === lv).map(x => x._id));
                options.push(...arr.filter(k => ok.has(k.p.id)).map(k => k.u));
              }
            }
          }
          const labels = [];
          for (const u of options.slice(0, 150)) { try { const d = await fetchUuid(fs, u); labels.push(`${d.name} — ${u}`); } catch { /* compendium absent */ } }
          if (!labels.length && options.length) labels.push(`(options dans des compendiums non installés — fournis l'UUID de ton choix)`);
          pending.push({ id: key(adv, l), objet: item.name, niveau: l, type: "ItemChoice", titre: adv.title || "Choix",
            aide: strip(adv.hint) || (c.restriction?.list ? `Listes : ${c.restriction.list.join(", ")}, niveau ${c.restriction.level}` : ""),
            nombre: count, options: labels });
          break;
        }
        const docs = [], subSteps = [];
        for (const u of val.slice(0, count)) {
          let d;
          try { d = await fetchUuid(fs, u); } catch (e) { warnings.push(e.message); continue; }
          docs.push({ uuid: u, doc: d });
          if (depth < 3 && advList(d).length) {
            const sub = await plan(fs, actor, d, { fromLevel: 0, toLevel: Math.max(toLevel, 0), choices, isFirstClass, depth: depth + 1 });
            subSteps.push(...sub.steps); pending.push(...sub.pending); warnings.push(...sub.warnings);
          }
        }
        steps.push({ kind: "grant", item, adv, level: l, docs, spell: c.spell, choiceStore: true, spellAbility: choices[`${key(adv, l)}:ability`] }, ...subSteps);
        break;
      }
      case "Subclass": {
        const val = choice(adv, l);
        if (!val) {
          pending.push({ id: key(adv, l), objet: item.name, niveau: l, type: "Subclass", titre: "Sous-classe",
            aide: "UUID de la sous-classe (search_compendium item_type=subclass), ex. Compendium.dnd5e.classes24.Item.phbclcLifeDomain" });
          break;
        }
        const sub = await fetchUuid(fs, val);
        steps.push({ kind: "subclass", item, adv, level: l, doc: sub, uuid: val });
        const p = await plan(fs, actor, sub, { fromLevel: 0, toLevel, choices, isFirstClass, depth: depth + 1 });
        steps.push(...p.steps.map(s => ({ ...s, ofSubclass: true }))); pending.push(...p.pending); warnings.push(...p.warnings);
        break;
      }
      case "Size": {
        const val = choice(adv, l) || (c.sizes?.length === 1 ? c.sizes[0] : null);
        if (!val) pending.push({ id: key(adv, l), objet: item.name, niveau: l, type: "Size", titre: "Taille", options: c.sizes });
        else steps.push({ kind: "size", item, adv, level: l, size: val });
        break;
      }
      default: break; // ScaleValue & co : calculés par Foundry, rien à appliquer
    }
  }
  // équipement de départ : historique à l'import, classe au niveau 1 de la 1re classe
  if (depth === 0 && ((item.type === "background" && fromLevel <= 0) || (isClass && isFirstClass && fromLevel <= 1 && toLevel >= 1))) {
    const se = await planStartingEquipment(fs, item, choices);
    pending.push(...se.pending); warnings.push(...se.warnings);
    if (se.step && !se.pending.length) steps.push(se.step);
  }
  return { steps, pending, warnings };
}
const strip = h => String(h || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);

// ---------- application ----------
export async function apply(fs, actor, rootItemId, steps, { hpMode = "avg", isFirstClass }) {
  const A = `Actor.${actor._id}`;
  const actorUpd = {};
  const advValues = {}; // itemId -> { advId -> value }
  const log = [];
  // identifiant d'avancement corrigé comme à la création de l'objet (repair.mjs) : les deux restent alignés
  const setAdv = (itemId, advId0, patch) => { const advId = fixId(advId0); ((advValues[itemId] ??= {})[advId] ??= {}); Object.assign(advValues[itemId][advId], patch); };
  const created = new Map(); // uuid du doc source (subclass/feat) -> id créé
  const abil = structuredClone(actor.system.abilities || {});
  const tr = structuredClone(actor.system.traits || {});
  const skills = structuredClone(actor.system.skills || {});
  const tools = structuredClone(actor.system.tools || {});
  const addTo = (arr, v) => { if (!arr.includes(v)) arr.push(v); };

  // advancementRoot (comme dnd5e : createItemData) : objet racine (classe, espèce, historique) de la chaîne
  // d'avancements ; la fiche s'en sert pour ranger l'aptitude (ex. « Ordre divin : Thaumaturge » sous Clerc).
  const rootOf = new Map((actor.items || []).map(i => [i._id, i.flags?.dnd5e?.advancementRoot]));
  async function createItems(docs, originId, advId, spellCfg, abilityPick) {
    const origin = `${originId}.${fixId(advId)}`, root = rootOf.get(originId) ?? origin;
    const data = docs.map(({ uuid, doc }) => {
      const d = structuredClone(doc);
      delete d._id; delete d.folder; delete d.sort; delete d.ownership; delete d.__pack;
      sanitizeItemData(d);
      d._stats = { ...(d._stats || {}), compendiumSource: uuid };
      d.flags = { ...(d.flags || {}), dnd5e: { ...(d.flags?.dnd5e || {}), sourceId: uuid, ...(advId === "startingEquipment" ? {} : { advancementOrigin: origin, advancementRoot: root }) } };
      if (spellCfg && d.type === "spell") {
        const ab = abilityPick || (Array.isArray(spellCfg.ability) ? spellCfg.ability.filter(Boolean)[0] : spellCfg.ability);
        if (ab) d.system.ability = ab;
        if (spellCfg.method) d.system.method = spellCfg.method;
        if (spellCfg.prepared != null) d.system.prepared = spellCfg.prepared;
        if (spellCfg.uses?.max) d.system.uses = { max: String(spellCfg.uses.max), spent: 0, recovery: spellCfg.uses.per ? [{ period: spellCfg.uses.per, type: "recoverAll" }] : [] };
      }
      return d;
    });
    if (!data.length) return [];
    const r = await fs.doc("create", "Item", { parentUuid: A, data, modifiedTime: Date.now() });
    if (advId !== "startingEquipment") r.forEach(x => rootOf.set(x._id, root));
    return r.map((x, i) => ({ id: x._id, name: x.name, uuid: docs[i].uuid }));
  }

  const originOf = s => s.item._id || rootItemId;

  for (const s of steps) {
    switch (s.kind) {
      case "hp": {
        const v = s.level === 1 && isFirstClass ? "max" : hpMode;
        setAdv(s.item._id, s.adv._id, { [`value.${s.level}`]: v });
        break;
      }
      case "grant": {
        const res = await createItems(s.docs, originOf(s), s.adv._id, s.spell, s.spellAbility);
        for (const r of res) { created.set(r.uuid, r.id); const src = s.docs.find(d => d.uuid === r.uuid).doc; src._id = r.id; }
        const added = Object.fromEntries(res.map(r => [r.id, r.uuid]));
        if (s.item._id) setAdv(s.item._id, s.adv._id, s.choiceStore ? { [`value.added.${s.level}`]: added } : { "value.added": added });
        log.push(`${s.item.name} niv. ${s.level} — ${s.adv.title || s.adv.type} : ${res.map(r => r.name).join(", ")}`);
        break;
      }
      case "trait": {
        for (const k of s.chosen) {
          const [t, a, b] = k.split(":");
          if (t === "saves") abil[a] = { ...(abil[a] || {}), proficient: 1 };
          else if (t === "skills") skills[a] = { ...(skills[a] || {}), value: Math.max(Number(skills[a]?.value) || 0, s.mode === "expertise" ? 2 : 1) };
          else if (t === "armor") { tr.armorProf ??= { value: [] }; addTo(tr.armorProf.value, a); }
          else if (t === "weapon") { tr.weaponProf ??= { value: [] }; addTo(tr.weaponProf.value, b || a); }
          else if (t === "tool") tools[b || a] = { ...(tools[b || a] || {}), value: 1 };
          else if (t === "languages") { tr.languages ??= { value: [] }; addTo(tr.languages.value, b || a); }
          else if (["di", "dr", "dv", "ci"].includes(t)) { tr[t] ??= { value: [] }; addTo(tr[t].value, a); }
        }
        if (s.item._id) setAdv(s.item._id, s.adv._id, { "value.chosen": s.chosen });
        log.push(`${s.item.name} niv. ${s.level} — ${s.adv.title || "Maîtrises"} : ${s.chosen.map(traitLabel).join(", ")}`);
        break;
      }
      case "asi": {
        if (s.featDoc) {
          const res = await createItems([{ uuid: s.featUuid, doc: s.featDoc }], originOf(s), s.adv._id);
          created.set(s.featUuid, res[0]?.id); s.featDoc._id = res[0]?.id;
          if (s.item._id) setAdv(s.item._id, s.adv._id, { "value.type": "feat", "value.feat": { [res[0].id]: s.featUuid } });
          log.push(`${s.item.name} niv. ${s.level} — Don : ${res[0]?.name}`);
        } else {
          const ch = [];
          for (const [k, v] of Object.entries(s.assignments)) if (v) {
            const before = Number(abil[k]?.value) || 10;
            abil[k] = { ...(abil[k] || {}), value: Math.min(20, before + Number(v)) };
            ch.push(`${ABIL[k]} ${before}→${abil[k].value}`);
          }
          if (s.item._id) setAdv(s.item._id, s.adv._id, { "value.type": "asi", "value.assignments": s.assignments });
          log.push(`${s.item.name} niv. ${s.level} — Amélioration : ${ch.join(", ")}`);
        }
        break;
      }
      case "subclass": {
        const res = await createItems([{ uuid: s.uuid, doc: s.doc }], originOf(s), s.adv._id);
        created.set(s.uuid, res[0].id); s.doc._id = res[0].id;
        if (s.item._id) setAdv(s.item._id, s.adv._id, { "value.document": res[0].id, "value.uuid": s.uuid });
        log.push(`${s.item.name} niv. ${s.level} — Sous-classe : ${res[0].name}`);
        break;
      }
      case "equipment": {
        const names = [];
        for (const { uuid, count } of s.items) {
          let doc;
          try { doc = await fetchUuid(fs, uuid); } catch (e) { log.push(`Équipement ignoré : ${e.message}`); continue; }
          // un objet pris seul dans le compendium ne garde pas son conteneur de compendium (ex. sac de couchage d'un paquetage)
          const sys = { ...doc.system, container: null, ...(count > 1 ? { quantity: count } : {}) };
          const res = await createItems([{ uuid, doc: { ...doc, system: sys } }], originOf(s), "startingEquipment");
          names.push(`${count > 1 ? count + "× " : ""}${res[0]?.name}`);
          // contenu d'un paquetage / conteneur : objets du même compendium rattachés à ce conteneur
          if (doc.type === "container" && doc.__pack && res[0]) {
            const idx = await packIdx(fs, doc.__pack, ["system.container"]);
            const contents = idx.filter(x => x.system?.container === doc._id);
            const cdocs = [];
            for (const c of contents) { try { cdocs.push({ uuid: `Compendium.${doc.__pack}.Item.${c._id}`, doc: await fetchUuid(fs, `Compendium.${doc.__pack}.Item.${c._id}`) }); } catch { /* */ } }
            for (const cd of cdocs) cd.doc = { ...cd.doc, system: { ...cd.doc.system, container: res[0].id } };
            if (cdocs.length) { await createItems(cdocs, originOf(s), "startingEquipment"); names.push(`(contenu : ${cdocs.map(c => c.doc.name).join(", ")})`); }
          }
        }
        for (const [k, v] of Object.entries(s.currency)) actorUpd[`system.currency.${k}`] = (Number(actor.system?.currency?.[k]) || 0) + v;
        log.push(`${s.item.name} — Équipement de départ : ${names.join(", ")}${Object.keys(s.currency).length ? " ; " + Object.entries(s.currency).map(([k, v]) => `${v} ${k}`).join(", ") : ""}`);
        break;
      }
      case "size":
        actorUpd["system.traits.size"] = s.size;
        if (s.item._id) setAdv(s.item._id, s.adv._id, { "value.size": s.size });
        break;
    }
  }

  Object.assign(actorUpd, { "system.abilities": abil, "system.traits": tr, "system.skills": skills, "system.tools": tools });
  await fs.doc("update", "Actor", { updates: [{ _id: actor._id, ...actorUpd }], diff: true, modifiedTime: Date.now() });
  // enregistre les valeurs d'avancement sur les objets (pour que Foundry sache qu'elles sont appliquées)
  const iu = [];
  for (const [itemId, advs] of Object.entries(advValues)) {
    const u = { _id: itemId };
    for (const [advId, patch] of Object.entries(advs)) for (const [k, v] of Object.entries(patch)) u[`system.advancement.${advId}.${k}`] = v;
    iu.push(u);
  }
  if (iu.length) await fs.doc("update", "Item", { parentUuid: A, updates: iu, diff: true, modifiedTime: Date.now() });
  return log;
}
