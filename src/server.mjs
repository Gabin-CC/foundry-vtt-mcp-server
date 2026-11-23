#!/usr/bin/env node
// Serveur MCP Foundry VTT — sans navigateur.
// Auth : Basic auth = identifiants d'un compte Foundry (nom + mot de passe).
// Chaque requête agit avec les droits Foundry de ce compte (joueur, MJ...).
import http from "node:http";
import crypto from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { FoundrySession } from "./foundry.mjs";
import { plan as advPlan, apply as advApply, fetchUuid } from "./advancement.mjs";
import { planClassSpells, applyClassSpells } from "./spells.mjs";
import { ensureCastSpells } from "./cast.mjs";
import { GM_TOOLS, GM_ROLE, handleGm } from "./gm.mjs";
import { rollFormula, derive, checkBonus, sheet, slotMax, useItem, translations, translateDoc, trFor, refreshUnits, localizeItem, actorMetricUpdates, ABIL, SKILLS } from "./dnd5e.mjs";

const PORT = Number(process.env.PORT || 8808);
const HOST = process.env.HOST || "0.0.0.0";
const TRUSTED_PROXY = process.env.TRUSTED_PROXY || ""; // IP du reverse proxy dont on accepte X-Forwarded-For
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, ""); // ex. https://foundry.example.com
// L'écran de connexion de Foundry grise les comptes déjà actifs : tant que le MCP garde sa session, le joueur ne
// peut pas (re)venir dans son navigateur. La connexion du MCP est donc relâchée quelques secondes après le dernier
// appel (IDLE_SECONDS, défaut 10 s). Le MCP, lui, fonctionne même si le joueur est connecté.
const IDLE_MS = (Number(process.env.IDLE_SECONDS) || 10) * 1000;
const MAX_OUT = 60000;
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
const out = v => {
  let t = typeof v === "string" ? v : (JSON.stringify(v, null, 1) ?? "(vide)");
  if (t.length > MAX_OUT) t = t.slice(0, MAX_OUT) + `\n… [tronqué : ${t.length} caractères au total. Utilise 'fields', 'path' ou 'limit' pour réduire.]`;
  return { content: [{ type: "text", text: t }] };
};
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

