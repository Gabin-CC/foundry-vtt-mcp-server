#!/usr/bin/env node
// Serveur MCP Foundry VTT — sans navigateur.
// Auth : Basic auth = identifiants d'un compte Foundry (nom + mot de passe).
// Chaque requête agit avec les droits Foundry de ce compte (joueur, MJ...).
import crypto from "node:crypto";
import express from "express";
import { rateLimit } from "express-rate-limit";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { FoundrySession } from "./foundry.mjs";
import { createFoundryOAuth, oauthEncryptionKey } from "./oauth.mjs";
import { plan as advPlan, apply as advApply, fetchUuid } from "./advancement.mjs";
import { planClassSpells, applyClassSpells } from "./spells.mjs";
import { ensureCastSpells } from "./cast.mjs";
import { GM_TOOLS, GM_ROLE, handleGm } from "./gm.mjs";
import { sanitizeItemData, itemWarnings } from "./repair.mjs";
import { applyPatches } from "./patches.mjs";
import { resolveImportEntry } from "./edition.mjs";
import { englishToolMetadata } from "./tool-english.mjs";
import { message } from "./i18n.mjs";
import { responseAliases } from "./response-aliases.mjs";
import { scrollFromSpell } from "./scroll.mjs";
import { render, nextPage, MAX_OUT } from "./paging.mjs";
import { auditTranslation, searchText, findReferences } from "./corpus.mjs";
import { TABLE_TOOLS, CARD_TOOLS, handleTable, handleCards } from "./tables.mjs";
import { resolveTarget, propose, applyDamage } from "./targets.mjs";
import { diffUpdates, saveSnapshot, currentDocs, listSnapshots, showSnapshot, restoreSnapshot } from "./snapshots.mjs";
import { rollFormula, derive, checkBonus, sheet, slotMax, useItem, translations, translateDoc, trFor, refreshUnits, localizeItem, actorTranslationContext, actorMetricUpdates, UNITS, ABIL, SKILLS } from "./dnd5e.mjs";
import { setSafePath } from "./security.mjs";
import { restrictedSession, isStub, limitedError } from "./access.mjs";
import { decodeUploadBase64, downloadPublicFile, validateUploadContent, validateUploadDestination } from "./upload.mjs";

const PORT = Number(process.env.PORT || 8808);
const HOST = process.env.HOST || "127.0.0.1";
const TRUSTED_PROXY = process.env.TRUSTED_PROXY || ""; // IP du reverse proxy dont on accepte X-Forwarded-For
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, ""); // ex. https://foundry.example.com
// L'écran de connexion de Foundry grise les comptes déjà actifs : tant que le MCP garde sa session, le joueur ne
// peut pas (re)venir dans son navigateur. La connexion du MCP est donc relâchée quelques secondes après le dernier
// appel (IDLE_SECONDS, défaut 10 s). Le MCP, lui, fonctionne même si le joueur est connecté.
const IDLE_MS = (Number(process.env.IDLE_SECONDS) || 10) * 1000;
const ROLES = { 0: "aucun", 1: "joueur", 2: "joueur de confiance", 3: "MJ assistant", 4: "MJ" };
const TYPES = ["Actor", "Item", "JournalEntry", "Scene", "Folder", "User", "Playlist", "RollTable", "Macro",
  "ChatMessage", "Combat", "Cards", "Setting", "Adventure",
  // embarqués (avec parent)
  "ActiveEffect", "JournalEntryPage", "Token", "Tile", "Wall", "Note", "AmbientLight", "AmbientSound",
  "Drawing", "MeasuredTemplate", "Region", "Level", "PlaylistSound", "TableResult", "Combatant"];

// ---------- sessions Foundry en cache ----------
const sessions = new Map(); // key -> {s, last, pending}
const keyOf = (u, p) => crypto.createHash("sha256").update(u.toLowerCase() + "\0" + p).digest("hex");
async function getSession(user, pass) {
  const k = keyOf(user, pass);
  const e = sessions.get(k);
  if (e?.s?.alive) { e.last = Date.now(); return e.s; }
  if (e?.pending) return e.pending;
  const pending = FoundrySession.login(user, pass).then(s => {
    if (s) sessions.set(k, { s, last: Date.now() }); else sessions.delete(k);
    return s;
  }).catch(err => { sessions.delete(k); throw err; });
  sessions.set(k, { pending });
  return pending;
}
if (process.env.NO_LISTEN !== "1") setInterval(() => {
  for (const [k, e] of sessions) if (e.s && !e.busy && Date.now() - e.last > IDLE_MS) { e.s.close(); sessions.delete(k); }
}, 2000).unref();

// ---------- anti brute-force ----------
const fails = new Map(); // ip -> [timestamps]
const clientIp = req => {
  const remote = req.socket.remoteAddress?.replace("::ffff:", "");
  const xff = req.headers["x-forwarded-for"];
  return remote === TRUSTED_PROXY && xff ? String(xff).split(",")[0].trim() : remote;
};
const recentFails = ip => (fails.get(ip) || []).filter(t => Date.now() - t < 15 * 60 * 1000);

// ---------- helpers ----------
const num0 = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const getPath = (o, p) => p ? p.split(".").reduce((a, k) => a?.[k], o) : o;
// Réponse d'un outil : la mise en forme (et le découpage en pages si elle est trop grosse) se fait dans handleTool.
const OUT = Symbol("out");
const out = v => ({ [OUT]: true, value: v });
const pick = (doc, fields) => {
  if (!fields?.length) return doc;
  const r = { _id: doc._id };
  for (const f of fields) r[f] = getPath(doc, f);
  return r;
};
const matches = (doc, filter) => Object.entries(filter || {}).every(([k, v]) => {
  const x = getPath(doc, k);
  return Array.isArray(x) ? x.includes(v) : x === v;
});
const parentOpt = (parent, pack) => ({ ...(parent ? { parentUuid: parent } : {}), ...(pack ? { pack } : {}) });
const typeProp = { type: "string", enum: TYPES, description: "Type de document Foundry" };
const packProp = { type: "string", description: "Compendium (id, ex. 'world.classes-and-sous-classes') pour agir sur ses entrées au lieu du monde" };
const parentProp = { type: "string", description: "Pour un document embarqué : UUID du parent, ex. 'Actor.abc123' (objets/effets d'un acteur), 'Scene.xyz' (tokens, murs...), 'JournalEntry.id' (pages)." };

