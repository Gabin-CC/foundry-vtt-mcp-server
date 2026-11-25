import assert from "node:assert/strict";
import { test } from "node:test";
import { currentLocale } from "../src/i18n.mjs";
import { responseAliases } from "../src/response-aliases.mjs";
import { split, render, nextPage } from "../src/paging.mjs";

process.env.NO_LISTEN = "1";
const { handleTool } = await import("../src/server.mjs");

test("FR mode returns the identical legacy object without copying or aliasing", () => {
  const value = { resultats: [{ nom: "Bouclier", niveau: 1, statut: "anglais" }], simulation: true };
  const before = JSON.stringify(value);
  assert.strictEqual(responseAliases("search_compendium", value, "fr"), value);
  assert.strictEqual(responseAliases("gm_sync_items", value, "fr"), value);
  assert.equal(JSON.stringify(value), before);
  assert.equal(Object.hasOwn(value, "results"), false);
});

test("EN adds matching root and nested aliases with no legacy-key or enum changes", () => {
  const value = { total: 1, resultats: [{ _id: "abc", nom: "Bouclier", nom_en: "Shield", niveau: 1,
    rarete: "rare", type: "spell" }] };
  const original = structuredClone(value);
  const response = responseAliases("search_compendium", value, "en");
  assert.notStrictEqual(response, value);
  assert.strictEqual(response.resultats, response.results);
  assert.deepEqual(response.resultats[0], {
    _id: "abc", nom: "Bouclier", nom_en: "Shield", niveau: 1, rarete: "rare", type: "spell",
    name: "Bouclier", english_name: "Shield", level: 1, rarity: "rare"
  });
  assert.deepEqual(value, original);
  assert.equal(response.results[0].type, "spell");
});

test("audit aliases cover portee, resultats, statut, and coverage without translating statuses", () => {
  const value = { portee: "world", couverture: [{ source: "world:Item", entrees: 3, entrees_traduites: 1,
    pourcentage: 33.3, champs: { spell: { anglais: 2 } } }], resultats: [{ uuid: "Item.X", statut: "anglais",
    champ: "name", categorie: "name", extrait: "Some spell" }] };
  const response = responseAliases("audit_translation", value, "en");
  assert.equal(response.scope, "world");
  assert.strictEqual(response.results, response.resultats);
  assert.strictEqual(response.coverage, response.couverture);
  assert.equal(response.results[0].status, "anglais");
  assert.equal(response.results[0].field, "name");
  assert.equal(response.coverage[0].translated_entries, 1);
  assert.deepEqual(response.coverage[0].champs, { spell: { anglais: 2 } });
  assert.equal(Object.hasOwn(response.coverage[0].champs.spell, "english"), false);
});

test("advance aliases preserve choice identifiers, option values, and pending shape", () => {
  const value = { choix_requis: [{ id: "asi@4", objet: "Paladin", niveau: 4, type: "AbilityScoreImprovement",
    titre: "Amélioration", aide: "Répartir 2 points", nombre: 1, max_par_carac: 2,
    verrouillees: ["wis"], options: ["skills:ins"] }], avertissements: ["warning"], rappel: "Retry" };
  const before = structuredClone(value);
  const response = responseAliases("advance", value, "en");
  assert.strictEqual(response.required_choices, response.choix_requis);
  assert.equal(response.required_choices[0].item, "Paladin");
  assert.equal(response.required_choices[0].level, 4);
  assert.equal(response.required_choices[0].help, "Répartir 2 points");
  assert.equal(response.required_choices[0].type, "AbilityScoreImprovement");
  assert.equal(response.required_choices[0].id, "asi@4");
  assert.deepEqual(response.required_choices[0].options, ["skills:ins"]);
  assert.strictEqual(response.warnings, response.avertissements);
  assert.deepEqual(value, before);
});

test("actor sheet aliases leave legacy ability map keys and derived values intact", () => {
  const value = { nom: "Merlin", niveau: 4, pv: { actuels: 22, max: 30, temp: 2 }, caracs: { FOR: "10 (+0)" },
    incantation: { carac: "INT", attaque: "+5", dd: 13 }, emplacements: { "niv. 1": "2/4" } };
  const response = responseAliases("actor_sheet", value, "en");
  assert.strictEqual(response.abilities, response.caracs);
  assert.deepEqual(Object.keys(response.abilities), ["FOR"]);
  assert.strictEqual(response.spell_slots, response.emplacements);
  assert.strictEqual(response.hp, response.pv);
  assert.equal(response.pv.current, 22);
  assert.equal(response.incantation.dc, 13);
  assert.equal(response.spellcasting.dc, 13);
});

