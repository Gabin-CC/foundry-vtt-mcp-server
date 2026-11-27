// Replay only decisions that Foundry actually persisted on the source actor.
// A replay is deliberately not a clone: equipment, prepared spells and campaign
// rewards are reported by the comparison tool and remain separate operations.
import { message } from "./i18n.mjs";
const ABILITIES = ["str", "dex", "con", "int", "wis", "cha"];
const list = item => {
  const value = item?.system?.advancement;
  return Array.isArray(value) ? value : Object.values(value || {});
};

const sourceUuid = item => item?._stats?.compendiumSource || item?.flags?.dnd5e?.sourceId || null;
const choicesAt = adv => {
  const value = adv.value || {};
  if (adv.type === "AbilityScoreImprovement") {
    if (value.type === "feat") {
      const feats = [...new Set(Object.values(value.feat || {}).filter(Boolean))];
      return feats.length === 1 ? { feat: feats[0] } : null;
    }
    if (value.type === "asi") {
      const selected = Object.fromEntries(Object.entries(value.assignments || {}).filter(([, v]) => Number(v) > 0));
      return Object.keys(selected).length ? selected : null;
    }
  }
  if (adv.type === "Subclass") return typeof value.uuid === "string" ? value.uuid : null;
  if (adv.type === "Trait") return Array.isArray(value.chosen) && value.chosen.length ? value.chosen : null;
  if (adv.type === "Size") return value.size || null;
  return null;
};

function classLineage(items, classId) {
  const descendants = new Set([classId]);
  // Older dnd5e imports have advancementOrigin but no advancementRoot.
  // Follow the ancestry transitively, without writing missing flags.
  for (let changed = true; changed;) {
    changed = false;
    for (const item of items) {
      if (descendants.has(item._id)) continue;
      const f = item.flags?.dnd5e || {};
      const parent = f.advancementOrigin?.split(".")[0];
      if (descendants.has(parent) || f.advancementRoot?.startsWith(classId + ".")) {
        descendants.add(item._id);
        changed = true;
      }
    }
  }
  return descendants;
}

/**
 * Build an exact replay plan for one class from a finished Foundry dnd5e actor.
 * No selected value is inferred from an item's title or from its description.
 */
