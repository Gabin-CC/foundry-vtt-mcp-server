/** Source-bounded evidence for D&D 2024 subclass spells. Never parse rules prose. */
import { fetchUuid } from "./advancement.mjs";

const ITEM_UUID = /^Compendium\.[^.]+\.[^.]+\.Item\.[A-Za-z0-9]{16}$/;
const PACK = /^Compendium\.([^.]+\.[^.]+)\.Item\./;
const advancementList = item => Array.isArray(item.system?.advancement)
  ? item.system.advancement : Object.values(item.system?.advancement || {});
const sourceUuid = item => item._stats?.compendiumSource || item.flags?.dnd5e?.sourceId || item.flags?.core?.sourceId;

// Only installed official system/SRD or PHB compendiums are trusted as
// *rules evidence*. A world compendium with `source.rules: "2024"` is not.
export function isOfficial2024Uuid(uuid) {
  return ITEM_UUID.test(uuid || "") && (uuid.startsWith("Compendium.dnd5e.classes24.Item.") ||
    uuid.startsWith("Compendium.dnd5e.spells24.Item.") ||
    uuid.startsWith("Compendium.dnd5e.feats24.Item.") ||
    uuid.startsWith("Compendium.dnd5e.origins24.Item.") ||
    uuid.startsWith("Compendium.dnd-players-handbook."));
}

/** Class and subclass evidence must originate in an official class pack. */
export function isOfficial2024ClassUuid(uuid) {
  return ITEM_UUID.test(uuid || "") && (uuid.startsWith("Compendium.dnd5e.classes24.Item.") ||
    uuid.startsWith("Compendium.dnd-players-handbook."));
}

/** Verify an embedded subclass against its exact installed official source. */
export async function verifySubclass(fs, sub, parent) {
  const uuid = sourceUuid(sub);
  if (!isOfficial2024ClassUuid(uuid)) return { reason: "An exact official D&D 2024 subclass compendium UUID is unavailable." };
  let doc;
  try { doc = await fetchUuid(fs, uuid); }
  catch { return { reason: "The recorded official subclass source cannot be read." }; }
  if (doc.__pack !== PACK.exec(uuid)?.[1])
    return { source: uuid, reason: "The recorded subclass source resolved through a different compendium, not the exact official pack." };
  if (doc.type !== "subclass" || doc.system?.source?.rules !== "2024" ||
      String(doc.system?.classIdentifier || "").toLowerCase() !== String(parent.system?.identifier || "").toLowerCase() ||
      String(doc.system?.identifier || "").toLowerCase() !== String(sub.system?.identifier || "").toLowerCase())
    return { mismatch: true, source: uuid, reason: "The recorded subclass source disagrees with its class, identifier or edition." };
  return { source: uuid, doc };
}

/**
 * Trace mandatory always-prepared spells through exact official ItemGrant
 * sources, including nested features. A declared spell UUID is *not* verified
 * until its exact source pack can be loaded, but it can explain why an
 * unattributed owned spell is already covered by an explicit source warning.
 */
async function traceAlwaysPrepared(fs, officialRoot, level, kind, onlySpellRoots) {
  const expected = new Map();
  const unresolved = [];
  const declared = new Set();
  const visited = new Set();
  let scanned = 0;

  async function visit(doc, depth) {
    if (depth > 4 || ++scanned > 100) {
      unresolved.push(`${kind} feature grant graph exceeds the safe verification bound.`);
      return;
    }
    for (const adv of advancementList(doc)) {
      if (adv.type !== "ItemGrant" || Number(adv.level ?? 0) > level) continue;
      if (onlySpellRoots && depth === 0 && Number(adv.configuration?.spell?.prepared) !== 2) continue;
      const always = Number(adv.configuration?.spell?.prepared) === 2;
      for (const grant of adv.configuration?.items || []) {
        // Optional ItemGrant entries are player choices, not mandatory grants.
        if (grant.optional) continue;
        const uuid = grant.uuid;
        if (always && /^Compendium\.(?:dnd5e\.spells24|dnd-players-handbook\.spells)\.Item\./.test(uuid || "") &&
            isOfficial2024Uuid(uuid)) declared.add(uuid);
        if (!isOfficial2024Uuid(uuid)) {
          unresolved.push(`A required ${kind} grant has no verified official source: ${String(uuid)}`);
          continue;
        }
        let source;
        try { source = await fetchUuid(fs, uuid); }
        catch { unresolved.push(`Required ${kind} grant cannot be loaded: ${uuid}`); continue; }
        if (source.__pack !== PACK.exec(uuid)?.[1]) {
          unresolved.push(`Required ${kind} grant resolved from a different compendium: ${uuid}`);
          continue;
        }
        if (source.system?.source?.rules !== "2024") {
          unresolved.push(`Required ${kind} grant does not declare 2024 rules: ${uuid}`);
          continue;
        }
        if (source.type === "spell") {
          if (always) expected.set(uuid, Math.min(level, Number(adv.level ?? 0)));
          else unresolved.push(`${kind} spell grant has no proven always-prepared state: ${uuid}`);
        } else if (!visited.has(uuid)) {
          visited.add(uuid);
          await visit(source, depth + 1);
        }
      }
    }
  }

  await visit(officialRoot, 0);
  return { expected, declared, unresolved: [...new Set(unresolved)] };
}

/** Trace all mandatory subclass feature chains, including nested spell grants. */
export const subclassAlwaysPrepared = (fs, officialSubclass, level) =>
  traceAlwaysPrepared(fs, officialSubclass, level, "subclass", false);

/** Trace only class grants explicitly configured to give always-prepared spells. */
export const classAlwaysPrepared = (fs, officialClass, level) =>
  traceAlwaysPrepared(fs, officialClass, level, "class", true);

/** Only these PHB 2024 third-casters use the Wizard list by rule. */
export const THIRD_CASTER_WIZARD_LIST = Object.freeze({
  fighter: "eldritch-knight",
  rogue: "arcane-trickster"
});
