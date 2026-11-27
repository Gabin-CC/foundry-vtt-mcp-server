/** Read-only, source-aware D&D 2024 character audit. This is not full rules certification. */
import { fetchUuid, spellLists } from "./advancement.mjs";
import { slotMax } from "./dnd5e.mjs";
import { PRIMARY } from "./actor-multiclass.mjs";
import { scaleBonus } from "./spells.mjs";
import { verifySubclass, subclassAlwaysPrepared, classAlwaysPrepared, isOfficial2024ClassUuid, THIRD_CASTER_WIZARD_LIST } from "./subclass-spells.mjs";
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
    spells: [], subclass_spells: [], class_granted_spells: [], feats: [] };
  const verifiedSubclasses = new Map();
  const verifiedSpellcasting = new Map();
  const declaredAlwaysPrepared = new Set();
  const scopedAlwaysPrepared = new Map();
  const incompleteGrantTraces = new Set();
  const verifiedClassGrantRoots = new Set();
  const recordGrantEvidence = (classId, grants) => {
    const sources = scopedAlwaysPrepared.get(classId) || new Set();
    for (const uuid of grants.declared) { declaredAlwaysPrepared.add(uuid); sources.add(uuid); }
    for (const [uuid] of grants.expected) sources.add(uuid);
    scopedAlwaysPrepared.set(classId, sources);
    if (grants.unresolved.length) incompleteGrantTraces.add(classId);
  };
  const verifiedAdvancements = [];
  // Load each *exact* installed spell pack index at most once. Foundry's Item
  // index exposes official spell levels without fetching hundreds of full
  // documents or allowing fetchUuid's same-ID cross-pack fallback.
  const spellIndexes = new Map();
  let installedItemPacks = null;
  async function officialSpellEntry(uuid) {
    const parsed = /^Compendium\.([^.]+\.[^.]+)\.Item\.([A-Za-z0-9]{16})$/.exec(uuid || "");
    if (!parsed) return { status: "invalid" };
    const [, pack, itemId] = parsed;
    if (!installedItemPacks) {
      try { installedItemPacks = new Set(((await fs.worldData()).packs || [])
        .filter(p => p.type === "Item").map(p => p.id)); }
      catch { return { status: "unavailable" }; }
    }
    if (!installedItemPacks.has(pack)) return { status: "unavailable" };
    if (!spellIndexes.has(pack)) {
      try {
        const docs = await fs.doc("get", "Item", { pack, query: {}, index: true,
          indexFields: ["_id", "type", "system.level", "system.source.rules"] });
        spellIndexes.set(pack, Array.isArray(docs) ? new Map(docs.map(doc => [doc._id, doc])) : null);
      } catch { spellIndexes.set(pack, null); }
    }
    const index = spellIndexes.get(pack);
    if (!index) return { status: "unavailable" };
    const entry = index.get(itemId);
    return entry ? { status: "ok", entry } : { status: "missing" };
  }
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
    // The owned subclass can carry stale spellcasting fields. Once its exact
    // official source is verified, a contradictory progression is provable.
    const officialProgression = evidence.doc.system?.spellcasting?.progression;
    if (typeof officialProgression === "string") verifiedSpellcasting.set(sub._id, officialProgression);
    if (typeof officialProgression === "string" &&
        (sub.system?.spellcasting?.progression || "none") !== officialProgression)
      check("error", "subclass_spellcasting_progression_mismatch",
        `${sub.name}: its recorded spellcasting progression differs from the exact official 2024 subclass source.`, sub._id, [evidence.source]);
    const grants = await subclassAlwaysPrepared(fs, evidence.doc, Number(cls.system?.levels) || 0);
    recordGrantEvidence(id, grants);
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
    const classPack = /^Compendium\.([^.]+\.[^.]+)\.Item\./.exec(classSource || "")?.[1];
    let officialClass = null;
    if (!UUID.test(classSource || "")) {
      check("unverified", "class_source_missing", `${cls.name}: exact official class compendium UUID is unavailable.`, cls._id);
    } else if (!isOfficial2024ClassUuid(classSource)) {
      check("unverified", "class_source_unverified", `${cls.name}: its class source is not an official 2024 class compendium.`, cls._id, [classSource]);
    } else {
      try {
        const doc = await fetchUuid(fs, classSource);
        if (doc.__pack !== classPack)
          check("unverified", "class_source_unavailable", `${cls.name}: the exact recorded official class pack could not be read; a different compendium matched its item ID.`, cls._id, [classSource]);
        else if (doc.type !== "class" || String(doc.system?.identifier || "").toLowerCase() !== id || doc.system?.source?.rules !== "2024")
          check("error", "class_source_mismatch", `${cls.name}: recorded class source disagrees with its identifier or rules edition.`, cls._id, [classSource]);
        else { officialClass = doc; rulesSources.classes.push(classSource);
          if (typeof doc.system?.spellcasting?.progression === "string")
            verifiedSpellcasting.set(cls._id, doc.system.spellcasting.progression);
          verifiedAdvancements.push({ embedded: cls, official: doc,
            level: Number(cls.system?.levels) || 0, uuid: classSource }); }
      } catch {
        check("unverified", "class_source_unavailable", `${cls.name}: recorded source cannot be read from installed compendiums.`, cls._id, [classSource]);
      }
    }

    // Saved spell sourceClass strings are not guaranteed to retain casing.
    // Normalize them just like orphan detection, or class spells can vanish
    // from every preparation/cantrip audit without being reported as orphaned.
    const owned = spells.filter(s => String(s.system?.sourceClass || "").trim().toLowerCase() === id);
    const level = Number(cls.system?.levels);
    if (officialClass) {
      verifiedClassGrantRoots.add(id);
      const grants = await classAlwaysPrepared(fs, officialClass, level);
      recordGrantEvidence(id, grants);
      for (const reason of grants.unresolved)
        check("unverified", "class_grant_unverified", `${cls.name}: ${reason}`, cls._id, [classSource]);
      for (const [uuid] of grants.expected) {
        const granted = spells.filter(spell => sourceUuid(spell) === uuid);
        if (!granted.length)
          check("warning", "missing_class_granted_spell", `${cls.name}: a mandatory always-prepared class-granted spell is absent.`, cls._id, [classSource, uuid]);
        else if (!granted.some(spell => Number(spell.system?.prepared) === 2))
          check("warning", "class_granted_spell_not_always_prepared", `${cls.name}: a mandatory class-granted spell lacks permanent preparation.`, granted[0]._id, [classSource, uuid]);
        else rulesSources.class_granted_spells.push(uuid);
      }
    }
    const sub = subclasses.find(s => s.system?.classIdentifier === id);
    const verifiedSub = verifiedSubclasses.get(id)?.doc;
    const officialProgression = officialClass?.system?.spellcasting?.progression;
    if (typeof officialProgression === "string" &&
        (cls.system?.spellcasting?.progression || "none") !== officialProgression)
      check("error", "class_spellcasting_progression_mismatch",
        `${cls.name}: its recorded spellcasting progression differs from the exact official 2024 class source.`, cls._id, [classSource]);
    // Base spell limits on verified rules sources, not potentially stale owned
    // class/subclass fields. Unknown source data remains explicitly scoped.
    const classProgression = officialProgression ?? cls.system?.spellcasting?.progression ?? "none";
    const subProgression = verifiedSub?.system?.spellcasting?.progression ?? sub?.system?.spellcasting?.progression ?? "none";
    const progression = classProgression !== "none" ? classProgression : subProgression;
    if (progression === "none") {
      // A feat or another feature can grant a spell to a noncaster. Do not
      // declare those spells illegal, but neither silently certify them as
      // ordinary class spells without a verified casting progression.
      const explained = new Set([...rulesSources.subclass_spells,
        ...rulesSources.class_granted_spells, ...declaredAlwaysPrepared]);
      const unexplained = owned.filter(s => Number(s.system?.prepared) !== 2 || !explained.has(sourceUuid(s)));
      if (unexplained.length)
        check("unverified", "noncaster_class_spell_origin",
          `${cls.name}: ${unexplained.length} spell(s) are attributed to a class without ordinary spellcasting; their feat or feature origin requires separate evidence.`, cls._id);
      continue;
    }
    if (!officialClass) {
      check("unverified", "spell_progression_unavailable", `${cls.name}: prepared/cantrip limits cannot be checked without the official class source.`, cls._id);
      continue;
    }
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
    // The verified 2024 Paladin has no *base class* cantrip progression.
    // Blessed Warrior and other feature-granted cantrips are separate grants.
    // Missing ScaleValue is expected when no ordinary class cantrips exist.
    if (cantripScale == null) {
      const noBaseCantrips = !thirdCaster && id === "paladin" &&
        classSource.startsWith("Compendium.dnd5e.classes24.Item.") && !cantrips.length;
      if (!noBaseCantrips)
        check("unverified", "cantrip_scale_unavailable", `${cls.name}: official cantrip scale is unavailable.`, cls._id, [classSource]);
    }
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
      if (Number(spell.system?.prepared) !== 2 && allowed?.has(src)) {
        const source = await officialSpellEntry(src);
        if (source.status !== "ok")
          check("unverified", "spell_source_index_unavailable",
            `${spell.name}: its exact official spell source cannot be checked in the installed compendium index.`, spell._id, [src]);
        else if (source.entry.type !== "spell")
          check("error", "spell_source_type_mismatch",
            `${spell.name}: the recorded official source is not a spell.`, spell._id, [src]);
        else if (source.entry.system?.source?.rules !== "2024" ||
            source.entry.system?.level == null || source.entry.system.level === "" ||
            !Number.isInteger(Number(source.entry.system?.level)) ||
            Number(source.entry.system?.level) < 0 || Number(source.entry.system?.level) > 9)
          check("unverified", "spell_source_level_unavailable",
            `${spell.name}: the official source index does not prove a 2024 spell level.`, spell._id, [src]);
        else if (spell.system?.level == null || spell.system.level === "" ||
            !Number.isInteger(lvl) || lvl !== Number(source.entry.system.level))
          check("error", "spell_level_source_mismatch",
            `${spell.name}: its recorded level ${String(spell.system?.level)} differs from the exact official 2024 spell level ${source.entry.system.level}.`, spell._id, [src]);
      }
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

  // Permanently prepared spells are exempt from ordinary class preparation
  // limits, but the saved preparation flag alone never proves a feature grant.
  // Only flag unknown grants once the class/subclass grant roots were traced
  // without gaps. Otherwise existing source/ItemGrant uncertainty covers them.
  for (const spell of spells.filter(s => Number(s.system?.prepared) === 2)) {
    const owner = String(spell.system?.sourceClass || "").trim().toLowerCase();
    if (!verifiedClassGrantRoots.has(owner) || incompleteGrantTraces.has(owner) ||
        subclasses.some(s => String(s.system?.classIdentifier || "").toLowerCase() === owner &&
          !verifiedSubclasses.has(owner))) continue;
    const source = sourceUuid(spell);
    if (scopedAlwaysPrepared.get(owner)?.has(source)) continue;
    check("unverified", "always_prepared_origin_unverified",
      `${spell.name}: permanently prepared for ${owner}, but no traced official class/subclass grant proves this state; a feat, item or other feature may explain it.`,
      spell._id, UUID.test(source || "") ? [source] : []);
  }

  for (const spell of spells.filter(s => {
    const recorded = String(s.system?.sourceClass || "").trim().toLowerCase();
    return recorded && !ids.includes(recorded);
  }))
    check("unverified", "orphan_spell_class", `${spell.name}: sourceClass does not match any embedded class.`, spell._id);
  // No sourceClass means none of the class spell limits above could inspect
  // this spell. Feat, species and equipment grants can legitimately lack a
  // class attribution, but they must not silently count as certified spells.
  // An exact, independently traced always-prepared subclass grant is enough
  // evidence to avoid repeating an unnecessary uncertainty.
  const provenSpells = new Set([...rulesSources.subclass_spells, ...rulesSources.class_granted_spells]);
  for (const spell of spells.filter(s => !String(s.system?.sourceClass || "").trim())) {
    if (Number(spell.system?.prepared) === 2 &&
        (provenSpells.has(sourceUuid(spell)) || declaredAlwaysPrepared.has(sourceUuid(spell)))) continue;
    const source = sourceUuid(spell);
    check("unverified", "unattributed_spell_origin",
      `${spell.name}: no class is recorded for this spell; a feat, feature or other grant may explain its origin.`,
      spell._id, UUID.test(source || "") ? [source] : []);
  }
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

  // The expected slot table must not inherit a contradictory progression from
  // an owned class or subclass once the exact official source was verified.
  const slotItems = items.map(item => verifiedSpellcasting.has(item._id) ? {
    ...item, system: { ...item.system,
      spellcasting: { ...item.system?.spellcasting, progression: verifiedSpellcasting.get(item._id) } }
  } : item);
  const slotActor = { ...actor, items: slotItems };
  const expectedSlots = slotMax(slotActor); // Legacy/current sheet maxima, including explicit overrides.
  const slotEvidenceComplete = classes.length > 0 && classes.every(c => verifiedSpellcasting.has(c._id)) &&
    subclasses.every(s => verifiedSubclasses.has(String(s.system?.classIdentifier || "").toLowerCase()));
  // An override must not redefine the *official rules baseline*. Keep both
  // values separately and treat unexplained deviations as unverified, since
  // magic items or campaign-specific effects may legitimately add slots.
  const baseSlots = slotEvidenceComplete ? slotMax({ ...slotActor, system: { ...actor.system,
    spells: Object.fromEntries(Object.entries(actor.system?.spells || {}).map(([key, value]) =>
      [key, value && typeof value === "object" ? { ...value, override: null } : value])) } }) : null;
  if (baseSlots) for (const key of [...Array.from({ length: 9 }, (_, i) => `spell${i + 1}`), "pact"]) {
    const slot = actor.system?.spells?.[key];
    const override = slot?.override;
    const baseline = Number(baseSlots[key]) || 0;
    const hasOverride = override != null && override !== "";
    const overrideMatchesBase = hasOverride && Number(override) === baseline;
    if (hasOverride && (!Number.isInteger(Number(override)) || Number(override) < 0 || Number(override) !== baseline))
      check("unverified", "spell_slot_override_unverified",
        `${key}: the recorded maximum override differs from the verified 2024 class table; a feature or campaign rule may explain it.`, actor._id);
    const remaining = slot?.value;
    if (remaining == null || remaining === "") continue;
    const n = Number(remaining);
    if (!Number.isInteger(n) || n < 0)
      check("error", "invalid_spell_slot_value", `${key}: remaining spell slots must be a nonnegative integer.`, actor._id);
    // A redundant override equal to the official maximum must not suppress
    // a resource-excess check. A differing override already has its own
    // unverified diagnostic, so do not duplicate that uncertainty here.
    else if (n > baseline && (!hasOverride || overrideMatchesBase))
      check("unverified", "spell_slots_above_official_base",
        `${key}: ${n} remaining slots exceed the verified class-table maximum ${baseline}; an extra grant or stale value needs review.`, actor._id);
  }
  const counts = { errors: 0, warnings: 0, unverified: 0 };
  for (const d of diagnostics) counts[d.severity === "error" ? "errors" : d.severity === "warning" ? "warnings" : "unverified"]++;
  return {
    actor: { id: actor._id, name: actor.name, class_levels: classes.map(c => ({ id: c._id, name: c.name,
      identifier: c.system?.identifier, level: c.system?.levels })), total_level: sum },
    read_only: true,
    status: counts.errors ? "issues" : counts.unverified ? "incomplete" : counts.warnings ? "review" : "passed_scoped_checks",
    summary: counts,
    expected_spell_slots: expectedSlots,
    official_base_spell_slots: baseSlots,
    verified_sources: Object.fromEntries(Object.entries(rulesSources)
      .map(([kind, sources]) => [kind, [...new Set(sources)]])),
    diagnostics,
    limits: ["This reports only deterministic checks supported by installed sources, not full D&D 2024 legality.",
      "Recorded class, subclass, species and background choices are checked only against exact official advancements; historical ability scores, custom feats and HP rolls remain unverifiable.",
      "Unknown subclass sources, unverified feature grants, spell replacements and unusual magic items require case-by-case review."],
  };
}