export const TOOLS = [
  { name: "world_info", description: "Infos du monde Foundry actif, du compte connecté et liste des utilisateurs.",
    inputSchema: { type: "object", properties: {} } },
  { name: "list_documents",
    description: "Liste des documents d'un type (selon les droits du compte). Renvoie par défaut _id, name, type, folder. Filtres optionnels.",
    inputSchema: { type: "object", required: ["type"], properties: {
      type: typeProp, pack: packProp, parent: parentProp,
      name_contains: { type: "string", description: "Filtre insensible à la casse sur le nom" },
      filter: { type: "object", description: "Égalités sur des chemins, ex. {\"type\":\"character\",\"folder\":\"id\"}" },
      fields: { type: "array", items: { type: "string" }, description: "Champs à renvoyer (chemins pointés), ex. [\"name\",\"system.attributes.hp.value\"]" },
      limit: { type: "number", default: 200 } } } },
  { name: "get_document", description: "Lit un document complet (ou une sous-partie via 'path').",
    inputSchema: { type: "object", required: ["type", "id"], properties: {
      type: typeProp, pack: packProp, id: { type: "string" }, parent: parentProp,
      path: { type: "string", description: "Sous-partie à renvoyer, ex. 'system.abilities'" } } } },
  { name: "create_documents", description: "Crée un ou plusieurs documents.",
    inputSchema: { type: "object", required: ["type", "data"], properties: {
      type: typeProp, pack: packProp, parent: parentProp, data: { type: "array", items: { type: "object" } } } } },
  { name: "update_documents",
    description: "Modifie des documents. Chaque update contient _id + les champs à changer en notation pointée, ex. {\"_id\":\"abc\",\"system.abilities.str.value\":10}.",
    inputSchema: { type: "object", required: ["type", "updates"], properties: {
      type: typeProp, pack: packProp, parent: parentProp, updates: { type: "array", items: { type: "object" } } } } },
  { name: "delete_documents", description: "Supprime des documents (irréversible).",
    inputSchema: { type: "object", required: ["type", "ids"], properties: {
      type: typeProp, pack: packProp, parent: parentProp, ids: { type: "array", items: { type: "string" } } } } },
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
      mode: { type: "string", enum: ["public", "mj", "aveugle", "prive"], default: "public" } } } },
  { name: "rest", description: "Repos long (PV max, emplacements, utilisations, dés de vie récupérés à moitié) ou court (emplacements de pacte, utilisations 'sr').",
    inputSchema: { type: "object", required: ["actor", "type"], properties: { actor: { type: "string" }, type: { type: "string", enum: ["long", "court"] } } } },
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
    inputSchema: { type: "object", properties: { actor: { type: "string", description: "Nom ou _id de l'acteur" }, dry_run: { type: "boolean", description: "Liste les changements sans les appliquer" } }, required: ["actor"] } },
  { name: "add_from_compendium", description: "Ajoute des entrées de compendium à un acteur (sorts, objets, butin, classe, espèce, historique, dons...) ou les importe dans le monde si 'actor' est absent (ex. un monstre). Traduit en FR. Pour une classe, 'levels' fixe le niveau et remplit les PV (max au niv. 1, puis moyenne).",
    inputSchema: { type: "object", required: ["entries"], properties: {
      actor: { type: "string", description: "Acteur destinataire (nom ou _id). Absent = import dans le monde." },
      entries: { type: "array", items: { type: "object", properties: {
        pack: { type: "string" }, id: { type: "string" }, name: { type: "string", description: "Alternative à id : nom exact (FR ou EN)" }, uuid: { type: "string", description: "Alternative à pack+id : UUID (Compendium.x.y.Item.id, Item.id, Actor.id.Item.id)" }, item_type: { type: "string" }, quantity: { type: "number" }, levels: { type: "number" },
        equipped: { type: "boolean" }, overrides: { type: "object", description: "Champs à surcharger (notation pointée)" } } } },
      folder: { type: "string", description: "Dossier (_id) pour un import dans le monde" } } } },
  { name: "give_loot", description: "Ajoute du butin à un acteur : pièces (pp, po, pe, pa, pc) et/ou objets créés à la volée (nom, type, description, valeur, quantité).",
    inputSchema: { type: "object", required: ["actor"], properties: {
      actor: { type: "string" },
      currency: { type: "object", description: "Ex. {\"gp\":50,\"sp\":20} (pp platine, gp or, ep électrum, sp argent, cp cuivre). Valeurs négatives pour retirer." },
      items: { type: "array", items: { type: "object", required: ["name"], properties: {
        name: { type: "string" }, type: { type: "string", default: "loot" }, quantity: { type: "number" },
        description: { type: "string" }, price_gp: { type: "number" }, weight: { type: "number" }, img: { type: "string" },
        rarity: { type: "string", enum: ["", "common", "uncommon", "rare", "veryRare", "legendary", "artifact"] } } } } } } },
  { name: "upload_file", description: "Envoie une image/son sur le serveur Foundry (depuis une URL ou du base64) et renvoie le chemin à utiliser dans 'img'.",
    inputSchema: { type: "object", required: ["filename"], properties: {
      filename: { type: "string" }, folder: { type: "string", default: "images/uploads" },
      url: { type: "string" }, base64: { type: "string" } } } },
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
  ...GM_TOOLS,   // outils de MJ : listés seulement pour les comptes MJ / assistant MJ
];

