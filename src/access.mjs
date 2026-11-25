/**
 * Droits de lecture Foundry appliqués côté MCP pour les comptes non MJ.
 *
 * Le serveur Foundry envoie à chaque client l'ensemble des documents du monde : c'est le client (navigateur)
 * qui masque ce que l'utilisateur n'a pas le droit de voir. Le MCP lit les documents comme un client ; il doit
 * donc appliquer lui-même ces règles avant de renvoyer quoi que ce soit à un joueur.
 *
 * Règles (les mêmes que gm_permissions) :
 *  - niveau = ownership[utilisateur] ?? ownership.default ?? AUCUN ; « hérité » (-1) = niveau du parent ;
 *  - document du monde : titre visible si ≥ LIMITÉ (fiche réduite : _id, nom, type, image, dossier),
 *    contenu si ≥ OBSERVATEUR, absent des listes et refusé en lecture en dessous ;
 *  - page de journal : ownership propre (souvent « hérité ») ; une page accordée explicitement reste visible
 *    même si le journal ne l'est pas (le journal apparaît alors réduit, avec cette seule page) ;
 *  - compendium : droit selon le rôle (réglage ownership du compendium ; défaut PLAYER = OBSERVATEUR) ;
 *  - scène active : contenu visible ; jetons, tuiles, dessins cachés retirés ; notes liées à un journal invisible retirées ;
 *  - combat : combattants cachés retirés ; message de chat chuchoté : seulement pour l'auteur ou les destinataires ;
 *  - dossiers : visibles s'ils contiennent (directement ou non) un document visible.
 * Les MJ et assistants MJ (rôle ≥ GM_ROLE) voient tout : aucune enveloppe n'est posée.
 */
import { message } from "./i18n.mjs";

export const GM_ROLE = 3;   // 3 = assistant MJ, 4 = MJ
export const LEVEL = { INHERIT: -1, NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3 };
const ROLE_NAMES = { 1: "PLAYER", 2: "TRUSTED", 3: "ASSISTANT", 4: "GAMEMASTER" };
const LEVEL_OF = { NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3 };
const DEFAULT_PACK_OWNERSHIP = { PLAYER: "OBSERVER", ASSISTANT: "OWNER" };

/** Types du monde soumis au champ ownership. */
const OWNED = new Set(["Actor", "Item", "JournalEntry", "Scene", "RollTable", "Cards", "Macro", "Playlist"]);
/** Types du monde lisibles par tous (pas de droit par document). */
const PUBLIC = new Set(["User", "Setting"]);
/** Collections embarquées : type → champ du parent. */
export const COLLECTIONS = { JournalEntryPage: "pages", Item: "items", ActiveEffect: "effects", Token: "tokens", Note: "notes",
  Tile: "tiles", Drawing: "drawings", Wall: "walls", AmbientLight: "lights", AmbientSound: "sounds", MeasuredTemplate: "templates",
  Region: "regions", Level: "levels", PlaylistSound: "sounds", TableResult: "results", Combatant: "combatants", Card: "cards" };
const STUB_FIELDS = ["_id", "name", "type", "img", "folder", "sort"];

const stubs = new WeakSet();
/** Vrai si le document a été réduit à son titre (droit LIMITÉ). */
export const isStub = doc => !!doc && typeof doc === "object" && stubs.has(doc);
function stub(doc, extra = {}) {
  const s = {};
  for (const k of STUB_FIELDS) if (doc[k] !== undefined) s[k] = doc[k];
  Object.assign(s, extra);
  stubs.add(s);
  return s;
}

export const isGM = user => (Number(user?.role) || 0) >= GM_ROLE;

/** Niveau d'un document pour un utilisateur ({_id, role}) ; `inherited` = niveau du parent (ownership -1). */
export function levelFor(doc, user, inherited = LEVEL.NONE) {
  if (isGM(user)) return LEVEL.OWNER;
  const o = doc?.ownership || {};
  const v = Number(o[user._id] ?? o.default ?? LEVEL.NONE);
  return v === LEVEL.INHERIT ? inherited : Number.isFinite(v) ? v : LEVEL.NONE;
}

