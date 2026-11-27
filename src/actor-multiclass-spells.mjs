/** Exact, class-scoped spell choices for one D&D 2024 multiclass level. */
import { fetchUuid, spellLists } from "./advancement.mjs";
import { slotMax } from "./dnd5e.mjs";
import { classSpellList, scaleBonus, spellKey } from "./spells.mjs";
import { verifySubclass, THIRD_CASTER_WIZARD_LIST } from "./subclass-spells.mjs";

const UUID = /^Compendium\.[^.]+\.[^.]+\.Item\.[A-Za-z0-9]{16}$/;
const CHOICE_KEYS = new Set(["spells:cantrips", "spells:prepared", "spells:spellbook", "spells:replace"]);

function scaleAt(cls, identifier, level) {
  const advancements = cls.system?.advancement || [];
  const list = Array.isArray(advancements) ? advancements : Object.values(advancements);
  const scale = list.find(a => a.type === "ScaleValue" && a.configuration?.identifier === identifier)?.configuration?.scale;
  if (!scale) return null;
  let value = null;
  for (const [n, entry] of Object.entries(scale).sort((a, b) => Number(a[0]) - Number(b[0])))
    if (Number(n) <= level) value = Number(entry.value ?? entry.number);
  return Number.isFinite(value) ? value : null;
}

const identity = spell => spellKey(spell.system?.identifier || spell.key || spell.name);
const sourceUuid = spell => spell._stats?.compendiumSource || spell.flags?.dnd5e?.sourceId;

function singleClassSlots(cls, level, subclass = null) {
  const one = { ...cls, system: { ...cls.system, levels: level } };
  return slotMax({ items: subclass ? [one, subclass] : [one], system: { spells: {} } });
}

/**
 * No writes: a class's own slots/scale define spell eligibility, *not* the
 * shared multiclass slot table. A Wizard additionally selects spellbook
 * entries (6 on entry, 2 on each later Wizard level) before preparing them.
 */
