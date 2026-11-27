/** Source-bounded evidence for D&D 2024 subclass spells. Never parse rules prose. */
import { fetchUuid } from "./advancement.mjs";

const ITEM_UUID = /^Compendium\.[^.]+\.[^.]+\.Item\.[A-Za-z0-9]{16}$/;
const advancementList = item => Array.isArray(item.system?.advancement)
  ? item.system.advancement : Object.values(item.system?.advancement || {});
const sourceUuid = item => item._stats?.compendiumSource || item.flags?.dnd5e?.sourceId || item.flags?.core?.sourceId;

// Only installed official system/SRD or PHB compendiums are trusted as
// *rules evidence*. A world compendium with `source.rules: "2024"` is not.
export function isOfficial2024Uuid(uuid) {
  return ITEM_UUID.test(uuid || "") && (uuid.startsWith("Compendium.dnd5e.classes24.Item.") ||
    uuid.startsWith("Compendium.dnd5e.spells24.Item.") ||
    uuid.startsWith("Compendium.dnd-players-handbook."));
}

/** Verify an embedded subclass against its exact installed official source. */
export async function verifySubclass(fs, sub, parent) {
  const uuid = sourceUuid(sub);
  if (!isOfficial2024Uuid(uuid)) return { reason: "An exact official D&D 2024 subclass compendium UUID is unavailable." };
  let doc;
  try { doc = await fetchUuid(fs, uuid); }
  catch { return { reason: "The recorded official subclass source cannot be read." }; }
  if (doc.type !== "subclass" || doc.system?.source?.rules !== "2024" ||
      String(doc.system?.classIdentifier || "").toLowerCase() !== String(parent.system?.identifier || "").toLowerCase() ||
      String(doc.system?.identifier || "").toLowerCase() !== String(sub.system?.identifier || "").toLowerCase())
    return { mismatch: true, source: uuid, reason: "The recorded subclass source disagrees with its class, identifier or edition." };
  return { source: uuid, doc };
}

/**
 * Read mandatory, always-prepared ItemGrant spells, including nested feature
 * grants (e.g. Life Domain -> Life Domain Spells -> spells at levels 3/5/7/9).
 * Failures are explicit: incomplete evidence must not create false errors.
 */
export async function subclassAlwaysPrepared(fs, officialSubclass, level) {
  const expected = new Map();
  const unresolved = [];
  const visited = new Set();
  let scanned = 0;

  async function visit(doc, depth) {
    if (depth > 4 || ++scanned > 100) {
      unresolved.push("Subclass feature grant graph exceeds the safe verification bound.");
      return;
    }
    for (const adv of advancementList(doc)) {
      if (adv.type !== "ItemGrant" || Number(adv.level ?? 0) > level) continue;
      const always = Number(adv.configuration?.spell?.prepared) === 2;
      for (const grant of adv.configuration?.items || []) {
        // Optional ItemGrant entries are player choices, not mandatory grants.
        if (grant.optional) continue;
        const uuid = grant.uuid;
        if (!isOfficial2024Uuid(uuid)) {
          unresolved.push(`A required subclass grant has no verified official source: ${String(uuid)}`);
          continue;
        }
        let source;
        try { source = await fetchUuid(fs, uuid); }
        catch { unresolved.push(`Required subclass grant cannot be loaded: ${uuid}`); continue; }
        if (source.system?.source?.rules !== "2024") {
          unresolved.push(`Required subclass grant does not declare 2024 rules: ${uuid}`);
          continue;
        }
        if (source.type === "spell") {
          if (always) expected.set(uuid, Math.min(level, Number(adv.level ?? 0)));
          else unresolved.push(`Subclass spell grant has no proven always-prepared state: ${uuid}`);
        } else if (!visited.has(uuid)) {
          visited.add(uuid);
          await visit(source, depth + 1);
        }
      }
    }
  }

  await visit(officialSubclass, 0);
  return { expected, unresolved: [...new Set(unresolved)] };
}

/** Only these PHB 2024 third-casters use the Wizard list by rule. */
export const THIRD_CASTER_WIZARD_LIST = Object.freeze({
  fighter: "eldritch-knight",
  rogue: "arcane-trickster"
});