export const TOOL_DEFINITIONS = [
  { name: "world_info", description: "Infos du monde Foundry actif, du compte connecté et liste des utilisateurs.",
    inputSchema: { type: "object", properties: {} } },
  { name: "list_documents",
    description: "Liste des documents d'un type (selon les droits du compte). Renvoie par défaut _id, name, type, folder. Filtres optionnels. Paginé : total, next_cursor / next_offset (null = fin), ordre stable par _id.",
    inputSchema: { type: "object", required: ["type"], properties: {
      type: typeProp, pack: packProp, parent: parentProp,
      name_contains: { type: "string", description: "Filtre insensible à la casse sur le nom" },
      filter: { type: "object", description: "Égalités sur des chemins, ex. {\"type\":\"character\",\"folder\":\"id\"}" },
      fields: { type: "array", items: { type: "string" }, description: "Champs à renvoyer (chemins pointés), ex. [\"name\",\"system.attributes.hp.value\"]" },
      limit: { type: "number", default: 200, description: "Taille de page (max 5000 ; la page s'arrête plus tôt si la réponse devient trop grosse)" },
      cursor: { type: "string", description: "Page suivante : valeur next_cursor de la réponse précédente (dernier _id renvoyé)" },
      offset: { type: "number", description: "Alternative au curseur : position de départ (ordre par _id)" } } } },
  { name: "next_page", description: "Suite d'une réponse trop grosse découpée en pages (champ curseur_suivant d'une réponse précédente).",
    inputSchema: { type: "object", required: ["cursor"], properties: { cursor: { type: "string" } } } },
  { name: "get_document", description: "Lit un document complet (ou une sous-partie via 'path').",
    inputSchema: { type: "object", required: ["type", "id"], properties: {
      type: typeProp, pack: packProp, id: { type: "string" }, parent: parentProp,
      path: { type: "string", description: "Sous-partie à renvoyer, ex. 'system.abilities'" } } } },
  { name: "create_documents", description: "Crée un ou plusieurs documents.",
    inputSchema: { type: "object", required: ["type", "data"], properties: {
      type: typeProp, pack: packProp, parent: parentProp, data: { type: "array", items: { type: "object" } },
      warn_packs: { type: "array", items: { type: "string" }, description: "Compendiums où chercher une entrée de même nom quand un objet créé n'a ni activité ni effet (défaut : principaux compendiums du monde et de dnd5e 2024)" } } } },
  { name: "update_documents",
    description: "Modifie des documents. Chaque update contient _id + les champs à changer en notation pointée, ex. {\"_id\":\"abc\",\"system.abilities.str.value\":10}. dry_run = aperçu avant/après ; sinon un instantané des valeurs d'origine est gardé (outil snapshots pour restaurer).",
    inputSchema: { type: "object", required: ["type", "updates"], properties: {
      type: typeProp, pack: packProp, parent: parentProp, updates: { type: "array", items: { type: "object" } },
      dry_run: { type: "boolean", description: "Aperçu avant/après de chaque champ, sans rien modifier" } } } },
  { name: "delete_documents", description: "Supprime des documents. Un instantané complet est gardé côté serveur (restauration : outil snapshots).",
    inputSchema: { type: "object", required: ["type", "ids"], properties: {
      type: typeProp, pack: packProp, parent: parentProp, ids: { type: "array", items: { type: "string" } },
      dry_run: { type: "boolean", description: "Liste ce qui serait supprimé, sans supprimer" } } } },
  { name: "snapshots", description: "Instantanés de restauration pris automatiquement avant update_documents, delete_documents et localize_actor (valeurs d'origine des champs modifiés, documents supprimés). list (les plus récents), show (détail avant/après), restore (remet les valeurs d'origine ; dry_run pour un aperçu ; la restauration est elle-même annulable).",
    inputSchema: { type: "object", properties: {
      action: { type: "string", enum: ["list", "show", "restore"], default: "list" }, id: { type: "string", description: "Identifiant de l'instantané (show/restore)" },
      dry_run: { type: "boolean", description: "restore : aperçu sans rien modifier" }, tool: { type: "string", description: "list : filtrer par outil d'origine" },
      limit: { type: "number", default: 30 } } } },
  { name: "actor_sheet", description: "Fiche calculée d'un personnage/PNJ (niveau, maîtrise, caracs+mods, CA estimée, PV, compétences, DD/attaque de sort, emplacements, sorts, objets avec leurs _id).",
    inputSchema: { type: "object", required: ["actor"], properties: { actor: { type: "string", description: "Nom ou _id de l'acteur" } } } },
  { name: "roll", description: "Lance des dés et poste le résultat dans le chat Foundry. Formules : 1d20+5, 2d20kh1+3 (avantage), 2d20kl1 (désavantage), 8d6, 4d6kh3...",
    inputSchema: { type: "object", required: ["formula"], properties: {
      formula: { type: "string" }, flavor: { type: "string", description: "Libellé du jet" },
      actor: { type: "string", description: "Personnage qui lance (nom ou _id), optionnel" },
      mode: { type: "string", enum: ["public", "mj", "aveugle", "prive"], default: "public" } } } },
  { name: "check", description: "Test de caractéristique, sauvegarde, compétence ou initiative pour un acteur (bonus calculés), posté dans le chat.",
    inputSchema: { type: "object", required: ["actor", "kind"], properties: {
      actor: { type: "string" }, kind: { type: "string", enum: ["ability", "save", "skill", "initiative"] },
      key: { type: "string", description: "Carac (str,dex,con,int,wis,cha) ou compétence (acr,ani,arc,ath,dec,his,ins,itm,inv,med,nat,prc,prf,per,rel,slt,ste,sur)" },
      advantage: { type: "boolean" }, disadvantage: { type: "boolean" },
      mode: { type: "string", enum: ["public", "mj", "aveugle", "prive"], default: "public" } } } },
  { name: "use_item", description: "Utilise un objet/sort/aptitude d'un acteur : lance l'attaque et les dégâts/soins, indique le DD de sauvegarde, consomme emplacement de sort / utilisation / quantité, et poste la carte dans le chat.",
    inputSchema: { type: "object", required: ["actor", "item"], properties: {
      actor: { type: "string" }, item: { type: "string", description: "Nom ou _id de l'objet/sort sur l'acteur" },
      activity: { type: "string", description: "Nom ou _id de l'activité si l'objet en a plusieurs" },
      slot_level: { type: "number", description: "Niveau d'emplacement (sort lancé à plus haut niveau)" },
      advantage: { type: "boolean" }, disadvantage: { type: "boolean" }, versatile: { type: "boolean", description: "Arme polyvalente à deux mains" },
      consume: { type: "boolean", default: true, description: "Consommer emplacement/utilisation/quantité" },
      target: { type: "string", description: "Cible (texte libre affiché dans le chat)" },
      targets: { type: "array", items: { type: "string" }, description: "Jetons ciblés : UUID (Scene.x.Token.y), _id ou nom d'un jeton de la scène active ou de celle du combat en cours (un _id est aussi cherché sur les autres scènes), ou Actor.x. Calcule touché/raté (CA), sauvegarde de chaque cible, dégâts (résistances, immunités, vulnérabilités), soins et effets/états de l'activité, et renvoie une proposition à valider avec apply_damage." },
      mode: { type: "string", enum: ["public", "mj", "aveugle", "prive"], default: "public" } } } },
  { name: "apply_damage", description: "Validation de use_item avec cibles : applique la proposition (dégâts avec PV temporaires d'abord, soins plafonnés au max, PV temporaires, effets/états de l'activité copiés sur la cible comme le bouton du chat de dnd5e). Jetons non liés : modifie le jeton seul. 'manual' applique des valeurs libres sans proposition.",
    inputSchema: { type: "object", properties: {
      proposal: { type: "string", description: "Identifiant 'proposition' renvoyé par use_item" },
      targets: { type: "array", items: { type: "string" }, description: "Limiter à ces cibles (UUID ou nom)" },
      overrides: { type: "array", items: { type: "object", properties: { target: { type: "string" }, damage: { type: "number" }, healing: { type: "number" }, temp: { type: "number" },
        multiplier: { type: "number", description: "Ex. 0.5 (moitié), 0 (aucun dégât), 2" }, effects: { type: "boolean" } } } },
      manual: { type: "array", items: { type: "object", properties: { target: { type: "string" }, damage: { type: "number" }, healing: { type: "number" }, temp: { type: "number" } } } },
      force: { type: "boolean", description: "Réappliquer une proposition déjà appliquée" },
      chat: { type: "boolean", default: true }, mode: { type: "string", enum: ["public", "mj", "aveugle", "prive"], default: "public" } } } },
  { name: "rest", description: "Repos long (PV max, emplacements, utilisations, dés de vie récupérés à moitié) ou court (emplacements de pacte, utilisations 'sr').",
    inputSchema: { type: "object", required: ["actor", "type"], properties: { actor: { type: "string" }, type: { type: "string", enum: ["long", "court"] },
      mode: { type: "string", enum: ["public", "mj", "aveugle", "prive"], default: "public" } } } },
  { name: "list_packs", description: "Liste les compendiums disponibles (id, nom, type, nombre d'entrées, traduction FR dispo).",
    inputSchema: { type: "object", properties: { type: { type: "string", description: "Filtrer par type : Item, Actor, JournalEntry, RollTable..." } } } },
  { name: "search_compendium", description: "Cherche dans les compendiums par nom (français ou anglais). Renvoie pack, _id, nom FR, nom EN, type, niveau.",
    inputSchema: { type: "object", required: ["query"], properties: {
      query: { type: "string" }, pack: { type: "string", description: "Limiter à un compendium (id)" },
      item_type: { type: "string", description: "Type d'objet : spell, weapon, equipment, consumable, loot, class, subclass, feat, race, background, tool, container..." },
      level: { type: "number", description: "Niveau de sort" }, limit: { type: "number", default: 25 } } } },
  { name: "get_compendium_entry", description: "Lit une entrée de compendium (traduite en FR si possible).",
    inputSchema: { type: "object", required: ["pack", "id"], properties: { pack: { type: "string" }, id: { type: "string" }, path: { type: "string" } } } },
  { name: "localize_actor", description: "Traduit en FR les objets d'un acteur d'après leur compendium d'origine (comme la traduction d'acteur de Babele) et convertit les unités en mètres/kg si l'option métrique de dnd5e est active. Sans effet sur ce qui est déjà traduit/converti.",
    inputSchema: { type: "object", properties: { actor: { type: "string", description: "Nom ou _id de l'acteur" }, dry_run: { type: "boolean", description: "Aperçu avant/après de chaque champ, sans rien appliquer (sinon instantané de restauration : outil snapshots)" } }, required: ["actor"] } },
  { name: "add_from_compendium", description: "Ajoute des entrées de compendium à un acteur (sorts, objets, butin, classe, espèce, historique, dons...) ou les importe dans le monde si 'actor' est absent (ex. un monstre). Traduit en FR. Pour une classe, 'levels' fixe le niveau et remplit les PV (max au niv. 1, puis moyenne).",
    inputSchema: { type: "object", required: ["entries"], properties: {
      actor: { type: "string", description: "Acteur destinataire (nom ou _id). Absent = import dans le monde." },
      entries: { type: "array", items: { type: "object", properties: {
        pack: { type: "string" }, id: { type: "string" }, name: { type: "string", description: "Alternative à id : nom exact (FR ou EN)" }, uuid: { type: "string", description: "Alternative à pack+id : UUID (Compendium.x.y.Item.id, Item.id, Actor.id.Item.id)" }, item_type: { type: "string" },
        document_type: { type: "string", enum: ["Item", "Actor"], default: "Item", description: "Avec name sans pack : type de compendium où chercher (priorité : monde, puis dnd5e 2024, puis les autres)" }, rules: { type: "string", enum: ["2014", "2024"], description: "Version de règles voulue : si le compendium demandé n'est pas un « 24 », l'entrée 2024 équivalente est prise si elle existe" }, quantity: { type: "number" }, levels: { type: "number" },
        equipped: { type: "boolean" }, overrides: { type: "object", description: "Champs à surcharger (notation pointée)" },
        scroll: { type: "string", description: "Parchemin de sort (comme « Créer un parchemin » de dnd5e) : UUID du sort à mettre sur le parchemin ; le parchemin de base du niveau du sort est pris dans le compendium. Remplace pack/id/uuid." },
        enchant: { type: "object", description: "Applique un enchantement (activité « Enchanter » de dnd5e, ex. objets magiques 2024 « Armure +1, +2 ou +3 » sur une Cuirasse) : {uuid: objet source de l'enchantement, effect: nom ou _id de l'enchantement (ex. \"Armure +2\" ou \"+2\")}",
          properties: { uuid: { type: "string" }, effect: { type: "string" } } } } } },
      folder: { type: "string", description: "Dossier (_id) pour un import dans le monde" } } } },
  { name: "give_loot", description: "Ajoute du butin à un acteur : pièces (pp, po, pe, pa, pc) et/ou objets créés à la volée (nom, type, description, valeur, quantité). Poids : unité du monde (kg si l'option métrique de dnd5e est active, sinon lb) sauf weight_unit ; une valeur en lb est convertie en kg comme le module dnd5e_fr-FR (÷ 2), et inversement.",
    inputSchema: { type: "object", required: ["actor"], properties: {
      actor: { type: "string" },
      mode: { type: "string", enum: ["public", "mj", "aveugle", "prive"], default: "public" },
      weight_unit: { type: "string", enum: ["kg", "lb"], description: "Unité des poids fournis (défaut : unité du monde)" },
      currency: { type: "object", description: "Ex. {\"gp\":50,\"sp\":20} (pp platine, gp or, ep électrum, sp argent, cp cuivre). Valeurs négatives pour retirer." },
      items: { type: "array", items: { type: "object", required: ["name"], properties: {
        name: { type: "string" }, type: { type: "string", default: "loot" }, quantity: { type: "number" },
        description: { type: "string" }, price_gp: { type: "number" }, weight: { type: "number" }, img: { type: "string" },
        rarity: { type: "string", enum: ["", "common", "uncommon", "rare", "veryRare", "legendary", "artifact"] } } } } } } },
  { name: "upload_file", description: "Upload media from base64 or an explicitly allowed HTTPS origin (UPLOAD_ALLOWED_ORIGINS). Supported: PNG, JPEG, WebP, GIF, MP3, OGG, WAV, WebM, MP4, PDF; max 20 MiB. SVG and private-network URLs are blocked. Returns the Foundry file path.",
    inputSchema: { type: "object", required: ["filename"], properties: {
      filename: { type: "string", maxLength: 128 }, folder: { type: "string", maxLength: 256, default: "images/uploads" },
      url: { type: "string", description: "HTTPS URL from an origin configured in UPLOAD_ALLOWED_ORIGINS" },
      base64: { type: "string", description: "Base64 or data:*;base64 payload; provide exactly one of url/base64" } } } },
  { name: "send_chat", description: "Poste un message dans le chat Foundry (texte/HTML), en tant que joueur ou au nom d'un personnage.",
    inputSchema: { type: "object", required: ["content"], properties: {
      content: { type: "string" }, actor: { type: "string", description: "Parler au nom de ce personnage" },
      whisper_to: { type: "array", items: { type: "string" }, description: "Noms d'utilisateurs destinataires (chuchotement)" } } } },
  { name: "advance", description: "Montée de niveau / import avec l'assistant d'avancement de dnd5e (comme dans Foundry) : importe une classe, sous-classe, espèce, historique ou don depuis un compendium (source) ou fait monter une classe déjà présente (item) jusqu'à 'level'. Applique automatiquement aptitudes accordées, maîtrises, PV, sorts de domaine, sous-classe… Si des choix sont nécessaires, renvoie 'choix_requis' (id + options) : rappelle l'outil avec choices = { \"<id>\": valeur }. Valeurs : Trait → [\"skills:ins\", ...] ; AbilityScoreImprovement → {\"wis\":2} ou {\"feat\":\"<uuid>\"} ; ItemChoice → [\"<uuid>\", ...] (+ \"<id>:ability\": \"wis\" pour les sorts) ; Subclass → \"<uuid>\" ; Size → \"med\".",
    inputSchema: { type: "object", required: ["actor"], properties: {
      actor: { type: "string" },
      source: { type: "object", description: "Objet à importer : {pack, id}, {pack, name} ou {uuid} (y compris objets du monde \"Item.<id>\")", properties: { pack: { type: "string" }, id: { type: "string" }, name: { type: "string" }, uuid: { type: "string" } } },
      item: { type: "string", description: "Classe déjà présente sur l'acteur (nom ou _id) à faire monter" },
      level: { type: "number", description: "Niveau de classe visé (défaut : niveau actuel + 1, ou 1 pour un import)" },
      choices: { type: "object" }, hp: { type: "string", enum: ["avg", "max"], default: "avg" },
      spells: { type: "string", enum: ["none", "all"], default: "none", description: "'all' : ajoute tous les sorts de la classe accessibles (liste construite depuis tous les compendiums installés) et demande sorts mineurs (choices['spells:cantrips']) et sorts préparés (choices['spells:prepared'])" } } } },
  { name: "audit_translation", description: "Audit de traduction FR du monde et/ou des compendiums : champs restés en anglais (nom, description, activités, pages de journal, faces de cartes, résultats de tables, effets, objets des acteurs) avec UUID, champ, extrait, statut (anglais / mixte / inconnu ; « traduit » = traduction Babele) et correctif disponible (localize_actor). mode=coverage : part des entrées traduites par compendium / type de document. Heuristique mots-outils FR/EN + noms connus des compendiums traduits. Les compendiums complets sont lourds (≈ 40 s pour tout) : préférer 'packs'.",
    inputSchema: { type: "object", properties: {
      scope: { type: "string", enum: ["world", "packs", "all"], default: "world" },
      packs: { type: "array", items: { type: "string" }, description: "Compendiums à auditer (implique scope=packs)" },
      types: { type: "array", items: { type: "string" }, description: "Types de documents (Actor, Item, JournalEntry, RollTable, Cards, Scene, Playlist)" },
      categories: { type: "array", items: { type: "string", enum: ["nom", "description", "activite", "effet", "page", "carte", "resultat"] } },
      mode: { type: "string", enum: ["issues", "coverage"], default: "issues" },
      statuses: { type: "array", items: { type: "string", enum: ["anglais", "mixte", "inconnu", "fr", "traduit"] }, description: "Statuts à lister (défaut anglais + mixte)" },
      check_fixes: { type: "boolean", default: true, description: "Indiquer si localize_actor peut corriger (objets issus d'un compendium traduit)" },
      limit: { type: "number", default: 300 }, offset: { type: "number" } } } },
  { name: "search_text", description: "Recherche plein texte (sans accents ni casse) dans le monde et les compendiums (noms, descriptions, pages, résultats de tables, cartes, effets, activités, objets des acteurs ; versions FR traduites et d'origine). Renvoie UUID, document, chemin de dossier, champ, extrait.",
    inputSchema: { type: "object", required: ["query"], properties: {
      query: { type: "string" }, scope: { type: "string", enum: ["world", "packs", "all"], default: "all" },
      in: { type: "string", enum: ["all", "name", "text"], default: "all" },
      packs: { type: "array", items: { type: "string" } }, types: { type: "array", items: { type: "string" } },
      limit: { type: "number", default: 50 }, offset: { type: "number" } } } },
  { name: "find_references", description: "Références inverses d'un document (UUID) : où il est utilisé — liens @UUID dans les textes (monde et compendiums), objets d'acteurs copiés depuis lui (compendiumSource), jetons de scène, notes de carte, résultats de tables, effets (origin).",
    inputSchema: { type: "object", required: ["uuid"], properties: {
      uuid: { type: "string", description: "Ex. Compendium.dnd5e.spells24.Item.xxx, JournalEntry.abc, Actor.abc" },
      scope: { type: "string", enum: ["world", "packs", "all"], description: "Défaut : all pour un UUID de compendium, world sinon" },
      packs: { type: "array", items: { type: "string" } }, limit: { type: "number", default: 100 }, offset: { type: "number" } } } },
  ...TABLE_TOOLS, ...CARD_TOOLS,
  ...GM_TOOLS,   // GM-only tools are listed only for GM and assistant GM accounts.
];
export const TOOLS = TOOL_DEFINITIONS.map(englishToolMetadata);

