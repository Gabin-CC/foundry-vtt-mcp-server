// Build a new dnd5e 2024 character from explicit compendium sources and
// recorded choices, without requiring an existing actor as a template.
// Preflight is read-only; applying uses the existing advancement engine.
import { fetchUuid, plan as advancementPlan } from "./advancement.mjs";
import { planClassSpells } from "./spells.mjs";

const ABILITIES = ["str", "dex", "con", "int", "wis", "cha"];
const ROOTS = [
  { field: "class_source", type: "class" },
  { field: "species_source", type: "race" },
  { field: "background_source", type: "background" }
];
const UUID = /^Compendium\.[^.]+\.[^.]+\.Item\.[A-Za-z0-9]{16}$/;

/** Validate all critical inputs and source provenance before any mutation. */
export async function planActorBuild(fs, input = {}) {
  const missing = [];
  const name = String(input.name || "").trim();
  if (!name || name.length > 100) throw new Error("A unique character name (1–100 characters) is required.");
  const level = input.level ?? 1;
  if (!Number.isInteger(level) || level < 1 || level > 20)
    throw new Error("Character level must be an integer from 1 to 20.");
  const spells = input.spells ?? "none";
  if (!["none", "all"].includes(spells)) throw new Error("spells must be none or all.");
  for (const root of ROOTS) {
    if (!input[root.field]) missing.push({ champ: root.field, attendu: `Compendium UUID for a 2024 ${root.type}` });
    else if (typeof input[root.field] !== "string" || !UUID.test(input[root.field]))
      throw new Error(`${root.field} must be a verifiable Compendium.*.Item.* UUID.`);
  }
  const abilities = {};
  for (const key of ABILITIES) {
    const raw = input.abilities?.[key];
    if (raw === undefined || raw === null) {
      missing.push({ champ: `abilities.${key}`, attendu: "Base score before background ability increases (3–18)" });
      continue;
    }
    if (!Number.isInteger(raw) || raw < 3 || raw > 18)
      throw new Error(`abilities.${key} must be an integer from 3 to 18 before origin increases.`);
    abilities[key] = raw;
  }
  const hp = input.hp ?? "avg";
  if (!["avg", "max"].includes(hp)) throw new Error("hp must be avg or max.");
  const base = { nom: name, niveau: level, caracteristiques_initiales: abilities,
    parametres_requis: missing, choix_requis: [], etapes: [], avertissements: [],
    mode_pv: hp, mode_sorts: spells, pret: false };
  if (missing.length) return base;

  const choices = input.choices || {};
  if (!choices || typeof choices !== "object" || Array.isArray(choices))
    throw new Error("choices must be an object keyed by advancement identifiers.");
  const virtualActor = { _id: "BuildPreviewOnly1", name, type: "character",
    system: { abilities: Object.fromEntries(ABILITIES.map(k => [k, { value: abilities[k] }])) }, items: [] };
  const docs = [], stages = [], pending = [], warnings = [];
  for (const root of ROOTS) {
    const uuid = input[root.field];
    const doc = await fetchUuid(fs, uuid);
    if (doc.type !== root.type) throw new Error(`${uuid} is ${doc.type}, expected ${root.type}.`);
    if (String(doc.system?.source?.rules || "") !== "2024")
      throw new Error(`${uuid} has no verified D&D 2024 rules edition (system.source.rules).`);
    docs.push(doc);
    const p = await advancementPlan(fs, virtualActor, doc, {
      fromLevel: root.type === "class" ? 1 : 0,
      toLevel: level, choices, isFirstClass: root.type === "class"
    });
    pending.push(...p.pending.map(x => ({ ...x, origine: doc.name })));
    warnings.push(...p.warnings.map(x => `${doc.name}: ${x}`));
    stages.push({ type: root.type, nom: doc.name, source: uuid, etapes: p.steps.length });
  }
  if (spells === "all" && docs[0].system?.spellcasting?.progression &&
    docs[0].system.spellcasting.progression !== "none") {
    const spellPlan = await planClassSpells(fs, virtualActor, docs[0], level, choices);
    pending.push(...spellPlan.pending.map(x => ({ ...x, origine: docs[0].name })));
    warnings.push("spells=all imports the accessible class spell list. For classes with a limited spellbook, this is not a rules-legality guarantee.");
  }
  if (spells === "none" && docs[0].system?.spellcasting?.progression &&
    docs[0].system.spellcasting.progression !== "none")
    warnings.push("Class spell selection was not requested; choose spells explicitly with advance after building the character.");
  if (spells === "none" && Object.keys(choices).some(k => k.startsWith("spells:")))
    warnings.push("spells:* choices are ignored while spells=none. Use spells=all to request class spell imports.");
  return { ...base, choix_requis: pending, etapes: stages, avertissements: warnings,
    pret: pending.length === 0, parametres_requis: [], choices };
}
