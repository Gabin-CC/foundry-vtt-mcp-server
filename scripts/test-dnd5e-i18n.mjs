import assert from "node:assert/strict";
import { test } from "node:test";
import { checkBonus, rollFormula, sheet, useItem } from "../src/dnd5e.mjs";

function inLocale(locale, action) {
  const previous = process.env.MCP_LOCALE;
  process.env.MCP_LOCALE = locale;
  try { return action(); }
  finally {
    if (previous === undefined) delete process.env.MCP_LOCALE;
    else process.env.MCP_LOCALE = previous;
  }
}

const abilities = Object.fromEntries(["str", "dex", "con", "int", "wis", "cha"]
  .map(key => [key, { value: 10, proficient: key === "dex" ? 1 : 0 }]));
const actor = { _id: "actor1", name: "Hero", type: "character", effects: [], items: [], system: {
  abilities, attributes: { hp: { value: 10, max: 10 }, spellcasting: "int" },
  skills: { acr: { value: 1 }, prc: { value: 0 } }, spells: { spell1: { value: 2 } }
} };

test("dice and check diagnostics have English opt-in while French defaults remain exact", () => {
  assert.equal(inLocale("fr", () => checkBonus(actor, "ability", "dex").label), "Test de DEX");
  assert.equal(inLocale("en", () => checkBonus(actor, "ability", "dex").label), "DEX ability check");
  assert.equal(inLocale("fr", () => checkBonus(actor, "save", "dex").label), "Sauvegarde de DEX");
  assert.equal(inLocale("en", () => checkBonus(actor, "save", "dex").label), "DEX saving throw");
  assert.equal(inLocale("fr", () => checkBonus(actor, "skill", "acr").label), "Test de Acrobaties (DEX)");
  assert.equal(inLocale("en", () => checkBonus(actor, "skill", "acr").label), "Acrobatics check (DEX)");
  assert.throws(() => inLocale("fr", () => rollFormula("3/0")), /Division par zéro/);
  assert.throws(() => inLocale("en", () => rollFormula("3/0")), /Division by zero/);
});

test("spell damage and resource consumption preserve API keys and numeric data", () => {
  const spell = { name: "Flame Test", type: "spell", system: { level: 1, activities: {
    spell1: { _id: "spell1", type: "damage", damage: { parts: [{ number: 1, denomination: 1, types: ["fire"] }] } }
  } } };
  const fr = inLocale("fr", () => useItem(actor, spell, { consume: true }));
  const en = inLocale("en", () => useItem(actor, spell, { consume: true }));
  assert.deepEqual(Object.keys(en).sort(), Object.keys(fr).sort());
  assert.deepEqual(en.actorUpdate, fr.actorUpdate);
  assert.deepEqual(en.itemUpdate, fr.itemUpdate);
  assert.deepEqual(en.damage, fr.damage);
  assert.deepEqual(en.activity, fr.activity);
  assert.equal(fr.actorUpdate["system.spells.spell1.value"], 1);
  assert.match(fr.lignes[0], /^Emplacement niv\. 1 utilisé/);
  assert.match(fr.lignes[1], /^Dégâts : 1 feu/);
  assert.match(en.lignes[0], /^Level 1 spell slot used/);
  assert.match(en.lignes[1], /^Damage: 1 fire/);
  assert.match(en.rolls[0].roll.options.flavor, /damage fire/);
  assert.match(fr.rolls[0].roll.options.flavor, /dégâts feu/);
});

test("healing, utility rolls and sheet annotations are localized without renaming fields", () => {
  const healing = { name: "Healing Test", type: "feat", system: { activities: {
    heal1: { _id: "heal1", type: "heal", healing: { custom: { enabled: true, formula: "1d1" }, types: ["healing"] } }
  } } };
  const utility = { name: "Utility Test", type: "feat", system: { activities: {
    util1: { _id: "util1", type: "utility", roll: { formula: "1d1" } }
  } } };
  const frHeal = inLocale("fr", () => useItem(actor, healing, { consume: false }));
  const enHeal = inLocale("en", () => useItem(actor, healing, { consume: false }));
  assert.deepEqual(enHeal.healing, frHeal.healing);
  assert.match(frHeal.lignes[0], /^Soins : 1/);
  assert.match(enHeal.lignes[0], /^Healing: 1/);
  assert.match(inLocale("fr", () => useItem(actor, utility, { consume: false })).lignes[0], /^Jet : 1/);
  assert.match(inLocale("en", () => useItem(actor, utility, { consume: false })).lignes[0], /^Roll : 1/);

  const equipped = { _id: "item1", name: "Lucky Ring", type: "equipment", system: { equipped: true, attuned: true } };
  const frSheet = inLocale("fr", () => sheet({ ...actor, items: [equipped] }));
  const enSheet = inLocale("en", () => sheet({ ...actor, items: [equipped] }));
  assert.deepEqual(Object.keys(frSheet), Object.keys(enSheet));
  assert.ok(Object.hasOwn(enSheet.caracs, "FOR")); // Legacy nested response keys are intentionally unchanged.
  assert.match(frSheet.objets[0], /\[équipé\] \[harmonisé\]/);
  assert.match(enSheet.objets[0], /\[equipped\] \[attuned\]/);
  assert.match(frSheet.competences_maitrisees[0], /^Acrobaties/);
  assert.match(enSheet.competences_maitrisees[0], /^Acrobatics/);
});