// ---------- helpers D&D / Foundry ----------
async function findActor(fs, ref) {
  if (!ref) throw new Error("Acteur non précisé");
  const a = (await fs.doc("get", "Actor", { query: { _id: ref } })).find(x => x._id === ref);
  if (a) return a;
  const all = await fs.doc("get", "Actor", { query: {} });
  const low = String(ref).toLowerCase();
  const exact = all.filter(x => x.name.toLowerCase() === low);
  if (exact.length === 1) return exact[0];
  const part = exact.length ? exact : all.filter(x => x.name.toLowerCase().includes(low));
  if (part.length === 1) return part[0];
  if (!part.length) throw new Error(`Aucun acteur ne correspond à « ${ref} »`);
  throw new Error(`Plusieurs acteurs correspondent à « ${ref} » : ${part.slice(0, 10).map(x => `${x.name} (${x._id})`).join(", ")}`);
}
function findItem(actor, ref) {
  const items = actor.items || [];
  const low = String(ref).toLowerCase();
  const hit = items.find(i => i._id === ref) || items.filter(i => i.name.toLowerCase() === low)[0];
  if (hit) return hit;
  const part = items.filter(i => i.name.toLowerCase().includes(low));
  if (part.length === 1) return part[0];
  if (!part.length) throw new Error(`« ${ref} » introuvable sur ${actor.name}`);
  throw new Error(`Plusieurs objets correspondent : ${part.slice(0, 10).map(i => `${i.name} (${i._id})`).join(", ")}`);
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
const norm = t => String(t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
function setPath(o, p, v) { const ks = p.split("."); let x = o; ks.slice(0, -1).forEach(k => { x = x[k] ??= {}; }); x[ks.at(-1)] = v; }

function makeServer(fs) {
  const server = new Server({ name: "foundry-vtt", version: "1.0.0" }, { capabilities: { tools: {} } });
  const isGM = (Number(fs.user?.role) || 0) >= GM_ROLE;
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS.filter(t => !t.gm || isGM).map(({ gm, ...t }) => t) }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => handleTool(fs, params));
  return server;
}