test("GM permissions and repair reports add labels without changing permission/status enums", () => {
  const permission = { uuid: "Scene.abc", nom: "Crypt", utilisateurs: [{ nom: "Alice", niveau: "observateur",
    titre_visible: true, contenu_lisible: true, modifiable: false }], jetons_caches: ["Goblin"] };
  const p = responseAliases("gm_permissions", permission, "en");
  assert.strictEqual(p.users, p.utilisateurs);
  assert.equal(p.users[0].permission_level, "observateur");
  assert.equal(p.users[0].content_readable, true);
  assert.strictEqual(p.hidden_tokens, p.jetons_caches);
  assert.deepEqual(permission.utilisateurs[0], { nom: "Alice", niveau: "observateur", titre_visible: true,
    contenu_lisible: true, modifiable: false });

  const report = { acteur: "Hero", objets: 3, complets: 1, sans_source: 1, a_completer: 1,
    simulation: true, detail: [{ nom: "Feat", statut: "sans source (créé à la main)", manque: ["one activity"] }] };
  const r = responseAliases("gm_sync_items", report, "en");
  assert.equal(r.dry_run, true);
  assert.equal(r.needs_completion, 1);
  assert.strictEqual(r.details, r.detail);
  assert.equal(r.details[0].status, "sans source (créé à la main)");
  assert.deepEqual(r.details[0].missing, ["one activity"]);
});

test("gm_check_ids keeps issue IDs and patch reports keep fix identifiers", () => {
  const ids = { compendiums: [], objets_du_monde: [{ ou: "monde", objet: "Broken", ids: ["activities:bad-id"] }],
    fiches: [], effets_a_refaire: ["bad"], corriges: 0, simulation: true };
  const report = responseAliases("gm_check_ids", ids, "en");
  assert.strictEqual(report.world_items, report.objets_du_monde);
  assert.deepEqual(report.world_items[0].ids, ["activities:bad-id"]);
  assert.equal(report.world_items[0].location, "monde");
  assert.strictEqual(report.effects_to_recreate, report.effets_a_refaire);

  const patch = responseAliases("gm_patch_items", { a_corriger: 1, simulation: true,
    detail: [{ nom: "Lame", correctifs: ["booming-blade-attack"] }] }, "en");
  assert.deepEqual(patch.details[0].patches, ["booming-blade-attack"]);
  assert.strictEqual(patch.details, patch.detail);

  const allActors = responseAliases("gm_patch_items", { acteurs: 1,
    detail: [{ acteur: "Merlin", objets: [{ nom: "Lame", correctifs: ["booming-blade-attack"] }] }] }, "en");
  assert.equal(allActors.details[0].actor, "Merlin");
  assert.strictEqual(allActors.details[0].items, allActors.details[0].objets);
  assert.equal(allActors.details[0].items[0].name, "Lame");
  assert.deepEqual(allActors.details[0].items[0].patches, ["booming-blade-attack"]);
});

test("table, card, damage and dice aliases use only explicit display shapes", () => {
  const table = responseAliases("roll_table", { tirages: [{ jet: 4, formule: "1d6", resultats: [
    { _id: "A", nom: "Goblin", plage: "1–4", tire: true }]
  }] }, "en");
  assert.strictEqual(table.draws, table.tirages);
  assert.equal(table.draws[0].roll, 4);
  assert.strictEqual(table.draws[0].results, table.draws[0].resultats);
  assert.equal(table.draws[0].results[0].range, "1–4");

  const cards = responseAliases("cards", [{ nom: "Deck", disponibles: 12, cartes: 13 }], "en");
  assert.equal(cards[0].name, "Deck");
  assert.equal(cards[0].cards, 13);
  const applied = responseAliases("apply_damage", { applique: [{ cible: "Orc", degats: 7,
    soins: 0, pv_temporaires: 0 }] }, "en");
  assert.equal(applied.applied[0].damage, 7);
  assert.equal(applied.applied[0].target, "Orc");
  assert.equal(responseAliases("roll", { total: 12, formule: "2d6", des: [] }, "en").formula, "2d6");
});