export function advancementBlueprint(actor) {
  const items = actor?.items || [];
  const classes = items.filter(i => i.type === "class");
  if (classes.length !== 1) throw new Error(
    `Advancement replay requires exactly one class on the source actor (found ${classes.length}); multiclass replay is not supported.`);
  const cls = classes[0];
  const uuid = sourceUuid(cls);
  if (!/^Compendium\.[^.]+\.[^.]+\.Item\.[A-Za-z0-9]{16}$/.test(uuid || "")) {
    throw new Error(`Class "${cls.name}" has no verifiable compendium source UUID; cannot rebuild it safely.`);
  }
  const level = Number(cls.system?.levels);
  if (!Number.isInteger(level) || level < 1 || level > 20) throw new Error("Source class level is invalid.");

  const choices = {};
  const replayed = [];
  const conflicts = [];
  const lineage = classLineage(items, cls._id);
  // All nested class-granted feats/items may carry their own ItemChoice/ASI
  // advancements (e.g. Divine Order or Resilient).
  for (const item of items.filter(i => lineage.has(i._id))) {
    for (const adv of list(item)) {
      if (!adv?._id || (adv.level != null && Number(adv.level) > level)) continue;
      const picked = choicesAt(adv);
      if (picked != null) {
        const key = adv.level > 0 ? `${adv._id}@${adv.level}` : adv._id;
        if (key in choices && JSON.stringify(choices[key]) !== JSON.stringify(picked)) conflicts.push(key);
        else { choices[key] = picked; replayed.push({ item: item.name, type: adv.type, key }); }
      }
      if (adv.type === "ItemChoice") {
        const configurations = Object.keys(adv.configuration?.choices || {}).map(Number).filter(n => n <= level);
        const added = adv.value?.added || {};
        for (const [i, lvl] of configurations.entries()) {
          // Foundry often persists the first selection under added[0],
          // even when its configured choice is at character level 1 or 7.
          const levelAdded = added[lvl] || (configurations.length === 1 && i === 0 ? added[0] : null);
          const uuids = [...new Set(Object.values(levelAdded || {}).filter(Boolean))];
          if (!uuids.length) continue;
          const key = lvl > 0 ? `${adv._id}@${lvl}` : adv._id;
          if (key in choices && JSON.stringify(choices[key]) !== JSON.stringify(uuids)) conflicts.push(key);
          else { choices[key] = uuids; replayed.push({ item: item.name, type: adv.type, key }); }
        }
      }
    }
  }
  if (conflicts.length) throw new Error(`Conflicting recorded advancement choices: ${[...new Set(conflicts)].join(", ")}`);

  // Actor abilities include earlier advancement changes. Undo only changes
  // granted by this class, not race/background choices already applied before
  // its level-one progression.
  const baseAbilities = {};
  const preOriginAbilities = {};
  const changes = Object.fromEntries(ABILITIES.map(k => [k, 0]));
  const allChanges = Object.fromEntries(ABILITIES.map(k => [k, 0]));
  for (const item of items) {
    for (const adv of list(item)) {
      if (adv?.type !== "AbilityScoreImprovement" || adv.value?.type !== "asi") continue;
      for (const k of ABILITIES) allChanges[k] += Number(adv.value.assignments?.[k]) || 0;
    }
  }
  for (const item of items.filter(i => lineage.has(i._id))) {
    for (const adv of list(item)) {
      if (adv?.type !== "AbilityScoreImprovement" || Number(adv.level || 0) > level || adv.value?.type !== "asi") continue;
      for (const k of ABILITIES) changes[k] += Number(adv.value.assignments?.[k]) || 0;
    }
  }
  for (const k of ABILITIES) {
    const actual = Number(actor.system?.abilities?.[k]?.value);
    if (!Number.isFinite(actual)) throw new Error(`Missing source ability: ${k}`);
    baseAbilities[k] = actual - changes[k];
    if (baseAbilities[k] < 1 || baseAbilities[k] > 30) throw new Error(`Invalid reconstructed base ability: ${k}=${baseAbilities[k]}`);
    preOriginAbilities[k] = actual - allChanges[k];
    if (preOriginAbilities[k] < 1 || preOriginAbilities[k] > 30)
      throw new Error(`Invalid reconstructed pre-origin ability: ${k}=${preOriginAbilities[k]}`);
  }

  const hp = list(cls).find(x => x.type === "HitPoints")?.value || {};
  const modes = [...new Set(Array.from({ length: level - 1 }, (_, i) => hp[String(i + 2)]).filter(Boolean))];
  const hpMode = modes.length === 1 && ["avg", "max"].includes(modes[0]) ? modes[0] : null;
  return {
    actor_id: actor._id, actor_name: actor.name, class_name: cls.name, class_id: cls._id,
    class_source: uuid, level, base_abilities: baseAbilities,
    pre_origin_abilities: preOriginAbilities, choices, recorded: replayed,
    hp_mode: hpMode,
    warnings: [
      ...(!hpMode && level > 1 ? [message(
        "Hit point advancement modes are mixed or missing; select an HP mode explicitly.",
        "Progression de PV mixte ou manquante ; choisis explicitement le mode de PV.")] : []),
      message(
        "Class-only replay retains already-applied origin bonuses in its base abilities. Do not advance a background/species afterwards without first resetting to pre_origin_abilities, or bonuses could be applied twice.",
        "Le rejeu de classe conserve les bonus d'origine déjà appliqués. Ne rejoue pas l'historique ou l'espèce ensuite sans repartir de pre_origin_abilities, sinon les bonus risquent de se cumuler deux fois."),
      message(
        "Starting equipment, prepared spells, ancestry/background and campaign rewards are not automatically replayed.",
        "Équipement de départ, sorts préparés, espèce/historique et récompenses de campagne non rejoués automatiquement.")
    ]
  };
}

const normalizeItemName = s => String(s).replace(/\s+\([A-Za-z0-9]{16}\)$/, "").trim();
const counts = arr => {
  const m = new Map();
  for (const name of arr.map(normalizeItemName)) m.set(name, (m.get(name) || 0) + 1);
  return m;
};
function missingFrom(a, b) {
  const need = counts(a), have = counts(b), missing = [];
  for (const [name, n] of need) for (let i = 0; i < n - (have.get(name) || 0); i++) missing.push(name);
  return missing.sort((x, y) => x.localeCompare(y));
}

/** Compare computed sheets without relying on embedded item IDs. */
export function compareAdvancementSheets(source, target) {
  const attributes = {};
  for (const key of ["niveau", "classes", "pv", "ca_estimee", "caracs", "competences_maitrisees", "incantation", "emplacements"]) {
    const a = source[key], b = target[key];
    const equal = key === "competences_maitrisees"
      ? JSON.stringify([...(a || [])].sort()) === JSON.stringify([...(b || [])].sort())
      : JSON.stringify(a) === JSON.stringify(b);
    if (!equal) attributes[key] = { source: a, target: b };
  }
  const categories = {
    aptitudes: [source.aptitudes || [], target.aptitudes || []],
    objets: [source.objets || [], target.objets || []]
  };
  for (const level of new Set([...Object.keys(source.sorts_par_niveau || {}), ...Object.keys(target.sorts_par_niveau || {})]))
    categories[`sorts_niveau_${level}`] = [source.sorts_par_niveau?.[level] || [], target.sorts_par_niveau?.[level] || []];
  const differences = {};
  for (const [key, [a, b]] of Object.entries(categories)) {
    const missing = missingFrom(a, b), extra = missingFrom(b, a);
    if (missing.length || extra.length) differences[key] = { manquants: missing, supplementaires: extra };
  }
  return {
    conforme: !Object.keys(attributes).length && !Object.keys(differences).length,
    differences_de_valeurs: attributes, differences_de_contenu: differences,
    note: "Comparison is structural, not proof of D&D rules legality; magic effects and item descriptions need independent review."
  };
}
