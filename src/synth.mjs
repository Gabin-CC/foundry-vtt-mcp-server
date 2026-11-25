/**
 * Avancements reconstruits pour les contenus importés par Plutonium (5etools).
 *
 * Plutonium importe dans les compendiums du monde des classes, historiques, dons et sous-classes SANS avancements
 * dnd5e (il les applique lui-même au moment d'importer sur une fiche). Sans eux, l'assistant de niveau n'a
 * rien à faire. On les reconstruit à la volée, de façon générique, à partir de ce que 5etools fournit :
 *  - le texte anglais d'origine, au format régulier de 5etools (« Ability Scores: … », « Feat: @feat[…] »,
 *    « Increase your X, Y, or Z by 1 », « You always have the @spell[…] spell prepared », tables de sorts…) ;
 *  - les identifiants Plutonium (flags.plutonium.hash), qui relient une sous-classe à ses aptitudes :
 *    « <aptitude>_<classe>_<src>_<sous-classe>_<src>_<niveau>_<src> », et une classe aux siennes :
 *    « <aptitude>_<classe>_<src>_<niveau>_<src> » (page « classFeature ») ;
 *  - les sections « Level N: Nom » du texte d'une classe (améliorations de caractéristique, sous-classe, dons).
 * Ce que le texte 5etools d'une classe ne contient pas (maîtrises d'armures/armes/outils, équipement de départ)
 * est repris de la classe officielle équivalente (même system.identifier, même version de règles).
 * Rien n'est écrit dans les compendiums : l'objet créé sur la fiche porte les avancements reconstruits, comme
 * s'ils venaient du compendium. Les identifiants sont déterministes (même objet -> mêmes identifiants).
 */
import crypto from "node:crypto";

const ABIL_EN = { strength: "str", dexterity: "dex", constitution: "con", intelligence: "int", wisdom: "wis", charisma: "cha" };
const ALL_ABIL = ["str", "dex", "con", "int", "wis", "cha"];
const SKILL_EN = { acrobatics: "acr", "animal handling": "ani", arcana: "arc", athletics: "ath", deception: "dec", history: "his",
  insight: "ins", intimidation: "itm", investigation: "inv", medicine: "med", nature: "nat", perception: "prc", performance: "prf",
  persuasion: "per", religion: "rel", "sleight of hand": "slt", stealth: "ste", survival: "sur" };
const CLASS_LISTS = ["artificer", "bard", "cleric", "druid", "paladin", "ranger", "sorcerer", "warlock", "wizard"];

