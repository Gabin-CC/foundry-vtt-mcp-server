/**
 * Réponses volumineuses : jamais tronquées au milieu du JSON. Une réponse trop grosse est découpée en pages
 * JSON valides (tableau découpé par éléments, objet par clés, texte par paragraphes), gardées côté serveur
 * 30 min ; la première page est renvoyée avec un curseur à passer à l'outil next_page.
 */
import crypto from "node:crypto";
import { message } from "./i18n.mjs";

export const MAX_OUT = Number(process.env.MAX_OUT) || 60000;
const TTL = 30 * 60 * 1000;
const MAX_STORED = 100;
const store = new Map();   // id -> { owner, pages, at }

const json = v => JSON.stringify(v, null, 1) ?? "";
const size = v => typeof v === "string" ? v.length + 2 : json(v).length;

function splitString(s, budget) {
  const parts = [];
  let rest = s;
  while (rest.length > budget) {
    let cut = rest.lastIndexOf("\n", budget);
    if (cut < budget / 2) cut = rest.lastIndexOf(" ", budget);
    if (cut < budget / 2) cut = budget;
    parts.push(rest.slice(0, cut)); rest = rest.slice(cut);
  }
  if (rest) parts.push(rest);
  return parts;
}

/** Découpe une valeur en morceaux dont la taille sérialisée tient dans le budget (au mieux). */
export function split(v, budget = Math.floor(MAX_OUT * 0.9)) {
  if (size(v) <= budget) return [v];
  if (typeof v === "string") return splitString(v, Math.floor(budget * 0.8));
  if (Array.isArray(v)) {
    const pages = []; let cur = [], curSize = 2;
    const flush = () => { if (cur.length) pages.push(cur); cur = []; curSize = 2; };
    v.forEach((item, i) => {
      const n = size(item) + 3;
      if (n > budget) {   // élément trop gros à lui seul : découpé, une page par morceau
        flush();
        const parts = split(item, budget - 200);
        parts.forEach((p, j) => pages.push([{ element: i, partie: `${j + 1}/${parts.length}`, valeur: p }]));
        return;
      }
      if (curSize + n > budget) flush();
      cur.push(item); curSize += n;
    });
    flush();
    return pages;
  }
  if (v && typeof v === "object") {
    const keys = Object.keys(v);
    // cas courant : un objet avec une grosse liste ({ total, documents: [...] }) → la liste est découpée,
    // les autres champs sont répétés sur chaque page
    const biggest = keys.reduce((b, k) => size(v[k]) > size(v[b] ?? "") ? k : b, keys[0]);
    if (Array.isArray(v[biggest])) {
      // Additive English aliases share the same array reference in memory.
      // Split it once and repeat each matching key on the same page, instead
      // of putting the legacy and English copies on separate pages.
      const shared = keys.filter(k => v[k] === v[biggest]);
      const rest = Object.fromEntries(keys.filter(k => !shared.includes(k)).map(k => [k, v[k]]));
      const restSize = size(rest);
      if (restSize < budget / 4 && budget - restSize - 100 > shared.length * 200) {
        const chunkBudget = Math.floor((budget - restSize - 100) / shared.length);
        return split(v[biggest], chunkBudget).map(chunk => ({ ...rest, ...Object.fromEntries(shared.map(k => [k, chunk])) }));
      }
    }
    const pages = []; let cur = {}, curSize = 2;
    const flush = () => { if (Object.keys(cur).length) pages.push(cur); cur = {}; curSize = 2; };
    for (const k of keys) {
      const n = size(v[k]) + k.length + 6;
      if (n > budget) {   // champ trop gros : découpé ; les petits champs en attente restent avec sa première partie
        const head = curSize < budget / 4 ? cur : (flush(), {});
        const parts = split(v[k], budget - k.length - 200 - (Object.keys(head).length ? size(head) : 0));
        parts.forEach((p, j) => pages.push({ ...(j === 0 ? head : {}), [k]: p, _partie: `${j + 1}/${parts.length}` }));
        cur = {}; curSize = 2;
        continue;
      }
      if (curSize + n > budget) flush();
      cur[k] = v[k]; curSize += n;
    }
    flush();
    return pages;
  }
  return [v];
}

function prune() {
  const now = Date.now();
  for (const [k, e] of store) if (now - e.at > TTL) store.delete(k);
  while (store.size > MAX_STORED) store.delete(store.keys().next().value);
}

const wrap = (id, pages, i) => ({
  page: i + 1, pages: pages.length,
  curseur_suivant: i + 1 < pages.length ? `${id}:${i + 2}` : null,
  note: i + 1 < pages.length ? message("Response split into valid JSON pages: call next_page with the curseur_suivant field to continue.", "Réponse découpée en pages JSON valides : appelle next_page avec curseur_suivant pour la suite.") : undefined,
  contenu: pages[i],
});

/** Texte d'une réponse MCP : tel quel s'il tient, sinon première page + curseur. */
export function render(v, owner) {
  const t = typeof v === "string" ? v : (json(v) || message("(empty)", "(vide)"));
  if (t.length <= MAX_OUT) return t;
  const pages = split(v);
  if (pages.length <= 1) return t;   // indivisible (cas extrême) : renvoyé entier plutôt que coupé
  prune();
  const id = crypto.randomBytes(6).toString("hex");
  store.set(id, { owner, pages, at: Date.now() });
  return json(wrap(id, pages, 0));
}

/** Page suivante d'une réponse découpée (curseur « id:n »). */
export function nextPage(cursor, owner) {
  const m = /^([0-9a-f]+):(\d+)$/.exec(String(cursor || ""));
  const e = m && store.get(m[1]);
  if (!e || e.owner !== owner) throw new Error(message("Unknown or expired cursor (30 minutes): retry the original tool call.", "Curseur inconnu ou expiré (30 min) : relance l'appel d'origine."));
  const i = Number(m[2]) - 1;
  if (i < 0 || i >= e.pages.length) throw new Error(message(`Page out of range (1–${e.pages.length})`, `Page hors limites (1–${e.pages.length})`));
  e.at = Date.now();
  return wrap(m[1], e.pages, i);
}
