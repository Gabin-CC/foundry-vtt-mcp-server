/** Read-only verification of recorded D&D 2024 advancement decisions. */
import { fetchUuid } from "./advancement.mjs";
import { isOfficial2024Uuid } from "./subclass-spells.mjs";

const UUID = /^Compendium\.[^.]+\.[^.]+\.Item\.[A-Za-z0-9]{16}$/;
const PACK = /^Compendium\.([^.]+\.[^.]+)\.Item\./;
const ABILITIES = new Set(["str", "dex", "con", "int", "wis", "cha"]);
const sourceUuid = item => item?._stats?.compendiumSource || item?.flags?.dnd5e?.sourceId || item?.flags?.core?.sourceId;
// Foundry stores some owned background/species advancements as keyed value-only
// overrides. Their keys, not the partial values, are the advancement IDs.
const list = item => Array.isArray(item?.system?.advancement)
  ? item.system.advancement : Object.entries(item?.system?.advancement || {})
    .map(([id, value]) => ({ ...value, _id: value?._id || id }));
const object = value => value && typeof value === "object" && !Array.isArray(value);
const entries = value => object(value) ? Object.entries(value) : [];

const recordedChoice = adv => {
  const value = adv.value || {};
  if (adv.type === "HitPoints") return Object.keys(value).some(key => Number(key) > 0);
  if (adv.type === "AbilityScoreImprovement") return value.type === "feat" ?
    entries(value.feat).some(([, uuid]) => !!uuid) :
    entries(value.assignments).some(([, n]) => Number(n) > 0);
  if (adv.type === "ItemGrant" || adv.type === "ItemChoice")
    return entries(value.added).some(([, v]) => typeof v === "string" || entries(v).length > 0);
  if (adv.type === "Subclass") return !!value.uuid;
  if (adv.type === "Trait") return Array.isArray(value.chosen) && value.chosen.length > 0;
  return !!value.size;
};