export async function planMulticlassSpells(fs, actor, cls, level, choices = {}) {
  if (cls.system?.source?.rules !== "2024") throw new Error("Spell selection requires a verified 2024 class source.");
  for (const key of Object.keys(choices))
    if (key.startsWith("spells:") && !CHOICE_KEYS.has(key)) throw new Error(`Unsupported spell choice: ${key}`);
  const id = String(cls.system?.identifier || "").toLowerCase();
  const progression = cls.system?.spellcasting?.progression || "none";
  const subclass = (actor.items || []).find(i => i.type === "subclass" &&
    String(i.system?.classIdentifier || "").toLowerCase() === id);
  let third = null;
  if (progression === "none" && subclass) {
    const verified = await verifySubclass(fs, subclass, cls);
    if (verified.doc?.system?.spellcasting?.progression === "third" &&
        THIRD_CASTER_WIZARD_LIST[id] === verified.doc.system?.identifier)
      third = verified.doc;
  }
  if (!["full", "half", "pact", "artificer"].includes(progression) && !third)
    throw new Error(`${id}: selected class spells require supported 2024 Spellcasting, Pact Magic or a verified existing third-caster subclass.`);
  const listClass = third ? "wizard" : id;
  const official = (await spellLists(fs)).get(`class:${listClass}`) || new Set();
  if (!official.size) throw new Error(`${id}: no installed official ${listClass} spell list; cannot verify spell choices.`);
  const listClassDoc = third ? { ...cls, system: { ...cls.system, identifier: listClass } } : cls;
  const listed = await classSpellList(fs, listClassDoc);
  const allowed = listed.filter(s => official.has(s.uuid) && s.rules === "2024" && UUID.test(s.uuid));
  const own = (actor.items || []).filter(i => i.type === "spell" && i.system?.sourceClass === id);
  const existing = new Set(own.map(identity));
  const available = allowed.filter(s => !existing.has(identity(s)));
  const single = singleClassSlots(cls, level, third);
  const maxLevel = Math.max(0, Number(single.pactLevel) || 0,
    ...Object.keys(single).filter(k => /^spell\d$/.test(k)).map(k => Number(k.slice(5))));
  const scaleSource = third || cls;
  const baseCantripsMax = scaleAt(scaleSource, "cantrips-known", level);
  if (third && baseCantripsMax == null)
    throw new Error(`${id}: official third-caster subclass has no verifiable cantrip progression.`);
  const cantripMax = (baseCantripsMax ?? 0) + scaleBonus(actor, id, "cantrips-known");
  const basePreparedMax = scaleAt(scaleSource, "max-prepared", level);
  if (basePreparedMax == null) throw new Error(`${id}: no verifiable prepared-spell progression; refuse automatic selection.`);
  const preparedMax = basePreparedMax + scaleBonus(actor, id, "max-prepared");
  const haveCantrips = own.filter(s => Number(s.system?.level) === 0).length;
  const havePrepared = own.filter(s => Number(s.system?.level) >= 1 && Number(s.system?.prepared) === 1).length;
  if (haveCantrips > cantripMax || havePrepared > preparedMax)
    throw new Error(`${id}: existing class spell counts exceed verifiable 2024 progression; inspect the sheet.`);
  const counts = { cantrips: cantripMax - haveCantrips, prepared: preparedMax - havePrepared };
  if (id === "wizard") counts.spellbook = level === 1 ? 6 : 2;
  else if (choices["spells:spellbook"] != null) throw new Error("spells:spellbook applies only to Wizard levels.");
  const pending = [];

  async function pick(key, count, pool) {
    const value = choices[key];
    if (!count) {
      if (value != null && (!Array.isArray(value) || value.length))
        throw new Error(`${key}: no selections required at this level.`);
      return [];
    }
    if (value == null || (Array.isArray(value) && value.length < count)) {
      pending.push({ id: key, type: "Spells", objet: cls.name, nombre: count,
        options: pool.map(s => `${s.name_en || s.name} — ${s.uuid}`),
        aide: `Select exactly ${count} distinct, official D&D 2024 ${id} spell UUIDs.` });
      return [];
    }
    if (!Array.isArray(value) || value.length !== count || new Set(value).size !== value.length)
      throw new Error(`${key}: exactly ${count} distinct spell UUIDs are required.`);
    const byUuid = new Map(pool.map(s => [s.uuid, s]));
    const selected = [];
    for (const uuid of value) {
      if (!UUID.test(uuid) || !byUuid.has(uuid))
        throw new Error(`${key}: ${uuid} is not a verified, eligible 2024 ${id} spell UUID.`);
      const doc = await fetchUuid(fs, uuid);
      if (doc.type !== "spell" || doc.system?.source?.rules !== "2024" ||
          Number(doc.system?.level) !== byUuid.get(uuid).level)
        throw new Error(`${key}: ${uuid} has invalid spell type, edition, or level.`);
      selected.push(byUuid.get(uuid));
    }
    return selected;
  }

  const cantrips = await pick("spells:cantrips", counts.cantrips, available.filter(s => s.level === 0));
  const leveledPool = available.filter(s => s.level >= 1 && s.level <= maxLevel);
  const spellbook = id === "wizard" ? await pick("spells:spellbook", counts.spellbook, leveledPool) : [];
  const existingUnprepared = own.filter(s => Number(s.system?.level) >= 1 && Number(s.system?.prepared) !== 1 &&
    official.has(sourceUuid(s)) && s.system?.source?.rules === "2024" && Number(s.system.level) <= maxLevel)
    .map(s => ({ uuid: sourceUuid(s), name: s.name, name_en: s.name, level: Number(s.system.level), key: identity(s) }));
  const prepPool = id === "wizard" ? [...spellbook, ...existingUnprepared]
    : [...leveledPool, ...existingUnprepared];
  const prepared = await pick("spells:prepared", counts.prepared, prepPool);
  // 2024 Eldritch Knight/Arcane Trickster: on each class level-up, at most
  // one cantrip and one prepared spell can be replaced. Keep this opt-in;
  // replacing other classes' spells is a separate rules-specific workflow.
  const replacements = [];
  if (choices["spells:replace"] !== undefined) {
    if (!third) throw new Error("spells:replace is currently supported only for verified 2024 third-caster subclasses.");
    const requests = choices["spells:replace"];
    if (!Array.isArray(requests) || requests.length > 2 || requests.some(r => !r || typeof r !== "object" || Array.isArray(r)))
      throw new Error("spells:replace requires an array of at most one cantrip and one prepared-spell replacement.");
    const seenKinds = new Set(), seenSource = new Set();
    const newSelected = new Set([...cantrips, ...prepared].map(s => s.uuid));
    for (const request of requests) {
      const { kind, from, to } = request;
      if (!["cantrip", "prepared"].includes(kind) || seenKinds.has(kind))
        throw new Error("spells:replace permits one cantrip and one prepared-spell replacement at most.");
      seenKinds.add(kind);
      const current = own.find(i => i._id === from);
      if (!current || Number(current.system?.prepared) === 2 ||
          (kind === "cantrip" ? Number(current.system?.level) !== 0 :
            Number(current.system?.level) < 1 || Number(current.system?.prepared) !== 1) ||
          !official.has(sourceUuid(current)) || current.system?.source?.rules !== "2024")
        throw new Error(`spells:replace: ${String(from)} is not an eligible owned, ordinary 2024 ${id} ${kind}.`);
      const pool = available.filter(s => kind === "cantrip" ? s.level === 0 : s.level >= 1 && s.level <= maxLevel);
      const chosen = pool.find(s => s.uuid === to);
      if (!UUID.test(to || "") || !chosen || newSelected.has(to) || seenSource.has(to) ||
          identity(current) === identity(chosen))
        throw new Error(`spells:replace: ${String(to)} is not a distinct, eligible official 2024 ${listClass} spell.`);
      const doc = await fetchUuid(fs, to);
      if (doc.type !== "spell" || doc.system?.source?.rules !== "2024" || Number(doc.system?.level) !== chosen.level)
        throw new Error(`spells:replace: ${to} has invalid type, edition or level.`);
      seenSource.add(to);
      replacements.push({ from, to: chosen, kind });
    }
  }
  const added = id === "wizard" ? spellbook : prepared.filter(s => !existing.has(identity(s)));
  return { pending, counts, maxLevel, classSlots: single,
    step: { cls, level, cantrips, leveled: added, prepared: new Set(prepared.map(identity)),
      replacements, maxLvl: maxLevel, perClass: true },
    selectedUuids: [...cantrips, ...added, ...replacements.map(r => r.to)].map(s => s.uuid) };
}
