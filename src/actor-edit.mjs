/** Plan bounded D&D 2024 equipment and prepared-spell edits on an existing actor. */
import { slotMax } from "./dnd5e.mjs";

const plain = x => x !== null && typeof x === "object" && !Array.isArray(x);
const advList = cls => Array.isArray(cls.system?.advancement)
  ? cls.system.advancement : Object.values(cls.system?.advancement || {});

function preparedMax(cls) {
  const adv = advList(cls).find(x => x.type === "ScaleValue" && x.configuration?.identifier === "max-prepared");
  if (!adv) return null;
  let value = null;
  const level = Number(cls.system?.levels) || 0;
  for (const [l, entry] of Object.entries(adv.configuration?.scale || {}).sort((a, b) => Number(a[0]) - Number(b[0])))
    if (Number(l) <= level) value = Number(entry?.value ?? entry?.number);
  return Number.isFinite(value) ? value : null;
}

const armorKind = item => {
  const type = item.system?.type?.value;
  if (["light", "lgt"].includes(type)) return "lgt";
  if (["medium", "med"].includes(type)) return "med";
  if (["heavy", "hvy"].includes(type)) return "hvy";
  if (["shield", "shl"].includes(type)) return "shl";
  return null;
};

function checkEquipment(actor, resulting, warnings) {
  const armorProf = new Set(actor.system?.traits?.armorProf?.value || []);
  const weaponProf = new Set(actor.system?.traits?.weaponProf?.value || []);
  const worn = (actor.items || []).filter(i => ["weapon", "equipment"].includes(i.type) &&
    (resulting.has(i._id) ? resulting.get(i._id) : !!i.system?.equipped));
  const armor = worn.filter(i => i.type === "equipment" && armorKind(i) && armorKind(i) !== "shl");
  const shields = worn.filter(i => i.type === "equipment" && armorKind(i) === "shl");
  const weapons = worn.filter(i => i.type === "weapon");
  if (armor.length > 1 || shields.length > 1)
    throw new Error("Equip at most one suit of armor and one shield. Unequip the replaced item in the same request.");
  for (const i of armor) if (!armorProf.has(armorKind(i)))
    warnings.push(`${i.name}: armor without training; Strength/Dexterity D20 tests have Disadvantage and the character cannot cast spells (D&D 2024).`);
  for (const i of shields) if (!armorProf.has("shl"))
    warnings.push(`${i.name}: shield without training; its Armor Class bonus does not apply (D&D 2024).`);
  for (const i of weapons) {
    const type = String(i.system?.type?.value || "");
    const baseItem = i.system?.type?.baseItem;
    if (!((type.startsWith("simple") && weaponProf.has("sim")) ||
      (type.startsWith("martial") && weaponProf.has("mar")) || weaponProf.has(baseItem)))
      warnings.push(`${i.name}: usable without weapon proficiency, but attack rolls do not add Proficiency Bonus (D&D 2024).`);
  }
  if (shields.length && weapons.some(i => (i.system?.properties || []).includes("two")))
    throw new Error("A two-handed weapon and a shield cannot be equipped together.");
  if (weapons.length > 1)
    warnings.push("Multiple weapons are marked equipped; check how many hands are used when actually attacking.");
}

export function planActorEdits(actor, { equipment = {}, prepared_spells = {} } = {}) {
  const classes = (actor.items || []).filter(i => i.type === "class");
  if (actor.type !== "character" || classes.length !== 1 || classes[0].system?.source?.rules !== "2024")
    throw new Error("edit_actor requires an existing single-class D&D 2024 character.");
  if (!plain(equipment) || !plain(prepared_spells))
    throw new Error("equipment and prepared_spells must be objects mapping owned item IDs to booleans.");
  const cls = classes[0];
  const byId = new Map((actor.items || []).map(i => [i._id, i]));
  const updates = new Map(), gear = [], spells = [], warnings = [];
  const afterEquipment = new Map();
  for (const [id, flag] of Object.entries(equipment)) {
    if (typeof flag !== "boolean") throw new Error(`equipment.${id} must be a boolean.`);
    const item = byId.get(id);
    if (!item || !["equipment", "weapon"].includes(item.type))
      throw new Error(`equipment.${id}: unknown or non-equippable character item.`);
    afterEquipment.set(id, flag);
    if (!!item.system?.equipped !== flag) {
      updates.set(id, { _id: id, "system.equipped": flag });
      gear.push({ id, name: item.name, avant: !!item.system?.equipped, apres: flag });
    }
  }
  if (Object.keys(equipment).length) checkEquipment(actor, afterEquipment, warnings);

  const max = Object.keys(prepared_spells).length ? preparedMax(cls) : null;
  if (Object.keys(prepared_spells).length && max == null)
    throw new Error(`Cannot verify maximum prepared spells for ${cls.name}; edit refused.`);
  const slots = slotMax(actor);
  const unlocked = Math.max(0, Number(slots.pactLevel) || 0,
    ...Object.keys(slots).filter(k => /^spell\d$/.test(k)).map(k => Number(k.slice(5))));
  const afterSpells = new Map();
  for (const [id, flag] of Object.entries(prepared_spells)) {
    if (typeof flag !== "boolean") throw new Error(`prepared_spells.${id} must be a boolean.`);
    const item = byId.get(id);
    if (!item || item.type !== "spell" || Number(item.system?.level) < 1 ||
      item.system?.sourceClass !== cls.system?.identifier || item.system?.source?.rules !== "2024" ||
      Number(item.system?.prepared) === 2)
      throw new Error(`prepared_spells.${id}: not an editable owned 2024 class spell.`);
    if (flag && Number(item.system?.level) > unlocked)
      throw new Error(`${item.name}: spell level exceeds unlocked class spell slots (${unlocked}).`);
    const desired = flag ? 1 : 0;
    afterSpells.set(id, desired);
    if (Number(item.system?.prepared) !== desired) {
      updates.set(id, { _id: id, "system.prepared": desired });
      spells.push({ id, name: item.name, avant: Number(item.system?.prepared) || 0, apres: desired });
    }
  }
  const count = (actor.items || []).filter(i => i.type === "spell" && i.system?.sourceClass === cls.system?.identifier &&
    (afterSpells.get(i._id) ?? Number(i.system?.prepared)) === 1).length;
  if (max != null && count > max)
    throw new Error(`Too many prepared class spells: ${count} > ${max}. Unprepare others in the same request.`);
  return { simulation: true, pret: true, acteur: { id: actor._id, name: actor.name },
    changements: { equipement: gear, sorts_prepares: spells },
    ...(max != null ? { preparation: { utilises: count, maximum: max } } : {}),
    modifications: [...updates.values()],
    avertissements: warnings,
    rappel: "Preview is read-only. Set apply=true to commit these item states with a recovery snapshot." };
}
