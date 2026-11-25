/**
 * Corpus textuel du monde et des compendiums : chaque champ textuel de chaque document (et sous-document) avec
 * son UUID, son dossier et, pour les compendiums, sa traduction Babele. Sert à l'audit de traduction
 * (audit_translation), à la recherche globale (search_text) et aux références inverses (find_references).
 * Les compendiums sont lus un par un et gardés 10 min en mémoire (texte seulement).
 */
import { translations, trFor, localizeItem } from "./dnd5e.mjs";
import { textFields, applyBabele, plain, detectLang, norm, snippet } from "./texts.mjs";
import { message } from "./i18n.mjs";

export const WORLD_TYPES = ["Actor", "Item", "JournalEntry", "RollTable", "Cards", "Scene", "Macro", "Playlist"];
const PACK_TTL = 10 * 60 * 1000;
const packCache = new Map();   // packId -> { at, data }

function folderPaths(folders) {
  const byId = new Map(folders.map(f => [f._id, f]));
  const memo = new Map();
  const pathOf = id => {
    if (!id) return null;
    if (memo.has(id)) return memo.get(id);
    const parts = []; let f = byId.get(id), guard = 0;
    while (f && guard++ < 20) { parts.unshift(f.name); f = byId.get(f.folder); }
    const p = parts.join(" / ") || null; memo.set(id, p); return p;
  };
  return pathOf;
}

/** Liens structurels (hors texte) : source de compendium des objets, jetons → acteur, notes → journal. */
function links(doc, type, uuid, out) {
  const src = d => d?._stats?.compendiumSource || d?.flags?.core?.sourceId;
  const push = (u, champ, cible) => { if (cible) out.push({ uuid: u, champ, cible }); };
  push(uuid, "_stats.compendiumSource", src(doc));
  push(uuid, "_stats.duplicateSource", doc?._stats?.duplicateSource);
  for (const it of doc.items || []) push(`${uuid}.Item.${it._id}`, "_stats.compendiumSource", src(it));
  for (const e of doc.effects || []) push(`${uuid}.ActiveEffect.${e._id}`, "origin", e.origin);
  if (type === "Scene") {
    for (const t of doc.tokens || []) if (t.actorId) push(`${uuid}.Token.${t._id}`, "actorId", `Actor.${t.actorId}`);
    for (const n of doc.notes || []) {
      if (n.entryId) push(`${uuid}.Note.${n._id}`, "entryId", `JournalEntry.${n.entryId}`);
      if (n.entryId && n.pageId) push(`${uuid}.Note.${n._id}`, "pageId", `JournalEntry.${n.entryId}.JournalEntryPage.${n.pageId}`);
    }
    if (doc.journal) push(uuid, "journal", `JournalEntry.${doc.journal}`);
    if (doc.playlist) push(uuid, "playlist", `Playlist.${doc.playlist}`);
  }
  for (const r of doc.results || []) if (r.documentUuid) push(`${uuid}.TableResult.${r._id}`, "documentUuid", r.documentUuid);
  for (const c of doc.cards || []) if (c.origin) push(`${uuid}.Card.${c._id}`, "origin", `Cards.${c.origin}`);
}

function recordsOf(doc, type, uuid, folder, tdoc) {
  const raw = textFields(doc, type, uuid);
  const trd = tdoc ? textFields(tdoc, type, uuid) : null;
  return raw.map((f, i) => {
    // les listes de champs ont le même ordre tant que la traduction ne vide pas un champ ; sinon on cherche
    const t = trd ? (trd[i]?.uuid === f.uuid && trd[i]?.champ === f.champ ? trd[i] : trd.find(x => x.uuid === f.uuid && x.champ === f.champ)) : null;
    return { uuid: f.uuid, racine: uuid, nom_racine: tdoc?.name || doc.name, type, dossier: folder, champ: f.champ, categorie: f.categorie,
      html: f.html, valeur: f.valeur, traduction: t && t.valeur !== f.valeur ? t.valeur : null };
  });
}