/** Verifies only advancement claims that can be proven from exact official source data. */
export async function auditRecordedAdvancements(fs, actor, sources, check) {
  const owned = actor.items || [];
  const byId = new Map(owned.map(i => [i._id, i]));
  const verifiedFeats = new Set();
  const classes = owned.filter(i => i.type === "class");
  const totalLevel = classes
    .reduce((n, i) => n + (Number(i.system?.levels) || 0), 0);
  const oneClass = classes.length === 1;
  const featFeatureGrants = new Map();
  const verifiedFeatureIdentifiers = new Map();
  for (const { embedded, official, level } of sources) {
    const recorded = new Map(list(embedded).filter(a => a?._id).map(a => [a._id, a]));
    for (const advancement of list(official)) {
      if (advancement.type !== "ItemGrant" || Number(advancement.level || 0) > level) continue;
      const at = Number(advancement.level || 0);
      for (const grant of advancement.configuration?.items || []) {
        if (grant.optional || !grant.uuid) continue;
        const additions = entries(recorded.get(advancement._id)?.value?.added);
        // Ownership alone cannot date a feature: the saved official grant must
        // point to the same embedded item and its exact source UUID.
        const matched = additions.filter(([id, uuid]) => uuid === grant.uuid &&
          byId.has(id) && sourceUuid(byId.get(id)) === grant.uuid);
        if (matched.length !== 1) continue;
        const origin = ["race", "background"].includes(embedded.type);
        const proof = { itemId: matched[0][0], at, lower: origin && at === 0 ? 1 : Math.max(1, at),
          exact: origin && at === 0 ? 1 : oneClass ? Math.max(1, at) : null };
        if (!featFeatureGrants.has(grant.uuid)) featFeatureGrants.set(grant.uuid, []);
        featFeatureGrants.get(grant.uuid).push(proof);
      }
    }
  }

  const acquisitionForStep = (root, at) => {
    const milestone = Number(at);
    if (root.type === "class" || root.type === "subclass")
      return { lower: Math.max(1, milestone), exact: oneClass ? Math.max(1, milestone) : null };
    if (["race", "background"].includes(root.type) && milestone === 0)
      return { lower: 1, exact: 1 };
    const proofs = featFeatureGrants.get(sourceUuid(root)) || [];
    if (root.type !== "feat" || proofs.length !== 1 || proofs[0].itemId !== root._id) return null;
    const parent = proofs[0];
    return milestone === 0 || milestone === parent.at ? parent : { lower: parent.lower, exact: null };
  };

  async function verifyFeatChoice(root, recordedId, uuid, src, restriction = null, acquisition = null) {
    const matching = owned.filter(item => item.type === "feat" && sourceUuid(item) === uuid);
    const direct = byId.get(recordedId);
    if ((direct && (direct.type !== "feat" || sourceUuid(direct) !== uuid)) || (!direct && matching.length))
      check("unverified", "stale_feat_item_id", `${root.name}: saved feat item ID no longer identifies the recorded feat.`, recordedId, [src]);
    if (!matching.length)
      check("unverified", "recorded_feat_missing", `${root.name}: the feat's recorded source is not present on the actor.`, root._id, [src, uuid]);
    if (!isOfficial2024Uuid(uuid)) {
      check("unverified", "feat_source_unverified", `${root.name}: feat source is not a verified official 2024 compendium.`, root._id);
      return;
    }
    let feat;
    try { feat = await fetchUuid(fs, uuid); }
    catch { check("unverified", "feat_source_unavailable", `${root.name}: the official feat source cannot be loaded.`, root._id, [uuid]); return; }
    if (feat.__pack !== PACK.exec(uuid)?.[1]) {
      check("unverified", "feat_source_pack_unverified", `${root.name}: feat was resolved from a different compendium than its recorded source.`, root._id, [uuid]);
      return;
    }
    if (feat.type !== "feat" || feat.system?.source?.rules !== "2024") {
      check("error", "feat_source_mismatch", `${root.name}: recorded feat source is not a 2024 feat.`, root._id, [uuid]);
      return;
    }
    if (restriction) {
      const kind = feat.system?.type || {};
      if ((restriction.type && kind.value !== restriction.type) ||
          (restriction.subtype && kind.subtype !== restriction.subtype)) {
        check("error", "feat_choice_restriction_mismatch", `${root.name}: the selected feat violates its official type or subtype restriction.`, recordedId, [src, uuid]);
        return;
      }
      if ((restriction.list || []).length || (restriction.school || []).length)
        check("unverified", "feat_choice_extra_restriction", `${root.name}: additional official choice restrictions require separate review.`, root._id, [src, uuid]);
    }
    verifiedFeats.add(uuid);
    const requiredLevel = feat.system?.prerequisites?.level;
    if (requiredLevel != null && requiredLevel !== "") {
      const minimum = Number(requiredLevel);
      if (!Number.isInteger(minimum) || minimum < 0)
        check("unverified", "feat_level_prerequisite_unreadable", `${feat.name}: level prerequisite is not numeric.`, root._id, [uuid]);
      else if (totalLevel < minimum)
        check("error", "feat_level_prerequisite_unmet", `${feat.name}: requires at least character level ${minimum}, but the actor is level ${totalLevel}.`, root._id, [uuid]);
      else if (acquisition?.exact != null && acquisition.exact < minimum)
        check("error", "feat_level_prerequisite_unmet_at_choice", `${feat.name}: its recorded acquisition at character level ${acquisition.exact} precedes the required level ${minimum}.`, root._id, [src, uuid]);
      else if (minimum > 0 && acquisition?.exact == null && (acquisition?.lower ?? 0) < minimum)
        check("unverified", "feat_level_at_choice_unverified", `${feat.name}: current level meets ${minimum}, but the historical character level at acquisition is not proven.`, root._id, [src, uuid]);
    }
    // Today's ability scores cannot establish scores when the feat was taken.
    const prereqs = feat.system?.prerequisites || {};
    // 2024 Fighting Style feats require the Fighting Style feature. This one
    // prerequisite can be proven by the *exact* source feature, its official
    // ItemChoice restriction, and a saved ItemGrant to the same owned item.
    const fightingStyleProven = root.type === "feat" && sourceUuid(root) === src &&
      verifiedFeatureIdentifiers.get(src) === "fighting-style" &&
      restriction?.type === "feat" && restriction.subtype === "fightingStyle" &&
      feat.system?.type?.subtype === "fightingStyle" &&
      (featFeatureGrants.get(src) || []).length === 1 && featFeatureGrants.get(src)[0].itemId === root._id;
    if (Object.entries(prereqs).some(([key, val]) => !["level", "repeatable"].includes(key) && val !== "" && val !== false && val != null &&
        !(key === "items" && Array.isArray(val) && fightingStyleProven && val.every(v => v === "fighting-style")) &&
        !(Array.isArray(val) && !val.length) && !(object(val) && !Object.keys(val).length)))
      check("unverified", "feat_historical_prerequisite", `${feat.name}: historical or conditional feat prerequisites cannot be certified from current attributes.`, root._id, [uuid]);
  }

  async function checkFeat(root, adv, src, milestone) {
    const pairs = entries(adv.value?.feat).filter(([, uuid]) => !!uuid);
    if (pairs.length !== 1 || !UUID.test(pairs[0]?.[1] || "")) {
      check("error", "invalid_recorded_feat", `${root.name}: feat advancement must record one exact source UUID.`, root._id, [src]);
      return;
    }
    await verifyFeatChoice(root, pairs[0][0], pairs[0][1], src, null, acquisitionForStep(root, milestone));
  }

  async function checkItemChoice(root, saved, official, level, src) {
    const config = official.configuration || {};
    if (config.type !== "feat") {
      check("unverified", "item_choice_type_unverified", `${root.name}: this official ItemChoice is not a feat selection.`, root._id, [src]);
      return;
    }
    const groups = entries(config.choices);
    if (!groups.length || groups.some(([at, rule]) => !/^\d+$/.test(at) ||
      !Number.isInteger(Number(rule?.count)) || Number(rule.count) < 0)) {
      check("unverified", "feat_choice_configuration_unreadable", `${root.name}: official feat choice counts cannot be read reliably.`, root._id, [src]);
      return;
    }
    const configured = new Map(groups);
    const added = saved.value?.added || {};
    if (entries(added).some(([at, value]) => !/^\d+$/.test(at) || !object(value))) {
      check("unverified", "feat_choice_record_format_unverified", `${root.name}: saved feat choices do not use the expected level-keyed format.`, root._id, [src]);
      return;
    }
    for (const [at, value] of entries(added)) if (!configured.has(at) && entries(value).length)
      check("unverified", "unknown_feat_choice_group", `${root.name}: a saved feat choice group is absent from the official source.`, root._id, [src]);
    const pool = (config.pool || []).map(v => v?.uuid).filter(Boolean);
    for (const [at, rule] of groups) {
      const pairs = entries(added[at]).filter(([, uuid]) => !!uuid);
      if (Number(at) > level) {
        if (pairs.length) check("error", "future_feat_choice_recorded", `${root.name}: a feat is selected at future level ${at}, beyond character level ${level}.`, root._id, [src]);
        continue;
      }
      if (pairs.length > Number(rule.count))
        check("error", "too_many_recorded_feat_choices", `${root.name}: saved feat choices exceed the ${rule.count} official options at level ${at}.`, root._id, [src]);
      else if (pairs.length < Number(rule.count))
        check("unverified", "incomplete_recorded_feat_choices", `${root.name}: not every feat choice at level ${at} is saved.`, root._id, [src]);
      for (const [recordedId, uuid] of pairs) {
        if (!UUID.test(uuid)) {
          check("error", "invalid_recorded_feat", `${root.name}: feat choice must record an exact compendium UUID.`, recordedId, [src]);
          continue;
        }
        // allowDrops means that the pool is a *recommendation*, not a whitelist.
        if (config.allowDrops === false && pool.length && !pool.includes(uuid)) {
          check("error", "feat_choice_not_in_pool", `${root.name}: selected feat is outside the closed official pool.`, recordedId, [src, uuid]);
          continue;
        }
        if (config.allowDrops === false && !pool.length)
          check("unverified", "feat_choice_pool_unavailable", `${root.name}: a closed feat choice has no verifiable official pool.`, root._id, [src]);
        await verifyFeatChoice(root, recordedId, uuid, src, config.restriction || {}, acquisitionForStep(root, at));
      }
    }
  }

  async function checkAdvancement(root, official, level, src) {
    const recorded = new Map(list(root).filter(a => a?._id).map(a => [a._id, a]));
    const source = new Map(list(official).filter(a => a?._id).map(a => [a._id, a]));

    for (const a of list(root)) if (a?._id && !source.has(a._id) &&
      (recordedChoice(a) || Object.keys(a.value || {}).some(key => key !== "type")))
      check("unverified", "unknown_recorded_advancement", `${root.name}: a recorded choice is absent from the installed official source revision.`, root._id, [src]);

    for (const a of source.values()) {
      const step = recorded.get(a._id);
      if (!step) {
        if (Number(a.level || 0) <= level && ["AbilityScoreImprovement", "Subclass", "ItemGrant"].includes(a.type))
          check("unverified", "advancement_record_missing", `${root.name}: an official ${a.type} advancement is absent from the embedded item.`, root._id, [src]);
        continue;
      }
      // A saved value-only override inherits its type and configuration from
      // this exact, already-verified official advancement.
      if (step.type && step.type !== a.type) {
        check("error", "advancement_type_mismatch", `${root.name}: recorded advancement type differs from the official source.`, root._id, [src]);
        continue;
      }
      const saved = { ...a, ...step, value: step.value || {} };
      const milestone = Number(a.level || 0);
      if (milestone > level) {
        if (recordedChoice(saved))
          check("error", "future_advancement_recorded", `${root.name}: a decision is recorded for level ${milestone}, above the current class level ${level}.`, root._id, [src]);
        continue;
      }
      if (a.type === "AbilityScoreImprovement") {
        const value = step.value || {};
        if (value.type === "feat") { await checkFeat(root, step, src, milestone); continue; }
        if (value.type !== "asi") {
          check("unverified", "asi_choice_missing", `${root.name}: no verifiable feat or ability-score decision is recorded for level ${milestone}.`, root._id, [src]);
          continue;
        }
        const assignments = entries(value.assignments);
        if (!assignments.length) {
          check("unverified", "asi_allocation_missing", `${root.name}: the ability-score allocation was not saved.`, root._id, [src]);
          continue;
        }
        // Some official advancements include fixed increases as well as
        // selectable points. Their stored assignments may combine both;
        // without the exact derived split, do not invent a points violation.
        if (entries(a.configuration?.fixed).some(([, n]) => Number(n) !== 0)) {
          check("unverified", "asi_fixed_allocation_unverified", `${root.name}: fixed and selected ability increases cannot be separated reliably from the saved allocation.`, root._id, [src]);
          continue;
        }
        const cap = Number(a.configuration?.cap ?? 2);
        const points = Number(a.configuration?.points ?? 2);
        const locked = new Set(a.configuration?.locked || []);
        let total = 0, invalid = false;
        for (const [ability, raw] of assignments) {
          const n = Number(raw);
          if (!ABILITIES.has(ability) || !Number.isInteger(n) || n < 0 || n > cap || (locked.has(ability) && n > 0)) invalid = true;
          total += Number.isFinite(n) ? n : 0;
        }
        if (invalid || total > points || !Number.isInteger(points) || points < 0)
          check("error", "invalid_asi_allocation", `${root.name}: recorded ability increases violate the official points, per-ability cap or locked abilities.`, root._id, [src]);
        else if (total < points)
          check("warning", "incomplete_asi_allocation", `${root.name}: only ${total} of ${points} available ability points are recorded.`, root._id, [src]);
      } else if (a.type === "Subclass") {
        const uuid = step.value?.uuid;
        if (!UUID.test(uuid || "")) {
          check("unverified", "subclass_choice_not_recorded", `${root.name}: the chosen subclass UUID was not saved in the official advancement.`, root._id, [src]);
          continue;
        }
        const sub = owned.filter(i => i.type === "subclass" && sourceUuid(i) === uuid &&
          i.system?.classIdentifier === root.system?.identifier);
        if (!sub.length)
          check("unverified", "recorded_subclass_missing", `${root.name}: the saved subclass UUID has no matching embedded subclass.`, root._id, [src, uuid]);
        else if (step.value?.document && !sub.some(i => i._id === step.value.document))
          check("unverified", "stale_subclass_item_id", `${root.name}: saved subclass item ID is stale although its UUID is present.`, root._id, [src, uuid]);
      } else if (a.type === "ItemGrant") {
        const configured = (a.configuration?.items || []).map(i => i.uuid).filter(Boolean);
        const additions = entries(step.value?.added).filter(([, uuid]) => typeof uuid === "string");
        for (const [, uuid] of additions) if (!configured.includes(uuid))
          check("error", "unexpected_recorded_grant", `${root.name}: a recorded grant UUID is not in the official advancement.`, root._id, [src]);
        for (const grant of a.configuration?.items || []) {
          if (grant.optional || !grant.uuid) continue;
          const found = owned.filter(item => sourceUuid(item) === grant.uuid);
          if (!found.length) {
            const savedIds = additions.filter(([, uuid]) => uuid === grant.uuid).map(([id]) => id);
            if (savedIds.some(id => byId.has(id) && !sourceUuid(byId.get(id))))
              check("unverified", "feature_provenance_missing", `${root.name}: granted item exists without verifiable provenance.`, root._id, [src, grant.uuid]);
            else check("warning", "mandatory_feature_missing", `${root.name}: mandatory feature for level ${milestone} is absent from the actor.`, root._id, [src, grant.uuid]);
          }
        }
      } else if (a.type === "ItemChoice") {
        await checkItemChoice(root, saved, a, level, src);
      } else if (a.type === "Size") {
        const chosen = saved.value?.size;
        if (!chosen)
          check("unverified", "origin_size_not_recorded", `${root.name}: the species size selection is not recorded.`, root._id, [src]);
        else if (Array.isArray(a.configuration?.sizes) && !a.configuration.sizes.includes(chosen))
          check("error", "invalid_origin_size", `${root.name}: recorded species size is not an official option.`, root._id, [src]);
      } else if (a.type === "Trait" && ["race", "background"].includes(root.type)) {
        const chosen = saved.value?.chosen;
        const grants = Array.isArray(a.configuration?.grants) ? a.configuration.grants : [];
        const choices = Array.isArray(a.configuration?.choices) ? a.configuration.choices : [];
        if (!Array.isArray(chosen)) {
          check("unverified", "origin_trait_choice_missing", `${root.name}: no trait choices were saved.`, root._id, [src]);
          continue;
        }
        // Exact, single-pool choices can be checked. Multiple choice groups,
        // replacement modes and custom options are deliberately not guessed.
        if (a.configuration?.allowReplacements ||
            (a.configuration?.mode && a.configuration.mode !== "default") || choices.length > 1 ||
            (choices.length === 1 && !Array.isArray(choices[0]?.pool))) {
          check("unverified", "origin_trait_complex_choice", `${root.name}: the official trait choice format needs a separate review.`, root._id, [src]);
          continue;
        }
        if (!choices.length) continue;
        const selected = chosen.filter(key => !grants.some(grant => grant === key ||
          (typeof grant === "string" && typeof key === "string" &&
            grant.endsWith("*") && key.startsWith(grant.slice(0, -1)))));
        const pool = choices[0].pool;
        const expected = Number(choices[0].count);
        if (!Number.isInteger(expected) || expected < 0 || pool.some(option => typeof option !== "string") ||
            selected.some(key => typeof key !== "string")) {
          check("unverified", "origin_trait_choice_unreadable", `${root.name}: the saved trait choice or official option pool is not a comparable list.`, root._id, [src]);
          continue;
        }
        const permitted = key => pool.some(option => option === key ||
          (option.endsWith("*") && key.startsWith(option.slice(0, -1))));
        if (selected.some(key => !permitted(key)) ||
            new Set(selected).size !== selected.length || selected.length > expected)
          check("error", "invalid_origin_trait_choice", `${root.name}: the recorded trait selection violates the official choice pool or count.`, root._id, [src]);
        else if (selected.length < expected)
          check("unverified", "origin_trait_choice_incomplete", `${root.name}: not all official trait choices are recorded.`, root._id, [src]);
      } else if (a.type === "HitPoints") {
        for (const key of Object.keys(step.value || {})) if (/^\d+$/.test(key) && Number(key) > level)
          check("error", "future_hit_points_recorded", `${root.name}: HP progression is recorded at character class level ${key} above level ${level}.`, root._id, [src]);
      }
    }
  }

  for (const { embedded, official, level, uuid } of sources)
    await checkAdvancement(embedded, official, level, uuid);
  // A bounded second pass checks official feat-granting features that already
  // contain ItemChoice advancements. It does not crawl arbitrary feat graphs.
  for (const item of owned.filter(i => i.type === "feat" && list(i).some(a => a.type === "ItemChoice"))) {
    const uuid = sourceUuid(item);
    if (!isOfficial2024Uuid(uuid)) {
      check("unverified", "feat_choice_feature_source_unverified", `${item.name}: its choice-granting feature lacks official 2024 provenance.`, item._id);
      continue;
    }
    let official;
    try { official = await fetchUuid(fs, uuid); }
    catch {
      check("unverified", "feat_choice_feature_source_unavailable", `${item.name}: the exact feature source cannot be loaded.`, item._id, [uuid]);
      continue;
    }
    if (official.__pack !== PACK.exec(uuid)?.[1] || official.type !== "feat" || official.system?.source?.rules !== "2024") {
      check("unverified", "feat_choice_feature_source_mismatch", `${item.name}: the official feat-choice feature source could not be established.`, item._id, [uuid]);
      continue;
    }
    verifiedFeatureIdentifiers.set(uuid, official.system?.identifier);
    await checkAdvancement(item, official, totalLevel, uuid);
  }
  return [...verifiedFeats];
}
