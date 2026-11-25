/** Resolve a compendium import without silently crossing the requested rules edition. */
const normalize = value => String(value || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const is2024Pack = id => /24$/.test(String(id));

export async function resolveImportEntry(fs, packs, entry, indexOf) {
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