/** Niveau d'un compendium selon le rôle de l'utilisateur (meilleur niveau des rôles ≤ au sien). */
export function packLevel(pack, user) {
  if (!pack) return LEVEL.NONE;
  const role = Number(user?.role) || 0;
  if (role >= GM_ROLE) return LEVEL.OWNER;
  const own = pack.ownership || (pack.private ? {} : DEFAULT_PACK_OWNERSHIP);
  let best = LEVEL.NONE;
  for (let r = 1; r <= role; r++) {
    const v = own[ROLE_NAMES[r]];
    best = Math.max(best, typeof v === "number" ? v : LEVEL_OF[v] ?? LEVEL.NONE);
  }
  return best;
}

/** Page de journal vue par l'utilisateur : null (aucun droit), réduite (titre) ou complète. */
function viewPage(page, user, entryLevel) {
  const lvl = levelFor(page, user, entryLevel);
  if (lvl >= LEVEL.OBSERVER) return page;
  if (lvl >= LEVEL.LIMITED) return stub(page, page.title ? { title: page.title } : {});
  return null;
}

function viewJournal(doc, user) {
  const lvl = levelFor(doc, user);
  const pages = (doc.pages || []).map(p => viewPage(p, user, lvl)).filter(Boolean);
  if (lvl >= LEVEL.OBSERVER) return { ...doc, pages };
  // journal invisible ou réduit : seules les pages accordées explicitement restent
  if (lvl >= LEVEL.LIMITED || pages.length) return stub(doc, { pages });
  return null;
}

/**
 * Document du monde (type racine) tel que l'utilisateur peut le voir : null, version réduite ou complète.
 * `ctx.journalLevel(id)` : niveau d'un journal (notes de scène), `ctx.userId`.
 */
export function viewWorldDoc(type, doc, user, ctx = {}) {
  if (!doc || isGM(user)) return doc;
  if (PUBLIC.has(type)) return doc;
  if (type === "JournalEntry") return viewJournal(doc, user);
  if (type === "ChatMessage") {
    const whisper = doc.whisper || [];
    if (!whisper.length) return doc;
    if (whisper.includes(user._id)) return doc;
    if (doc.author === user._id && !doc.blind) return doc;
    return null;
  }
  if (type === "Combat") return { ...doc, combatants: (doc.combatants || []).filter(c => !c.hidden) };
  if (!OWNED.has(type)) return null;   // Adventure, FogExploration… : réservés au MJ
  let lvl = levelFor(doc, user);
  if (type === "Scene" && doc.active) lvl = Math.max(lvl, LEVEL.OBSERVER);   // la scène active est affichée à tous
  if (lvl < LEVEL.LIMITED) return null;
  if (lvl < LEVEL.OBSERVER) return stub(doc);
  if (type === "Scene") {
    const visibleNote = n => !n.entryId || !ctx.journalLevel || ctx.journalLevel(n.entryId, n.pageId) >= LEVEL.LIMITED;
    return { ...doc, tokens: (doc.tokens || []).filter(t => !t.hidden), tiles: (doc.tiles || []).filter(t => !t.hidden),
      drawings: (doc.drawings || []).filter(d => !d.hidden), notes: (doc.notes || []).filter(visibleNote) };
  }
  return doc;
}

/** Document de compendium vu par l'utilisateur, d'après le niveau du compendium. */
export function viewPackDoc(doc, level) {
  if (level >= LEVEL.OBSERVER) return doc;
  if (level >= LEVEL.LIMITED) return stub(doc);
  return null;
}

/**
 * Session Foundry filtrée pour un compte non MJ : `doc("get", …)` et `worldData()` ne renvoient que ce que
 * l'utilisateur a le droit de voir ; les écritures passent telles quelles (Foundry les contrôle lui-même).
 * Les caches posés sur la session (index de compendiums…) restent sur la session d'origine.
 */