/** Corpus du monde (selon les droits du compte). */
export async function worldCorpus(fs, types = WORLD_TYPES) {
  const folders = await fs.doc("get", "Folder", { query: {} }).catch(() => []);
  const pathOf = folderPaths(folders);
  const records = [], linkList = [], docs = [];
  for (const type of types) {
    let list = [];
    try { list = await fs.doc("get", type, { query: {} }); } catch { continue; }
    for (const d of list) {
      const uuid = `${type}.${d._id}`;
      records.push(...recordsOf(d, type, uuid, pathOf(d.folder), null));
      links(d, type, uuid, linkList);
      docs.push({ type, doc: d, uuid });
    }
  }
  return { records, links: linkList, docs };
}

/** Corpus d'un compendium (valeurs d'origine + traductions Babele), en cache 10 min. */
export async function packCorpus(fs, pack) {
  const key = `${fs.userId}|${pack.id}`;   // par compte : les droits de lecture des compendiums diffèrent
  const c = packCache.get(key);
  if (c && Date.now() - c.at < PACK_TTL) return c.data;
  let docs = [];
  try { docs = await fs.doc("get", pack.type, { pack: pack.id, query: {} }); } catch { docs = []; }
  let folders = [];
  try { folders = await fs.doc("get", "Folder", { pack: pack.id, query: {} }); } catch { folders = []; }
  const pathOf = folderPaths(folders);
  const tr = await translations(pack.id);
  const records = [], linkList = [];
  for (const d of docs) {
    const uuid = `Compendium.${pack.id}.${pack.type}.${d._id}`;
    const t = trFor(tr, d);
    const td = t ? applyBabele(d, t, pack.type) : null;
    records.push(...recordsOf(d, pack.type, uuid, pathOf(d.folder), td));
    links(d, pack.type, uuid, linkList);
  }
  const data = { records, links: linkList, count: docs.length, translated: !!tr };
  packCache.set(key, { at: Date.now(), data });
  // libère les plus vieux si trop de compendiums en mémoire
  if (packCache.size > 40) packCache.delete(packCache.keys().next().value);
  return data;
}

// ---------------------------------------------------------------- audit de traduction
/** Noms anglais / français connus (index des compendiums traduits), pour juger les noms courts. */
async function knownNames(fs, packs, packIndex) {
  if (fs._knownNames && Date.now() - fs._knownNames.at < PACK_TTL) return fs._knownNames;
  const en = new Set(), fr = new Set();
  for (const p of packs) {
    for (const e of await packIndex(fs, p)) {
      if (e.name_fr && e.name_fr !== e.name) { en.add(norm(e.name)); fr.add(norm(e.name_fr)); }
    }
  }
  fs._knownNames = { en, fr, at: Date.now() };
  return fs._knownNames;
}

function classify(rec, names) {
  if (rec.traduction) return { statut: "traduit", langue: "fr" };
  const isName = rec.champ === "name" || rec.champ.endsWith(".name");
  const txt = rec.html ? plain(rec.valeur) : rec.valeur;
  if (!txt || !/\p{L}/u.test(txt)) return { statut: "vide", langue: "?" };
  const d = detectLang(txt);
  let lang = d.lang;
  if (lang === "?" && isName && names) {
    const n = norm(txt);
    if (names.fr.has(n)) lang = "fr";
    else if (names.en.has(n)) lang = "en";
  }
  return { statut: lang === "fr" ? "fr" : lang === "en" ? "anglais" : lang === "mixte" ? "mixte" : "inconnu", langue: lang };
}

/**
 * Audit : champs restés en anglais (monde et/ou compendiums), ou couverture de traduction par compendium.
 * @param {object} a  scope, packs, types, categories, mode, statuses, limit, offset
 */
