/**
 * Prévisualisation avant/après et instantanés de restauration des modifications par lot.
 *
 * Avant chaque modification (update_documents, localize_actor, delete_documents), les valeurs actuelles des champs
 * touchés sont enregistrées côté serveur (fichiers JSON dans SNAPSHOT_DIR, défaut data/snapshots du dépôt). L'outil
 * snapshots permet de les lister, de les voir et de les restaurer (la restauration crée elle-même un instantané).
 */
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { message } from "./i18n.mjs";
import { captureActorState, restoreActorState } from "./actor-progress.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = process.env.SNAPSHOT_DIR || path.join(ROOT, "data", "snapshots");
const KEEP = Number(process.env.SNAPSHOT_KEEP) || 500;
const KEEP_DAYS = Number(process.env.SNAPSHOT_DAYS) || 90;

const getPath = (o, p) => p.split(".").reduce((a, k) => a?.[k], o);
const isObj = v => v && typeof v === "object" && !Array.isArray(v);
const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);

/** Update Foundry (objets imbriqués ou notation pointée) → { "chemin.pointé": valeur } aux feuilles. */
export function flattenUpdate(u, prefix = "", res = {}) {
  for (const [k, v] of Object.entries(u || {})) {
    if (!prefix && k === "_id") continue;
    const p = prefix ? `${prefix}.${k}` : k;
    const last = k.split(".").at(-1);
    if (isObj(v) && Object.keys(v).length && !last.startsWith("==") && !last.startsWith("-=")) flattenUpdate(v, p, res);
    else res[p] = v;
  }
  return res;
}
/** Chemin réel d'une clé d'update (« a.-=b » → suppression de a.b, « a.==b » → remplacement de a.b). */
const realPath = p => p.split(".").map(k => k.replace(/^(-=|==)/, "")).join(".");
const isDeletion = p => p.split(".").at(-1).startsWith("-=");

export const excerpt = (v, n = 300) => {
  if (typeof v !== "string") return v;
  return v.length > n ? v.slice(0, n) + `… (${v.length} car.)` : v;
};

/**
 * Compare des updates aux documents actuels.
 * @returns {{entries: object[], preview: object[]}} entries = pour l'instantané (valeurs complètes), preview = affichage
 */
export function diffUpdates(docs, updates) {
  const byId = new Map(docs.map(d => [d._id, d]));
  const entries = [], preview = [];
  for (const u of updates) {
    const d = byId.get(u._id);
    if (!d) { preview.push({ _id: u._id, erreur: "document introuvable" }); continue; }
    const avant = {}, apres = {}, absents = [], changes = [];
    for (const [k, v] of Object.entries(flattenUpdate(u))) {
      const p = realPath(k);
      const before = getPath(d, p);
      const after = isDeletion(k) ? undefined : v;
      if (same(before, after)) continue;
      if (before === undefined) absents.push(p); else avant[p] = before;
      apres[p] = after === undefined ? null : after;
      changes.push({ champ: p, avant: before === undefined ? "(absent)" : excerpt(before), apres: isDeletion(k) ? "(supprimé)" : excerpt(after) });
    }
    if (!changes.length) { preview.push({ _id: u._id, nom: d.name, changements: "aucun (valeurs identiques)" }); continue; }
    entries.push({ _id: u._id, nom: d.name, avant, absents, apres });
    preview.push({ _id: u._id, nom: d.name, changements: changes });
  }
  return { entries, preview };
}

async function ensureDir() { await fsp.mkdir(DIR, { recursive: true }); }
const file = id => path.join(DIR, `${id}.json`);

async function prune() {
  try {
    const names = (await fsp.readdir(DIR)).filter(n => n.endsWith(".json")).sort();   // id = horodatage en tête
    const old = Date.now() - KEEP_DAYS * 86400000;
    const drop = names.slice(0, Math.max(0, names.length - KEEP));
    for (const n of names) if (Number(n.slice(0, 13)) < old && !drop.includes(n)) drop.push(n);
    for (const n of drop) await fsp.unlink(path.join(DIR, n)).catch(() => {});
  } catch { /* dossier absent */ }
}