test("unlisted tools and raw documents / snapshot records are never touched", () => {
  const raw = { _id: "abc", resultats: ["from Foundry"], statut: "anglais",
    system: { resultats: ["private game data"] } };
  for (const tool of ["get_document", "list_documents", "get_compendium_entry", "snapshots", "next_page", "not_a_tool", "__proto__"]) {
    assert.strictEqual(responseAliases(tool, raw, "en"), raw, tool);
    assert.equal(Object.hasOwn(raw, "results"), false);
    assert.equal(Object.hasOwn(raw.system, "results"), false);
  }
});

test("existing English keys are never overwritten, and non-object results pass through", () => {
  const original = { resultats: ["legacy"], results: ["caller value"] };
  const expanded = responseAliases("search_compendium", original, "en");
  assert.deepEqual(expanded.results, ["caller value"]);
  assert.deepEqual(expanded.resultats, ["legacy"]);
  assert.equal(responseAliases("gm_pause", "Game paused", "en"), "Game paused");
  assert.equal(responseAliases("roll", null, "en"), null);
});

test("large bilingual arrays stay aligned on each valid JSON pagination chunk", () => {
  const entries = Array.from({ length: 250 }, (_, i) => ({ _id: String(i), nom: `Item ${i}`,
    nom_en: `Item ${i}`, niveau: 1, rarete: "common" }));
  const response = responseAliases("search_compendium", { total: entries.length, resultats: entries }, "en");
  const pages = split(response, 1800);
  assert.ok(pages.length > 2);
  let seen = 0;
  for (const page of pages) {
    assert.ok(Object.hasOwn(page, "resultats"));
    assert.ok(Object.hasOwn(page, "results"));
    assert.deepEqual(page.results, page.resultats);
    assert.equal(JSON.parse(JSON.stringify(page)).results.length, page.resultats.length);
    assert.ok(JSON.stringify(page).length <= 1800, "page must respect its size budget");
    seen += page.results.length;
  }
  assert.equal(seen, entries.length);
});

test("next_page cursors keep both aliases together after real rendering", () => {
  const entries = Array.from({ length: 550 }, (_, i) => ({ nom: `Spell ${i} ${"x".repeat(55)}`, niveau: 1 }));
  const response = responseAliases("search_compendium", { total: entries.length, resultats: entries }, "en");
  let page = JSON.parse(render(response, "alias-test-owner"));
  assert.ok(page.curseur_suivant, "result should need pagination");
  let seen = 0;
  while (page) {
    assert.deepEqual(page.contenu.results, page.contenu.resultats);
    seen += page.contenu.results.length;
    page = page.curseur_suivant ? nextPage(page.curseur_suivant, "alias-test-owner") : null;
  }
  assert.equal(seen, entries.length);
});

test("handleTool adds aliases in EN while retaining exact FR wire response", async () => {
  const session = { userId: "gm", world: { id: "world", title: "World", system: "dnd5e" },
    user: { _id: "user", role: 4, name: "GM" }, async doc(action, type) {
      if (action !== "get") throw new Error(`Unexpected ${action}`);
      return type === "User" ? [{ _id: "alice", name: "Alice", role: 1 }] : [];
    } };
  const result = await handleTool(session, { name: "world_info", arguments: {} });
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.utilisateurs[0].name, "Alice");
  assert.deepEqual(body.utilisateurs.map(u => u.role), ["joueur"]);
  if (currentLocale() === "en") {
    assert.strictEqual(body.users[0].name, body.utilisateurs[0].name);
    assert.equal(body.connected_as.name, body.connecte_en_tant_que.name);
  } else {
    assert.equal(Object.hasOwn(body, "users"), false);
    assert.equal(Object.hasOwn(body, "connected_as"), false);
  }
});

test("handleTool never aliases real Foundry document fields in EN", async () => {
  const item = { _id: "abcdefghijklmnop", name: "Spell", system: { resultats: ["game data"], statut: "anglais" } };
  const session = { userId: "gm", user: { role: 4 }, async doc() { return [item]; } };
  const result = await handleTool(session, { name: "get_document", arguments: { type: "Item", id: item._id } });
  const body = JSON.parse(result.content[0].text);
  assert.deepEqual(body.system, item.system);
  assert.equal(Object.hasOwn(body.system, "results"), false);
  assert.equal(Object.hasOwn(body.system, "status"), false);
});
