import assert from "node:assert/strict";
import { test } from "node:test";
import { rollFormula, toRollFormula, useItem } from "../src/dnd5e.mjs";
import { message } from "../src/i18n.mjs";
import { resolveImportEntry } from "../src/edition.mjs";

test("dice arithmetic respects precedence, unary signs, and division rounding", () => {
  assert.equal(rollFormula("2+3*4").total, 14);
  assert.equal(rollFormula(toRollFormula("(2+3)*4")).total, 20);
  assert.equal(rollFormula("2*-3").total, -6);
  assert.equal(rollFormula("9/2").total, 4);
  assert.equal(rollFormula("2+8/2").total, 6);
  assert.equal(rollFormula("2d1+3*2").total, 8);
  assert.throws(() => rollFormula("3/0"), new RegExp(message("Division by zero", "Division par zéro")));
  assert.throws(() => rollFormula("3*"), new RegExp(message("Incomplete", "incomplète"), "i"));
});

test("dice division preserves actual rolls instead of reducing the number of dice", () => {
  assert.equal(toRollFormula("2d1/2"), "2d1/2");
  assert.equal(toRollFormula("3d1/2"), "3d1/2");
  assert.equal(rollFormula(toRollFormula("2d1/2")).total, 1);
  assert.equal(rollFormula(toRollFormula("3d1/2")).total, 1);
});

test("simple floor wrappers preserve dice and numeric functions handle division", () => {
  assert.equal(toRollFormula("floor(2d1/2)"), "2d1/2");
  assert.equal(toRollFormula("floor(3d1/2)+1"), "3d1/2+1");
  assert.equal(rollFormula(toRollFormula("floor(3d1/2)+1")).total, 2);
  assert.equal(toRollFormula("ceil(3/2)"), "2");
  assert.equal(toRollFormula("max(1,ceil(3/2))"), "2");
  // This rewrite would be unsafe: (floor(dice / 2) * 3) differs from floor(dice / 2 * 3).
  assert.equal(toRollFormula("floor(2d1/2*3)"), "floor(2d1/2*3)");
});

test("spell DC formula variables resolve to the actual save DC, not the slot level", () => {
  const abilities = Object.fromEntries(["str", "dex", "con", "int", "wis", "cha"]
    .map(k => [k, { value: k === "int" ? 16 : 10 }]));
  const actor = { type: "character", effects: [], items: [],
    system: { abilities, attributes: { spellcasting: "int" } } };
  const spell = { name: "Formula Probe", type: "spell", system: { level: 0,
    activities: { aaaaaaaaaaaaaaaa: { _id: "aaaaaaaaaaaaaaaa", type: "damage", damage: {
      parts: [{ custom: { enabled: true, formula: "@attributes.spell.dc" }, types: ["force"] }]
    } } } } };
  const result = useItem(actor, spell, { consume: false });
  assert.equal(result.damage?.[0]?.total, 13); // 8 + proficiency 2 + INT modifier 3
});

const OLD_ID = "bbbbbbbbbbbbbbbb";
const NEW_ID = "cccccccccccccccc";
const packs = [{ id: "dnd5e.spells", type: "Item" }, { id: "dnd5e.spells24", type: "Item" }];
const documents = {
  "dnd5e.spells": [{ _id: OLD_ID, name: "Fire Bolt", type: "spell", system: { source: { rules: "2014" } } }],
  "dnd5e.spells24": [{ _id: NEW_ID, name: "Fire Bolt", type: "spell", system: { source: { rules: "2024" } } }]
};
const fakeSession = { async doc(action, type, options) {
  assert.equal(action, "get");
  return documents[options.pack].filter(item => item._id === options.query._id);
} };
const indexOf = async pack => documents[pack.id];

test("rules 2024 resolves the corresponding entry by name when item IDs differ", async () => {
  const result = await resolveImportEntry(fakeSession, packs, {
    pack: "dnd5e.spells", id: OLD_ID, rules: "2024", item_type: "spell"
  }, indexOf);
  assert.equal(result.pack.id, "dnd5e.spells24");
  assert.equal(result.id, NEW_ID);
  assert.equal(result.source.system.source.rules, "2024");
});

test("rules 2014 never imports a 2024 item just because the ID was supplied", async () => {
  const result = await resolveImportEntry(fakeSession, packs, {
    pack: "dnd5e.spells24", id: NEW_ID, rules: "2014", item_type: "spell"
  }, indexOf);
  assert.equal(result.pack.id, "dnd5e.spells");
  assert.equal(result.id, OLD_ID);
});

test("edition selection fails closed when the requested pack or rule-specific item is absent", async () => {
  await assert.rejects(resolveImportEntry(fakeSession, packs.slice(0, 1), {
    pack: "dnd5e.spells", name: "Fire Bolt", rules: "2024"
  }, indexOf), /Cannot verify rules 2024/);
  const missing = await resolveImportEntry(fakeSession, packs, {
    pack: "dnd5e.spells", name: "Fire Bolt", rules: "2024", item_type: "2024"
  }, indexOf);
  assert.equal(missing.missing, "Fire Bolt");
});

test("custom compendiums with explicit 2024 metadata work without a separate *24 pack", async () => {
  const customPack = [{ id: "world.spells", type: "Item" }];
  const doc = { _id: NEW_ID, name: "Fire Bolt", type: "spell", system: { source: { rules: "2024" } } };
  const session = { async doc() { return [doc]; } };
  const result = await resolveImportEntry(session, customPack, {
    pack: "world.spells", name: "Fire Bolt", rules: "2024", item_type: "spell"
  }, async () => [doc]);
  assert.equal(result.id, NEW_ID);
  assert.equal(result.pack.id, "world.spells");
});