const sid = (...parts) => {
  const h = crypto.createHash("sha1").update(parts.join("|")).digest("base64").replace(/[^A-Za-z0-9]/g, "");
  return ("syn" + h).slice(0, 16);
};
const text = html => String(html || "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const refs = (s, tag) => [...String(s).matchAll(new RegExp(`@${tag}\\[([^|\\]]+)(?:\\|([^|\\]]*))?(?:\\|([^\\]]*))?\\]`, "g"))]
  .map(m => ({ name: m[1].trim(), source: (m[2] || "").trim(), display: (m[3] || "").trim() }));
const norm = s => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[’']/g, "'").trim();

// ---- index des compendiums (noms anglais bruts) ----
async function packIndex(fs, pack, fields = []) {
  fs._synIdx ??= new Map();
  const k = pack + "|" + fields.join(",");
  if (!fs._synIdx.has(k)) {
    let r = [];
    try { r = await fs.doc("get", "Item", { pack, query: {}, index: true, indexFields: ["_id", "name", "type", ...fields] }); } catch { /* absent */ }
    fs._synIdx.set(k, r);
  }
  return fs._synIdx.get(k);
}
/** Cherche un objet par son nom anglais, dans l'ordre des compendiums donnés. */
async function findByName(fs, name, packs, type) {
  const q = norm(name);
  for (const p of packs) {
    const hit = (await packIndex(fs, p)).find(x => norm(x.name) === q && (!type || x.type === type));
    if (hit) return `Compendium.${p}.Item.${hit._id}`;
  }
  return null;
}
const SPELL_PACKS = ["dnd5e.spells24", "world.sors", "dnd5e.spells"];
const ITEM_PACKS = ["dnd5e.equipment24", "world.objets", "dnd5e.items"];
const FEAT_PACKS = ["dnd5e.feats24", "world.dons"]; // version officielle (avec avancements) en priorité

// ---- briques d'avancement ----
const asi = (id, { points, cap, allowed, title = "" }) => ({
  _id: id, type: "AbilityScoreImprovement", level: 0, title,
  configuration: { points, cap, fixed: Object.fromEntries(ALL_ABIL.map(a => [a, 0])), locked: ALL_ABIL.filter(a => !allowed.includes(a)), recommendation: null },
  value: { type: "asi" }
});
const grant = (id, uuids, level = 0, spell = null, title = "") => ({
  _id: id, type: "ItemGrant", level, title,
  configuration: { items: uuids.map(uuid => ({ uuid, optional: false })), optional: false, spell }, value: {}
});
const ALWAYS = { ability: [], method: "spell", prepared: 2, uses: { max: "", per: "", requireSlot: false } };

/** Abilities nommées dans un passage (« Dexterity, Constitution, Wisdom » / « Intelligence, Wisdom, or Charisma »). */
function abilitiesIn(s) {
  const out = [];
  for (const [en, k] of Object.entries(ABIL_EN)) if (new RegExp(`\\b${en}\\b`, "i").test(s)) out.push(k);
  return out;
}
/** Segment « Label: … » d'une liste 5etools (jusqu'au label suivant). */
function segment(t, label) {
  const m = new RegExp(`${label}\\s*:\\s*(.*?)(?=\\s(?:Ability Scores|Feats?|Skill Proficienc(?:y|ies)|Tool Proficienc(?:y|ies)|Equipment)\\s*:|$)`, "i").exec(t);
  return m ? m[1].trim() : "";
}

// ---- historique ----
async function background(fs, raw) {
  const t = text(raw.system?.description?.value);
  if (!/Ability Scores\s*:/i.test(t)) return null;
  const adv = [];
  const abil = abilitiesIn(segment(t, "Ability Scores"));
  if (abil.length) adv.push(asi(sid(raw._id, "asi"), { points: 3, cap: 2, allowed: abil, title: "Background Ability Score Improvement" }));
  // don d'origine : « @feat[Magic Initiate|XPHB] (Druid) » -> variante Plutonium « Magic Initiate; Druid » si elle existe
  const featSeg = segment(t, "Feat");
  const f = refs(featSeg, "feat")[0];
  if (f) {
    const variant = /\(([^)]+)\)/.exec(featSeg.slice(featSeg.indexOf(f.name)))?.[1];
    const uuid = (variant && await findByName(fs, `${f.name}; ${variant}`, FEAT_PACKS)) || await findByName(fs, f.name, FEAT_PACKS);
    if (uuid) adv.push(grant(sid(raw._id, "feat"), [uuid], 0, null, "Background Feat"));
  }
  // maîtrises : compétences + outil
  const grants = [];
  for (const m of segment(t, "Skill Proficienc(?:y|ies)").matchAll(/Reference\[skill=([^\]]+)\]/gi)) { const k = SKILL_EN[norm(m[1])]; if (k) grants.push(`skills:${k}`); }
  const choices = [];
  const toolSeg = segment(t, "Tool Proficienc(?:y|ies)");
  for (const r of refs(toolSeg, "item")) {
    const cat = { "gaming set": "game", "musical instrument": "music", "artisan's tools": "art" }[norm(r.name)];
    if (cat) { choices.push({ count: 1, pool: [`tool:${cat}:*`] }); continue; }
    const uuid = await findByName(fs, r.name, ["dnd5e.equipment24", "dnd5e.items"], "tool");
    if (!uuid) continue;
    const [, pack, , id] = /^Compendium\.([^.]+\.[^.]+)\.(Item)\.(.+)$/.exec(uuid);
    const tool = (await packIndex(fs, pack, ["system.type.value", "system.type.baseItem"])).find(x => x._id === id);
    if (tool?.system?.type?.baseItem) grants.push(`tool:${tool.system.type.value}:${tool.system.type.baseItem}`);
  }
  if (grants.length || choices.length) adv.push({ _id: sid(raw._id, "prof"), type: "Trait", level: 0, title: "Background Proficiencies",
    configuration: { mode: "default", allowReplacements: false, grants, choices }, value: {} });
  // équipement : « (A) @item[…], @item[Arrow|XPHB|20 Arrows], …, 3 GP; or (B) 50 GP »
  const eq = [];
  const eqSeg = segment(t, "Equipment");
  const optA = /\(A\)(.*?)(?:;\s*or\s*\(B\)|$)/i.exec(eqSeg)?.[1] || "";
  const optB = /\(B\)\s*(.*)$/i.exec(eqSeg)?.[1] || "";
  if (optA || optB) {
    const orId = sid(raw._id, "eq-or"), aId = sid(raw._id, "eq-a");
    eq.push({ _id: orId, type: "OR", group: "", sort: 0, requiresProficiency: false });
    eq.push({ _id: aId, type: "AND", group: orId, sort: 1, requiresProficiency: false });
    let n = 0;
    for (const r of refs(optA, "item")) {
      const uuid = await findByName(fs, r.name, ITEM_PACKS);
      if (!uuid) continue;
      const count = Number(/^(\d+)\s/.exec(r.display)?.[1] || 1);
      eq.push({ _id: sid(raw._id, "eq-a", r.name), type: "linked", key: uuid, count, group: aId, sort: ++n, requiresProficiency: false });
    }
    const gpA = /(\d+)\s*GP/i.exec(optA.replace(/@item\[[^\]]*\]/g, ""))?.[1];
    if (gpA) eq.push({ _id: sid(raw._id, "eq-a-gp"), type: "currency", key: "gp", count: Number(gpA), group: aId, sort: ++n, requiresProficiency: false });
    const gpB = /(\d+)\s*GP/i.exec(optB)?.[1];
    if (gpB) eq.push({ _id: sid(raw._id, "eq-b"), type: "currency", key: "gp", count: Number(gpB), group: orId, sort: 2, requiresProficiency: false });
  }
  return { advancement: adv, startingEquipment: eq };
}