export async function handleTool(fs, params) {
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
          const total = docs.length;
          const fields = a.fields?.length ? a.fields : ["name", "type", "folder"];
          return out({ total, documents: docs.slice(0, a.limit || 200).map(d => pick(d, fields)) });
        }
        case "get_document": {
          // le filtre _id n'est pas appliqué par Foundry sur les collections embarquées : on filtre ici
          const d = (await fs.doc("get", a.type, { query: { _id: a.id }, ...parentOpt(a.parent, a.pack) })).find(x => x._id === a.id);
          if (!d) return out(`Introuvable : ${a.type} ${a.id}`);
          return out(getPath(d, a.path));
        }
        case "create_documents": {
          const r = await fs.doc("create", a.type, { data: a.data, modifiedTime: Date.now(), render: true, renderSheet: false, ...parentOpt(a.parent, a.pack) });
          return out({ crees: r.map(d => ({ _id: d._id, name: d.name })) });
        }
        case "update_documents": {
          const r = await fs.doc("update", a.type, { updates: a.updates, diff: true, recursive: true, modifiedTime: Date.now(), render: true, ...parentOpt(a.parent, a.pack) });
          return out({ modifies: r.length, resultat: r });
        }
        case "delete_documents": {
          const r = await fs.doc("delete", a.type, { ids: a.ids, modifiedTime: Date.now(), render: true, ...parentOpt(a.parent, a.pack) });
          return out({ supprimes: r });
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
          const res = useItem(actor, item, { activityId: a.activity, slotLevel: a.slot_level, advantage: a.advantage, disadvantage: a.disadvantage, consume: a.consume !== false, versatile: a.versatile });
          if (Object.keys(res.actorUpdate).length) await fs.doc("update", "Actor", { updates: [{ _id: actor._id, ...res.actorUpdate }], diff: true, modifiedTime: Date.now() });
          if (res.deleteItem) await fs.doc("delete", "Item", { parentUuid: `Actor.${actor._id}`, ids: [item._id], modifiedTime: Date.now() });
          else if (Object.keys(res.itemUpdate).length) await fs.doc("update", "Item", { parentUuid: `Actor.${actor._id}`, updates: [{ _id: item._id, ...res.itemUpdate }], diff: true, modifiedTime: Date.now() });
          const desc = item.system?.description?.value || "";
          const card = `<div class="dnd5e2 chat-card"><h3><img src="${esc(item.img)}" width="32" height="32" style="vertical-align:middle;border:none"> ${esc(item.name)}${a.slot_level ? ` (niv. ${a.slot_level})` : ""}</h3>`
            + (a.target ? `<p><b>Cible :</b> ${esc(a.target)}</p>` : "")
            + `<ul>${res.lignes.map(l => `<li>${esc(l)}</li>`).join("")}</ul>`
            + (desc ? `<details><summary>Description</summary>${desc}</details>` : "") + `</div>`;
          await postChat(fs, { actor, flavor: item.name, content: card, rolls: res.rolls, mode: a.mode });
          return out({ objet: item.name, resultats: res.lignes });
        }
        case "rest": {
          const actor = await findActor(fs, a.actor);
          const s = actor.system, d = derive(actor), upd = {}, lines = [];
          const sh = sheet(actor);
          if (a.type === "long") {
            upd["system.attributes.hp.value"] = sh.pv.max; upd["system.attributes.hp.temp"] = 0;
            for (const [k, m] of Object.entries(slotMax(actor))) if (k !== "pactLevel") upd[`system.spells.${k}.value`] = m;
            lines.push(`PV restaurés à ${sh.pv.max}`, "Emplacements de sort restaurés");
          } else {
            const mx = slotMax(actor); if (mx.pact) { upd["system.spells.pact.value"] = mx.pact; lines.push("Emplacements de pacte restaurés"); }
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
          if (iu.length) { await fs.doc("update", "Item", { parentUuid: `Actor.${actor._id}`, updates: iu, diff: true, modifiedTime: Date.now() }); lines.push(`${iu.length} objet(s)/aptitude(s) rechargé(s)`); }
          await postChat(fs, { actor, flavor: `Repos ${a.type}`, content: `<p>${esc(actor.name)} prend un repos ${a.type}.</p><ul>${lines.map(l => `<li>${esc(l)}</li>`).join("")}</ul>` });
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
          const hits = [];
          for (const p of packs) {
            for (const e of await packIndex(fs, p)) {
              if (a.item_type && e.type !== a.item_type) continue;
              if (a.level != null && e.system?.level !== a.level) continue;
              const nf = norm(e.name_fr), ne = norm(e.name);
              const score = nf === q || ne === q ? 3 : nf.startsWith(q) || ne.startsWith(q) ? 2 : nf.includes(q) || ne.includes(q) ? 1 : 0;
              if (score) hits.push({ score, pack: p.id, _id: e._id, nom: e.name_fr || e.name, nom_en: e.name, type: e.type, niveau: e.system?.level, rarete: e.system?.rarity || undefined });
            }
          }
          hits.sort((x, y) => y.score - x.score || x.nom.localeCompare(y.nom));
          return out({ total: hits.length, resultats: hits.slice(0, a.limit || 25).map(({ score, ...h }) => h) });
        }
        case "get_compendium_entry": {
          const pack = (await packsOf(fs)).find(p => p.id === a.pack);
          if (!pack) return out(`Compendium inconnu : ${a.pack}`);
          const d = (await fs.doc("get", pack.type, { pack: pack.id, query: { _id: a.id } })).find(x => x._id === a.id);
          if (!d) return out("Entrée introuvable");
          return out(getPath(await translateDoc(pack.id, d), a.path));
        }
        case "localize_actor": {
          const act = await findActor(fs, a.actor);
          await refreshUnits(fs);
          const items = await fs.doc("get", "Item", { parentUuid: `Actor.${act._id}`, query: {} });
          const updates = [], noms = [], effUps = [];
          for (const it of items) {
            const up = await localizeItem(it, fs);
            if (up.__effects) { effUps.push([it._id, up.__effects]); noms.push(`${up.name || it.name} : ${up.__effects.length} effet(s)`); }
            if (Object.keys(up).length) { updates.push({ _id: it._id, ...up }); noms.push(up.name ? `${it.name} → ${up.name}` : `${it.name} (${up["system.description.value"] ? "description" : up["system.materials.value"] ? "composantes" : "unités"})`); }
          }
          const aup = actorMetricUpdates(act);
          if (!a.dry_run) {
            for (let i = 0; i < updates.length; i += 50) await fs.doc("update", "Item", { parentUuid: `Actor.${act._id}`, updates: updates.slice(i, i + 50), diff: true, recursive: true, modifiedTime: Date.now(), render: true });
            if (Object.keys(aup).length) await fs.doc("update", "Actor", { updates: [{ _id: act._id, ...aup }], diff: true, recursive: true, modifiedTime: Date.now(), render: true });
            for (const [iid, eu] of effUps)
              await fs.doc("update", "ActiveEffect", { parentUuid: `Actor.${act._id}.Item.${iid}`, updates: eu, diff: true, recursive: true, modifiedTime: Date.now(), render: true });
          }
          return out({ acteur: act.name, objets_modifies: updates.length, effets_modifies: effUps.reduce((n, [, e]) => n + e.length, 0), acteur_modifie: Object.keys(aup), detail: noms, simulation: !!a.dry_run });
        }
        case "add_from_compendium": {
          const actor = a.actor ? await findActor(fs, a.actor) : null;
          const packs = await packsOf(fs);
          const byType = {};
          const missing = [];
          for (const e of a.entries) {
            if (e.uuid) {
              const d = structuredClone(await fetchUuid(fs, e.uuid));
              delete d._id; delete d.folder; delete d.sort; delete d.ownership;
              d._stats = { ...(d._stats || {}), compendiumSource: e.uuid };
              if (e.quantity != null && d.system) d.system.quantity = e.quantity;
              if (e.equipped != null && d.system) d.system.equipped = e.equipped;
              for (const [k, v] of Object.entries(e.overrides || {})) setPath(d, k, v);
              (byType[d.items || d.prototypeToken ? "Actor" : "Item"] ??= []).push(d);
              continue;
            }
            const pack = packs.find(p => p.id === e.pack);
            if (!pack) throw new Error(`Compendium inconnu : ${e.pack}`);
            if (!e.id && e.name) {
              const q = norm(e.name);
              const hit = (await packIndex(fs, pack)).find(x => (norm(x.name) === q || norm(x.name_fr) === q) && (!e.item_type || x.type === e.item_type));
              if (!hit) { missing.push(e.name); continue; }
              e.id = hit._id;
            }
            const src = (await fs.doc("get", pack.type, { pack: pack.id, query: { _id: e.id } })).find(x => x._id === e.id);
            if (!src) throw new Error(`Entrée ${e.id} introuvable dans ${e.pack}`);
            const d = await translateDoc(pack.id, src);
            delete d._id; delete d.folder; delete d.sort; delete d.ownership;
            d._stats = { ...(d._stats || {}), compendiumSource: `Compendium.${pack.id}.${pack.type}.${e.id}` };
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
            for (const [k, v] of Object.entries(e.overrides || {})) setPath(d, k, v);
            (byType[pack.type] ??= []).push(d);
          }
          const created = [];
          for (const [type, data] of Object.entries(byType)) {
            if (actor && type !== "Item") throw new Error(`Impossible d'ajouter un ${type} à un acteur`);
            if (!actor && a.folder) data.forEach(d => d.folder = a.folder);
            const r = await fs.doc("create", type, { data, modifiedTime: Date.now(), ...(actor ? { parentUuid: `Actor.${actor._id}` } : {}) });
            created.push(...r.map(x => ({ _id: x._id, nom: x.name, type: x.type })));
          }
          const notes = a.entries.map(e => e._note).filter(Boolean);
          if (created.some(c => c.type === "class")) notes.push("Assistant de niveau non exécuté (headless) : ajoute aptitudes de classe, compétences et maîtrises au choix via search_compendium/add_from_compendium/update_documents.");
          if (missing.length) notes.push(`Introuvables dans le compendium : ${missing.join(", ")}`);
          if (actor) { const cn = await ensureCastSpells(fs, actor._id); if (cn.length) notes.push("Sorts d'aptitude ajoutés : " + cn.join(", ")); }
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
                price: { value: i.price_gp ?? 0, denomination: "gp" }, weight: { value: i.weight ?? 0, units: "lb" }, rarity: i.rarity || "" } }));
            const r = await fs.doc("create", "Item", { parentUuid: `Actor.${actor._id}`, data, modifiedTime: Date.now() });
            lines.push(...r.map(x => `${x.name}${x.system?.quantity > 1 ? " ×" + x.system.quantity : ""}`));
          }
          await postChat(fs, { actor, flavor: "Butin", content: `<p><b>${esc(actor.name)}</b> reçoit :</p><ul>${lines.map(l => `<li>${esc(l)}</li>`).join("")}</ul>` });
          return out({ a: actor.name, recu: lines });
        }
        case "upload_file": {
          let buf;
          if (a.url) { const r = await fetch(a.url); if (!r.ok) throw new Error(`Téléchargement impossible (${r.status})`); buf = Buffer.from(await r.arrayBuffer()); }
          else if (a.base64) buf = Buffer.from(a.base64.replace(/^data:[^,]+,/, ""), "base64");
          else throw new Error("Fournis 'url' ou 'base64'");
          if (buf.length > 20 * 1024 * 1024) throw new Error("Fichier trop gros (max 20 Mo)");
          const ext = a.filename.split(".").pop().toLowerCase();
          const mime = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml", mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav", webm: "video/webm", mp4: "video/mp4", pdf: "application/pdf" }[ext];
          const path = await fs.upload((a.folder || "images/uploads").replace(/^\/+|\/+$/g, ""), a.filename, buf, mime);
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
          const classes = (actor.items || []).filter(i => i.type === "class");
          let root, isNew = false;
          if (a.source?.uuid) {
            root = await fetchUuid(fs, a.source.uuid); root.__src = a.source.uuid; isNew = true;
          } else if (a.source) {
            const pack = (await packsOf(fs)).find(p => p.id === a.source.pack);
            if (!pack) throw new Error(`Compendium inconnu : ${a.source.pack}`);
            let id = a.source.id;
            if (!id && a.source.name) { const q = norm(a.source.name); id = (await packIndex(fs, pack)).find(x => norm(x.name) === q || norm(x.name_fr) === q)?._id; }
            if (!id) throw new Error(`Introuvable dans ${pack.id} : ${a.source.name}`);
            root = await fetchUuid(fs, `Compendium.${pack.id}.${pack.type}.${id}`);
            root.__src = `Compendium.${pack.id}.${pack.type}.${id}`; isNew = true;
          } else if (a.item) root = findItem(actor, a.item);
          else throw new Error("Précise 'source' (import) ou 'item' (classe à faire monter)");
          const isClass = root.type === "class";
          const current = isNew ? 0 : Number(root.system?.levels) || 0;
          const charLevel = classes.reduce((t, c) => t + (Number(c.system?.levels) || 0), 0);
          // espèce / historique / don : paliers jusqu'au niveau de personnage actuel (min. 1)
          const target = isClass ? (a.level ?? current + 1) : Math.max(1, charLevel);
          // le paramètre spells n'est pas exposé par tous les clients : des choix « spells:… » valent spells:"all"
          const wantSpells = a.spells === "all" || Object.keys(a.choices || {}).some(k => k.startsWith("spells:"));
          const onlySpells = isClass && target <= current && wantSpells;
          if (isClass && target <= current && !onlySpells) return out(`${root.name} est déjà niveau ${current}`);
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
              && Object.values(i.system?.advancement || {}).some(x => Number(x.level) > 0));
            for (const it of leveled) { const p2 = await advPlan(fs, actor, it, { fromLevel: from, toLevel: target, choices: a.choices || {}, isFirstClass }); steps.push(...p2.steps); pending.push(...p2.pending); warnings.push(...p2.warnings); }
          }
          let spellPlan = null;
          if (wantSpells && isClass && root.system?.spellcasting?.progression && root.system.spellcasting.progression !== "none") {
            spellPlan = await planClassSpells(fs, actor, root, Math.max(target, current), a.choices || {});
            pending.push(...spellPlan.pending);
          }
          if (pending.length) return out({ choix_requis: pending, avertissements: warnings.length ? warnings : undefined, rappel: "Rappelle 'advance' avec les mêmes paramètres + choices { id: valeur }. Rien n'a encore été appliqué." });
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
          if (spellPlan) log.push("Sorts — " + await applyClassSpells(fs, await findActor(fs, actor._id), spellPlan.step, root._id));
          const castNew = await ensureCastSpells(fs, actor._id);   // sorts des activités « Lancer un sort » (comme Foundry)
          if (castNew.length) log.push("Sorts d'aptitude : " + castNew.join(", "));
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
            rappel_sorts: isClass && root.system?.spellcasting?.progression && root.system.spellcasting.progression !== "none" ? "Les sorts préparés/connus se choisissent ensuite (search_compendium + add_from_compendium), comme dans Foundry." : undefined });
        }
        default:
          if (params.name.startsWith("gm_")) {
            if ((Number(fs.user?.role) || 0) < GM_ROLE) return out("Outil réservé aux comptes MJ ou assistant MJ.");
            return out(await handleGm(fs, params.name, a));
          }
          return out(`Outil inconnu : ${params.name}`);
      }
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: `Erreur Foundry : ${e.message}` }] };
    }
}

