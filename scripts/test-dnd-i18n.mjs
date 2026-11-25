import assert from "node:assert/strict";
import { test } from "node:test";
import { currentLocale } from "../src/i18n.mjs";
import { checkBonus, useItem, sheet } from "../src/dnd5e.mjs";
import { fetchUuid, plan, planStartingEquipment } from "../src/advancement.mjs";
import { planClassSpells, applyClassSpells } from "../src/spells.mjs";
import { scrollFromSpell } from "../src/scroll.mjs";

const english = currentLocale() === "en";
const translated = (en, fr) => english ? en : fr;
const abilities = Object.fromEntries(["str", "dex", "con", "int", "wis", "cha"].map(k => [k, { value: k === "int" ? 16 : 10 }]));
const actor = () => ({ _id: "abcdefghijklmnop", name: "Merlin", type: "character", items: [], effects: [],
  system: { abilities: structuredClone(abilities), skills: { arc: { value: 1 } },
    attributes: { spellcasting: "int" }, spells: { spell1: { value: 0 } } } });

test("D&D check labels and sheet values are localized without changing schema keys", () => {
  const a = actor();
  assert.equal(checkBonus(a, "ability", "wis").label, translated("WIS check", "Test de SAG"));
  assert.equal(checkBonus(a, "save", "int").label, translated("INT saving throw", "Sauvegarde de INT"));
  assert.equal(checkBonus(a, "skill", "arc").label, translated("Arcana check (INT)", "Test de Arcanes (INT)"));
  assert.equal(checkBonus(a, "skill", "arc").bonus, 5);
  assert.throws(() => checkBonus(a, "skill", "missing"),
    e => e.message === translated("Unknown skill: missing", "Compétence inconnue : missing"));
  const result = sheet(a);
  assert.ok(Object.hasOwn(result, "competences_maitrisees"));
  assert.ok(Object.hasOwn(result, "caracs"));
  assert.ok(Object.hasOwn(result.caracs, "SAG")); // legacy protocol key, even in English
  assert.ok(result.competences_maitrisees[0].startsWith(translated("Arcana", "Arcanes")));
});

test("D&D slot and item-use errors preserve protocol names and resource updates", () => {
  const a = actor();
  const spell = { name: "Shield", type: "spell", system: { level: 1, activities: {} } };
  assert.throws(() => useItem(a, spell, {}), e => e.message === translated(
    "No level 1 spell slot available (spell1: 0). Specify another slot_level or consume=false.",
    "Plus d'emplacement de niveau 1 disponible (spell1 : 0). Précise un autre slot_level ou consume=false."));
  const noConsume = useItem(a, spell, { consume: false });
  assert.deepEqual(noConsume.actorUpdate, {});
  assert.deepEqual(noConsume.itemUpdate, {});
  assert.deepEqual(noConsume.lignes, [translated("(No activity: nothing to execute)", "(Aucune activité : rien à lancer)")]);

  const item = { name: "Potion", type: "consumable", system: { uses: { max: 2, spent: 1 },
    activities: { use: { _id: "use", type: "utility", consumption: { targets: [{ type: "itemUses" }] } } } } };
  const used = useItem(a, item, {});
  assert.equal(used.itemUpdate["system.uses.spent"], 2);
  assert.deepEqual(Object.keys(used), ["lignes", "rolls", "actorUpdate", "itemUpdate", "deleteItem", "crit", "activity"]);
  assert.deepEqual(used.lignes, [translated("Uses: 0/2", "Utilisations : 0/2")]);
  item.system.uses.spent = 2;
  assert.throws(() => useItem(a, item, {}), e => e.message === translated(
    "Potion has no uses remaining.", "Potion n'a plus d'utilisation disponible."));
});

test("Saving throws and damage translate text, not enums, rolls or formulas", () => {
  const a = actor();
  const spell = { name: "Flame", type: "spell", system: { level: 0, activities: { fire: {
    _id: "fire", type: "save", save: { ability: ["dex"] },
    damage: { onSave: "half", parts: [{ number: 1, denomination: 1, types: ["fire"] }] }
  } } } };
  const out = useItem(a, spell, { consume: false });
  assert.deepEqual(out.save, { abilities: ["dex"], dc: 13, onSave: "half" });
  assert.deepEqual(out.damage, [{ total: 1, types: ["fire"], formula: "1d1" }]);
  assert.equal(out.lignes[0], translated(
    "Saving throw DEX DC 13 (half damage on a successful save)",
    "Jet de sauvegarde de DEX DD 13 (moitié des dégâts si réussi)"));
  assert.equal(out.lignes[1], translated("Damage: 1 fire (1d1)", "Dégâts : 1 feu (1d1)"));
});

