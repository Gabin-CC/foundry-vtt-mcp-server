// Sorts de classe : construit la liste de sorts d'une classe à partir de TOUT ce qui est installé
// dans Foundry (listes de sorts officielles + classes déclarées par chaque sort), puis ajoute
// sorts mineurs / sorts de classe / sorts préparés selon les compteurs de la classe.
import { translations, trFor, slotMax } from "./dnd5e.mjs";
import { spellLists, fetchUuid } from "./advancement.mjs";
import { message } from "./i18n.mjs";

const norm = t => String(t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const cap = s => String(s || "").replace(/(^|[-_ ])(\w)/g, (_, a, b) => (a ? " " : "") + b.toUpperCase());
const advList = item => { const a = item?.system?.advancement; return Array.isArray(a) ? a : Object.values(a || {}); };

function scaleAt(cls, identifier, level) {
  const adv = advList(cls).find(a => a.type === "ScaleValue" && a.configuration?.identifier === identifier);
  if (!adv) return null;
  let v = null;
  for (const [l, x] of Object.entries(adv.configuration.scale || {})) if (Number(l) <= level) v = x.value ?? x.number ?? v;
  return v == null ? null : Number(v);
}
// bonus d'effets actifs sur un compteur de classe (ex. Thaumaturge : +1 sort mineur)
function scaleBonus(actor, clsId, identifier) {
  let b = 0;
  for (const i of actor.items || []) for (const e of i.effects || []) {
    if (e.disabled) continue;
    for (const c of e.system?.changes || e.changes || []) if (c.key === `system.scale.${clsId}.${identifier}.value` && (c.type || "add") === "add") b += Number(c.value) || 0;
  }
  return b;
}

/** Nom anglais normalisé, sans le possessif d'un sorcier célèbre en tête (« Tenser's », « Mordenkainen’s »…). */
// (seulement s'il reste au moins deux mots : « Hunter's Mark » reste tel quel)
export const spellKey = name => {
  const n = String(name || "");
  const stripped = n.replace(/^\s*[A-Z][\w-]*['’]s?\s+(?=\S)/, "");
  return norm(stripped !== n && norm(stripped).includes(" ") ? stripped : n);
};

const listCache = new Map();
/** Tous les sorts de la classe, dédoublonnés (préférence : même édition de règles que la classe). */
export async function classSpellList(fs, cls) {
  const id = cls.system?.identifier;
  const key = `${id}|${cls.system?.source?.rules || ""}`;
  if (listCache.has(key)) return listCache.get(key);
  const official = (await spellLists(fs)).get(`class:${id}`) || new Set();
  const className = cap(id);
  const packs = ((await fs.worldData()).packs || []).filter(p => p.type === "Item");
  const rules2024 = String(cls.system?.source?.rules || "") === "2024";
  const rank = pk => (pk.id === "dnd5e.spells24" ? (rules2024 ? 0 : 2) : pk.id === "dnd5e.spells" ? (rules2024 ? 2 : 0) : 1);
  const best = new Map();
  for (const pk of packs) {
    let idx = [];
    try { idx = await fs.doc("get", "Item", { pack: pk.id, query: {}, index: true, indexFields: ["_id", "name", "type", "system.level", "system.identifier", "system.source.rules", "flags.plutonium.spellClassNames", "system.sourceClass"] }); } catch { continue; }
    const tr = await translations(pk.id);
    for (const e of idx) {
      if (e.type !== "spell") continue;
      const uuid = `Compendium.${pk.id}.Item.${e._id}`;
      const declared = e.flags?.plutonium?.spellClassNames || [];
      if (!(official.has(uuid) || declared.includes(className) || e.system?.sourceClass === id)) continue;
      // clé = nom anglais sans possessif : « Tasha's Hideous Laughter » (2014) et « Hideous Laughter » (2024),
      // « Leomund's Tiny Hut » / « Tiny Hut »… sont le même sort (la version 2024 officielle est gardée par le rang)
      const k = spellKey(e.name) || e.system?.identifier;
      const cand = { uuid, name: trFor(tr, e)?.name || e.name, name_en: e.name, level: Number(e.system?.level) || 0,
        key: k, rank: rank(pk), rules: e.system?.source?.rules };
      const cur = best.get(k);
      if (!cur || cand.rank < cur.rank) best.set(k, cand);
    }
  }
  const list = [...best.values()].sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));
  listCache.set(key, list);
  return list;
}

/**
 * Plan : sorts mineurs à choisir, tous les sorts de classe accessibles (comme l'option
 * « tous les sorts de classe » de l'import), et sorts préparés à choisir.
 */
export async function planClassSpells(fs, actor, cls, level, choices) {
  const id = cls.system?.identifier;
  const list = await classSpellList(fs, cls);
  const fake = { items: [{ type: "class", system: { ...cls.system, levels: level } }], system: { spells: {} } };
  const slots = slotMax(fake);
  // emplacements de sort ordinaires et, pour la magie de pacte, niveau des emplacements de pacte
  const maxLvl = Math.max(0, Number(slots.pactLevel) || 0, ...Object.keys(slots).filter(k => /^spell\d$/.test(k)).map(k => Number(k.slice(5))));
  const have = new Set((actor.items || []).filter(i => i.type === "spell").map(i => i.system?.identifier || norm(i.name)));
  const pending = [];
  const pick = (val, pool) => (Array.isArray(val) ? val : []).map(v => pool.find(s => s.uuid === v || norm(s.name) === norm(v) || norm(s.name_en) === norm(v))).filter(Boolean);
  // sort donné par UUID hors de la liste construite (ex. sort de Xanathar absent des listes de classe) : accepté tel quel
  const pickAny = async (val, pool, lvlOk) => {
    const out = [];
    for (const v of Array.isArray(val) ? val : []) {
      const hit = pool.find(s => s.uuid === v || norm(s.name) === norm(v) || norm(s.name_en) === norm(v));
      if (hit) { out.push(hit); continue; }
      if (!/^Compendium\./.test(String(v))) continue;
      try {
        const d = await fetchUuid(fs, v);
        const k = d.system?.identifier || norm(d.name);
        if (d.type === "spell" && lvlOk(Number(d.system?.level) || 0) && !have.has(k)) out.push({ uuid: v, name: d.name, name_en: d.name, level: Number(d.system?.level) || 0, key: k, rank: 9 });
      } catch { /* introuvable */ }
    }
    return out;
  };

  // sorts mineurs
  const cantripMax = (scaleAt(cls, "cantrips-known", level) ?? 0) + scaleBonus(actor, id, "cantrips-known");
  const ownCantrips = (actor.items || []).filter(i => i.type === "spell" && Number(i.system?.level) === 0 && i.system?.sourceClass === id).length;
  const cantripPool = list.filter(s => s.level === 0 && !have.has(s.key));
  const needC = Math.max(0, cantripMax - ownCantrips);
  let cantrips = [];
  if (needC) {
    cantrips = await pickAny(choices["spells:cantrips"], cantripPool, l => l === 0);
    if (cantrips.length > needC) throw new Error(message(`Too many cantrips: ${cantrips.length} > ${needC}`, `Trop de sorts mineurs : ${cantrips.length} > ${needC}`));
    // comme pour les sorts préparés : une liste fournie peut être plus courte que le maximum
    if (!choices["spells:cantrips"]) pending.push({ id: "spells:cantrips", objet: cls.name, type: "Spells", titre: message(`${cls.name} cantrips`, `Sorts mineurs de ${cls.name}`), nombre: needC, options: cantripPool.map(s => `${s.name} — ${s.uuid}`) });
  }
  // sorts de classe accessibles
  const leveled = list.filter(s => s.level >= 1 && s.level <= maxLvl && !have.has(s.key));
  // préparés
  const prepMax = scaleAt(cls, "max-prepared", level);
  const alreadyPrep = (actor.items || []).filter(i => i.type === "spell" && Number(i.system?.prepared) === 1 && i.system?.sourceClass === id).length;
  let prepared = [];
  if (prepMax) {
    const needP = Math.max(0, prepMax - alreadyPrep);
    prepared = await pickAny(choices["spells:prepared"], [...leveled, ...list.filter(s => s.level >= 1 && have.has(s.key))], l => l >= 1 && l <= maxLvl);
    if (needP && !choices["spells:prepared"]) pending.push({ id: "spells:prepared", objet: cls.name, type: "Spells", titre: message(`Prepared spells (${needP} max)`, `Sorts préparés (${needP} max)`), nombre: needP, options: leveled.map(s => `${message("lvl.", "niv.")}${s.level} ${s.name} — ${s.uuid}`) });
    if (prepared.length > needP) throw new Error(message(`Too many prepared spells: ${prepared.length} > ${needP}`, `Trop de sorts préparés : ${prepared.length} > ${needP}`));
  }
  // la limite exacte est recalculée à l'application (les aptitudes accordées au même passage,
  // ex. Thaumaturge +1 sort mineur, n'existent pas encore sur la fiche au moment du plan)
  return { pending, step: { cls, level, cantrips, leveled, prepared: new Set(prepared.map(s => s.key)), maxLvl } };
}

/**
 * Strict 2024 character-build mode: import ONLY selected, officially listed
 * class spells. The legacy planClassSpells intentionally imports every spell
 * in its pool; it must not be used for a rules-bounded new character.
 */
export async function planSelectedClassSpells(fs, actor, cls, level, choices = {},
  { grantedUuids = [], grantedIdentifiers = [] } = {}) {
  if (String(cls.system?.source?.rules || "") !== "2024")
    throw new Error("Selected spell import requires a verified 2024 class.");
  const id = cls.system?.identifier;
  const list = await classSpellList(fs, cls);
  const official = (await spellLists(fs)).get(`class:${id}`) || new Set();
  if (!official.size) throw new Error(`No installed official spell list for class ${id}; selected import cannot be verified.`);
  const fake = { items: [{ type: "class", system: { ...cls.system, levels: level } }], system: { spells: {} } };
  const slots = slotMax(fake);
  const maxLvl = Math.max(0, Number(slots.pactLevel) || 0,
    ...Object.keys(slots).filter(k => /^spell\d$/.test(k)).map(k => Number(k.slice(5))));
  const have = new Set((actor.items || []).filter(i => i.type === "spell")
    .map(i => i._stats?.compendiumSource || i.flags?.dnd5e?.sourceId).filter(Boolean));
  const haveKeys = new Set((actor.items || []).filter(i => i.type === "spell")
    .map(i => norm(i.system?.identifier || i.name)));
  for (const id of grantedIdentifiers) haveKeys.add(norm(id));
  const excluded = new Set([...have, ...grantedUuids]);
  const allowed = list.filter(s => official.has(s.uuid) && s.rules === "2024" &&
    !excluded.has(s.uuid) && !haveKeys.has(norm(s.key)));
  const cantripMax = (scaleAt(cls, "cantrips-known", level) ?? 0) + scaleBonus(actor, id, "cantrips-known");
  const alreadyCantrips = (actor.items || []).filter(i => i.type === "spell" &&
    Number(i.system?.level) === 0 && i.system?.sourceClass === id).length;
  const preparedMax = scaleAt(cls, "max-prepared", level);
  if (preparedMax == null && cantripMax === 0)
    throw new Error(`${cls.name}: no supported 2024 prepared-spell progression; use spells=none.`);
  const alreadyPrepared = (actor.items || []).filter(i => i.type === "spell" &&
    Number(i.system?.prepared) === 1 && i.system?.sourceClass === id).length;
  const needCantrips = Math.max(0, cantripMax - alreadyCantrips);
  const needPrepared = Math.max(0, (preparedMax || 0) - alreadyPrepared);
  const pending = [];

  async function selected(kind, count, pool) {
    if (!count) {
      if ((choices[kind] || []).length) throw new Error(`${kind}: this class requires no selections.`);
      return [];
    }
    const raw = choices[kind];
    if (raw == null || (Array.isArray(raw) && raw.length < count)) {
      pending.push({ id: kind, objet: cls.name, type: "Spells", titre: message("Choose class spells", "Choisir les sorts de classe"),
        nombre: count, options: pool.map(s => `${message("lvl.", "niv.")}${s.level} ${s.name} — ${s.uuid}`),
        aide: message(`Provide exactly ${count} distinct, official 2024 spell UUIDs.`,
          `Fournir exactement ${count} UUID de sorts 2024 officiels et distincts.`) });
      return [];
    }
    if (!Array.isArray(raw) || raw.length !== count || new Set(raw).size !== raw.length)
      throw new Error(`${kind}: exactly ${count} distinct spell UUIDs are required.`);
    const byUuid = new Map(pool.map(s => [s.uuid, s]));
    const picked = [];
    for (const uuid of raw) {
      if (!UUID_SPELL.test(uuid) || !byUuid.has(uuid))
        throw new Error(`${kind}: ${uuid} is not a verified, eligible 2024 ${cls.name} spell UUID.`);
      const spell = await fetchUuid(fs, uuid);
      if (spell.type !== "spell" || spell.system?.source?.rules !== "2024")
        throw new Error(`${kind}: ${uuid} does not declare D&D 2024 rules.`);
      picked.push(byUuid.get(uuid));
    }
    return picked;
  }

  const cantrips = await selected("spells:cantrips", needCantrips, allowed.filter(s => s.level === 0));
  const prepared = await selected("spells:prepared", needPrepared,
    allowed.filter(s => s.level >= 1 && s.level <= maxLvl));
  return { pending, step: { cls, level, cantrips, leveled: prepared,
    prepared: new Set(prepared.map(s => s.key)), maxLvl },
  counts: { cantrips: needCantrips, prepared: needPrepared } };
}

const UUID_SPELL = /^Compendium\.[^.]+\.[^.]+\.Item\.[A-Za-z0-9]{16}$/;

export async function applyClassSpells(fs, actor, step, classItemId) {
  const data = [];
  // l'acteur est relu après l'avancement : on saute ce qui a été accordé entre-temps (ex. sorts de domaine)
  const have = new Set((actor.items || []).filter(i => i.type === "spell").map(i => i.system?.identifier || norm(i.name)));
  const id = step.cls.system?.identifier;
  const cMax = (scaleAt(step.cls, "cantrips-known", step.level) ?? 0) + scaleBonus(actor, id, "cantrips-known");
  const cOwn = (actor.items || []).filter(i => i.type === "spell" && Number(i.system?.level) === 0 && i.system?.sourceClass === id).length;
  step.cantrips = step.cantrips.filter(c => !have.has(c.key)).slice(0, Math.max(0, cMax - cOwn));
  for (const s of [...step.cantrips, ...step.leveled]) {
    if (have.has(s.key)) continue;
    let d;
    try { d = structuredClone(await fetchUuid(fs, s.uuid)); } catch { continue; }
    delete d._id; delete d.folder; delete d.sort; delete d.ownership; delete d.__pack;
    d._stats = { ...(d._stats || {}), compendiumSource: s.uuid };
    d.system.sourceClass = step.cls.system?.identifier;
    if (s.level >= 1) d.system.prepared = step.prepared.has(s.key) ? 1 : 0;
    if (d.system.method === undefined || d.system.method === "") d.system.method = "spell";
    data.push(d);
  }
  // préparation de sorts déjà présents (ex. relancer avec une nouvelle sélection)
  const upd = (actor.items || []).filter(i => i.type === "spell" && step.prepared.has(i.system?.identifier || norm(i.name)) && Number(i.system?.prepared) === 0).map(i => ({ _id: i._id, "system.prepared": 1 }));
  if (data.length) await fs.doc("create", "Item", { parentUuid: `Actor.${actor._id}`, data, modifiedTime: Date.now() });
  if (upd.length) await fs.doc("update", "Item", { parentUuid: `Actor.${actor._id}`, updates: upd, modifiedTime: Date.now() });
  return message(`${step.cantrips.length} cantrip(s), ${step.leveled.length} class spell(s) (levels 1 to ${step.maxLvl}), ${step.prepared.size} prepared`, `${step.cantrips.length} sort(s) mineur(s), ${step.leveled.length} sort(s) de classe (niv. 1 à ${step.maxLvl}), ${step.prepared.size} préparé(s)`);
}