// ---- don ----
async function feat(fs, raw) {
  const html = raw.system?.description?.value || "";
  const t = text(html);
  const adv = [];
  // « Ability Score Increase. Increase your Intelligence, Wisdom, or Charisma by 1 » / « … one ability score of your choice … »
  const m = /Ability Score Increase\.\s*(.*?)(?:\.\s|$)/i.exec(t);
  if (m) {
    const by = Number(/by (\d)/i.exec(m[1])?.[1] || 1);
    const allowed = /of your choice|one ability score/i.test(m[1]) && !abilitiesIn(m[1]).length ? ALL_ABIL : abilitiesIn(m[1]);
    if (allowed.length) adv.push(asi(sid(raw._id, "asi"), { points: by, cap: by, allowed, title: "Ability Score Increase" }));
  }
  // sorts toujours préparés : « You always have the @spell[X|SRC] spell prepared »
  const always = [...html.matchAll(/always have the (@spell\[[^\]]+\](?:\s*(?:and|,)\s*@spell\[[^\]]+\])*) spells? prepared/gi)]
    .flatMap(x => refs(x[1], "spell"));
  if (always.length) {
    const uuids = [];
    for (const s of always) { const u = await findByName(fs, s.name, SPELL_PACKS, "spell"); if (u) uuids.push(u); }
    const once = /cast it without a spell slot.*?Long Rest/i.test(t);
    if (uuids.length) adv.push(grant(sid(raw._id, "spells"), uuids, 0,
      { ability: adv.length ? [] : ["int", "wis", "cha"], method: "spell", prepared: 2, uses: once ? { max: "1", per: "lr", requireSlot: false } : { max: "", per: "", requireSlot: false } }));
  }
  // listes de sorts au choix (Initié à la magie et variantes) : « learn two cantrips … from the Druid spell list »
  const listOf = s => CLASS_LISTS.filter(c => new RegExp(`\\b${c}\\b`, "i").test(s)).map(c => `class:${c}`);
  const cant = /learn (two|one|three) cantrips? of your choice from the (.*?) spell list/i.exec(t);
  if (cant) {
    const lists = listOf(cant[2]);
    if (lists.length) adv.push({ _id: sid(raw._id, "cantrips"), type: "ItemChoice", level: 0, title: "Cantrips",
      configuration: { allowDrops: true, type: "spell", pool: [], choices: { 0: { count: { one: 1, two: 2, three: 3 }[cant[1].toLowerCase()], replacement: false } },
        restriction: { list: lists, level: "0" }, spell: { ability: ["int", "wis", "cha"], method: "", prepared: 0, uses: { max: "", per: "", requireSlot: false } } },
      value: { added: {}, replaced: {} } });
  }
  const lvl1 = /Choose a level 1 spell from the (.*?) spell list/i.exec(t);
  if (lvl1) {
    const lists = listOf(lvl1[1]);
    if (lists.length) adv.push({ _id: sid(raw._id, "level1"), type: "ItemChoice", level: 0, title: "Level 1 Spell",
      configuration: { allowDrops: true, type: "spell", pool: [], choices: { 0: { count: 1, replacement: false } },
        restriction: { list: lists, level: "1" }, spell: { ability: ["int", "wis", "cha"], method: "spell", prepared: 2, uses: { max: "1", per: "lr", requireSlot: false } } },
      value: { added: {}, replaced: {} } });
  }
  // maîtrise de compétence au choix : « gain proficiency in one of the following skills of your choice: &Reference[skill=X], … »
  const sk = /proficiency in (one|two|three) of the following skills(?: of your choice)?\s*:?(.*?)(?:\.\s|$)/i.exec(t);
  if (sk) {
    const pool = [...sk[2].matchAll(/Reference\[skill=([^\]]+)\]/gi)].map(x => SKILL_EN[norm(x[1])]).filter(Boolean).map(k => `skills:${k}`);
    if (pool.length) adv.push({ _id: sid(raw._id, "skills"), type: "Trait", level: 0, title: "Skill Proficiency",
      configuration: { mode: "default", allowReplacements: false, grants: [], choices: [{ count: { one: 1, two: 2, three: 3 }[sk[1].toLowerCase()], pool }] }, value: {} });
  }
  return adv.length ? { advancement: adv } : null;
}