// ---------- helpers D&D / Foundry ----------
async function findActor(fs, ref) {
  if (!ref) throw new Error(message("Actor not specified", "Acteur non précisé"));
  const a = (await fs.doc("get", "Actor", { query: { _id: ref } })).find(x => x._id === ref);
  if (a && isStub(a)) throw limitedError(a.name);
  if (a) return a;
  // fiches réduites au titre (droit LIMITÉ, comptes non MJ) : visibles dans les listes, pas utilisables ici
  const listed = await fs.doc("get", "Actor", { query: {} });
  const all = listed.filter(x => !isStub(x));
  const low = String(ref).toLowerCase();
  const limited = listed.find(x => isStub(x) && (x._id === ref || x.name.toLowerCase() === low));
  if (limited && !all.some(x => x._id === ref || x.name.toLowerCase() === low)) throw limitedError(limited.name);
  const exact = all.filter(x => x.name.toLowerCase() === low);
  if (exact.length === 1) return exact[0];
  const part = exact.length ? exact : all.filter(x => x.name.toLowerCase().includes(low));
  if (part.length === 1) return part[0];
  if (!part.length) throw new Error(message(`No actor matches "${ref}"`, `Aucun acteur ne correspond à « ${ref} »`));
  throw new Error(message(`Multiple actors match "${ref}": ${part.slice(0, 10).map(x => `${x.name} (${x._id})`).join(", ")}`, `Plusieurs acteurs correspondent à « ${ref} » : ${part.slice(0, 10).map(x => `${x.name} (${x._id})`).join(", ")}`));
}
function findItem(actor, ref) {
  const items = actor.items || [];
  const low = String(ref).toLowerCase();
  const hit = items.find(i => i._id === ref) || items.filter(i => i.name.toLowerCase() === low)[0];
  if (hit) return hit;
  const part = items.filter(i => i.name.toLowerCase().includes(low));
  if (part.length === 1) return part[0];
  if (!part.length) throw new Error(message(`"${ref}" was not found on ${actor.name}`, `« ${ref} » introuvable sur ${actor.name}`));
  throw new Error(message(`Multiple items match: ${part.slice(0, 10).map(i => `${i.name} (${i._id})`).join(", ")}`, `Plusieurs objets correspondent : ${part.slice(0, 10).map(i => `${i.name} (${i._id})`).join(", ")}`));
}
async function whisperFor(fs, mode) {
  if (!mode || mode === "public") return {};
  const users = await fs.doc("get", "User", { query: {} });
  const gms = users.filter(u => u.role >= 4).map(u => u._id);
  if (mode === "mj") return { whisper: [...new Set([...gms, fs.userId])] };
  if (mode === "aveugle") return { whisper: gms, blind: true };
  if (mode === "prive") return { whisper: [fs.userId] };
  return {};
}
async function postChat(fs, { actor, flavor, content, rolls = [], mode, extra = {} }) {
  const data = {
    author: fs.userId, content: content ?? (rolls.length === 1 ? String(rolls[0].total) : ""),
    speaker: actor ? { actor: actor._id, alias: actor.name, scene: null, token: null } : { alias: fs.user.name },
    flavor, rolls: rolls.map(r => JSON.stringify(r.roll)), sound: rolls.length ? "sounds/dice.wav" : null,
    ...(await whisperFor(fs, mode)), ...extra,
  };
  const [m] = await fs.doc("create", "ChatMessage", { data: [data], modifiedTime: Date.now() });
  return m?._id;
}
const esc = t => String(t ?? "").replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
async function packsOf(fs) {
  if (!fs._packs || Date.now() - fs._packsAt > 10 * 60 * 1000) {
    const w = await fs.worldData();
    fs._packs = w.packs || []; fs._packsAt = Date.now(); fs._idx = new Map();
  }
  return fs._packs;
}
async function packIndex(fs, pack) {
  await packsOf(fs);
  if (!fs._idx.has(pack.id)) {
    const fields = ["_id", "name", "type", "img", "system.level", "system.rarity", "system.price"];
    let idx = [];
    try { idx = await fs.doc("get", pack.type, { pack: pack.id, query: {}, index: true, indexFields: fields }); } catch { idx = []; }
    const tr = await translations(pack.id);
    fs._idx.set(pack.id, idx.map(e => ({ ...e, name_fr: trFor(tr, e)?.name || null })));
  }
  return fs._idx.get(pack.id);
}
/** Surcharges (notation pointée) ; le nom du jeton suit le nom final de l'acteur s'il valait l'ancien nom. */
function applyOverrides(d, overrides) {
  const before = d.name;
  const follows = d.prototypeToken && (!d.prototypeToken.name || d.prototypeToken.name === before);
  for (const [k, v] of Object.entries(overrides || {})) setPath(d, k, v);
  if (follows && !Object.keys(overrides || {}).some(k => k.startsWith("prototypeToken.name") || k === "prototypeToken")) d.prototypeToken.name = d.name;
  return d;
}
/**
 * Poids d'un objet de butin dans l'unité du monde (réglage dnd5e metricWeightUnits : kg, sinon lb).
 * La valeur fournie est dans `unit` (défaut : unité du monde) ; lb → kg divise par 2 comme le module dnd5e_fr-FR
 * (convention des traductions françaises), kg → lb multiplie par 2.
 */
