import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateNumericFormula } from "../src/formula-numeric.mjs";
import { evalBonus, rollFormula, toRollFormula, useItem } from "../src/dnd5e.mjs";
import { currentLocale } from "../src/i18n.mjs";

test("deterministic formulas evaluate arithmetic, unary signs and nested functions", () => {
  assert.equal(evaluateNumericFormula("2+3*4"), 14);
  assert.equal(evaluateNumericFormula("-(2+3)*4"), -20);
  assert.equal(evaluateNumericFormula("ceil((3)/2)"), 2);
  assert.equal(evaluateNumericFormula("min(5, max(1, floor(7/2)))"), 3);
  assert.equal(evaluateNumericFormula("round(-1.5) + abs(-2)"), 1);
  assert.equal(evaluateNumericFormula("2*.25"), 0.5);
  assert.ok(Number.isNaN(evaluateNumericFormula("1/0")));
  assert.ok(Number.isNaN(evaluateNumericFormula("process.exit(1)")));
  assert.ok(Number.isNaN(evaluateNumericFormula("max()")));
  assert.ok(Number.isNaN(evaluateNumericFormula("floor(1,2)")));
  assert.ok(Number.isNaN(evaluateNumericFormula("(".repeat(70) + "2" + ")".repeat(70))));
});

test("bonus formulas no longer execute source text and still resolve actor variables", () => {
  const actor = { system: { abilities: { dex: { value: 14 } } },
    items: [{ type: "class", system: { levels: 5 } }] };
  assert.equal(evalBonus("max(1, floor(7/2)) + @prof + @abilities.dex.mod", actor), 8);
  assert.equal(evalBonus("@abilities.dex.value / 2", actor), 7);
  assert.equal(evalBonus("globalThis.test = 42", actor), 0);
});

test("unary dice and signed numbers serialize terms that match their totals", () => {
  const signedNumber = rollFormula("2*-3");
  assert.equal(signedNumber.total, -6);
  assert.equal(signedNumber.roll.terms[2].number, -3);

  const signedDice = rollFormula("5--2d1");
  assert.equal(signedDice.total, 7);
  assert.deepEqual(signedDice.roll.terms.map(term => term.class),
    ["NumericTerm", "OperatorTerm", "NumericTerm", "OperatorTerm", "Die"]);
  assert.equal(signedDice.roll.terms[2].number, -1);
  assert.equal(signedDice.roll.terms[4].results.reduce((n, result) => n + result.result, 0), 2);

  assert.equal(rollFormula("1.5*2d1").total, 3);
});

test("dice parser errors use English opt-in and preserve exact legacy French messages", () => {
  const largeNumber = "9".repeat(400);
  const multiplication = `${"9".repeat(180)}*${"9".repeat(180)}`;
  const longFormula = "1+".repeat(3000);
  const cases = [
    [longFormula, "Dice formula is too long", "Formule de dés trop longue"],
    ["1e500", "Unsupported dice formula: 1e500", "Formule non supportée : 1e500"],
    ["1+", "Incomplete dice formula: 1+", "Formule incomplète : 1+"],
    ["1*/2", "Unexpected operator: /", "Opérateur inattendu : /"],
    ["2/0", "Division by zero in dice formula", "Division par zéro dans la formule de dés"],
    [largeNumber, `Numeric term is out of range: ${largeNumber}`, `Terme numérique hors limites : ${largeNumber}`],
    [multiplication, "Numeric result is out of range", "Résultat numérique hors limites"],
    ["101d6", "Dice limits exceeded: 101d6", "Dés hors limites : 101d6"],
    ["2dd6", "Unsupported dice term: 2dd6", "Terme non supporté : 2dd6"],
  ];
  const english = currentLocale() === "en";
  for (const [formula, englishError, frenchError] of cases) {
    assert.throws(() => rollFormula(formula), error => {
      assert.equal(error.message, english ? englishError : frenchError, `formula: ${formula.slice(0, 24)}`);
      return true;
    });
  }
});

test("numeric functions preserve rounding order while retaining dice in simple floor wrappers", () => {
  assert.equal(toRollFormula("ceil((3)/2)"), "2");
  assert.equal(toRollFormula("floor((3)/2)"), "1");
  assert.equal(toRollFormula("max(1,ceil(3/2))"), "2");
  assert.equal(toRollFormula("floor(2d1/2)"), "2d1/2");
});

test("healing and utility activities normalize numeric function formulas like damage activities", () => {
  const abilities = Object.fromEntries(["str", "dex", "con", "int", "wis", "cha"]
    .map(name => [name, { value: 10 }]));
  const actor = { type: "character", effects: [], items: [], system: { abilities, attributes: { spellcasting: "int" } } };
  const healing = { name: "Healing Probe", type: "feat", system: { activities: {
    a: { _id: "a", type: "heal", healing: {
      custom: { enabled: true, formula: "1d1+ceil(3/2)" }, types: ["healing"]
    } }
  } } };
  const utility = { name: "Utility Probe", type: "feat", system: { activities: {
    b: { _id: "b", type: "utility", roll: { formula: "1d1+floor(5/2)" } }
  } } };
  assert.equal(useItem(actor, healing, { consume: false }).healing.total, 3);
  assert.equal(useItem(actor, utility, { consume: false }).rolls[0].total, 3);
});