// ---- sous-classe ----
async function subclass(fs, raw) {
  let h = String(raw.flags?.plutonium?.hash || "");
  try { h = decodeURIComponent(h); } catch { /* déjà décodé */ }
  // « druid_xphb,state:sub_moon_xphb=b1 »
  const m = /^([^_,]+)_([^,]+),state:sub_([^_]+)_([^=]+)=/.exec(h);
  if (!m) return null;
  const [, cls, csrc, short, ssrc] = m;
  const esc = x => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`_${esc(cls)}_${esc(csrc)}_${esc(short)}_${esc(ssrc)}_(\\d+)_`);
  const adv = [];
  // aptitudes : compendiums du monde (aptitudes Plutonium), rangées par niveau
  const byLevel = {};
  for (const x of await pluFeatures(fs)) {
    const lm = re.exec(x.hash);
    if (lm) (byLevel[lm[1]] ??= []).push(x);
  }
  for (const [lv, list] of Object.entries(byLevel))
    adv.push(grant(sid(raw._id, "feat", lv), list.map(x => x.uuid), Number(lv), null, "Features"));
  // sorts de sous-classe : table « <Classe> Level | Spells » de la description (« 3 » ou « 3rd »)
  const html = raw.system?.description?.value || "";
  for (const row of html.matchAll(/<tr[^>]*>\s*<td[^>]*>\s*(\d+)(?:st|nd|rd|th)?\s*<\/td>\s*<td[^>]*>(.*?)<\/td>\s*<\/tr>/gis)) {
    const spells = refs(row[2], "spell");
    if (!spells.length) continue;
    const uuids = [];
    for (const s of spells) { const u = await findByName(fs, s.name, SPELL_PACKS, "spell"); if (u) uuids.push(u); }
    if (uuids.length) adv.push(grant(sid(raw._id, "spells", row[1]), uuids, Number(row[1]), ALWAYS, "Subclass Spells"));
  }
  return adv.length ? { advancement: adv } : null;
}