export function lootWeight(value, unit, metric = UNITS.weight) {
  const units = metric ? "kg" : "lb";
  let v = Number(value) || 0;
  const from = unit === "kg" || unit === "lb" ? unit : units;
  if (from === "lb" && units === "kg") v = v / 2;
  if (from === "kg" && units === "lb") v = v * 2;
  return { value: Math.round(v * 100) / 100, units };
}
const randomId = () => { const c = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"; return Array.from(crypto.randomBytes(16), b => c[b % c.length]).join(""); };
const norm = t => String(t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const setPath = setSafePath;

function makeServer(fs) {
  const server = new Server({ name: "foundry-vtt", version: "1.0.0" }, { capabilities: { tools: {} } });
  const isGM = (Number(fs.user?.role) || 0) >= GM_ROLE;
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS.filter(t => !t.gm || isGM).map(({ gm, ...t }) => t) }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => handleTool(fs, params));
  return server;
}

export async function handleTool(fs, params) {
  const r = await runTool(fs, params);
  if (!r?.[OUT]) return r;
  return { content: [{ type: "text", text: r.value === undefined ? message("(empty)", "(vide)") : render(responseAliases(params.name, r.value), fs.userId) }] };
}

async function runTool(session, params) {
  // comptes non MJ : lectures filtrées selon les droits Foundry (voir access.mjs) ; `session` (non filtrée) ne sert
  // qu'au calcul des cibles de use_item / apply_damage (CA, sauvegardes), qui ne renvoie pas les fiches des cibles.
  const fs = restrictedSession(session);
  try { await refreshUnits(fs); } catch { /* pas bloquant */ }
    const a = params.arguments || {};
    try {
      switch (params.name) {
        case "world_info": {
          const users = await fs.doc("get", "User", { query: {} });
          return out({ world: { id: fs.world.id, title: fs.world.title, system: fs.world.system, coreVersion: fs.world.coreVersion },
            connecte_en_tant_que: { ...fs.user, role: ROLES[fs.user.role] },
            utilisateurs: users.map(u => ({ _id: u._id, name: u.name, role: ROLES[u.role], character: u.character })) });
        }
        case "list_documents": {
          let docs = await fs.doc("get", a.type, { query: {}, ...parentOpt(a.parent, a.pack) });
          if (a.name_contains) docs = docs.filter(d => (d.name || "").toLowerCase().includes(a.name_contains.toLowerCase()));
          if (a.filter) docs = docs.filter(d => matches(d, a.filter));
          // pagination stable : ordre par _id (ordre de Foundry), curseur = dernier _id renvoyé (insensible aux
          // créations/suppressions entre deux pages) ou offset ; la page s'arrête avant de dépasser la taille max.
          docs.sort((x, y) => (x._id < y._id ? -1 : x._id > y._id ? 1 : 0));
          const total = docs.length;
          const fields = a.fields?.length ? a.fields : ["name", "type", "folder"];
          let start = Math.max(0, Number(a.offset) || 0);
          if (a.cursor) { start = docs.findIndex(d => d._id > a.cursor); if (start < 0) start = total; }
          const limit = Math.max(1, Math.min(Number(a.limit) || 200, 5000));
          const page = [];
          let size = 200;
          for (let i = start; i < total && page.length < limit; i++) {
            const p = pick(docs[i], fields), n = JSON.stringify(p, null, 1).length + 3;
            if (page.length && size + n > MAX_OUT * 0.9) break;
            page.push(p); size += n;
          }
          const end = start + page.length;
          return out({ total, offset: start, count: page.length,
            next_cursor: end < total ? page.at(-1)._id : null, next_offset: end < total ? end : null, documents: page });
        }
        case "next_page": return out(nextPage(a.cursor, fs.userId));
        case "get_document": {
          // le filtre _id n'est pas appliqué par Foundry sur les collections embarquées : on filtre ici
          const d = (await fs.doc("get", a.type, { query: { _id: a.id }, ...parentOpt(a.parent, a.pack) })).find(x => x._id === a.id);
          if (!d) return out(message(`Not found: ${a.type} ${a.id}`, `Introuvable : ${a.type} ${a.id}`));
          if (isStub(d) && a.path && !(a.path.split(".")[0] in d)) throw limitedError(d.name);
          return out(getPath(d, a.path));
        }
        case "create_documents": {
          // comme un import de compendium : identifiants d'avancement/activité/effet corrigés avant création
          // (Foundry v14 exige 16 alphanumériques ; un seul identifiant invalide fait disparaître l'objet de la fiche).
          const changed = [];
          const seen = new Set();
          const eachItem = (obj, fn) => {
            if (!obj || typeof obj !== "object" || seen.has(obj)) return;
            seen.add(obj);
            if (obj.system) fn(obj);
            for (const it of obj.items || []) eachItem(it, fn);
            for (const e of obj.effects || []) eachItem(e, fn);
            for (const p of obj.pages || []) eachItem(p, fn);
          };
          for (const d of a.data) eachItem(d, x => changed.push(...sanitizeItemData(x)));
          const r = await fs.doc("create", a.type, { data: a.data, modifiedTime: Date.now(), render: true, renderSheet: false, ...parentOpt(a.parent, a.pack) });
          // objets créés sans activité ni effet (typiquement écrits à la main) : proposer une source de compendium
          const warns = [];
          if (a.type === "Item" || a.type === "Actor") {
            const created = Array.isArray(r) ? r : [r];
            const pools = {};
            const fill = async p => { if (!pools[p]) { try { pools[p] = await fs.doc("get", "Item", { pack: p, query: {}, index: true, indexFields: ["name"] }); } catch { pools[p] = []; } } return pools[p]; };
            for (const d of created) {
              // acteur : seuls ses objets sont contrôlés (« aucune activité » ne concerne pas l'acteur lui-même)
              for (const it of (a.type === "Actor" ? (d.items || []) : [d])) {
                const w0 = itemWarnings(it);
                if (!w0.length) continue;
                const byName = [];
                for (const p of (a.warn_packs || ["world.capacites-de-classe", "world.sors", "world.objets", "world.dons", "world.classes-and-sous-classes", "dnd5e.classes24", "dnd5e.spells24", "dnd5e.equipment24"])) {
                  if (byName.length) break;
                  const hit = (await fill(p)).filter(x => norm(x.name) === norm(it.name));
                  if (hit.length) byName.push({ pack: p, _id: hit[0]._id, name: it.name, type: hit[0].type });
                }
                const label = `${it.name} (${it.type}) : ${w0.join(", ")}`;
                if (byName.length) warns.push(message(`${label} — possible source: ${byName.map(b => `${b.pack}.${b.type}.${b._id}`).join(", ")} (add_from_compendium {pack, id} or gm_sync_items)`, `${label} — source possible : ${byName.map(b => `${b.pack}.${b.type}.${b._id}`).join(", ")} (add_from_compendium {pack, id} ou gm_sync_items)`));
                else if (w0.some(w => w.includes(message("no activity", "aucune activité")))) warns.push(label);
              }
            }
          }
          return out({ crees: r.map(d => ({ _id: d._id, name: d.name })),
            ...(changed.length ? { identifiants_corriges: [...new Set(changed)] } : {}),
            ...(warns.length ? { a_verifier: warns } : {}) });
        }
        case "update_documents": {
          const o = { type: a.type, pack: a.pack, parent: a.parent };
          const diff = diffUpdates(await currentDocs(fs, o, a.updates.map(u => u._id)), a.updates);
          if (a.dry_run) return out({ simulation: true, documents: diff.preview });
          if (diff.preview.some(p => p.erreur)) throw new Error(message(
            "Document update aborted: original document unavailable for snapshot",
            "Mise à jour des documents interrompue : document d'origine introuvable pour l'instantané"));
          if (!diff.entries.length) return out({ modifies: 0, resultat: [], note: message("No changes necessary", "Aucune modification nécessaire") });
          const snap = await saveSnapshot(fs, "update_documents", `${a.type} : ${diff.entries.map(e => e.nom || e._id).slice(0, 5).join(", ")}${diff.entries.length > 5 ? "…" : ""}`, [{ action: "update", ...o, entries: diff.entries }]);
          if (!snap) throw new Error(message("Document update aborted: no recovery snapshot was created",
            "Mise à jour des documents interrompue : aucun instantané de restauration créé"));
          const r = await fs.doc("update", a.type, { updates: a.updates, diff: true, recursive: true, modifiedTime: Date.now(), render: true, ...parentOpt(a.parent, a.pack) });
          return out({ modifies: r.length, instantane: snap, resultat: r });
        }
        case "delete_documents": {
          const o = { type: a.type, pack: a.pack, parent: a.parent };
          const docs = await currentDocs(fs, o, a.ids);
          if (a.dry_run) return out({ simulation: true, seraient_supprimes: docs.map(d => ({ _id: d._id, nom: d.name, type: d.type })), introuvables: a.ids.filter(id => !docs.some(d => d._id === id)) });
          if (docs.length !== new Set(a.ids).size) throw new Error(message(
            "Document deletion aborted: original document unavailable for snapshot",
            "Suppression des documents interrompue : document d'origine introuvable pour l'instantané"));
          const snap = await saveSnapshot(fs, "delete_documents", `suppression ${a.type} : ${docs.map(d => d.name || d._id).slice(0, 5).join(", ")}`, [{ action: "delete", ...o, docs }]);
          if (!snap) throw new Error(message("Document deletion aborted: no recovery snapshot was created",
            "Suppression des documents interrompue : aucun instantané de restauration créé"));
          const r = await fs.doc("delete", a.type, { ids: a.ids, modifiedTime: Date.now(), render: true, ...parentOpt(a.parent, a.pack) });
          return out({ supprimes: r, instantane: snap });
        }
        case "apply_damage": return out(await applyDamage(session, a, { postChat }));
        case "roll_table": return out(await handleTable(fs, a, { postChat }));
        case "cards": return out(await handleCards(fs, a, { postChat }));
        case "audit_translation": return out(await auditTranslation(fs, a, { packsOf, packIndex }));
        case "search_text": return out(await searchText(fs, a, { packsOf }));
        case "find_references": return out(await findReferences(fs, a, { packsOf }));
        case "snapshots": {
          const isGM = (Number(fs.user?.role) || 0) >= GM_ROLE;
          if (!a.action || a.action === "list") return out(await listSnapshots(fs, isGM, { limit: a.limit || 30, tool: a.tool }));
          if (!a.id) throw new Error(message("Specify 'id'", "Préciser 'id'"));
          if (a.action === "show") return out(await showSnapshot(fs, isGM, a.id));
          if (a.action === "restore") return out(await restoreSnapshot(fs, isGM, a.id, { dryRun: !!a.dry_run }));
          throw new Error(message(`Unknown action: ${a.action}`, `Action inconnue : ${a.action}`));
        }

        case "actor_sheet": return out(sheet(await findActor(fs, a.actor)));
        case "roll": {
          const actor = a.actor ? await findActor(fs, a.actor) : null;
          const r = rollFormula(a.formula, { flavor: a.flavor });
          await postChat(fs, { actor, flavor: a.flavor || a.formula, rolls: [r], mode: a.mode });
          return out({ total: r.total, formule: r.formula, des: r.dice });
        }
        case "check": {
          const actor = await findActor(fs, a.actor);
          const { bonus, label } = checkBonus(actor, a.kind, a.key);
          const d20 = a.advantage && !a.disadvantage ? "2d20kh1" : a.disadvantage && !a.advantage ? "2d20kl1" : "1d20";
          const r = rollFormula(`${d20}${bonus >= 0 ? "+" : ""}${bonus}`, { flavor: label });
          const flavor = `${label}${a.advantage ? " (avantage)" : a.disadvantage ? " (désavantage)" : ""}`;
          await postChat(fs, { actor, flavor, rolls: [r], mode: a.mode });
          if (a.kind === "initiative") {
            const combats = await fs.doc("get", "Combat", { query: {} });
            for (const c of combats.filter(c => c.active)) {
              const cb = (c.combatants || []).find(x => x.actorId === actor._id);
              if (cb) await fs.doc("update", "Combatant", { parentUuid: `Combat.${c._id}`, updates: [{ _id: cb._id, initiative: r.total }], modifiedTime: Date.now() });
            }
          }
          return out({ jet: flavor, total: r.total, formule: r.formula, des: r.dice });
        }
        case "use_item": {
          const actor = await findActor(fs, a.actor);
          const item = findItem(actor, a.item);
          const tgts = [];
          for (const ref of (typeof a.targets === "string" ? [a.targets] : a.targets || [])) tgts.push(await resolveTarget(session, ref));   // erreurs avant toute consommation
          const res = useItem(actor, item, { activityId: a.activity, slotLevel: a.slot_level, advantage: a.advantage, disadvantage: a.disadvantage, consume: a.consume !== false, versatile: a.versatile });
          const prop = tgts.length ? await propose(session, { attacker: actor, item, res, targets: tgts, mode: a.mode }) : null;
          if (prop) { res.rolls.push(...prop.saveRolls); for (const r of prop.rows) res.lignes.push(`${r.cible} : ${[r.attaque, r.sauvegarde].filter(Boolean).join(" ; ") || "ciblé"}`); }
          if (Object.keys(res.actorUpdate).length) await fs.doc("update", "Actor", { updates: [{ _id: actor._id, ...res.actorUpdate }], diff: true, modifiedTime: Date.now() });
          if (res.deleteItem) await fs.doc("delete", "Item", { parentUuid: `Actor.${actor._id}`, ids: [item._id], modifiedTime: Date.now() });
          else if (Object.keys(res.itemUpdate).length) await fs.doc("update", "Item", { parentUuid: `Actor.${actor._id}`, updates: [{ _id: item._id, ...res.itemUpdate }], diff: true, modifiedTime: Date.now() });
          const desc = item.system?.description?.value || "";
          const card = `<div class="dnd5e2 chat-card"><h3><img src="${esc(item.img)}" width="32" height="32" style="vertical-align:middle;border:none"> ${esc(item.name)}${a.slot_level ? message(` (lvl. ${a.slot_level})`, ` (niv. ${a.slot_level})`) : ""}</h3>`
            + (a.target || tgts.length ? `<p><b>${message("Target:", "Cible :")}</b> ${esc([a.target, ...tgts.map(t => t.label)].filter(Boolean).join(", "))}</p>` : "")
            + `<ul>${res.lignes.map(l => `<li>${esc(l)}</li>`).join("")}</ul>`
            + (desc ? `<details><summary>${message("Description", "Description")}</summary>${desc}</details>` : "") + `</div>`;
          await postChat(fs, { actor, flavor: item.name, content: card, rolls: res.rolls, mode: a.mode });
          return out({ objet: item.name, resultats: res.lignes, ...(prop ? { proposition: prop.id, cibles: prop.rows,
            validation: message(`Nothing has been applied to targets yet: apply_damage {proposal: "${prop.id}"} (use targets for a subset, overrides to adjust).`,
              `Rien n'est encore appliqué aux cibles : apply_damage {proposal: "${prop.id}"} (option targets pour un sous-ensemble, overrides pour corriger).`) } : {}) });
        }
        case "rest": {
          const actor = await findActor(fs, a.actor);
          const s = actor.system, d = derive(actor), upd = {}, lines = [];
          const sh = sheet(actor);
          if (a.type === "long") {
            upd["system.attributes.hp.value"] = sh.pv.max; upd["system.attributes.hp.temp"] = 0;
            for (const [k, m] of Object.entries(slotMax(actor))) if (k !== "pactLevel") upd[`system.spells.${k}.value`] = m;
            lines.push(message(`HP restored to ${sh.pv.max}`, `PV restaurés à ${sh.pv.max}`),
              message("Spell slots restored", "Emplacements de sort restaurés"));
          } else {
            const mx = slotMax(actor); if (mx.pact) { upd["system.spells.pact.value"] = mx.pact; lines.push(message("Pact slots restored", "Emplacements de pacte restaurés")); }
          }
          await fs.doc("update", "Actor", { updates: [{ _id: actor._id, ...upd }], diff: true, modifiedTime: Date.now() });
          const per = a.type === "long" ? ["lr", "sr", "day"] : ["sr"];
          const iu = [];
          for (const i of actor.items || []) {
            const u = {};
            if (i.system?.uses?.max && (i.system.uses.recovery || []).some(r => per.includes(r.period))) u["system.uses.spent"] = 0;
            if (i.type === "class" && a.type === "long") { const spent = Math.max(0, num0(i.system.hd?.spent) - Math.max(1, Math.floor(num0(i.system.levels) / 2))); u["system.hd.spent"] = spent; }
            for (const [aid, act] of Object.entries(i.system?.activities || {})) if (act.uses?.max && (act.uses.recovery || []).some(r => per.includes(r.period))) u[`system.activities.${aid}.uses.spent`] = 0;
            if (Object.keys(u).length) iu.push({ _id: i._id, ...u });
          }
          if (iu.length) { await fs.doc("update", "Item", { parentUuid: `Actor.${actor._id}`, updates: iu, diff: true, modifiedTime: Date.now() }); lines.push(message(`${iu.length} item(s)/feature(s) recharged`, `${iu.length} objet(s)/aptitude(s) rechargé(s)`)); }
          const restEn = a.type === "long" ? "long" : "short";
          await postChat(fs, { actor, flavor: message(`${restEn === "long" ? "Long" : "Short"} rest`, `Repos ${a.type}`),
            content: message(`<p>${esc(actor.name)} takes a ${restEn} rest.</p>`, `<p>${esc(actor.name)} prend un repos ${a.type}.</p>`)
              + `<ul>${lines.map(l => `<li>${esc(l)}</li>`).join("")}</ul>`, mode: a.mode });
          return out({ repos: a.type, effets: lines });
        }
        case "list_packs": {
          const packs = (await packsOf(fs)).filter(p => !a.type || p.type === a.type);
          const res = [];
          for (const p of packs) res.push({ id: p.id, nom: p.label, type: p.type, entrees: p.index?.length ?? null, fr: !!(await translations(p.id)) });
          return out(res);
        }
        case "search_compendium": {
          const q = norm(a.query);
          const packs = (await packsOf(fs)).filter(p => !a.pack || p.id === a.pack);
          // priorité 2024 : à score égal, une entrée « 2024 » (monde ou dnd5e.*24) passe avant une version 2014
          const rank = e => (String(e.system?.source?.rules || e.flags?.plutonium?.source || "") === "2024" ? 0 : 1);
          const packRank = id => /24$/.test(String(id)) ? 0 : 1;
          const hits = [];
          for (const p of packs) {
            for (const e of await packIndex(fs, p)) {
              if (a.item_type && e.type !== a.item_type) continue;
              if (a.level != null && e.system?.level !== a.level) continue;
              const nf = norm(e.name_fr), ne = norm(e.name);
              const score = nf === q || ne === q ? 3 : nf.startsWith(q) || ne.startsWith(q) ? 2 : nf.includes(q) || ne.includes(q) ? 1 : 0;
              if (score) hits.push({ score, pack: p.id, _id: e._id, nom: e.name_fr || e.name, nom_en: e.name, type: e.type, niveau: e.system?.level, rarete: e.system?.rarity || undefined,
                _r: rank(e), _p: packRank(p.id) });
            }
          }
          hits.sort((x, y) => y.score - x.score || x._r - y._r || x._p - y._p || x.nom.localeCompare(y.nom));
          const rules = hits.length && hits[0]._r === 0 && hits.some(h => h._r === 1)
            ? message("2024 preferred (a 2014 version also exists)", "2024 privilégié (une version 2014 existe aussi)") : undefined;
          return out({ total: hits.length, ...(rules ? { note: rules } : {}),
            resultats: hits.slice(0, a.limit || 25).map(({ score, _r, _p, ...h }) => h) });
        }
        case "get_compendium_entry": {
          const pack = (await packsOf(fs)).find(p => p.id === a.pack);
          if (!pack) return out(message(`Unknown compendium: ${a.pack}`, `Compendium inconnu : ${a.pack}`));
          const d = (await fs.doc("get", pack.type, { pack: pack.id, query: { _id: a.id } })).find(x => x._id === a.id);
          if (!d) return out(message("Entry not found", "Entrée introuvable"));
          if (isStub(d) && a.path && !(a.path.split(".")[0] in d)) throw limitedError(d.name);
          return out(getPath(await translateDoc(pack.id, d), a.path));
        }
        case "localize_actor": {
          const act = await findActor(fs, a.actor);
          await refreshUnits(fs);
          const items = await fs.doc("get", "Item", { parentUuid: `Actor.${act._id}`, query: {} });
          const updates = [], noms = [], effUps = [];
          // acteur venu d'un compendium d'acteurs (monstre…) : ses objets se traduisent par l'entrée de l'acteur source
          const actorCtx = await actorTranslationContext(act, fs);
          for (const it of items) {
            const fromActor = actorCtx?.forItem(it);
            const up = await localizeItem(it, fs, fromActor ? { entry: fromActor.entry, sourceEffects: fromActor.sourceEffects } : {});
            if (up.__effects) { effUps.push([it._id, up.__effects]); noms.push(`${up.name || it.name} : ${up.__effects.length} effet(s)`); }
            if (Object.keys(up).length) { updates.push({ _id: it._id, ...up }); noms.push(up.name ? `${it.name} → ${up.name}` : `${it.name} (${up["system.description.value"] ? "description" : up["system.materials.value"] ? "composantes" : "unités"})`); }
          }
          const aup = actorMetricUpdates(act);
          // avant/après de chaque champ (aperçu en simulation, instantané de restauration sinon)
          const itemDiff = diffUpdates(items, updates);
          const actorDiff = diffUpdates([act], Object.keys(aup).length ? [{ _id: act._id, ...aup }] : []);
          const effDiffs = effUps.map(([iid, eu]) => [iid, diffUpdates(items.find(i => i._id === iid)?.effects || [], eu)]);
          if (a.dry_run) return out({ acteur: act.name, simulation: true, objets: itemDiff.preview, acteur_modifie: actorDiff.preview,
            effets: effDiffs.flatMap(([iid, d]) => d.preview.map(p => ({ objet: iid, ...p }))) });
          let snap = null;
          if (!a.dry_run) {
            snap = await saveSnapshot(fs, "localize_actor", `traduction/unités de ${act.name}`, [
              { action: "update", type: "Item", parent: `Actor.${act._id}`, entries: itemDiff.entries },
              { action: "update", type: "Actor", entries: actorDiff.entries },
              ...effDiffs.map(([iid, d]) => ({ action: "update", type: "ActiveEffect", parent: `Actor.${act._id}.Item.${iid}`, entries: d.entries }))]);
            for (let i = 0; i < updates.length; i += 50) await fs.doc("update", "Item", { parentUuid: `Actor.${act._id}`, updates: updates.slice(i, i + 50), diff: true, recursive: true, modifiedTime: Date.now(), render: true });
            if (Object.keys(aup).length) await fs.doc("update", "Actor", { updates: [{ _id: act._id, ...aup }], diff: true, recursive: true, modifiedTime: Date.now(), render: true });
            for (const [iid, eu] of effUps)
              await fs.doc("update", "ActiveEffect", { parentUuid: `Actor.${act._id}.Item.${iid}`, updates: eu, diff: true, recursive: true, modifiedTime: Date.now(), render: true });
          }
          return out({ acteur: act.name, objets_modifies: updates.length, effets_modifies: effUps.reduce((n, [, e]) => n + e.length, 0), acteur_modifie: Object.keys(aup), detail: noms, simulation: !!a.dry_run, instantane: snap || undefined });
        }
        case "add_from_compendium": {
          const actor = a.actor ? await findActor(fs, a.actor) : null;
          const packs = await packsOf(fs);
          const byType = {};
          const missing = [], enchants = [], notes0 = [];
          for (const e of a.entries) {
            if (e.scroll) {
              const d = await scrollFromSpell(fs, e.scroll);
              if (e.quantity != null) d.system.quantity = e.quantity;
              for (const [k, v] of Object.entries(e.overrides || {})) setPath(d, k, v);
              (byType.Item ??= []).push(d);
              continue;
            }
            if (e.uuid) {
              const d = structuredClone(await fetchUuid(fs, e.uuid));
              delete d._id; delete d.folder; delete d.sort; delete d.ownership;
              d._stats = { ...(d._stats || {}), compendiumSource: e.uuid };
              if (e.quantity != null && d.system) d.system.quantity = e.quantity;
              if (e.equipped != null && d.system) d.system.equipped = e.equipped;
              delete d.__pack;
              applyOverrides(d, e.overrides);
              const t = d.items || d.prototypeToken ? "Actor" : "Item";
              (byType[t] ??= []).push(d);
              if (e.enchant) { d._id = randomId(); enchants.push({ type: t, id: d._id, ...e.enchant }); }
              continue;
            }
            const selected = await resolveImportEntry(fs, packs, e, p => packIndex(fs, p));
            if (selected.missing) { missing.push(selected.missing); continue; }
            const { pack, source: src, id } = selected;
            const d = await translateDoc(pack.id, src);
            delete d._id; delete d.folder; delete d.sort; delete d.ownership;
            d._stats = { ...(d._stats || {}), compendiumSource: `Compendium.${pack.id}.${pack.type}.${id}` };
            if (e.quantity != null && d.system) d.system.quantity = e.quantity;
            if (e.equipped != null && d.system) d.system.equipped = e.equipped;
            if (d.type === "class" && e.levels) {
              d.system.levels = e.levels;
              const isFirst = !(actor?.items || []).some(i => i.type === "class");
              const advList = Array.isArray(d.system.advancement) ? d.system.advancement : Object.values(d.system.advancement || {});
              const hpAdv = advList.find(x => x.type === "HitPoints");
              if (hpAdv) { hpAdv.value = {}; for (let l = 1; l <= e.levels; l++) hpAdv.value[l] = l === 1 && isFirst ? "max" : "avg"; }
              if (isFirst && actor) {
                const saves = advList.filter(x => x.type === "Trait" && (x.level ?? 1) <= 1)
                  .flatMap(x => x.configuration?.grants || []).filter(g => g.startsWith("saves:")).map(g => g.split(":")[1]);
                if (saves.length) {
                  await fs.doc("update", "Actor", { updates: [{ _id: actor._id, ...Object.fromEntries(saves.map(k => [`system.abilities.${k}.proficient`, 1])) }], diff: true, modifiedTime: Date.now() });
                  e._note = `Sauvegardes maîtrisées : ${saves.join(", ")}`;
                }
              }
            }
            applyOverrides(d, e.overrides);
            (byType[pack.type] ??= []).push(d);
            if (e.enchant) { d._id = randomId(); enchants.push({ type: pack.type, id: d._id, ...e.enchant }); }
          }
          for (const list of Object.values(byType)) for (const d of list) if (d.system) {
            const r = applyPatches(d);   // entrées de compendium à structure incomplète (cantrips d'arme…)
            Object.keys(d).forEach(k => delete d[k]); Object.assign(d, r.doc);
            sanitizeItemData(d);
            if (actor && d.system.container) d.system.container = null;
            if (r.appliques.length) notes0.push(`${d.name} : ${r.appliques.join(", ")}`);
          }
          const created = [], createdBy = {};
          for (const [type, data] of Object.entries(byType)) {
            if (actor && type !== "Item") throw new Error(message(`Cannot add a ${type} to an actor`, `Impossible d'ajouter un ${type} à un acteur`));
            if (!actor && a.folder) data.forEach(d => d.folder = a.folder);
            const r = await fs.doc("create", type, { data, keepId: data.some(d => d._id), modifiedTime: Date.now(), ...(actor ? { parentUuid: `Actor.${actor._id}` } : {}) });
            createdBy[type] = r;
            created.push(...r.map(x => ({ _id: x._id, nom: x.name, type: x.type })));
          }
          // Enchantements : équivalent d'EnchantActivity#applyEnchantment de dnd5e (copie de l'effet
          // d'enchantement sur l'objet cible, activé, origin = l'activité source).
          for (const en of enchants) {
            // Foundry ne renvoie pas forcément les documents créés dans l'ordre envoyé : on retrouve la cible par son _id
            const target = (createdBy[en.type] || []).find(x => x._id === en.id);
            if (!target || en.type !== "Item") continue;
            const src = await fetchUuid(fs, en.uuid);
            const acts = Object.values(src.system?.activities || {}).filter(x => x.type === "enchant");
            const q = norm(String(en.effect || ""));
            const pool = (src.effects || []).filter(x => x.type === "enchantment" && acts.some(ac => (ac.effects || []).some(r => r._id === x._id)));
            const eff = pool.find(x => x._id === en.effect) || pool.find(x => norm(x.name) === q) || pool.find(x => q && norm(x.name).endsWith(q))
              || (pool.length === 1 ? pool[0] : null);
            if (!eff) throw new Error(message(`Enchantment "${en.effect}" not found in ${en.uuid} (available: ${pool.map(x => x.name).join(", ")})`, `Enchantement « ${en.effect} » introuvable dans ${en.uuid} (disponibles : ${pool.map(x => x.name).join(", ")})`));
            const act = acts.find(ac => (ac.effects || []).some(r => r._id === eff._id));
            const ed = structuredClone(eff); delete ed._id; delete ed._stats; delete ed.folder;
            // gabarit de nom en mots anglais (« {} of the War Mage, +1 ») : la traduction ne couvre pas les changements ;
            // on prend le nom traduit de l'enchantement s'il commence par le nom de l'objet (« Baguette du mage de guerre +1 »).
            for (const ch of ed.system?.changes || []) {
              if (ch.key !== "name" || typeof ch.value !== "string" || !ch.value.includes("{}")) continue;
              const words = ch.value.replace("{}", "").replace(/[+\d\s,()-]/g, "");
              const base = String(target.name || "");
              if (words && eff.name && base && eff.name.toLowerCase().startsWith(base.toLowerCase())) ch.value = "{}" + eff.name.slice(base.length);
            }
            // dnd5e 6 / Foundry v14 : l'origine d'un enchantement appliqué est system.origin.activity
            ed.disabled = false;
            // DAE (si actif) rattache la clé « name » à « token.name » (phase finale) et écarte alors le
            // changement de nom de l'objet (« {} +2 ») : phaseStamped lui fait respecter la phase de dnd5e.
            ed.flags = { ...(ed.flags || {}), dnd5e: { ...(ed.flags?.dnd5e || {}), enchantmentProfile: eff._id }, dae: { ...(ed.flags?.dae || {}), phaseStamped: true } };
            ed.system = { ...(ed.system || {}), origin: { ...(ed.system?.origin || {}), activity: `${en.uuid}.Activity.${act._id}`, profile: eff._id } };
            const parentUuid = actor ? `Actor.${actor._id}.Item.${target._id}` : `Item.${target._id}`;
            const [ench] = await fs.doc("create", "ActiveEffect", { parentUuid, data: [ed], modifiedTime: Date.now() });
            // « riders » du profil d'enchantement (dnd5e : EnchantmentData, à la création de l'enchantement, côté
            // navigateur) : effets et activités de l'objet source recopiés sur l'objet enchanté, dépendants de l'enchantement.
            const profile = (act.effects || []).find(r => r._id === eff._id) || {};
            const riderEffects = [];
            for (const id of profile.riders?.effect || []) {
              const se = (src.effects || []).find(x => x._id === id);
              if (!se || (se.type && se.type !== "base")) continue;
              const r = structuredClone(se); delete r._id; delete r._stats; delete r.folder;
              if (r.flags?.dnd5e) delete r.flags.dnd5e.rider;
              r.system = { ...(r.system || {}), origin: { ...(ed.system?.origin || {}) } };
              r.flags = { ...(r.flags || {}), dnd5e: { ...(r.flags?.dnd5e || {}), dependentOn: ench?._id } };
              riderEffects.push(r);
            }
            if (riderEffects.length) await fs.doc("create", "ActiveEffect", { parentUuid, data: riderEffects, modifiedTime: Date.now() });
            const riderActs = {};
            for (const id of profile.riders?.activity || []) {
              const sa = src.system?.activities?.[id];
              if (!sa) continue;
              const na = structuredClone(sa); na._id = randomId();
              na.flags = { ...(na.flags || {}), dnd5e: { ...(na.flags?.dnd5e || {}), dependentOn: ench?._id } };
              riderActs[na._id] = na;
            }
            if (Object.keys(riderActs).length) await fs.doc("update", "Item", { parentUuid: actor ? `Actor.${actor._id}` : undefined,
              updates: [{ _id: target._id, ...Object.fromEntries(Object.entries(riderActs).map(([k, v]) => [`system.activities.${k}`, v])) }], diff: true, modifiedTime: Date.now() });
            const c = created.find(x => x._id === target._id); if (c) c.enchantement = eff.name;
          }
          const notes = [...notes0, ...a.entries.map(e => e._note).filter(Boolean)];
          if (created.some(c => c.type === "class")) notes.push(message(
            "Level-up wizard not run (headless): add class features, chosen skills and proficiencies using search_compendium/add_from_compendium/update_documents.",
            "Assistant de niveau non exécuté (headless) : ajoute aptitudes de classe, compétences et maîtrises au choix via search_compendium/add_from_compendium/update_documents."));
          if (missing.length) notes.push(message(`Not found in compendium: ${missing.join(", ")}`, `Introuvables dans le compendium : ${missing.join(", ")}`));
          if (actor) { const cn = await ensureCastSpells(fs, actor._id); if (cn.length) notes.push(message(`Feature spells added: ${cn.join(", ")}`, "Sorts d'aptitude ajoutés : " + cn.join(", "))); }
          return out({ ajoutes: created, a: actor ? actor.name : "monde", notes });
        }
        case "give_loot": {
          const actor = await findActor(fs, a.actor);
          const lines = [];
          if (a.currency) {
            const cur = { ...(actor.system.currency || {}) }, upd = {};
            for (const [k, v] of Object.entries(a.currency)) {
              const key = { po: "gp", pa: "sp", pc: "cp", pe: "ep", pp: "pp" }[k] || k;
              upd[`system.currency.${key}`] = Math.max(0, num0(cur[key]) + num0(v));
              lines.push(`${v >= 0 ? "+" : ""}${v} ${key}`);
            }
            await fs.doc("update", "Actor", { updates: [{ _id: actor._id, ...upd }], diff: true, modifiedTime: Date.now() });
          }
          if (a.items?.length) {
            const data = a.items.map(i => ({ name: i.name, type: i.type || "loot", img: i.img || undefined,
              system: { quantity: i.quantity ?? 1, description: { value: i.description ? `<p>${esc(i.description)}</p>` : "" },
                price: { value: i.price_gp ?? 0, denomination: "gp" }, weight: lootWeight(i.weight, a.weight_unit), rarity: i.rarity || "" } }));
            const r = await fs.doc("create", "Item", { parentUuid: `Actor.${actor._id}`, data, modifiedTime: Date.now() });
            lines.push(...r.map(x => `${x.name}${x.system?.quantity > 1 ? " ×" + x.system.quantity : ""}`));
          }
          await postChat(fs, { actor, flavor: message("Loot", "Butin"),
            content: message(`<p><b>${esc(actor.name)}</b> receives:</p>`, `<p><b>${esc(actor.name)}</b> reçoit :</p>`)
              + `<ul>${lines.map(l => `<li>${esc(l)}</li>`).join("")}</ul>`, mode: a.mode });
          return out({ a: actor.name, recu: lines });
        }
        case "upload_file": {
          const { filename, folder, mime } = validateUploadDestination(a.filename, a.folder);
          if (!!a.url === !!a.base64) throw new Error(message("Provide exactly one of 'url' or 'base64'",
            "Fournir exactement l'un des paramètres « url » ou « base64 »"));
          const buf = a.url ? await downloadPublicFile(a.url) : decodeUploadBase64(a.base64);
          validateUploadContent(buf, filename);
          const path = await fs.upload(folder, filename, buf, mime);
          return out({ chemin: path, ...(PUBLIC_URL ? { url: `${PUBLIC_URL}/${encodeURI(path)}` } : {}) });
        }
        case "send_chat": {
          const actor = a.actor ? await findActor(fs, a.actor) : null;
          let extra = {};
          if (a.whisper_to?.length) {
            const users = await fs.doc("get", "User", { query: {} });
            extra.whisper = a.whisper_to.map(n => users.find(u => u.name.toLowerCase() === n.toLowerCase())?._id).filter(Boolean);
          }
          const id = await postChat(fs, { actor, content: a.content, extra });
          return out({ message: id });
        }

        case "advance": {
          let actor = await findActor(fs, a.actor);
          // fiches créées avant que le MCP écrive advancementRoot : on le complète en remontant la chaîne d'origines
          {
            const byId = new Map((actor.items || []).map(i => [i._id, i]));
            const rootFor = (it, seen = new Set()) => {
              const f = it.flags?.dnd5e || {};
              if (f.advancementRoot) return f.advancementRoot;
              if (!f.advancementOrigin) return null;
              const parent = byId.get(f.advancementOrigin.split(".")[0]);
              if (!parent || seen.has(parent._id)) return f.advancementOrigin;
              seen.add(parent._id);
              return rootFor(parent, seen) ?? f.advancementOrigin;
            };
            const ups = (actor.items || []).filter(i => i.flags?.dnd5e?.advancementOrigin && !i.flags?.dnd5e?.advancementRoot)
              .map(i => ({ _id: i._id, "flags.dnd5e.advancementRoot": rootFor(i) }));
            if (ups.length) { await fs.doc("update", "Item", { parentUuid: `Actor.${actor._id}`, updates: ups, diff: true, modifiedTime: Date.now() }); actor = await findActor(fs, actor._id); }
          }
          const classes = (actor.items || []).filter(i => i.type === "class");
          let root, isNew = false;
          if (a.source?.uuid) {
            root = await fetchUuid(fs, a.source.uuid); root.__src = a.source.uuid; isNew = true;
          } else if (a.source) {
            const pack = (await packsOf(fs)).find(p => p.id === a.source.pack);
            if (!pack) throw new Error(message(`Unknown compendium: ${a.source.pack}`, `Compendium inconnu : ${a.source.pack}`));
            let id = a.source.id;
            if (!id && a.source.name) { const q = norm(a.source.name); id = (await packIndex(fs, pack)).find(x => norm(x.name) === q || norm(x.name_fr) === q)?._id; }
            if (!id) throw new Error(message(`Not found in ${pack.id}: ${a.source.name}`, `Introuvable dans ${pack.id} : ${a.source.name}`));
            root = await fetchUuid(fs, `Compendium.${pack.id}.${pack.type}.${id}`);
            root.__src = `Compendium.${pack.id}.${pack.type}.${id}`; isNew = true;
          } else if (a.item) root = findItem(actor, a.item);
          else throw new Error(message("Specify 'source' (import) or 'item' (class to advance)", "Précise 'source' (import) ou 'item' (classe à faire monter)"));
          const isClass = root.type === "class";
          const current = isNew ? 0 : Number(root.system?.levels) || 0;
          const charLevel = classes.reduce((t, c) => t + (Number(c.system?.levels) || 0), 0);
          // espèce / historique / don : paliers jusqu'au niveau de personnage actuel (min. 1)
          const target = isClass ? (a.level ?? current + 1) : Math.max(1, charLevel);
          // le paramètre spells n'est pas exposé par tous les clients : des choix « spells:… » valent spells:"all"
          const wantSpells = a.spells === "all" || Object.keys(a.choices || {}).some(k => k.startsWith("spells:"));
          const onlySpells = isClass && target <= current && wantSpells;
          if (isClass && target <= current && !onlySpells) return out(message(`${root.name} is already level ${current}`, `${root.name} est déjà niveau ${current}`));
          const isFirstClass = isClass && (isNew ? classes.length === 0 : (actor.system?.details?.originalClass ? actor.system.details.originalClass === root._id : classes[0]?._id === root._id));
          const from = isClass ? current + 1 : 0;
          // inclut les avancements de la sous-classe existante
          const { steps, pending, warnings } = onlySpells ? { steps: [], pending: [], warnings: [] }
            : await advPlan(fs, actor, root, { fromLevel: from, toLevel: target, choices: a.choices || {}, isFirstClass });
          if (isClass && !isNew && !onlySpells) {
            const sub = (actor.items || []).find(i => i.type === "subclass" && i.system?.classIdentifier === root.system?.identifier);
            // paliers liés au niveau de personnage : espèce, historique et ce qu'ils ont accordé (ex. lignage Haut-elfe aux niv. 3 et 5)
            const originItems = (actor.items || []).filter(i => ["race", "background"].includes(i.type));
            // fermeture transitive : tout ce qui a été accordé (directement ou en chaîne) par la classe,
            // la sous-classe, l'espèce ou l'historique (ex. Elfe → Lignage elfique → Haut-elfe)
            const origins = new Set([root._id, sub?._id, ...originItems.map(i => i._id)].filter(Boolean));
            for (let grew = true; grew;) {
              grew = false;
              for (const i of actor.items || []) {
                const o = i.flags?.dnd5e?.advancementOrigin?.split(".")[0];
                if (o && origins.has(o) && !origins.has(i._id)) { origins.add(i._id); grew = true; }
              }
            }
            const leveled = (actor.items || []).filter(i => i._id !== root._id && origins.has(i._id)
              && Object.values(i.system?.advancement || {}).some(x => Number(x.level) > 0
                || (x.type === "ItemChoice" && Object.entries(x.configuration?.choices || {}).some(([lv, v]) => Number(lv) > 0 && Number(v?.count ?? v) > 0))));
            for (const it of leveled) { const p2 = await advPlan(fs, actor, it, { fromLevel: from, toLevel: target, choices: a.choices || {}, isFirstClass }); steps.push(...p2.steps); pending.push(...p2.pending); warnings.push(...p2.warnings); }
          }
          let spellPlan = null;
          if (wantSpells && isClass && root.system?.spellcasting?.progression && root.system.spellcasting.progression !== "none") {
            spellPlan = await planClassSpells(fs, actor, root, Math.max(target, current), a.choices || {});
            pending.push(...spellPlan.pending);
          }
          if (pending.length) return out({ choix_requis: pending, avertissements: warnings.length ? warnings : undefined, rappel: message("Call 'advance' again with the same parameters + choices { id: value }. Nothing has been applied yet.", "Rappelle 'advance' avec les mêmes paramètres + choices { id: valeur }. Rien n'a encore été appliqué.") });
          const hadClass = (actor.items || []).some(i => i.type === "class") || (await fs.doc("get", "Item", { parentUuid: `Actor.${actor._id}`, query: { type: "class" } })).some(i => i.type === "class");
          const slotsBefore = hadClass ? slotMax(actor) : {};
          const hpBefore = hadClass ? sheet(actor).pv : { max: 0 };   // PV avant (0 sans classe) : les PV gagnés s'ajoutent aux PV courants
          if (isNew) {
            const d = structuredClone(root); delete d._id; delete d.folder; delete d.sort; delete d.ownership; delete d.__src;
            d._stats = { ...(d._stats || {}), compendiumSource: root.__src };
            d.flags = { ...(d.flags || {}), dnd5e: { ...(d.flags?.dnd5e || {}), sourceId: root.__src } };
            if (isClass) d.system.levels = target;
            const [c] = await fs.doc("create", "Item", { parentUuid: `Actor.${actor._id}`, data: [d], modifiedTime: Date.now() });
            root._id = c._id;
            const det = {};
            if (isClass && isFirstClass) det["system.details.originalClass"] = c._id;
            if (root.type === "race") det["system.details.race"] = c._id;
            if (root.type === "background") det["system.details.background"] = c._id;
            if (Object.keys(det).length) await fs.doc("update", "Actor", { updates: [{ _id: actor._id, ...det }], diff: true, modifiedTime: Date.now() });
            actor = await findActor(fs, actor._id);
          } else if (isClass) {
            await fs.doc("update", "Item", { parentUuid: `Actor.${actor._id}`, updates: [{ _id: root._id, "system.levels": target }], modifiedTime: Date.now() });
          }
          const log = await advApply(fs, actor, root._id, steps, { hpMode: a.hp || "avg", isFirstClass });
          if (spellPlan) log.push(message("Spells — ", "Sorts — ") + await applyClassSpells(fs, await findActor(fs, actor._id), spellPlan.step, root._id));
          const castNew = await ensureCastSpells(fs, actor._id);   // sorts des activités « Lancer un sort » (comme Foundry)
          if (castNew.length) log.push(message("Feature spells: ", "Sorts d'aptitude : ") + castNew.join(", "));
          const fresh = await findActor(fs, actor._id);
          let after = sheet(fresh);
          // PV et emplacements de sort gagnés : ajoutés aux valeurs courantes (comme une montée de niveau dans Foundry)
          const upd = {};
          const gain = (after.pv.max || 0) - (hpBefore.max || 0);
          if (gain) {
            const cur = Number(actor.system?.attributes?.hp?.value) || 0;
            upd["system.attributes.hp.value"] = Math.min(after.pv.max, Math.max(0, cur + gain));
          }
          const slotsAfter = slotMax(fresh);
          for (const [k, m] of Object.entries(slotsAfter)) {
            if (k === "pactLevel") continue;
            const d = (Number(m) || 0) - (Number(slotsBefore[k]) || 0);
            if (d > 0) upd[`system.spells.${k}.value`] = Math.min(Number(m), (Number(fresh.system?.spells?.[k]?.value) || 0) + d);
          }
          if (Object.keys(upd).length) {
            await fs.doc("update", "Actor", { updates: [{ _id: actor._id, ...upd }], diff: true, modifiedTime: Date.now() });
            after = sheet(await findActor(fs, actor._id));
          }
          return out({ applique: log, avertissements: warnings.length ? warnings : undefined, niveau: after.niveau, pv_max: after.pv.max, caracs: after.caracs,
            rappel_sorts: isClass && root.system?.spellcasting?.progression && root.system.spellcasting.progression !== "none" ? message("Select prepared/known spells next (search_compendium + add_from_compendium), as in Foundry.", "Les sorts préparés/connus se choisissent ensuite (search_compendium + add_from_compendium), comme dans Foundry.") : undefined });
        }
        default:
          if (params.name.startsWith("gm_")) {
            if ((Number(fs.user?.role) || 0) < GM_ROLE) return out(message("This tool is restricted to Gamemaster or Assistant Gamemaster accounts.", "Outil réservé aux comptes MJ ou assistant MJ."));
            return out(await handleGm(fs, params.name, a));
          }
          return out(message(`Unknown tool: ${params.name}`, `Outil inconnu : ${params.name}`));
      }
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: message(`Foundry error: ${e.message}`, `Erreur Foundry : ${e.message}`) }] };
    }
}

