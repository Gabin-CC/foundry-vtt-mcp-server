/** Read-only, source-aware D&D 2024 character audit. This is not full rules certification. */
import { fetchUuid, spellLists } from "./advancement.mjs";
import { slotMax } from "./dnd5e.mjs";
import { PRIMARY } from "./actor-multiclass.mjs";
import { scaleBonus } from "./spells.mjs";
import { verifySubclass, subclassAlwaysPrepared, THIRD_CASTER_WIZARD_LIST } from "./subclass-spells.mjs";
import { auditRecordedAdvancements } from "./advancement-audit.mjs";

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

  const rulesSources = { classes: [], subclasses: [], species: [], backgrounds: [],
    spells: [], subclass_spells: [], feats: [] };
  const verifiedSubclasses = new Map();
  const verifiedAdvancements = [];
  for (const origin of items.filter(i => ["race", "background"].includes(i.type))) {
    const uuid = sourceUuid(origin);
    const pack = /^Compendium\.([^.]+\.[^.]+)\.Item\./.exec(uuid || "")?.[1];
    if (!UUID.test(uuid || "") || !(pack === "dnd5e.origins24" || pack?.startsWith("dnd-players-handbook."))) {
      check("unverified", "origin_source_unverified", `${origin.name}: no exact official 2024 species/background source is available.`, origin._id);
      continue;
    }
    try {
      const official = await fetchUuid(fs, uuid);
      if (official.__pack !== pack) {
        check("unverified", "origin_source_unavailable", `${origin.name}: its source was resolved through a different compendium, not the recorded one.`, origin._id, [uuid]);
      } else if (official.type !== origin.type || official.system?.source?.rules !== "2024" ||
          (origin.system?.source?.rules && origin.system.source.rules !== "2024") ||
          (official.system?.identifier && origin.system?.identifier &&
            String(official.system.identifier).toLowerCase() !== String(origin.system.identifier).toLowerCase())) {
        check("error", "origin_source_mismatch", `${origin.name}: recorded species/background contradicts its official 2024 source.`, origin._id, [uuid]);
      } else {
        rulesSources[origin.type === "race" ? "species" : "backgrounds"].push(uuid);
        verifiedAdvancements.push({ embedded: origin, official, level: sum, uuid });
      }
    } catch {
      check("unverified", "origin_source_unavailable", `${origin.name}: the exact official 2024 source cannot be loaded.`, origin._id, [uuid]);
    }
  }
  for (const sub of subclasses) {
    const id = String(sub.system?.classIdentifier || "").toLowerCase();
    if (!id || !ids.includes(id)) {
      check("unverified", "unlinked_subclass", `${sub.name}: subclass has no verifiable matching classIdentifier.`, sub._id);
      continue;
    }
    const cls = classes.find(c => String(c.system?.identifier || "").toLowerCase() === id);
    const evidence = await verifySubclass(fs, sub, cls);
    if (!evidence.doc) {
      check(evidence.mismatch ? "error" : "unverified",
        evidence.mismatch ? "subclass_source_mismatch" : "subclass_source_unverified",
        `${sub.name}: ${evidence.reason}`, sub._id, evidence.source ? [evidence.source] : []);
      continue;
    }
    verifiedSubclasses.set(id, evidence);
    rulesSources.subclasses.push(evidence.source);
    verifiedAdvancements.push({ embedded: sub, official: evidence.doc,
      level: Number(cls.system?.levels) || 0, uuid: evidence.source });
    const grants = await subclassAlwaysPrepared(fs, evidence.doc, Number(cls.system?.levels) || 0);
    for (const reason of grants.unresolved)
      check("unverified", "subclass_grant_unverified", `${sub.name}: ${reason}`, sub._id, [evidence.source]);
    for (const [uuid] of grants.expected) {
      const owned = spells.filter(s => sourceUuid(s) === uuid);
      if (!owned.length)
        check("warning", "missing_subclass_spell", `${sub.name}: a mandatory always-prepared spell is missing from this character.`, sub._id, [evidence.source, uuid]);
      else if (!owned.some(s => Number(s.system?.prepared) === 2))
        check("warning", "subclass_spell_not_always_prepared", `${sub.name}: an official always-prepared spell is present but its preparation state is not permanent.`, owned[0]._id, [evidence.source, uuid]);
      else rulesSources.subclass_spells.push(uuid);
    }
  }

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
        else { officialClass = doc; rulesSources.classes.push(classSource);
          verifiedAdvancements.push({ embedded: cls, official: doc,
            level: Number(cls.system?.levels) || 0, uuid: classSource }); }
      } catch {
        check("unverified", "class_source_unavailable", `${cls.name}: recorded source cannot be read from installed compendiums.`, cls._id, [classSource]);
      }
    }

    const owned = spells.filter(s => s.system?.sourceClass === id);
    const level = Number(cls.system?.levels);
    const sub = subclasses.find(s => s.system?.classIdentifier === id);
    const classProgression = cls.system?.spellcasting?.progression || "none";
    const progression = classProgression !== "none" ? classProgression : sub?.system?.spellcasting?.progression || "none";
    if (progression === "none") continue;
    if (!officialClass) {
      check("unverified", "spell_progression_unavailable", `${cls.name}: prepared/cantrip limits cannot be checked without the official class source.`, cls._id);
      continue;
    }
    const verifiedSub = verifiedSubclasses.get(id)?.doc;
    const thirdCaster = progression === "third" && verifiedSub?.system?.spellcasting?.progression === "third" &&
      THIRD_CASTER_WIZARD_LIST[id] === verifiedSub?.system?.identifier;
    if (progression === "third" && !thirdCaster) {
      check("unverified", "third_caster_features",
        `${cls.name}: the 2024 subclass spell progression and eligible spell list lack exact official evidence.`, cls._id);
      continue;
    }
    const casterSource = thirdCaster ? verifiedSub : officialClass;
    const preparedScale = scaleAt(casterSource, "max-prepared", level);
    const cantripScale = scaleAt(casterSource, "cantrips-known", level);
    const listClass = thirdCaster ? "wizard" : id;
    const allowed = officialLists?.get(`class:${listClass}`);
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
        check("unverified", "class_spell_list_missing", `${cls.name}: no installed official ${listClass} spell list was found.`, cls._id);
    const highest = maxSpellLevel({ ...cls, system: { ...cls.system, spellcasting: officialClass.system?.spellcasting || cls.system.spellcasting } }, thirdCaster ? verifiedSub : sub);
    for (const spell of owned) {
      const lvl = Number(spell.system?.level);
      const src = sourceUuid(spell);
      if (Number(spell.system?.prepared) !== 2 && lvl >= 1 && lvl > highest) {
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
          `${spell.name}: its exact source is absent from the installed official ${listClass} spell list; a subclass, older book or variant could explain this.`, spell._id, [src]);
      else rulesSources.spells.push(src);
    }
    if (id === "wizard")
      check("unverified", "wizard_spellbook_provenance",
        "Wizard spellbook entries may also be copied from other sources. Current items do not prove when or how every spell entered the book; there is no fixed spellbook maximum.", cls._id);
    if (thirdCaster && cantripScale == null)
      check("unverified", "third_caster_cantrips_unknown",
        `${cls.name}: official subclass does not expose a verifiable cantrip progression.`, cls._id);
  }

  for (const spell of spells.filter(s => s.system?.sourceClass && !ids.includes(String(s.system.sourceClass).toLowerCase())))
    check("unverified", "orphan_spell_class", `${spell.name}: sourceClass does not match any embedded class.`, spell._id);
  rulesSources.feats.push(...await auditRecordedAdvancements(fs, actor, verifiedAdvancements, check));
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
    verified_sources: Object.fromEntries(Object.entries(rulesSources)
      .map(([kind, sources]) => [kind, [...new Set(sources)]])),
    diagnostics,
    limits: ["This reports only deterministic checks supported by installed sources, not full D&D 2024 legality.",
      "Recorded class, subclass, species and background choices are checked only against exact official advancements; historical ability scores, custom feats and HP rolls remain unverifiable.",
      "Unknown subclass sources, unverified feature grants, spell replacements and unusual magic items require case-by-case review."],
  };
}