export function restrictedSession(fs) {
  const user = { _id: fs.userId, role: fs.user?.role };
  if (isGM(user)) return fs;
  const raw = (...args) => fs.doc(...args);
  let packsP = null, journalsP = null;
  const packs = () => (packsP ??= fs.worldData().then(w => w?.packs || []));
  const packOf = async id => (await packs()).find(p => p.id === id);
  const journals = () => (journalsP ??= raw("get", "JournalEntry", { query: {} }).then(list => new Map(list.map(j => [j._id, j]))).catch(() => new Map()));
  const ctxFor = async () => {
    const js = await journals();
    return { journalLevel: (id, pageId) => {
      const j = js.get(id);
      if (!j) return LEVEL.NONE;
      const lvl = levelFor(j, user);
      const page = pageId && (j.pages || []).find(p => p._id === pageId);
      return page ? levelFor(page, user, lvl) : lvl;
    } };
  };
  const filterWorld = async (type, list) => {
    const ctx = type === "Scene" ? await ctxFor() : {};
    return list.map(d => viewWorldDoc(type, d, user, ctx)).filter(Boolean);
  };
  async function visibleFolders(list) {
    // un dossier est visible s'il contient (directement ou dans un sous-dossier) un document visible
    const byId = new Map(list.map(f => [f._id, f]));
    const keep = new Set();
    const types = [...new Set(list.map(f => f.type).filter(t => OWNED.has(t)))];
    for (const t of types) {
      let docs = [];
      try { docs = await filterWorld(t, await raw("get", t, { query: {} })); } catch { docs = []; }
      for (const d of docs) for (let f = byId.get(d.folder), guard = 0; f && guard++ < 50; f = byId.get(f.folder)) keep.add(f._id);
    }
    return list.filter(f => keep.has(f._id));
  }
  async function doc(action, type, operation = {}) {
    const res = await raw(action, type, operation);
    if (action !== "get" || !Array.isArray(res)) return res;
    // compendium : droit du compendium selon le rôle
    if (operation.pack) {
      const lvl = packLevel(await packOf(operation.pack), user);
      if (lvl < LEVEL.LIMITED) return [];
      if (operation.parentUuid && lvl < LEVEL.OBSERVER) return [];
      return res.map(d => viewPackDoc(d, lvl)).filter(Boolean);
    }
    if (operation.parentUuid) {
      // document embarqué : vue du document racine, puis collection correspondante
      const parts = String(operation.parentUuid).split(".");
      const [rootType, rootId] = parts;
      const root = (await raw("get", rootType, { query: { _id: rootId } })).find(d => d._id === rootId);
      const view = root && (await filterWorld(rootType, [root]))[0];
      if (!view) return [];
      if (parts.length === 2) {
        const coll = COLLECTIONS[type];
        const allowed = coll && Array.isArray(view[coll]) ? new Map(view[coll].map(x => [x._id, x])) : null;
        if (allowed) return res.filter(d => allowed.has(d._id)).map(d => isStub(allowed.get(d._id)) ? allowed.get(d._id) : d);
      }
      return isStub(view) ? [] : res;
    }
    if (type === "Folder") return visibleFolders(res);
    return filterWorld(type, res);
  }
  async function worldData() {
    const w = await fs.worldData();
    if (!w || !Array.isArray(w.packs)) return w;
    return { ...w, packs: w.packs.filter(p => packLevel(p, user) >= LEVEL.LIMITED) };
  }
  return new Proxy(fs, {
    get(target, key) {
      if (key === "doc") return doc;
      if (key === "worldData") return worldData;
      if (key === "restricted") return true;
      if (key === "raw") return target;
      const v = Reflect.get(target, key, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
    set(target, key, value) { return Reflect.set(target, key, value, target); }
  });
}

/** Erreur d'accès : seul le titre du document est visible avec le droit actuel (LIMITÉ). */
export function limitedError(what) {
  return new Error(message(`Permission denied: you can only see the title of ${what}`, `Accès refusé : seul le titre de ${what} vous est visible`));
}