export async function auditTranslation(fs, a, { packsOf, packIndex }) {
  const scope = a.packs?.length ? "packs" : (a.scope || "world");
  const allPacks = await packsOf(fs);
  const packs = scope === "world" ? [] : allPacks.filter(p => (!a.packs?.length || a.packs.includes(p.id)) && (!a.types?.length || a.types.includes(p.type))
    && !["Macro", "Playlist", "Scene", "ActiveEffect"].includes(p.type));
  const names = await knownNames(fs, allPacks.filter(p => p.type === "Item" || p.type === "Actor"), packIndex);
  const cats = a.categories?.length ? new Set(a.categories) : null;
  const wanted = new Set(a.statuses?.length ? a.statuses : ["anglais", "mixte"]);
  const issues = [], coverage = [];
  const consider = rec => !cats || cats.has(rec.categorie);

  const tally = (records, label, extra = {}) => {
    const roots = new Map(), champs = {};
    for (const rec of records) {
      if (!consider(rec) || rec.champ === "command") continue;
      const c = classify(rec, names);
      if (c.statut === "vide") continue;
      (champs[rec.categorie] ??= { fr: 0, traduit: 0, anglais: 0, mixte: 0, inconnu: 0 })[c.statut]++;
      const r = roots.get(rec.racine) || { ok: true, seen: false };
      if (c.statut === "anglais" || c.statut === "mixte") r.ok = false;
      r.seen = true; roots.set(rec.racine, r);
      if (wanted.has(c.statut)) issues.push({ uuid: rec.uuid, document: rec.nom_racine, dossier: rec.dossier || undefined, champ: rec.champ,
        categorie: rec.categorie, statut: c.statut, extrait: snippet(rec.valeur, null, 140) });
    }
    const entrees = [...roots.values()].filter(r => r.seen).length, ok = [...roots.values()].filter(r => r.seen && r.ok).length;
    coverage.push({ ...extra, source: label, entrees, entrees_traduites: ok, pourcentage: entrees ? Math.round(ok * 1000 / entrees) / 10 : null, champs });
  };

  if (scope === "world" || scope === "all") {
    const types = (a.types?.length ? a.types : WORLD_TYPES).filter(t => WORLD_TYPES.includes(t) && t !== "Macro");
    const w = await worldCorpus(fs, types);
    for (const t of types) tally(w.records.filter(r => r.type === t), `monde:${t}`);
    // objets d'acteurs / du monde issus d'un compendium traduit : correctif disponible (localize_actor)
    if (a.check_fixes !== false) {
      const flagged = new Set(issues.filter(i => /\.Item\.[^.]+$|^Item\.[^.]+$/.test(i.uuid)).map(i => i.uuid));
      for (const { type, doc, uuid } of w.docs) {
        const its = type === "Actor" ? (doc.items || []).map(it => [`${uuid}.Item.${it._id}`, it]) : type === "Item" ? [[uuid, doc]] : [];
        for (const [u, it] of its) {
          if (!flagged.has(u)) continue;
          let up = {};
          try { up = await localizeItem(it, fs); } catch { continue; }
          const fix = ["name", "system.description.value", "system.materials.value"].filter(k => k in up);
          if (!fix.length) continue;
          for (const i of issues) if (i.uuid === u && fix.includes(i.champ)) i.correctif = type === "Actor" ? `localize_actor ${doc.name}` : "traduction disponible (compendium d'origine)";
        }
      }
    }
  }
  for (const p of packs) {
    const c = await packCorpus(fs, p);
    tally(c.records, p.id, { libelle: p.label, type: p.type, fichier_traduction: c.translated });
  }
  if (a.mode === "coverage") return { portee: scope, couverture: coverage };
  const total = issues.length, offset = Math.max(0, Number(a.offset) || 0), limit = Math.max(1, Number(a.limit) || 300);
  const page = issues.slice(offset, offset + limit);
  return { portee: scope, total, offset, count: page.length, next_offset: offset + page.length < total ? offset + page.length : null,
    couverture: coverage.map(({ champs, ...c }) => c), resultats: page };
}

// ---------------------------------------------------------------- recherche globale
export async function searchText(fs, a, { packsOf }) {
  const q = norm(a.query || "");
  if (q.length < 2) throw new Error(message("Query too short (minimum 2 characters)", "Requête trop courte (2 caractères min.)"));
  const scope = a.packs?.length ? "packs" : (a.scope || "all");
  const where = a.in || "all";   // name | text | all
  const hits = [];
  const test = rec => {
    if (where === "name" && rec.champ !== "name") return null;
    if (where === "text" && rec.champ === "name") return null;
    for (const [v, version] of [[rec.traduction, "fr"], [rec.valeur, rec.traduction ? "origine" : undefined]]) {
      if (!v) continue;
      const t = rec.html ? plain(v) : v;
      if (norm(t).includes(q)) return { version, extrait: snippet(v, a.query, 160) };
    }
    return null;
  };
  const push = (rec, m, pack) => hits.push({ uuid: rec.uuid, document: rec.nom_racine, type: rec.type, pack, dossier: rec.dossier || undefined,
    champ: rec.champ, version: m.version, extrait: m.extrait, score: rec.champ === "name" ? (norm(rec.traduction || rec.valeur) === q ? 3 : 2) : 1 });
  if (scope === "world" || scope === "all") {
    const types = (a.types?.length ? a.types : WORLD_TYPES).filter(t => WORLD_TYPES.includes(t));
    const w = await worldCorpus(fs, types);
    for (const rec of w.records) { const m = test(rec); if (m) push(rec, m); }
  }
  if (scope !== "world") {
    const packs = (await packsOf(fs)).filter(p => (!a.packs?.length || a.packs.includes(p.id)) && (!a.types?.length || a.types.includes(p.type)));
    for (const p of packs) for (const rec of (await packCorpus(fs, p)).records) { const m = test(rec); if (m) push(rec, m, p.id); }
  }
  hits.sort((x, y) => y.score - x.score || x.uuid.localeCompare(y.uuid));
  const total = hits.length, offset = Math.max(0, Number(a.offset) || 0), limit = Math.max(1, Number(a.limit) || 50);
  const page = hits.slice(offset, offset + limit).map(({ score, ...h }) => h);
  return { total, offset, count: page.length, next_offset: offset + page.length < total ? offset + page.length : null, resultats: page };
}