// ---- aptitudes Plutonium des compendiums du monde ----
const decode = h => { try { return decodeURIComponent(String(h || "")); } catch { return String(h || ""); } };
const esc = x => String(x).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const advOf = d => Array.isArray(d?.system?.advancement) ? d.system.advancement : Object.values(d?.system?.advancement || {});
const packsOf = async fs => (fs._packs2 ??= ((await fs.worldData()).packs || []));
/**
 * Aptitudes de classe / sous-classe importées par Plutonium, tous compendiums d'objets du monde confondus :
 * flags.plutonium.page = « classFeature » | « subclassFeature », flags.plutonium.hash =
 * « <aptitude>_<classe>_<src>_<niveau>_<src> » ou « <aptitude>_<classe>_<src>_<sous-classe>_<src>_<niveau>_<src> ».
 */
async function pluFeatures(fs) {
  if (fs._synFeatures) return fs._synFeatures;
  const out = [];
  for (const p of (await packsOf(fs)).filter(p => p.type === "Item" && String(p.id).startsWith("world."))) {
    for (const x of await packIndex(fs, p.id, ["flags.plutonium.hash", "flags.plutonium.page"])) {
      const pl = x.flags?.plutonium;
      if (!pl?.hash || !/^(sub)?classFeature$/.test(pl.page || "")) continue;
      out.push({ uuid: `Compendium.${p.id}.Item.${x._id}`, _id: x._id, name: x.name, hash: decode(pl.hash), page: pl.page });
    }
  }
  return (fs._synFeatures = out);
}

