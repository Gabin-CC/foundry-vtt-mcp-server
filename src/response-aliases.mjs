/**
 * Additive English aliases for MCP-owned response fields.
 *
 * Only known tool result shapes are described here. In particular, raw Foundry
 * documents, compendium entries, snapshot payloads, status/enum values and
 * user-defined data must never be traversed or rewritten by this adapter.
 * The default French mode retains the original response byte-for-byte.
 */
import { currentLocale } from "./i18n.mjs";

const schema = (fields = {}, children = {}) => ({ fields, children });

const hp = schema({ actuels: "current" });
const spellcasting = schema({ carac: "ability", attaque: "attack", dd: "dc" });
const sheet = schema({
  nom: "name", niveau: "level", bonus_maitrise: "proficiency_bonus", pv: "hp", ca_estimee: "estimated_ac",
  caracs: "abilities", sauvegardes: "saving_throws", perception_passive: "passive_perception",
  competences_maitrisees: "proficient_skills", incantation: "spellcasting", emplacements: "spell_slots",
  sorts_par_niveau: "spells_by_level", objets: "items", aptitudes: "features", monnaie: "currency"
}, { pv: hp, incantation: spellcasting });

const dice = { formule: "formula", des: "dice" };
const target = schema({
  cible: "target", attaque: "attack", sauvegarde: "saving_throw", degats: "damage", detail_degats: "damage_details",
  soins: "healing", pv_temporaires: "temporary_hp", effets: "effects", erreur: "error"
});
const rollTableResult = schema({ plage: "range", nom: "name", texte: "text", tire: "drawn" });
const card = schema({ nom: "name", tiree: "drawn" });

const auditCoverage = schema({ libelle: "label", entrees: "entries", entrees_traduites: "translated_entries",
  pourcentage: "percentage", fichier_traduction: "translation_file" });
const auditIssue = schema({ dossier: "folder", champ: "field", categorie: "category", statut: "status",
  extrait: "excerpt", correctif: "suggested_fix" });
const textHit = schema({ dossier: "folder", champ: "field", categorie: "category", extrait: "excerpt",
  genre: "kind" });

const pendingChoice = schema({ objet: "item", niveau: "level", titre: "title", aide: "help", nombre: "count",
  max_par_carac: "max_per_ability", verrouillees: "locked" });
const gmIssue = schema({ ou: "location", objet: "item" });
const gmDetail = schema({ nom: "name", probleme: "problem", manque: "missing", a_verifier: "to_check",
  statut: "status", correctifs: "patches" });
const gmPatchDetail = schema({ ...gmDetail.fields, acteur: "actor", objets: "items" },
  { objets: gmDetail });
const gmUser = schema({ nom: "name", niveau: "permission_level", titre_visible: "title_visible",
  contenu_lisible: "content_readable", modifiable: "editable" });
const gmPage = schema({ nom: "name", lisible_par: "readable_by", titre_seulement: "title_only" });
const gmScene = schema({ nom: "name", jetons_caches: "hidden_tokens", jetons_visibles: "visible_tokens",
  obscurite: "darkness", droits: "permissions" }, { droits: gmUser });
const gmJournal = schema({ nom: "name", apercu: "preview", destinataires: "recipients" },
  { destinataires: schema({ nom: "name", peut_deja_lire: "can_already_read", verra: "will_see" }) });

