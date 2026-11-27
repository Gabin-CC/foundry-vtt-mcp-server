/** Strict D&D 2024 multiclass eligibility and one-level-at-a-time planning. */

// A group is OR (Fighter); separate groups would be AND. All other classes
// have one AND group. Use official identifiers, never translated display names.
export const PRIMARY = Object.freeze({
  barbarian: [["str"]], bard: [["cha"]], cleric: [["wis"]], druid: [["wis"]],
  fighter: [["str", "dex"]], monk: [["dex"], ["wis"]],
  paladin: [["str"], ["cha"]], ranger: [["dex"], ["wis"]],
  rogue: [["dex"]], sorcerer: [["cha"]], warlock: [["cha"]], wizard: [["int"]]
});

const numberOf = c => Number(c.system?.levels);
const identifierOf = c => String(c.system?.identifier || "").toLowerCase();

export function planMulticlass(actor, { incoming, existingItem, level }) {
  if (actor.type !== "character") throw new Error("Multiclassing requires an existing character.");
  const classes = (actor.items || []).filter(i => i.type === "class");
  if (!classes.length) throw new Error("Create the character's first class with build_actor or advance.");
  if (classes.some(c => c.system?.source?.rules !== "2024") || incoming.system?.source?.rules !== "2024")
    throw new Error("Multiclassing requires verifiable D&D 2024 class sources for every class.");
  const ids = classes.map(identifierOf);
  if ([...ids, identifierOf(incoming)].some(id => !Object.hasOwn(PRIMARY, id)))
    throw new Error("An unknown class identifier prevents verified D&D 2024 multiclassing.");
  if (new Set(ids).size !== ids.length)
    throw new Error("Duplicate existing class identifiers; inspect the actor before progressing.");
  if (classes.some(c => !Number.isInteger(numberOf(c)) || numberOf(c) < 1))
    throw new Error("An existing class has an invalid level.");
  const total = classes.reduce((sum, c) => sum + numberOf(c), 0);
  if (total > 20) throw new Error("Existing character level exceeds the level 20 limit.");
  const isNew = !existingItem;
  if (isNew && ids.includes(identifierOf(incoming)))
    throw new Error("That class already exists on the character; supply its embedded item ID instead.");
  if (!isNew && (!classes.some(c => c._id === existingItem) || classes.length < 2))
    throw new Error("Use progress_actor for a single class; multiclass level-up requires an existing secondary class ID.");
  const previous = isNew ? 0 : numberOf(incoming);
  const next = level ?? previous + 1;
  if (!Number.isInteger(next) || next !== previous + 1 || next > 20 || total + 1 > 20)
    throw new Error(`Multiclassing advances one class level at a time and total character level must not exceed 20 (requested ${next}).`);

  // These requirements apply when *entering* multiclassing, even to the first
  // class. A level-up of an already-owned class need not re-check ability scores.
  const requirements = [];
  if (isNew) {
    for (const cls of [...classes, incoming]) {
      const id = identifierOf(cls);
      for (const alternatives of PRIMARY[id]) {
        const satisfied = alternatives.some(key => {
          const score = Number(actor.system?.abilities?.[key]?.value);
          return Number.isFinite(score) && score >= 13;
        });
        requirements.push({ classe: id, caracteristiques: alternatives, minimum: 13, satisfait: satisfied });
      }
    }
    if (requirements.some(r => !r.satisfait))
      throw new Error(`Multiclass ability prerequisites not met: ${requirements.filter(r => !r.satisfait)
        .map(r => `${r.classe} (${r.caracteristiques.join(" or ")} >= 13)`).join(", ")}.`);
  }
  return { isNew, oldLevel: previous, newLevel: next, totalBefore: total, totalAfter: total + 1,
    requirements, existingClasses: classes.map(c => ({ id: c._id, identifier: identifierOf(c), level: numberOf(c) })) };
}
