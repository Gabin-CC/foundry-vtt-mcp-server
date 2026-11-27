/** Read-only, source-aware D&D 2024 character audit. This is not full rules certification. */
import { fetchUuid, spellLists } from "./advancement.mjs";
import { slotMax } from "./dnd5e.mjs";
import { PRIMARY } from "./actor-multiclass.mjs";
import { scaleBonus } from "./spells.mjs";

const UUID = /^Compendium\.[^.]+\.[^.]+\.Item\.[A-Za-z0-9]{16}$/;
const attr = (actor, key) => Number(actor.system?.abilities?.[key]?.value);
const sourceUuid = item => item._stats?.compendiumSource || item.flags?.dnd5e?.sourceId || item.flags?.core?.sourceId;
const advancementList = item => Array.isArray(item.system?.advancement)
  ? item.system.advancement : Object.values(item.system?.advancement || {});

function scaleAt(cls, identifier, level) {
  const adv = advancementList(cls).find(a => a.type === "ScaleValue" && a.configuration?.identifier === identifier);
  if (!adv) return null;
  let value = null;
  for (const [n, entry] of Object.entries(adv.configuration?.scale || {}).sort((a, b) => Number(a[0]) - Number(b[0])))
    if (Number(n) <= level) value = Number(entry?.value ?? entry?.number);
  return Number.isFinite(value) ? value : null;
}

function equipmentKind(item) {
  const kind = item.system?.type?.value;
  if (["light", "lgt"].includes(kind)) return "lgt";
  if (["medium", "med"].includes(kind)) return "med";
  if (["heavy", "hvy"].includes(kind)) return "hvy";
  if (["shield", "shl"].includes(kind)) return "shl";
  return null;
}

const maxSpellLevel = (cls, sub) => {
  const slots = slotMax({ items: sub ? [cls, sub] : [cls], system: { spells: {} } });
  return Math.max(0, Number(slots.pactLevel) || 0,
    ...Object.keys(slots).filter(k => /^spell[1-9]$/.test(k)).map(k => Number(k.slice(5))));
};