// Explicit whitelist: no fallback that guesses translations for unknown keys.
const TOOL_SCHEMAS = Object.freeze({
  world_info: schema({ connecte_en_tant_que: "connected_as", utilisateurs: "users" }),
  create_documents: schema({ crees: "created", identifiants_corriges: "fixed_ids", a_verifier: "warnings" }),
  update_documents: schema({ modifies: "modified", resultat: "result", instantane: "snapshot", simulation: "dry_run" }),
  delete_documents: schema({ seraient_supprimes: "would_delete", introuvables: "not_found",
    supprimes: "deleted", instantane: "snapshot", simulation: "dry_run" },
    { seraient_supprimes: schema({ nom: "name" }) }),
  actor_sheet: sheet,
  roll: schema(dice),
  check: schema({ ...dice, jet: "roll" }),
  use_item: schema({ objet: "item", resultats: "results", proposition: "proposal", cibles: "targets" },
    { cibles: target }),
  apply_damage: schema({ applique: "applied" }, { applique: target }),
  rest: schema({ repos: "rest", effets: "effects" }),
  list_packs: schema({ nom: "name", entrees: "entries" }),
  search_compendium: schema({ resultats: "results" },
    { resultats: schema({ nom: "name", nom_en: "english_name", niveau: "level", rarete: "rarity" }) }),
  localize_actor: schema({ acteur: "actor", objets: "items", objets_modifies: "items_modified",
    effets_modifies: "effects_modified", effets: "effects", acteur_modifie: "actor_changed",
    simulation: "dry_run", instantane: "snapshot" }),
  add_from_compendium: schema({ ajoutes: "added", a: "destination" }),
  give_loot: schema({ a: "recipient", recu: "received" }),
  upload_file: schema({ chemin: "path" }),
  advance: schema({ choix_requis: "required_choices", avertissements: "warnings", rappel: "reminder",
    applique: "applied", niveau: "level", pv_max: "max_hp", caracs: "abilities", rappel_sorts: "spell_reminder" },
    { choix_requis: pendingChoice }),
  audit_translation: schema({ portee: "scope", couverture: "coverage", resultats: "results" },
    { couverture: auditCoverage, resultats: auditIssue }),
  search_text: schema({ resultats: "results" }, { resultats: textHit }),
  find_references: schema({ cible: "target" }, { references: textHit }),
  roll_table: schema({ nom: "name", formule: "formula", remise: "replacement", resultats: "results",
    tirages: "draws", marques_tires: "marked_drawn" },
    { resultats: rollTableResult, tirages: schema({ jet: "roll", formule: "formula", resultats: "results" },
      { resultats: rollTableResult }) }),
  cards: schema({ nom: "name", disponibles: "available", cartes: "cards", de: "from", vers: "to" },
    { cartes: card, distribution: schema({ vers: "to", cartes: "cards" }, { cartes: card }) }),
  gm_scene: schema({}, { scenes: schema({ nom: "name" }) }),
  gm_music: schema({ nom: "name", en_cours: "playing", morceaux: "tracks" }),
  gm_show: schema({ apercu: "preview", destinataires: "recipients" },
    { apercu: schema({}, { scene: gmScene, journal: gmJournal }) }),
  gm_permissions: schema({ nom: "name", utilisateurs: "users", apercu: "preview", jetons_caches: "hidden_tokens" },
    { utilisateurs: gmUser, pages: gmPage }),
  gm_token: schema({ nom: "name", cache: "hidden" }),
  gm_combat: schema({ tour: "turn", ordre: "order" }),
  gm_check_ids: schema({ objets_du_monde: "world_items", fiches: "actor_items",
    effets_a_refaire: "effects_to_recreate", corriges: "fixed", simulation: "dry_run", instantane: "snapshot" },
    { compendiums: gmIssue, objets_du_monde: gmIssue, fiches: gmIssue }),
  gm_sync_items: schema({ acteur: "actor", objets: "items", complets: "complete", sans_source: "without_source",
    a_completer: "needs_completion", modifies: "modified", simulation: "dry_run",
    instantane: "snapshot", detail: "details" }, { detail: gmDetail }),
  gm_patch_items: schema({ ou: "location", acteurs: "actors", objets: "items", a_corriger: "to_patch",
    modifies: "modified", simulation: "dry_run", instantane: "snapshot", detail: "details" },
    { detail: gmPatchDetail })
});

function expand(value, definition) {
  if (Array.isArray(value)) return value.map(entry => expand(entry, definition));
  if (value === null || typeof value !== "object") return value;
  const result = { ...value };
  for (const [key, child] of Object.entries(definition.children)) {
    if (Object.hasOwn(value, key)) result[key] = expand(value[key], child);
  }
  for (const [legacy, english] of Object.entries(definition.fields)) {
    if (Object.hasOwn(value, legacy) && !Object.hasOwn(result, english)) result[english] = result[legacy];
  }
  return result;
}

/** Return the original value in FR; add only audited aliases in EN. */
export function responseAliases(tool, value, locale = currentLocale()) {
  const definition = Object.hasOwn(TOOL_SCHEMAS, tool) ? TOOL_SCHEMAS[tool] : null;
  return locale === "en" && definition ? expand(value, definition) : value;
}
