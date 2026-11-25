/** Resolve a compendium import without silently crossing the requested rules edition. */
import { message } from "./i18n.mjs";
const normalize = value => String(value || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const is2024Pack = id => /24$/.test(String(id));

/**
 * Priorité de recherche sans compendium précisé : compendiums du monde, puis dnd5e 2024 (« *24 »), puis les autres.
 * Avec rules, les compendiums dnd5e de l'autre édition sont écartés (les autres sont vérifiés après coup).
 */
export function packTier(pack) {
  if (String(pack.id).startsWith("world.")) return 0;
  const isSystem = pack.packageName === "dnd5e" || String(pack.id).startsWith("dnd5e.");
  return isSystem && is2024Pack(pack.id) ? 1 : 2;
}
function rulesCompatiblePack(pack, rules) {
  const isSystem = pack.packageName === "dnd5e" || String(pack.id).startsWith("dnd5e.");
  if (!rules || !isSystem) return true;
  return (rules === "2024") === is2024Pack(pack.id);
}

/**
 * Import par nom sans compendium : cherche dans les compendiums installés du type voulu (Item par défaut),
 * niveau de priorité par niveau (monde, dnd5e 2024, autres) ; nom FR ou EN exact, item_type et rules respectés.
 * Un même nom porté par plusieurs types d'objet (ex. sort et armure) sans item_type : erreur listant les candidats.
 */
async function resolveWithoutPack(fs, packs, entry, indexOf) {
  if (!entry.name) throw new Error(message("Provide 'pack' with an ID, or an exact name", "Préciser 'pack' avec un ID, ou un nom exact"));
  const docType = entry.document_type || "Item";
  const query = normalize(entry.name);
  const pool = packs.filter(p => p.type === docType && rulesCompatiblePack(p, entry.rules));
  const tiers = [...new Set(pool.map(packTier))].sort((a, b) => a - b);
  const errors = [];
  for (const tier of tiers) {
    const inTier = pool.filter(p => packTier(p) === tier);
    const indexes = await Promise.all(inTier.map(p => Promise.resolve(indexOf(p)).catch(() => [])));
    const hits = [];
    inTier.forEach((p, i) => {
      for (const doc of indexes[i] || []) {
        if (normalize(doc.name) !== query && normalize(doc.name_fr) !== query) continue;
        if (entry.item_type && doc.type !== entry.item_type) continue;
        hits.push({ pack: p, doc });
      }
    });
    if (!hits.length) continue;
    const types = [...new Set(hits.map(h => h.doc.type))];
    if (types.length > 1) {
      const list = hits.slice(0, 10).map(h => `${h.pack.id}/${h.doc._id} (${h.doc.type}: ${h.doc.name_fr || h.doc.name})`).join(", ");
      throw new Error(message(`Several item types are named "${entry.name}": ${list}. Specify item_type or pack.`,
        `Plusieurs types d'objet portent le nom « ${entry.name} » : ${list}. Préciser item_type ou pack.`));
    }
    for (const hit of hits) {
      try {
        const r = await resolveImportEntry(fs, packs, { ...entry, pack: hit.pack.id, id: hit.doc._id, name: undefined }, indexOf);
        if (!r.missing) return r;
      } catch (e) { errors.push(e.message); }   // édition non vérifiable dans ce compendium : candidat suivant
    }
  }
  if (errors.length) throw new Error(errors[0]);
  return { missing: entry.name };
}

export async function resolveImportEntry(fs, packs, entry, indexOf) {
  if (!entry.pack) return resolveWithoutPack(fs, packs, entry, indexOf);
  const originalPack = packs.find(p => p.id === entry.pack);
  if (!originalPack) throw new Error(`Unknown compendium: ${entry.pack}`);

  let pack = originalPack;
  let needsMetadataProof = false;
  if (entry.rules) {
    const wants2024 = entry.rules === "2024";
    if (wants2024 !== is2024Pack(originalPack.id)) {
      const alternateId = wants2024 ? `${originalPack.id}24` : originalPack.id.replace(/24$/, "");
      const alternate = packs.find(p => p.id === alternateId && p.type === originalPack.type);
      if (alternate) pack = alternate;
      else needsMetadataProof = true; // A custom pack may contain both editions.
    }
  }

  let id = entry.id;
  let name = entry.name;
  const packChanged = pack.id !== originalPack.id;
  if (packChanged && id && !name) {
    const original = (await fs.doc("get", originalPack.type, {
      pack: originalPack.id, query: { _id: id }
    })).find(doc => doc._id === id);
    if (!original) throw new Error(`Cannot resolve original item ${id} in ${originalPack.id}`);
    name = original.name;
  }

  // Item IDs are not guaranteed to be shared between the 2014 and 2024 packs.
  if (name && (!id || packChanged)) {
    const query = normalize(name);
    const matches = (await indexOf(pack)).filter(doc => (normalize(doc.name) === query || normalize(doc.name_fr) === query)
      && (!entry.item_type || doc.type === entry.item_type));
    let match = matches[0];
    if (needsMetadataProof && matches.length > 1) {
      // Pick an explicitly labelled edition if a mixed custom pack has duplicate names.
      match = matches.find(doc => String(doc.system?.source?.rules || "") === entry.rules);
      if (!match) {
        for (const candidate of matches) {
          const full = (await fs.doc("get", pack.type, { pack: pack.id, query: { _id: candidate._id } }))
            .find(doc => doc._id === candidate._id);
          if (String(full?.system?.source?.rules || "") === entry.rules) { match = candidate; break; }
        }
      }
    }
    if (!match) return { missing: name };
    id = match._id;
  }
  if (!id) throw new Error("Provide a compendium item ID or name");

  const source = (await fs.doc("get", pack.type, { pack: pack.id, query: { _id: id } })).find(doc => doc._id === id);
  if (!source) throw new Error(`Item ${id} was not found in ${pack.id}`);
  if (entry.item_type && source.type !== entry.item_type) throw new Error(`Expected item type ${entry.item_type}, got ${source.type}`);
  const sourceRules = String(source.system?.source?.rules || "");
  if (needsMetadataProof && sourceRules !== entry.rules)
    throw new Error(`Cannot verify rules ${entry.rules} for ${pack.id}/${id}: no corresponding edition pack is installed`);
  if (entry.rules && sourceRules && sourceRules !== entry.rules)
    throw new Error(`Expected rules ${entry.rules}, but ${pack.id}/${id} declares ${sourceRules}`);
  return { pack, source, id };
}