export async function validateActor2024(fs, actor) {
  const diagnostics = [];
  const check = (severity, code, detail, subject = null, references = []) => {
    diagnostics.push({ severity, code, detail, ...(subject ? { subject } : {}),
      ...(references.length ? { references } : {}) });
  };
  const items = actor.items || [];
  const classes = items.filter(i => i.type === "class");
  const subclasses = items.filter(i => i.type === "subclass");
  const spells = items.filter(i => i.type === "spell");
  const sum = classes.reduce((n, c) => n + (Number(c.system?.levels) || 0), 0);
  if (actor.type !== "character") check("error", "not_character", "This document is not a character.");
  if (!classes.length) check("unverified", "no_class", "No embedded class was found; class rules cannot be audited.");
  if (sum > 20) check("error", "level_above_20", `Total class level ${sum} exceeds 20.`);
  if (classes.some(c => !Number.isInteger(Number(c.system?.levels)) || Number(c.system.levels) < 1))
    check("error", "invalid_class_level", "Every embedded class needs a positive integer level.");
  const ids = classes.map(c => String(c.system?.identifier || "").toLowerCase());
  if (new Set(ids).size !== ids.length) check("error", "duplicate_class", "Multiple embedded classes share an identifier.");
  if (classes.some(c => c.system?.source?.rules !== "2024"))
    check("unverified", "unsupported_edition", "Not every class declares 2024 rules; 2024-only validation is incomplete.");

  if (classes.length > 1) {
    for (const c of classes) {
      const id = String(c.system?.identifier || "").toLowerCase();
      if (!PRIMARY[id]) {
        check("unverified", "unknown_multiclass_prerequisite", `${c.name}: no verified PHB 2024 multiclass prerequisite is available.`, c._id);
        continue;
      }
      for (const group of PRIMARY[id]) {
        if (!group.some(a => Number.isFinite(attr(actor, a)) && attr(actor, a) >= 13))
          check("warning", "multiclass_score_now_below_13",
            `${c.name}: current ${group.join(" or ").toUpperCase()} score is below 13. The score at multiclass entry is not recorded, so legality cannot be concluded.`, c._id);
      }
    }
  }

  for (const sub of subclasses) {
    const id = String(sub.system?.classIdentifier || "").toLowerCase();
    if (!id || !ids.includes(id))
      check("unverified", "unlinked_subclass", `${sub.name}: subclass has no verifiable matching classIdentifier.`, sub._id);
  }

  const rulesSources = { classes: [], spells: [] };
  let officialLists = null;
  try { officialLists = await spellLists(fs); }
  catch { check("unverified", "spell_lists_unavailable", "Official class spell lists could not be read from installed compendiums."); }
  for (const cls of classes) {
    const id = String(cls.system?.identifier || "").toLowerCase();
    if (cls.system?.source?.rules !== "2024") continue;
    const classSource = sourceUuid(cls);
    let officialClass = null;
    if (!UUID.test(classSource || "")) {
      check("unverified", "class_source_missing", `${cls.name}: exact official class compendium UUID is unavailable.`, cls._id);
    } else {
      try {
        const doc = await fetchUuid(fs, classSource);
        if (doc.type !== "class" || String(doc.system?.identifier || "").toLowerCase() !== id || doc.system?.source?.rules !== "2024")
          check("error", "class_source_mismatch", `${cls.name}: recorded class source disagrees with its identifier or rules edition.`, cls._id, [classSource]);
        else { officialClass = doc; rulesSources.classes.push(classSource); }
      } catch {
        check("unverified", "class_source_unavailable", `${cls.name}: recorded source cannot be read from installed compendiums.`, cls._id, [classSource]);
      }
    }

    const owned = spells.filter(s => s.system?.sourceClass === id);
    const level = Number(cls.system?.levels);
    const sub = subclasses.find(s => s.system?.classIdentifier === id);
    const progression = cls.system?.spellcasting?.progression || sub?.system?.spellcasting?.progression || "none";
    if (progression === "none") continue;
    if (!officialClass) {
      check("unverified", "spell_progression_unavailable", `${cls.name}: prepared/cantrip limits cannot be checked without the official class source.`, cls._id);
      continue;
    }
    const preparedScale = scaleAt(officialClass, "max-prepared", level);
    const cantripScale = scaleAt(officialClass, "cantrips-known", level);
    const allowed = officialLists?.get(`class:${id}`);
    // Only official class-list spells can *prove* a class-preparation violation.
    // Subclass/feat spells can be prepared in addition to the class limit.
    const ordinary = owned.filter(s => allowed?.has(sourceUuid(s)) && Number(s.system?.prepared) !== 2);
    const prepared = ordinary.filter(s => Number(s.system?.level) >= 1 && Number(s.system?.prepared) === 1);
    const cantrips = ordinary.filter(s => Number(s.system?.level) === 0);
    if (preparedScale == null)
      check("unverified", "prepared_scale_unavailable", `${cls.name}: official max-prepared scale is unavailable.`, cls._id, [classSource]);
    else {
      const limit = preparedScale + scaleBonus(actor, id, "max-prepared");
      if (prepared.length > limit)
        check("error", "too_many_prepared", `${cls.name}: ${prepared.length} selected class spells exceed the verified limit of ${limit}.`, cls._id, [classSource]);
    }
    if (cantripScale == null)
      check("unverified", "cantrip_scale_unavailable", `${cls.name}: official cantrip scale is unavailable.`, cls._id, [classSource]);
    else {
      const limit = cantripScale + scaleBonus(actor, id, "cantrips-known");
      if (cantrips.length > limit)
        check("error", "too_many_cantrips", `${cls.name}: ${cantrips.length} class cantrips exceed the verified limit of ${limit}.`, cls._id, [classSource]);
    }
    if (!allowed?.size)
      check("unverified", "class_spell_list_missing", `${cls.name}: no installed official class spell list was found.`, cls._id);
    const highest = maxSpellLevel({ ...cls, system: { ...cls.system, spellcasting: officialClass.system?.spellcasting || cls.system.spellcasting } }, sub);
    for (const spell of owned) {
      const lvl = Number(spell.system?.level);
      const src = sourceUuid(spell);
      if (Number(spell.system?.prepared) !== 2 && progression !== "third" && lvl >= 1 && lvl > highest) {
        if (allowed?.has(src))
          check("error", "spell_above_class_level",
            `${cls.name}: ${spell.name} (spell level ${lvl}) is beyond this class's unlocked spell level ${highest}, irrespective of shared multiclass slots.`, spell._id, [classSource, src]);
        else check("unverified", "unattributed_high_level_spell",
          `${cls.name}: ${spell.name} exceeds this class's ordinary spell level, but its origin might be a subclass or other feature.`, spell._id);
      }
      if (Number(spell.system?.prepared) === 2) continue; // Always-granted spells are a separate feature check.
      if (!UUID.test(src || ""))
        check("unverified", "spell_source_missing", `${spell.name}: class spell has no verifiable compendium UUID.`, spell._id);
      else if (!allowed?.has(src))
        check("unverified", "spell_class_list_unconfirmed",
          `${spell.name}: its exact source is absent from the installed official ${cls.name} class spell list; a subclass, older book or variant could explain this.`, spell._id, [src]);
      else rulesSources.spells.push(src);
    }
    if (id === "wizard")
      check("unverified", "wizard_spellbook_provenance",
        "Wizard spellbook entries may also be copied from other sources. Current items do not prove when or how every spell entered the book; there is no fixed spellbook maximum.", cls._id);
    if (progression === "third")
      check("unverified", "third_caster_features",
        `${cls.name}: subclass-based spell choices and progression need separate rules verification.`, cls._id);
  }

  for (const spell of spells.filter(s => s.system?.sourceClass && !ids.includes(String(s.system.sourceClass).toLowerCase())))
    check("unverified", "orphan_spell_class", `${spell.name}: sourceClass does not match any embedded class.`, spell._id);
  const worn = items.filter(i => ["weapon", "equipment"].includes(i.type) && i.system?.equipped);
  const armor = worn.filter(i => i.type === "equipment" && equipmentKind(i) && equipmentKind(i) !== "shl");
  const shields = worn.filter(i => i.type === "equipment" && equipmentKind(i) === "shl");
  if (armor.length > 1) check("error", "multiple_armors", "More than one suit of armor is marked equipped.", armor.map(i => i._id).join(","));
  if (shields.length > 1) check("error", "multiple_shields", "More than one shield is marked equipped.", shields.map(i => i._id).join(","));
  const proficiencies = actor.system?.traits?.armorProf?.value;
  if (!Array.isArray(proficiencies) && [...armor, ...shields].length)
    check("unverified", "armor_training_unknown", "Armor/shield training is absent from actor data; proficiency cannot be audited.");
  else {
    const armorProf = new Set(proficiencies || []);
    for (const item of [...armor, ...shields]) if (!armorProf.has(equipmentKind(item)))
      check("warning", "armor_without_training", `${item.name}: equipped without matching armor/shield training; apply the appropriate D&D 2024 consequences.`, item._id);
  }
  if (shields.length && worn.some(i => i.type === "weapon" && (i.system?.properties || []).includes("two")))
    check("warning", "two_handed_with_shield", "A shield and a two-handed weapon are marked equipped; check what is actually being wielded.");

  const counts = { errors: 0, warnings: 0, unverified: 0 };
  for (const d of diagnostics) counts[d.severity === "error" ? "errors" : d.severity === "warning" ? "warnings" : "unverified"]++;
  return {
    actor: { id: actor._id, name: actor.name, class_levels: classes.map(c => ({ id: c._id, name: c.name,
      identifier: c.system?.identifier, level: c.system?.levels })), total_level: sum },
    read_only: true,
    status: counts.errors ? "issues" : counts.unverified ? "incomplete" : counts.warnings ? "review" : "passed_scoped_checks",
    summary: counts,
    expected_spell_slots: slotMax(actor),
    verified_sources: { classes: [...new Set(rulesSources.classes)], spells: [...new Set(rulesSources.spells)] },
    diagnostics,
    limits: ["This reports only deterministic checks supported by installed sources, not full D&D 2024 legality.",
      "Advancement decisions, feat choices, hit point rolls, historical ability scores and subclass exceptions require separate evidence.",
      "Wizard spellbook copies, always-prepared feature spells and unusual magic items require case-by-case review."],
  };
}