/**
 * Enregistre un instantané. ops : [{ action: "update", type, pack?, parent?, entries }]
 *                                 [{ action: "delete", type, pack?, parent?, docs }]
 *                                 [{ action: "actor_state", type: "Actor", actor_id, before, after? }]
 */
export async function saveSnapshot(fs, tool, label, ops) {
  ops = ops.filter(o => (o.entries?.length || o.docs?.length || (o.action === "actor_state" && o.before)));
  if (!ops.length) return null;
  await ensureDir();
  const id = `${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  const snap = { id, date: new Date().toISOString(), user: fs.userId, user_name: fs.user?.name, tool, label, ops };
  await fsp.writeFile(file(id), JSON.stringify(snap));
  prune();
  return id;
}

/** Record the precise post-write state for optimistic, conflict-safe actor restoration. */
export async function finalizeActorSnapshot(id, actorId, after) {
  const s = await load(id);
  const o = s.ops.find(o => o.action === "actor_state" && o.actor_id === actorId);
  if (!o || o.after) throw new Error("Invalid or already finalized character progression snapshot.");
  if (after.actor_id !== actorId) throw new Error("Character snapshot actor ID mismatch.");
  o.after = after;
  await fsp.writeFile(file(id), JSON.stringify(s));
}

async function load(id) {
  if (!/^\d{13}-[0-9a-f]{6}$/.test(String(id))) throw new Error(message(`Invalid snapshot ID: ${id}`, `Identifiant d'instantané invalide : ${id}`));
  try { return JSON.parse(await fsp.readFile(file(id), "utf8")); } catch { throw new Error(message(`Snapshot not found: ${id}`, `Instantané introuvable : ${id}`)); }
}
const canSee = (fs, s, isGM) => isGM || s.user === fs.userId;
const summary = s => ({ id: s.id, date: s.date, utilisateur: s.user_name, outil: s.tool, libelle: s.label,
  operations: s.ops.map(o => o.action === "actor_state"
    ? message(`Character state: ${o.actor_id} (${o.after ? "restorable" : "not finalized"})`, `État du personnage : ${o.actor_id} (${o.after ? "restaurable" : "non finalisé"})`)
    : message(`${o.action} ${o.type}${o.parent ? ` (in ${o.parent})` : ""}${o.pack ? ` [${o.pack}]` : ""}: ${(o.entries || o.docs).length} document(s)`, `${o.action} ${o.type}${o.parent ? ` (dans ${o.parent})` : ""}${o.pack ? ` [${o.pack}]` : ""} : ${(o.entries || o.docs).length} document(s)`)),
  restaure: s.restored || undefined });

export async function listSnapshots(fs, isGM, { limit = 30, tool } = {}) {
  let names = [];
  try { names = (await fsp.readdir(DIR)).filter(n => n.endsWith(".json")).sort().reverse(); } catch { return []; }
  const res = [];
  for (const n of names) {
    if (res.length >= limit) break;
    try {
      const s = JSON.parse(await fsp.readFile(path.join(DIR, n), "utf8"));
      if (!canSee(fs, s, isGM) || (tool && s.tool !== tool)) continue;
      res.push(summary(s));
    } catch { /* fichier illisible */ }
  }
  return res;
}

export async function showSnapshot(fs, isGM, id) {
  const s = await load(id);
  if (!canSee(fs, s, isGM)) throw new Error(message("Snapshot belongs to another user", "Instantané d'un autre utilisateur"));
  return { ...summary(s), detail: s.ops.map(o => o.action === "actor_state"
    ? { action: "actor_state", type: "Actor", acteur: o.actor_id, restaurable: !!o.after,
      objets_avant: o.before.items.length, objets_apres: o.after?.items.length }
    : ({ action: o.action, type: o.type, parent: o.parent, pack: o.pack,
    documents: o.action === "update"
      ? o.entries.map(e => ({ _id: e._id, nom: e.nom, champs: [...Object.entries(e.avant).map(([k, v]) => ({ champ: k, valeur_sauvegardee: excerpt(v), valeur_apres: excerpt(e.apres?.[k]) })),
          ...e.absents.map(k => ({ champ: k, valeur_sauvegardee: message("(missing)", "(absent)"), valeur_apres: excerpt(e.apres?.[k]) }))] }))
      : o.docs.map(d => ({ _id: d._id, nom: d.name })) })) };
}

