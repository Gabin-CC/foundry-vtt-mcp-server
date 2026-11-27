/** Exact, class-scoped spell choices for one D&D 2024 multiclass level. */
import { fetchUuid, spellLists } from "./advancement.mjs";
import { slotMax } from "./dnd5e.mjs";
import { classSpellList, scaleBonus, spellKey } from "./spells.mjs";

const UUID = /^Compendium\.[^.]+\.[^.]+\.Item\.[A-Za-z0-9]{16}$/;
const CHOICE_KEYS = new Set(["spells:cantrips", "spells:prepared", "spells:spellbook"]);

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

function singleClassSlots(cls, level) {
  const one = { ...cls, system: { ...cls.system, levels: level } };
  return slotMax({ items: [one], system: { spells: {} } });
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
  if (!["full", "half", "pact", "artificer"].includes(progression))
    throw new Error(`${id}: selected class spells require a supported 2024 Spellcasting or Pact Magic progression; subclass third-casters need separate verification.`);
  const official = (await spellLists(fs)).get(`class:${id}`) || new Set();
  if (!official.size) throw new Error(`${id}: no installed official class spell list; cannot verify spell choices.`);
  const listed = await classSpellList(fs, cls);
  const allowed = listed.filter(s => official.has(s.uuid) && s.rules === "2024" && UUID.test(s.uuid));
  const own = (actor.items || []).filter(i => i.type === "spell" && i.system?.sourceClass === id);
  const existing = new Set(own.map(identity));
  const available = allowed.filter(s => !existing.has(identity(s)));
  const single = singleClassSlots(cls, level);
  const maxLevel = Math.max(0, Number(single.pactLevel) || 0,
    ...Object.keys(single).filter(k => /^spell\d$/.test(k)).map(k => Number(k.slice(5))));
  const cantripMax = (scaleAt(cls, "cantrips-known", level) ?? 0) + scaleBonus(actor, id, "cantrips-known");
  const basePreparedMax = scaleAt(cls, "max-prepared", level);
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
  const added = id === "wizard" ? spellbook : prepared.filter(s => !existing.has(identity(s)));
  return { pending, counts, maxLevel, classSlots: single,
    step: { cls, level, cantrips, leveled: added, prepared: new Set(prepared.map(identity)),
      maxLvl: maxLevel, perClass: true },
    selectedUuids: [...cantrips, ...added].map(s => s.uuid) };
}