// ---------------------------------------------------------------- références inverses
/** Où un document est utilisé : liens @UUID dans les textes, sources de compendium, jetons, notes, résultats de table. */
export async function findReferences(fs, a, { packsOf }) {
  const uuid = String(a.uuid || "").trim();
  if (!uuid) throw new Error(message("Specify 'uuid'", "Préciser 'uuid'"));
  const id = uuid.split(".").at(-1);
  // formes acceptées dans les textes : @UUID[uuid], @UUID[uuid]{…}, ancien @Compendium[pack.id], @Actor[id]…
  const m = /^Compendium\.([^.]+\.[^.]+)\.(?:\w+\.)?([A-Za-z0-9]{16})$/.exec(uuid);
  const needles = [uuid];
  if (m) needles.push(`@Compendium[${m[1]}.${m[2]}]`);
  else if (/^\w+\.[A-Za-z0-9]{16}$/.test(uuid)) needles.push(`@${uuid.split(".")[0]}[${id}]`);
  const startsWithUuid = (target) => target === uuid || target?.startsWith(uuid + ".");
  const res = [];
  const scanRecords = (records, pack) => {
    for (const rec of records) {
      if (rec.uuid === uuid) continue;
      for (const v of [rec.valeur, rec.traduction]) {
        if (!v || !needles.some(n => v.includes(n))) continue;
        const i = Math.max(0, v.indexOf(needles.find(n => v.includes(n))) - 60);
        res.push({ uuid: rec.uuid, document: rec.nom_racine, pack, dossier: rec.dossier || undefined, champ: rec.champ, genre: "lien texte",
          extrait: v.slice(i, i + 200).replace(/\s+/g, " ") });
        break;
      }
    }
  };
  const scanLinks = (list, names, pack) => {
    for (const l of list) if (startsWithUuid(l.cible) || (m && l.cible === `Compendium.${m[1]}.${m[2]}`))
      res.push({ uuid: l.uuid, document: names.get(l.uuid.split(".").slice(0, pack ? 5 : 2).join(".")), pack, champ: l.champ,
        genre: l.champ.includes("compendiumSource") ? "copie (source de compendium)" : "lien" });
  };
  const scope = a.scope || (uuid.startsWith("Compendium.") ? "all" : "world");
  if (scope === "world" || scope === "all") {
    const w = await worldCorpus(fs);
    scanRecords(w.records);
    scanLinks(w.links, new Map(w.docs.map(d => [d.uuid, d.doc.name])));
  }
  if (scope !== "world") {
    const packs = (await packsOf(fs)).filter(p => !a.packs?.length || a.packs.includes(p.id));
    for (const p of packs) {
      const c = await packCorpus(fs, p);
      scanRecords(c.records, p.id);
      scanLinks(c.links, new Map(c.records.filter(r => r.uuid === r.racine && r.champ === "name").map(r => [r.uuid, r.nom_racine])), p.id);
    }
  }
  const total = res.length, offset = Math.max(0, Number(a.offset) || 0), limit = Math.max(1, Number(a.limit) || 100);
  return { cible: uuid, total, offset, next_offset: offset + limit < total ? offset + limit : null, references: res.slice(offset, offset + limit) };
}