/** Sections « Level N: Nom » du texte 5etools d'une classe (attribut data-roll-name-ancestor). */
export function classSections(html) {
  const out = [];
  for (const part of String(html || "").split(/data-roll-name-ancestor="/).slice(1)) {
    const q = part.indexOf('"');
    const head = part.slice(0, q).replace(/&#39;|&apos;|&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
    const m = /^Level (\d+)\s*:\s*(.+)$/i.exec(head.trim());
    if (m) out.push({ level: Number(m[1]), name: m[2].trim(), body: text(part.slice(q + 1).replace(/^[^>]*>/, "")) });
  }
  return out;
}

/**
 * Équivalent officiel d'une classe (ou sous-classe) : même system.identifier dans un compendium du système dnd5e
 * (ex. « fighter » -> dnd5e.classes24). Même version de règles (system.source.rules) en priorité.
 * @returns {{uuid, pack, id, rules}|null}
 */
export async function officialEquivalent(fs, doc) {
  const ident = doc?.system?.identifier;
  if (!ident || !["class", "subclass"].includes(doc.type)) return null;
  const hits = [];
  for (const p of (await packsOf(fs)).filter(p => p.type === "Item" && p.packageName === "dnd5e")) {
    for (const x of await packIndex(fs, p.id, ["system.identifier", "system.source.rules", "system.classIdentifier"])) {
      if (x.type !== doc.type || x.system?.identifier !== ident) continue;
      if (doc.type === "subclass" && x.system?.classIdentifier !== doc.system?.classIdentifier) continue;
      hits.push({ uuid: `Compendium.${p.id}.Item.${x._id}`, pack: p.id, id: x._id, rules: String(x.system?.source?.rules || "") });
    }
  }
  const rules = String(doc.system?.source?.rules || "");
  return hits.find(h => h.rules === rules) || hits[0] || null;
}

/** Vrai si l'objet (classe) accorde des aptitudes : sinon, l'import ne donnerait que PV et maîtrises. */
export const grantsFeatures = doc => advOf(doc).some(a => ["ItemGrant", "ItemChoice", "Subclass"].includes(a.type));

// « fighting style » -> « fightingStyle » (sous-type de don dnd5e)
const camel = s => norm(s).split(/[^a-z0-9]+/).filter(Boolean).map((w, i) => i ? w[0].toUpperCase() + w.slice(1) : w).join("");
async function featSubtypeExists(fs, subtype) {
  for (const p of (await packsOf(fs)).filter(p => p.type === "Item" && p.packageName === "dnd5e"))
    if ((await packIndex(fs, p.id, ["system.type.subtype"])).some(x => x.type === "feat" && x.system?.type?.subtype === subtype)) return true;
  return false;
}

// ---- classe ----
async function klass(fs, raw, existing) {
  // « fighter_xphb »
  const m = /^([^_,]+)_([^_,]+)$/.exec(decode(raw.flags?.plutonium?.hash));
  if (!m) return null;
  const [, cls, csrc] = m;
  const secs = classSections(raw.system?.description?.value);
  const adv = [];
  // amélioration de caractéristique / don : « Ability Score Improvement », ou toute section « … feat or another feat
  // of your choice for which you qualify » (ex. Don épique)
  const asiLv = new Map();
  for (const s of secs) if (/^ability score improvement$/i.test(s.name) || /\bor another feat of your choice\b/i.test(s.body)) if (!asiLv.has(s.level)) asiLv.set(s.level, s.name);
  // aptitudes de la classe (pas celles des sous-classes), par niveau
  const reF = new RegExp(`^(.+)_${esc(cls)}_${esc(csrc)}_(\\d+)_[^_]+$`);
  const reSub = new RegExp(`_${esc(cls)}_${esc(csrc)}_[^_]+_[^_]+_(\\d+)_[^_]+$`);
  const granted = new Set(existing.filter(a => a.type === "ItemGrant").flatMap(a => (a.configuration?.items || []).map(i => String(typeof i === "string" ? i : i.uuid).split(".").pop())));
  const byLevel = {}, seen = new Set(), subLevels = [];
  for (const f of await pluFeatures(fs)) {
    if (f.page === "subclassFeature") { const sm = reSub.exec(f.hash); if (sm) subLevels.push(Number(sm[1])); continue; }
    const fm = reF.exec(f.hash);
    if (!fm) continue;
    const lv = Number(fm[2]);
    if (asiLv.has(lv) && norm(asiLv.get(lv)) === norm(f.name)) continue;    // « Epic Boon » : choix de don, pas un objet
    const k = `${lv}|${norm(f.name)}`;
    if (granted.has(f._id) || seen.has(k)) continue;
    seen.add(k);
    (byLevel[lv] ??= []).push(f);
  }
  // rien de fiable à accorder : on laisse la main au repli (classe officielle équivalente)
  if (!Object.keys(byLevel).length) return null;
  for (const [lv, list] of Object.entries(byLevel).sort((a, b) => a[0] - b[0]))
    adv.push(grant(sid(raw._id, "feat", lv), list.map(x => x.uuid), Number(lv), null, "Features"));
  const asiHave = new Set(existing.filter(a => a.type === "AbilityScoreImprovement").map(a => Number(a.level)));
  for (const [lv, name] of [...asiLv].sort((a, b) => a[0] - b[0]))
    if (!asiHave.has(lv)) adv.push({ ...asi(sid(raw._id, "asi", lv), { points: 2, cap: 2, allowed: ALL_ABIL, title: name }), level: lv });
  // sous-classe : section « <Classe> Subclass », sinon premier niveau des aptitudes de sous-classe
  if (!existing.some(a => a.type === "Subclass")) {
    const lv = secs.find(s => /\bsubclass$/i.test(s.name))?.level ?? (subLevels.length ? Math.min(...subLevels) : null);
    if (lv) adv.push({ _id: sid(raw._id, "subclass"), type: "Subclass", level: lv, title: "Subclass", configuration: {}, value: {} });
  }
  // don au choix d'une catégorie (« gain a Fighting Style feat of your choice ») si cette catégorie existe dans dnd5e
  for (const s of secs) {
    if (asiLv.has(s.level)) continue;
    const fm = /\bgain an? ([A-Z][A-Za-z' ]+?) feat of your choice\b/.exec(s.body);
    if (!fm) continue;
    const subtype = camel(fm[1]);
    if (!subtype || !(await featSubtypeExists(fs, subtype))) continue;
    adv.push({ _id: sid(raw._id, "choice", s.level, subtype), type: "ItemChoice", level: s.level, title: s.name,
      configuration: { allowDrops: true, type: "feat", pool: [], choices: { [s.level]: { count: 1, replacement: true } },
        restriction: { type: "feat", subtype, list: [] }, spell: null },
      value: { added: {}, replaced: {} } });
  }
  // maîtrises d'armures / armes / outils et équipement de départ : absents du texte 5etools de Plutonium ;
  // repris de la classe officielle équivalente (même identifiant, même version de règles), si elle existe
  let startingEquipment = null;
  const off = await officialEquivalent(fs, raw);
  if (off && off.rules === String(raw.system?.source?.rules || "")) {
    const od = (await fs.doc("get", "Item", { pack: off.pack, query: { _id: off.id } }).catch(() => [])).find(x => x._id === off.id);
    const keysOf = a => [...(a.configuration?.grants || []), ...(a.configuration?.choices || []).flatMap(c => c.pool || [])];
    const haveKeys = new Set(existing.filter(a => a.type === "Trait").flatMap(keysOf));
    for (const a of advOf(od)) {
      if (a.type !== "Trait") continue;
      const keys = keysOf(a);
      if (!keys.length || !keys.every(k => /^(armor|weapon|tool):/.test(k)) || keys.every(k => haveKeys.has(k))) continue;
      adv.push({ ...structuredClone(a), _id: sid(raw._id, "trait", a._id), value: {} });
    }
    const se = od?.system?.startingEquipment || [];
    if (se.length) {
      const id = x => x ? sid(raw._id, "eq", x) : x;
      startingEquipment = se.map(e => ({ ...structuredClone(e), _id: id(e._id), group: id(e.group || "") || "" }));
    }
  }
  return { advancement: adv, startingEquipment };
}

/**
 * Complète `doc` (déjà traduit) avec des avancements reconstruits si l'objet d'origine (`raw`, texte anglais)
 * vient de Plutonium et n'en a aucun. Sans effet sinon.
 */
export async function synthesize(fs, doc, raw = doc) {
  const list = a => Array.isArray(a) ? a : Object.values(a || {});
  if (!doc?.system || !raw?.flags?.plutonium) return doc;
  const existing = list(doc.system.advancement);
  // sous-classe Plutonium avec seulement des valeurs d'échelle (ex. dés de supériorité) : aptitudes à reconstruire
  const grants = existing.filter(a => ["ItemGrant", "ItemChoice"].includes(a.type));
  // classe Plutonium : PV, sauvegardes, compétences et valeurs d'échelle seulement -> aptitudes à reconstruire
  const merge = ["subclass", "class"].includes(doc.type) && existing.length && !grants.length;
  if (existing.length && !merge) return doc;
  let r = null;
  try {
    if (doc.type === "background") r = await background(fs, raw);
    else if (doc.type === "feat") r = await feat(fs, raw);
    else if (doc.type === "subclass") r = await subclass(fs, raw);
    else if (doc.type === "class") r = await klass(fs, raw, existing);
  } catch { r = null; }
  if (!r) return doc;
  doc.system.advancement = Object.fromEntries([...(merge ? existing : []), ...r.advancement].map(a => [a._id, a]));
  if (r.startingEquipment?.length && !(doc.system.startingEquipment || []).length) doc.system.startingEquipment = r.startingEquipment;
  doc.flags = { ...(doc.flags || {}), mcp: { ...(doc.flags?.mcp || {}), synthesizedAdvancement: true } };
  return doc;
}
