/**
 * Avancements reconstruits pour les contenus importés par Plutonium (5etools).
 *
 * Plutonium importe dans les compendiums du monde des historiques, dons et sous-classes SANS avancements
 * dnd5e (il les applique lui-même au moment d'importer sur une fiche). Sans eux, l'assistant de niveau n'a
 * rien à faire. On les reconstruit à la volée, de façon générique, à partir de ce que 5etools fournit :
 *  - le texte anglais d'origine, au format régulier de 5etools (« Ability Scores: … », « Feat: @feat[…] »,
 *    « Increase your X, Y, or Z by 1 », « You always have the @spell[…] spell prepared », tables de sorts…) ;
 *  - les identifiants Plutonium (flags.plutonium.hash), qui relient une sous-classe à ses aptitudes :
 *    « <aptitude>_<classe>_<src>_<sous-classe>_<src>_<niveau>_<src> ».
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
const FEAT_PACKS = ["world.dons", "dnd5e.feats24"];

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
  const m = new RegExp(`${label}\\s*:\\s*(.*?)(?=\\s(?:Ability Scores|Feat|Skill Proficiencies|Tool Proficiency|Equipment)\\s*:|$)`, "i").exec(t);
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
  for (const m of segment(t, "Skill Proficiencies").matchAll(/Reference\[skill=([^\]]+)\]/gi)) { const k = SKILL_EN[norm(m[1])]; if (k) grants.push(`skills:${k}`); }
  const choices = [];
  const toolSeg = segment(t, "Tool Proficiency");
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
  return adv.length ? { advancement: adv } : null;
}

// ---- sous-classe ----
async function subclass(fs, raw) {
  const h = String(raw.flags?.plutonium?.hash || "");
  // « druid_xphb,state:sub_moon_xphb=b1 »
  const m = /^([^_,]+)_([^,]+),state:sub_([^_]+)_([^=]+)=/.exec(h);
  if (!m) return null;
  const [, cls, csrc, short, ssrc] = m;
  const re = new RegExp(`_${cls}_${csrc}_${short}_${ssrc}_(\\d+)_`);
  const adv = [];
  // aptitudes : compendium des capacités de classe, rangées par niveau
  const idx = await packIndex(fs, "world.capacites-de-classe", ["flags.plutonium.hash"]);
  const byLevel = {};
  for (const x of idx) {
    const lm = re.exec(decodeURIComponent(x.flags?.plutonium?.hash || ""));
    if (lm) (byLevel[lm[1]] ??= []).push(x);
  }
  for (const [lv, list] of Object.entries(byLevel))
    adv.push(grant(sid(raw._id, "feat", lv), list.map(x => `Compendium.world.capacites-de-classe.Item.${x._id}`), Number(lv), null, "Features"));
  // sorts de sous-classe : table « <Classe> Level | Spells » de la description
  const html = raw.system?.description?.value || "";
  for (const row of html.matchAll(/<tr[^>]*>\s*<td[^>]*>\s*(\d+)\s*<\/td>\s*<td[^>]*>(.*?)<\/td>\s*<\/tr>/gis)) {
    const spells = refs(row[2], "spell");
    if (!spells.length) continue;
    const uuids = [];
    for (const s of spells) { const u = await findByName(fs, s.name, SPELL_PACKS, "spell"); if (u) uuids.push(u); }
    if (uuids.length) adv.push(grant(sid(raw._id, "spells", row[1]), uuids, Number(row[1]), ALWAYS, "Subclass Spells"));
  }
  return adv.length ? { advancement: adv } : null;
}

/**
 * Complète `doc` (déjà traduit) avec des avancements reconstruits si l'objet d'origine (`raw`, texte anglais)
 * vient de Plutonium et n'en a aucun. Sans effet sinon.
 */
export async function synthesize(fs, doc, raw = doc) {
  const has = a => Array.isArray(a) ? a.length : Object.keys(a || {}).length;
  if (!doc?.system || has(doc.system.advancement) || !raw?.flags?.plutonium) return doc;
  let r = null;
  try {
    if (doc.type === "background") r = await background(fs, raw);
    else if (doc.type === "feat") r = await feat(fs, raw);
    else if (doc.type === "subclass") r = await subclass(fs, raw);
  } catch { r = null; }
  if (!r) return doc;
  doc.system.advancement = Object.fromEntries(r.advancement.map(a => [a._id, a]));
  if (r.startingEquipment?.length && !(doc.system.startingEquipment || []).length) doc.system.startingEquipment = r.startingEquipment;
  doc.flags = { ...(doc.flags || {}), mcp: { ...(doc.flags?.mcp || {}), synthesizedAdvancement: true } };
  return doc;
}