test("Advancement pending choices localize values while retaining IDs and choice shapes", async () => {
  const background = { name: "Background", system: { startingEquipment: [
    { _id: "pick", type: "OR", group: "" },
    { _id: "gold", type: "currency", group: "pick", count: 50, key: "gp" },
    { _id: "silver", type: "currency", group: "pick", count: 10, key: "sp" }
  ] } };
  const equipment = await planStartingEquipment({}, background, {});
  assert.equal(equipment.pending.length, 1);
  assert.equal(equipment.pending[0].id, "equip:pick");
  assert.equal(equipment.pending[0].type, "StartingEquipment");
  assert.equal(equipment.pending[0].titre, translated("Starting equipment (choice)", "Équipement de départ (choix)"));
  assert.equal(equipment.pending[0].aide, translated("Value = option identifier", "Valeur = l'identifiant de l'option"));
  const feat = { name: "Feat", type: "feat", system: { advancement: [
    { _id: "size-id", type: "Size", level: 0, configuration: { sizes: ["sm", "med"] } }
  ] } };
  const result = await plan({}, actor(), feat, { fromLevel: 0, toLevel: 0, choices: {} });
  assert.equal(result.pending[0].id, "size-id");
  assert.equal(result.pending[0].type, "Size");
  assert.deepEqual(result.pending[0].options, ["sm", "med"]);
  assert.equal(result.pending[0].titre, translated("Size", "Taille"));
  await assert.rejects(fetchUuid({}, "invalid"), e => e.message === translated(
    "Invalid compendium UUID: invalid", "UUID de compendium invalide : invalid"));
});

test("Spell preparation hints and summaries keep choices and counters unchanged", async () => {
  const cls = { name: "Wizard", type: "class", system: { identifier: "wizard", source: { rules: "2024" },
    spellcasting: { progression: "full" }, advancement: [
      { type: "ScaleValue", configuration: { identifier: "cantrips-known", scale: { 1: { value: 2 } } } },
      { type: "ScaleValue", configuration: { identifier: "max-prepared", scale: { 1: { value: 1 } } } }
    ] } };
  const session = { async worldData() { return { packs: [] }; } };
  const result = await planClassSpells(session, actor(), cls, 1, {});
  assert.deepEqual(result.pending.map(x => x.id), ["spells:cantrips", "spells:prepared"]);
  assert.deepEqual(result.pending.map(x => x.type), ["Spells", "Spells"]);
  assert.equal(result.pending[0].titre, translated("Wizard cantrips", "Sorts mineurs de Wizard"));
  assert.equal(result.pending[1].titre, translated("Prepared spells (1 max)", "Sorts préparés (1 max)"));
  const summary = await applyClassSpells(session, actor(), result.step, "class-id");
  assert.equal(summary, translated("0 cantrip(s), 0 class spell(s) (levels 1 to 1), 0 prepared",
    "0 sort(s) mineur(s), 0 sort(s) de classe (niv. 1 à 1), 0 préparé(s)"));
});

test("Invalid ability allocations and non-spell scrolls report bilingual errors", async () => {
  const feat = { name: "Feat", type: "feat", system: { advancement: [
    { _id: "asi-id", type: "AbilityScoreImprovement", level: 0,
      configuration: { points: 2, cap: 2, locked: ["wis"] } }
  ] } };
  await assert.rejects(plan({}, actor(), feat, { fromLevel: 0, toLevel: 0, choices: { "asi-id": { wis: 3 } } }),
    e => e.message === translated(
      'Invalid allocation for "ASI": {"wis":3} (points 2, max +2, locked wis)',
      'Répartition invalide pour « ASI » : {"wis":3} (points 2, max +2, verrouillées wis)'));

  const id = "abcdefghijklmnop";
  const session = { async doc(action, type, params) {
    assert.equal(action, "get"); assert.equal(type, "Item"); assert.equal(params.query._id, id);
    return [{ _id: id, name: "Sword", type: "weapon", system: {} }];
  } };
  await assert.rejects(scrollFromSpell(session, `Item.${id}`),
    e => e.message === translated(`Not a spell: Item.${id}`, `Pas un sort : Item.${id}`));
});