const deny = (res, code, msg, challenge) => {
  const h = { "content-type": "application/json" };
  if (code === 401) h["www-authenticate"] = challenge || 'Basic realm="Foundry VTT", charset="UTF-8"';
  res.writeHead(code, h).end(JSON.stringify({ error: msg }));
};

if (process.env.NO_LISTEN !== "1") {
const app = express();
// Derrière le reverse proxy, req.ip doit être l'IP réelle du client (anti brute-force et rate limit).
app.set("trust proxy", TRUSTED_PROXY ? ip => ip === TRUSTED_PROXY : false);
const oauth = process.env.OAUTH_ENABLED === "1" ? createFoundryOAuth({
  mcpUrl: process.env.OAUTH_MCP_URL,
  key: oauthEncryptionKey(),
  stateFile: process.env.OAUTH_STATE_PATH,
  login: (user, pass) => FoundrySession.login(user, pass),
  redirectOrigins: (process.env.OAUTH_REDIRECT_ORIGINS || "https://chatgpt.com").split(",").map(x => x.trim()).filter(Boolean)
}) : null;

if (oauth) {
  // Journalise chaque étape OAuth : indispensable pour diagnostiquer un blocage côté client.
  const oauthPaths = new Set(["/authorize", "/token", "/register", "/revoke", "/oauth/approve",
    "/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-authorization-server"]);
  const corsOrigins = new Set((process.env.OAUTH_REDIRECT_ORIGINS || "https://chatgpt.com").split(",").map(x => x.trim()).filter(Boolean));
  app.use((req, res, next) => {
    const path = req.path;
    if (!oauthPaths.has(path)) return next();
    const start = Date.now();
    res.on("finish", () => console.log(`[oauth] ${req.method} ${path} → ${res.statusCode} (${Date.now() - start} ms)`));
    const origin = req.headers.origin;
    if (!origin || !corsOrigins.has(origin)) return next();
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Max-Age", "600");
    if (req.method === "OPTIONS") return res.status(204).end();
    next();
  });
  app.use(mcpAuthRouter({
    provider: oauth.provider,
    issuerUrl: new URL(oauth.resource.origin),
    resourceServerUrl: oauth.resource,
    scopesSupported: ["foundry:access"],
    resourceName: "Foundry VTT MCP"
  }));
  app.post("/oauth/approve",
    rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: "draft-7", legacyHeaders: false,
      skipSuccessfulRequests: true, keyGenerator: req => clientIp(req) || "unknown" }),
    express.urlencoded({ extended: false, limit: "8kb" }), oauth.approve);
}

