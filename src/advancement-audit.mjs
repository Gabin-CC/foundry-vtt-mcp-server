/** Read-only verification of recorded D&D 2024 advancement decisions. */
import { fetchUuid } from "./advancement.mjs";
import { isOfficial2024Uuid } from "./subclass-spells.mjs";

const UUID = /^Compendium\.[^.]+\.[^.]+\.Item\.[A-Za-z0-9]{16}$/;
const ABILITIES = new Set(["str", "dex", "con", "int", "wis", "cha"]);
const sourceUuid = item => item?._stats?.compendiumSource || item?.flags?.dnd5e?.sourceId || item?.flags?.core?.sourceId;
const list = item => Array.isArray(item?.system?.advancement)
  ? item.system.advancement : Object.values(item?.system?.advancement || {});
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
  const totalLevel = owned.filter(i => i.type === "class")
    .reduce((n, i) => n + (Number(i.system?.levels) || 0), 0);

  async function checkFeat(root, adv, src) {
    const pairs = entries(adv.value?.feat).filter(([, uuid]) => !!uuid);
    if (pairs.length !== 1 || !UUID.test(pairs[0]?.[1] || "")) {
      check("error", "invalid_recorded_feat", `${root.name}: feat advancement must record one exact source UUID.`, root._id, [src]);
      return;
    }
    const [recordedId, uuid] = pairs[0];
    const matching = owned.filter(item => item.type === "feat" && sourceUuid(item) === uuid);
    const direct = byId.get(recordedId);
    if (direct && (direct.type !== "feat" || sourceUuid(direct) !== uuid))
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
    if (feat.type !== "feat" || feat.system?.source?.rules !== "2024") {
      check("error", "feat_source_mismatch", `${root.name}: recorded feat source is not a 2024 feat.`, root._id, [uuid]);
      return;
    }
    verifiedFeats.add(uuid);
    const requiredLevel = feat.system?.prerequisites?.level;
    if (requiredLevel != null && requiredLevel !== "") {
      const minimum = Number(requiredLevel);
      if (!Number.isInteger(minimum) || minimum < 0)
        check("unverified", "feat_level_prerequisite_unreadable", `${feat.name}: level prerequisite is not numeric.`, root._id, [uuid]);
      else if (totalLevel < minimum)
        check("error", "feat_level_prerequisite_unmet", `${feat.name}: requires at least character level ${minimum}, but the actor is level ${totalLevel}.`, root._id, [uuid]);
    }
    // Today's ability scores cannot establish scores when the feat was taken.
    const prereqs = feat.system?.prerequisites || {};
    if (Object.entries(prereqs).some(([key, val]) => key !== "level" && val !== "" && val != null &&
        !(Array.isArray(val) && !val.length) && !(object(val) && !Object.keys(val).length)))
      check("unverified", "feat_historical_prerequisite", `${feat.name}: historical or conditional feat prerequisites cannot be certified from current attributes.`, root._id, [uuid]);
  }

  async function checkAdvancement(root, official, level, src) {
    const recorded = new Map(list(root).filter(a => a?._id).map(a => [a._id, a]));
    const source = new Map(list(official).filter(a => a?._id).map(a => [a._id, a]));

    for (const a of list(root)) if (a?._id && !source.has(a._id) && recordedChoice(a))
      check("unverified", "unknown_recorded_advancement", `${root.name}: a recorded choice is absent from the installed official source revision.`, root._id, [src]);

    for (const a of source.values()) {
      const step = recorded.get(a._id);
      if (!step) {
        if (Number(a.level || 0) <= level && ["AbilityScoreImprovement", "Subclass", "ItemGrant"].includes(a.type))
          check("unverified", "advancement_record_missing", `${root.name}: an official ${a.type} advancement is absent from the embedded item.`, root._id, [src]);
        continue;
      }
      if (step.type !== a.type) {
        check("error", "advancement_type_mismatch", `${root.name}: recorded advancement type differs from the official source.`, root._id, [src]);
        continue;
      }
      const milestone = Number(a.level || 0);
      if (milestone > level) {
        if (recordedChoice(step))
          check("error", "future_advancement_recorded", `${root.name}: a decision is recorded for level ${milestone}, above the current class level ${level}.`, root._id, [src]);
        continue;
      }
      if (a.type === "AbilityScoreImprovement") {
        const value = step.value || {};
        if (value.type === "feat") { await checkFeat(root, step, src); continue; }
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
      } else if (a.type === "HitPoints") {
        for (const key of Object.keys(step.value || {})) if (/^\d+$/.test(key) && Number(key) > level)
          check("error", "future_hit_points_recorded", `${root.name}: HP progression is recorded at character class level ${key} above level ${level}.`, root._id, [src]);
      }
    }
  }

  for (const { embedded, official, level, uuid } of sources)
    await checkAdvancement(embedded, official, level, uuid);
  return [...verifiedFeats];
}