const deny = (res, code, msg) => {
  const h = { "content-type": "application/json" };
  if (code === 401) h["www-authenticate"] = 'Basic realm="Foundry VTT", charset="UTF-8"';
  res.writeHead(code, h).end(JSON.stringify({ error: msg }));
};

if (process.env.NO_LISTEN !== "1") http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/mcp-health") return res.writeHead(200).end("ok");
  if (url.pathname !== "/mcp") return deny(res, 404, "not found");
  const ip = clientIp(req);
  if (recentFails(ip).length >= 10) return deny(res, 429, "Trop d'échecs d'authentification, réessaie dans 15 min");
  const m = /^Basic\s+(.+)$/i.exec(req.headers.authorization || "");
  if (!m) return deny(res, 401, "Authentification requise (identifiants Foundry)");
  const dec = Buffer.from(m[1], "base64").toString("utf8");
  const i = dec.indexOf(":");
  const user = dec.slice(0, i), pass = dec.slice(i + 1);
  let fs;
  try { fs = i > 0 && pass ? await getSession(user, pass) : null; }
  catch (e) { return deny(res, 503, `Foundry indisponible : ${e.message}`); }
  const ent = sessions.get(keyOf(user, pass));
  if (ent) { ent.busy = (ent.busy || 0) + 1; res.on("close", () => { ent.busy--; ent.last = Date.now(); }); }
  if (!fs) {
    fails.set(ip, [...recentFails(ip), Date.now()]);
    console.warn(`[auth] échec pour "${user}" depuis ${ip}`);
    return deny(res, 401, "Identifiants Foundry invalides");
  }
  if (req.method !== "POST") return deny(res, 405, "Serveur MCP sans état : POST uniquement");
  const server = makeServer(fs);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}).listen(PORT, HOST, () => console.log(`MCP Foundry sur :${PORT}/mcp`));