app.use(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/mcp-health") return res.writeHead(200).end("ok");
  if (url.pathname !== "/mcp") return deny(res, 404, "not found");
  const ip = clientIp(req);
  if (recentFails(ip).length >= 10) return deny(res, 429, message("Too many authentication failures, try again in 15 minutes", "Trop d'échecs d'authentification, réessaie dans 15 min"));
  const authorization = req.headers.authorization || "";
  const basic = /^Basic\s+(.+)$/i.exec(authorization);
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization);
  const bearerChallenge = oauth ? `Bearer resource_metadata="${oauth.metadataUrl}"` : undefined;
  let user, pass;
  if (basic) {
    const dec = Buffer.from(basic[1], "base64").toString("utf8");
    const i = dec.indexOf(":");
    user = i > 0 ? dec.slice(0, i) : "";
    pass = i > 0 ? dec.slice(i + 1) : "";
  } else if (bearer && oauth) {
    try { ({ username: user, password: pass } = await oauth.credentialsForToken(bearer[1])); }
    catch { return deny(res, 401, message("Invalid or expired OAuth token", "Jeton OAuth invalide ou expiré"), bearerChallenge); }
  } else {
    return deny(res, 401, message("Authentication required", "Authentification requise"), bearerChallenge);
  }
  let fs;
  try { fs = user && pass ? await getSession(user, pass) : null; }
  catch (e) { return deny(res, 503, message(`Foundry unavailable: ${e.message}`, `Foundry indisponible : ${e.message}`)); }
  const ent = sessions.get(keyOf(user, pass));
  if (ent) { ent.busy = (ent.busy || 0) + 1; res.on("close", () => { ent.busy--; ent.last = Date.now(); }); }
  if (!fs) {
    fails.set(ip, [...recentFails(ip), Date.now()]);
    console.warn(`[auth] échec pour "${user}" depuis ${ip}`);
    return deny(res, 401, message("Invalid Foundry credentials", "Identifiants Foundry invalides"), bearer ? bearerChallenge : undefined);
  }
  if (req.method !== "POST") return deny(res, 405, message("Stateless MCP server: POST only", "Serveur MCP sans état : POST uniquement"));
  const server = makeServer(fs);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res);
});
app.listen(PORT, HOST, () => console.log(`MCP Foundry sur :${PORT}/mcp${oauth ? " (OAuth + Basic)" : " (Basic)"}`));
}