const opt = o => ({ ...(o.parent ? { parentUuid: o.parent } : {}), ...(o.pack ? { pack: o.pack } : {}) });
export async function currentDocs(fs, o, ids) {
  if (!o.parent && ids.length <= 20) {
    const res = [];
    for (const id of ids) res.push(...(await fs.doc("get", o.type, { query: { _id: id }, ...opt(o) })).filter(x => x._id === id));
    return res;
  }
  const want = new Set(ids);
  return (await fs.doc("get", o.type, { query: {}, ...opt(o) })).filter(x => want.has(x._id));
}

/** Restaure un instantané (ou le simule avec dryRun). La restauration est elle-même enregistrée comme instantané. */
export async function restoreSnapshot(fs, isGM, id, { dryRun = false } = {}) {
  const s = await load(id);
  if (!canSee(fs, s, isGM)) throw new Error(message("Snapshot belongs to another user", "Instantané d'un autre utilisateur"));
  const report = [], undoOps = [];
  // ordre inverse : la dernière opération est annulée en premier
  for (const o of [...s.ops].reverse()) {
    if (o.action === "actor_state") {
      if (!o.after) throw new Error(message("Character snapshot was not finalized; cannot restore it automatically.",
        "Instantané de personnage non finalisé : restauration automatique impossible."));
      const result = await restoreActorState(fs, o.after, o.before, { dryRun });
      report.push({ action: "actor_state", type: "Actor", ...result });
      if (!dryRun) {
        const restored = (await currentDocs(fs, { type: "Actor" }, [o.actor_id])).find(x => x._id === o.actor_id);
        if (!restored) throw new Error("Restored character is missing.");
        undoOps.push({ action: "actor_state", type: "Actor", actor_id: o.actor_id,
          before: o.after, after: captureActorState(restored) });
      }
    } else if (o.action === "update") {
      const updates = o.entries.map(e => {
        const u = { _id: e._id, ...e.avant };
        for (const p of e.absents) { const ks = p.split("."); u[[...ks.slice(0, -1), `-=${ks.at(-1)}`].join(".")] = null; }
        return u;
      });
      const docs = await currentDocs(fs, o, updates.map(u => u._id));
      const { entries, preview } = diffUpdates(docs, updates);
      report.push({ action: "update", type: o.type, parent: o.parent, documents: preview });
      if (!dryRun && entries.length) {
        const ok = updates.filter(u => entries.some(e => e._id === u._id));
        for (let i = 0; i < ok.length; i += 50)
          await fs.doc("update", o.type, { updates: ok.slice(i, i + 50), diff: true, recursive: true, modifiedTime: Date.now(), render: true, ...opt(o) });
        undoOps.push({ action: "update", type: o.type, pack: o.pack, parent: o.parent, entries });
      }
    } else if (o.action === "delete") {
      const existing = await currentDocs(fs, o, o.docs.map(d => d._id));
      const missing = o.docs.filter(d => !existing.some(x => x._id === d._id));
      report.push({ action: "recréation", type: o.type, parent: o.parent, documents: missing.map(d => ({ _id: d._id, nom: d.name })),
        deja_presents: existing.length ? existing.map(d => d._id) : undefined });
      if (!dryRun && missing.length) await fs.doc("create", o.type, { data: missing, keepId: true, keepEmbeddedIds: true, modifiedTime: Date.now(), render: true, ...opt(o) });
    }
  }
  let undo = null;
  if (!dryRun) {
    undo = await saveSnapshot(fs, "snapshots.restore", `annulation de la restauration ${id}`, undoOps);
    s.restored = { date: new Date().toISOString(), par: fs.user?.name, instantane_annulation: undo };
    await fsp.writeFile(file(id), JSON.stringify(s));
  }
  return { instantane: id, simulation: dryRun, operations: report, instantane_de_la_restauration: undo || undefined };
}
