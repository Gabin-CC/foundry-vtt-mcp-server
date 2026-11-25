/**
 * Tables aléatoires (RollTable) et cartes (Cards) — mêmes opérations que le client Foundry
 * (RollTable#draw, Cards#draw / deal / pass / shuffle / recall), via modifyDocument.
 */
import { rollFormula, translations, trFor } from "./dnd5e.mjs";
import { applyBabele, plain, norm } from "./texts.mjs";
import { message as localizedMessage } from "./i18n.mjs";
import { isStub, limitedError } from "./access.mjs";

const esc = t => String(t ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]));
const now = () => Date.now();

function byRef(list, ref, what) {
  const englishWhat = { "Table": "Table", "Pile de cartes": "Card stack" }[what] || what;
  const d = list.find(x => x._id === ref) || list.find(x => norm(x.name) === norm(ref)) || (() => {
    const part = list.filter(x => norm(x.name).includes(norm(ref)));
    if (part.length > 1) throw new Error(localizedMessage(`Multiple ${englishWhat} entries match "${ref}": ${part.slice(0, 10).map(x => `${x.name} (${x._id})`).join(", ")}`, `Plusieurs ${what} correspondent à « ${ref} » : ${part.slice(0, 10).map(x => `${x.name} (${x._id})`).join(", ")}`));
    return part[0];
  })();
  if (!d) throw new Error(localizedMessage(`${englishWhat} not found: ${ref}`, `${what} introuvable : ${ref}`));
  return d;
}

// ====================================================================== TABLES
export const TABLE_TOOLS = [
  { name: "roll_table", description: "Tire sur une table aléatoire (RollTable du monde ou d'un compendium, traduite en FR si possible) comme Foundry : formule de la table, résultats déjà tirés exclus si la table est sans remise (et marqués tirés), tables imbriquées tirées aussi, carte de tirage dans le chat (optionnelle). action=reset remet tous les résultats en jeu.",
    inputSchema: { type: "object", required: ["table"], properties: {
      table: { type: "string", description: "Nom, _id ou UUID (RollTable.x, Compendium.dnd5e.tables24.RollTable.x)" },
      action: { type: "string", enum: ["draw", "reset", "show"], default: "draw" },
      count: { type: "number", default: 1, description: "Nombre de tirages" },
      chat: { type: "boolean", default: true, description: "Poster le résultat dans le chat" },
      mode: { type: "string", enum: ["public", "mj", "aveugle", "prive"], default: "public" } } } },
];

async function resolveTable(fs, ref) {
  const m = /^Compendium\.([^.]+\.[^.]+)\.(?:RollTable\.)?([A-Za-z0-9]{16})$/.exec(ref);
  if (m) {
    const d = (await fs.doc("get", "RollTable", { pack: m[1], query: { _id: m[2] } })).find(x => x._id === m[2]);
    if (!d) throw new Error(localizedMessage(`Table not found: ${ref}`, `Table introuvable : ${ref}`));
    if (isStub(d)) throw limitedError(d.name);
    const t = trFor(await translations(m[1]), d);
    return { table: t ? applyBabele(d, t, "RollTable") : d, pack: m[1], uuid: ref };
  }
  const id = ref.replace(/^RollTable\./, "");
  const list = await fs.doc("get", "RollTable", { query: {} });
  const table = byRef(list, id, "Table");
  if (isStub(table)) throw limitedError(table.name);
  return { table, pack: null, uuid: `RollTable.${table._id}` };
}

/** Plages normalisées si la table n'a pas de formule (comme RollTable#normalize). */
function normalized(table) {
  if (table.formula) return { formula: table.formula, results: table.results || [] };
  let lo = 1;
  const results = (table.results || []).map(r => { const w = Number(r.weight) || 1; const x = { ...r, range: [lo, lo + w - 1] }; lo += w; return x; });
  return { formula: `1d${lo - 1}`, results };
}

async function rollOnce(fs, table, pack, depth, drawnNow) {
  if (depth > 5) throw new Error(localizedMessage("Maximum nested-table depth exceeded", "Profondeur maximale de tables imbriquées atteinte"));
  const { formula, results } = normalized(table);
  const available = results.filter(r => !r.drawn && !drawnNow.has(r._id));
  if (!available.length) throw new Error(localizedMessage(`No results left in "${table.name}" (table without replacement is exhausted: action=reset)`, `Plus aucun résultat disponible sur « ${table.name} » (table sans remise épuisée : action=reset)`));
  let roll, hits = [];
  for (let i = 0; i < 1000 && !hits.length; i++) {
    roll = rollFormula(formula, { flavor: table.name });
    hits = available.filter(r => roll.total >= r.range[0] && roll.total <= r.range[1]);
  }
  if (!hits.length) throw new Error(localizedMessage(`No reachable result with ${formula} on "${table.name}"`, `Aucun résultat atteignable avec ${formula} sur « ${table.name} »`));
  const out = [];
  for (const r of hits) {
    if (!table.replacement && !pack) drawnNow.add(r._id);
    if (r.type === "document" && /(^|\.)RollTable\.[A-Za-z0-9]{16}$/.test(r.documentUuid || "")) {
      const inner = await resolveTable(fs, r.documentUuid);
      const sub = await rollOnce(fs, inner.table, inner.pack, depth + 1, new Set());
      out.push(...sub.results.map(x => ({ ...x, via: table.name })));
      if (!inner.table.replacement && !inner.pack) await markDrawn(fs, inner.table._id, sub.results.map(x => x._id));
    } else out.push(r);
  }
  return { roll, results: out };
}
const markDrawn = (fs, tableId, ids) => ids.length ? fs.doc("update", "TableResult", { parentUuid: `RollTable.${tableId}`, updates: ids.map(_id => ({ _id, drawn: true })), modifiedTime: now() }) : null;

const resultView = r => ({ _id: r._id, plage: r.range?.join("–"), type: r.type, nom: r.name || undefined,
  texte: plain(r.description ?? r.text) || undefined, document: r.documentUuid || undefined, img: r.img || undefined, via: r.via });
function resultHtml(r) {
  const label = r.name || "";
  const body = r.documentUuid ? `@UUID[${r.documentUuid}]{${esc(label || r.documentUuid)}}${r.description ? ` ${r.description}` : ""}` : (r.description || esc(label));
  return `<li class="flexrow" data-result-id="${esc(r._id)}"><img src="${esc(r.img || "icons/svg/d20-black.svg")}"><div class="result-text">${body}</div></li>`;
}

export async function handleTable(fs, a, { postChat }) {
  const { table, pack, uuid } = await resolveTable(fs, a.table);
  if (a.action === "show") return { uuid, nom: table.name, formule: table.formula || localizedMessage("(normalized)", "(normalisée)"), remise: !!table.replacement,
    resultats: (table.results || []).map(r => ({ ...resultView(r), tire: !!r.drawn })) };
  if (a.action === "reset") {
    if (pack) throw new Error(localizedMessage("Compendium tables do not persist draws", "Les tables de compendium ne gardent pas les tirages"));
    const ups = (table.results || []).filter(r => r.drawn).map(r => ({ _id: r._id, drawn: false }));
    if (ups.length) await fs.doc("update", "TableResult", { parentUuid: uuid, updates: ups, modifiedTime: now() });
    return localizedMessage(`Table "${table.name}" reset (${ups.length} result(s) restored)`, `Table « ${table.name} » réinitialisée (${ups.length} résultat(s) remis en jeu)`);
  }
  const n = Math.max(1, Math.min(Number(a.count) || 1, 100));
  const drawnNow = new Set(), draws = [];
  for (let i = 0; i < n; i++) draws.push(await rollOnce(fs, table, pack, 0, drawnNow));
  if (drawnNow.size) await markDrawn(fs, table._id, [...drawnNow]);
  const all = draws.flatMap(d => d.results);
  let message;
  if (a.chat !== false) {
    const desc = table.description ? `<div class="table-description">${table.description}</div>` : "";
    const content = `<div class="table-draw" data-table-id="${esc(table._id)}">${desc}<ul class="table-results">${all.map(resultHtml).join("")}</ul></div>`;
    message = await postChat(fs, { flavor: localizedMessage(`Drew ${all.length} result${all.length > 1 ? "s" : ""} from ${esc(table.name)}`, `Tirage de ${all.length} résultat${all.length > 1 ? "s" : ""} sur ${esc(table.name)}`), content,
      rolls: table.displayRoll === false ? [] : draws.map(d => d.roll), mode: a.mode, extra: { flags: { core: { RollTable: table._id } } } });
  }
  return { table: table.name, uuid, tirages: draws.map(d => ({ jet: d.roll.total, formule: d.roll.formula, resultats: d.results.map(resultView) })),
    marques_tires: drawnNow.size || undefined, message };
}

// ====================================================================== CARTES
export const CARD_TOOLS = [
  { name: "cards", description: "Cartes (paquets, mains, défausses) comme le client Foundry. list (piles et cartes), draw (piocher de 'from' vers 'to'), deal (distribuer 'number' cartes de 'from' à chaque pile de 'to'), pass / discard (donner / défausser des cartes précises de 'from' vers 'to' ; discard sans 'to' = première défausse), shuffle (mélanger 'from'), recall (paquet : récupère toutes ses cartes ; main/défausse : renvoie ses cartes à leur paquet). Message dans le chat optionnel.",
    inputSchema: { type: "object", required: ["action"], properties: {
      action: { type: "string", enum: ["list", "draw", "deal", "pass", "discard", "shuffle", "recall"] },
      from: { type: "string", description: "Pile source (nom ou _id) ; pour list : pile à détailler" },
      to: { type: "array", items: { type: "string" }, description: "Pile(s) destination (nom ou _id) ; plusieurs pour deal" },
      number: { type: "number", default: 1 }, how: { type: "string", enum: ["top", "bottom", "random"], default: "top" },
      cards: { type: "array", items: { type: "string" }, description: "pass/discard : cartes (_id ou nom de face)" },
      face_down: { type: "boolean", description: "Cartes face cachée (face = null)" },
      chat: { type: "boolean", default: true } } } },
];

const cardName = c => (c.face != null && c.faces?.[c.face]?.name) || c.name;
const available = stack => (stack.cards || []).filter(c => stack.type !== "deck" || !c.drawn);
const isHome = (c, stack) => stack.type === "deck" || c.origin === stack._id;

function drawCards(stack, number, how) {
  const av = available(stack);
  if (av.length < number) throw new Error(localizedMessage(`Only ${av.length} card(s) available in "${stack.name}"`, `Seulement ${av.length} carte(s) disponible(s) dans « ${stack.name} »`));
  av.sort((x, y) => (x.sort || 0) - (y.sort || 0));
  if (how === "bottom") return av.slice(-number);
  if (how === "random") return av.map(c => [Math.random(), c]).sort((x, y) => x[0] - y[0]).slice(-number).map(x => x[1]);
  return av.slice(0, number);
}

/** Cards#pass : copie dans la destination (même _id), carte marquée tirée dans son paquet ou retirée de la pile. */
async function pass(fs, from, to, cards, updateData = {}) {
  const toCreate = [], toUpdate = [], fromUpdate = [], fromDelete = [];
  let maxSort = (to.cards || []).reduce((m, c) => Math.max(m, c.sort || 0), 0);
  for (const card of cards) {
    const home = isHome(card, from);
    if (from.type === "deck" && home && card.drawn) throw new Error(localizedMessage(`Card ${cardName(card)} has already been drawn`, `La carte ${cardName(card)} a déjà été tirée`));
    if (card.origin === to._id) toUpdate.push({ _id: card._id, drawn: false });   // retour à son paquet
    else {
      const d = { ...structuredClone(card), ...updateData };
      const copyCard = home && to.type === "deck";
      if (copyCard) d.origin = to._id;
      else if (home || !d.origin) d.origin = from._id;
      if (!copyCard) { maxSort += 100000; d.sort = maxSort; }
      d.drawn = !copyCard;
      if ((to.cards || []).some(c => c._id === d._id)) throw new Error(localizedMessage(`Card ${cardName(card)} is already in "${to.name}"`, `La carte ${cardName(card)} est déjà dans « ${to.name} »`));
      toCreate.push(d);
    }
    if (home && to.type !== "deck") fromUpdate.push({ _id: card._id, drawn: true });
    else if (!home) fromDelete.push(card._id);
  }
  if (toCreate.length) await fs.doc("create", "Card", { parentUuid: `Cards.${to._id}`, data: toCreate, keepId: true, modifiedTime: now() });
  if (toUpdate.length) await fs.doc("update", "Card", { parentUuid: `Cards.${to._id}`, updates: toUpdate, modifiedTime: now() });
  if (fromUpdate.length) await fs.doc("update", "Card", { parentUuid: `Cards.${from._id}`, updates: fromUpdate, modifiedTime: now() });
  if (fromDelete.length) await fs.doc("delete", "Card", { parentUuid: `Cards.${from._id}`, ids: fromDelete, modifiedTime: now() });
}

export async function handleCards(fs, a, { postChat }) {
  if (typeof a.to === "string") a.to = [a.to];
  if (["draw", "deal", "pass", "discard", "shuffle", "recall"].includes(a.action) && !a.from) throw new Error(localizedMessage("Specify 'from'", "Préciser 'from'"));
  if (["draw", "deal", "pass"].includes(a.action) && !a.to?.length) throw new Error(localizedMessage("Specify 'to'", "Préciser 'to'"));
  const stacks = await fs.doc("get", "Cards", { query: {} });
  const get = ref => { const s = byRef(stacks, ref, "Pile de cartes"); if (isStub(s)) throw limitedError(s.name); return s; };
  const notify = async (src, text) => {
    if (a.chat === false) return;
    await postChat(fs, { content: `<div class="cards-notification flexrow"><img class="icon" src="${esc(src.img || "icons/svg/card-hand.svg")}" alt="${esc(src.name)}"><p>${text}</p></div>` });
  };
  const view = (c, st) => ({ _id: c._id, nom: cardName(c), tiree: (st?.type === "deck" && c.drawn) || undefined, face: c.face == null ? "cachée" : undefined });
  const upd = a.face_down ? { face: null } : {};
  switch (a.action) {
    case "list": {
      if (a.from) {
        const s = get(a.from);
        const cards = (s.cards || []).slice().sort((x, y) => (x.sort || 0) - (y.sort || 0));
        return { _id: s._id, nom: s.name, type: s.type, disponibles: available(s).length, total: cards.length, cartes: cards.map(c => view(c, s)) };
      }
      return stacks.map(s => isStub(s) ? { _id: s._id, nom: s.name, type: s.type }
        : { _id: s._id, nom: s.name, type: s.type, cartes: (s.cards || []).length, disponibles: available(s).length });
    }
    case "draw": {
      const from = get(a.from), to = get(a.to?.[0] || "");
      const n = Math.max(1, Number(a.number) || 1);
      const picked = drawCards(from, n, a.how);
      await pass(fs, from, to, picked, upd);
      await notify(to, localizedMessage(`${n} card(s) drawn from @UUID[Cards.${from._id}]{${esc(from.name)}} by ${esc(to.name)}.`, `${n} carte${n > 1 ? "s" : ""} piochée${n > 1 ? "s" : ""} depuis @UUID[Cards.${from._id}]{${esc(from.name)}} par ${esc(to.name)}.`));
      return { de: from.name, vers: to.name, cartes: picked.map(view) };
    }
    case "deal": {
      const from = get(a.from), dests = (a.to || []).map(get);
      if (!dests.length) throw new Error(localizedMessage("Specify 'to' (destination stacks)", "Préciser 'to' (piles destinataires)"));
      const n = Math.max(1, Number(a.number) || 1);
      const picked = drawCards(from, n * dests.length, a.how);
      const per = dests.map(() => []);
      picked.forEach((c, i) => per[i % dests.length].push(c));
      for (let i = 0; i < dests.length; i++) await pass(fs, from, dests[i], per[i], upd);
      await notify(from, localizedMessage(`${n} card(s) dealt from ${esc(from.name)} to ${dests.map(d => `@UUID[Cards.${d._id}]{${esc(d.name)}}`).join(", ")}.`, `${n} carte${n > 1 ? "s" : ""} distribuée${n > 1 ? "s" : ""} depuis ${esc(from.name)} à ${dests.map(d => `@UUID[Cards.${d._id}]{${esc(d.name)}}`).join(", ")}.`));
      return { de: from.name, distribution: dests.map((d, i) => ({ vers: d.name, cartes: per[i].map(view) })) };
    }
    case "pass": case "discard": {
      const from = get(a.from);
      const to = a.to?.[0] ? get(a.to[0]) : a.action === "discard" ? stacks.find(s => s.type === "pile") : null;
      if (!to) throw new Error(a.action === "discard" ? localizedMessage("No discard pile in the world: specify 'to'", "Aucune défausse (pile) dans le monde : préciser 'to'") : localizedMessage("Specify 'to'", "Préciser 'to'"));
      if (!a.cards?.length) throw new Error(localizedMessage("Specify 'cards'", "Préciser 'cards'"));
      const picked = a.cards.map(r => {
        const c = (from.cards || []).find(x => x._id === r) || (from.cards || []).find(x => norm(cardName(x)) === norm(r) && (from.type !== "deck" || !x.drawn));
        if (!c) throw new Error(localizedMessage(`Card not found in "${from.name}": ${r}`, `Carte introuvable dans « ${from.name} » : ${r}`));
        return c;
      });
      await pass(fs, from, to, picked, upd);
      await notify(from, localizedMessage(`${picked.length} card(s) ${a.action === "discard" ? "discarded" : "passed"} from ${esc(from.name)} to @UUID[Cards.${to._id}]{${esc(to.name)}}.`, `${picked.length} carte${picked.length > 1 ? "s" : ""} ${a.action === "discard" ? "défaussée" : "passée"}${picked.length > 1 ? "s" : ""} de ${esc(from.name)} vers @UUID[Cards.${to._id}]{${esc(to.name)}}.`));
      return { de: from.name, vers: to.name, cartes: picked.map(view) };
    }
    case "shuffle": {
      const s = get(a.from);
      const order = (s.cards || []).map(c => [Math.random(), c]).sort((x, y) => x[0] - y[0]);
      await fs.doc("update", "Card", { parentUuid: `Cards.${s._id}`, updates: order.map(([, c], i) => ({ _id: c._id, sort: i, ...upd })), modifiedTime: now() });
      await notify(s, localizedMessage(`@UUID[Cards.${s._id}]{${esc(s.name)}} was shuffled.`, `@UUID[Cards.${s._id}]{${esc(s.name)}} a été mélangé.`));
      return localizedMessage(`"${s.name}" shuffled (${order.length} cards)`, `« ${s.name} » mélangé (${order.length} cartes)`);
    }
    case "recall": {
      const s = get(a.from);
      if (s.type === "deck") {
        let back = 0;
        for (const o of stacks) {
          if (o._id === s._id) continue;
          const ids = (o.cards || []).filter(c => c.origin === s._id).map(c => c._id);
          if (ids.length) { await fs.doc("delete", "Card", { parentUuid: `Cards.${o._id}`, ids, modifiedTime: now() }); back += ids.length; }
        }
        const ups = (s.cards || []).map(c => ({ _id: c._id, drawn: false, ...upd }));
        if (ups.length) await fs.doc("update", "Card", { parentUuid: `Cards.${s._id}`, updates: ups, modifiedTime: now() });
        await notify(s, localizedMessage(`@UUID[Cards.${s._id}]{${esc(s.name)}} was reset.`, `@UUID[Cards.${s._id}]{${esc(s.name)}} a été réinitialisé.`));
        return localizedMessage(`Deck "${s.name}" reset (${back} card(s) recovered)`, `Paquet « ${s.name} » réinitialisé (${back} carte(s) récupérée(s))`);
      }
      const byOrigin = {}, del = [];
      for (const c of s.cards || []) {
        if (isHome(c, s) || !c.origin) continue;
        const o = stacks.find(x => x._id === c.origin);
        if (o && (o.cards || []).some(x => x._id === c._id)) (byOrigin[o._id] ??= []).push({ _id: c._id, drawn: false, ...upd });
        del.push(c._id);
      }
      for (const [oid, ups] of Object.entries(byOrigin)) await fs.doc("update", "Card", { parentUuid: `Cards.${oid}`, updates: ups, modifiedTime: now() });
      if (del.length) await fs.doc("delete", "Card", { parentUuid: `Cards.${s._id}`, ids: del, modifiedTime: now() });
      await notify(s, localizedMessage(`Cards from @UUID[Cards.${s._id}]{${esc(s.name)}} were returned to their deck.`, `Les cartes de @UUID[Cards.${s._id}]{${esc(s.name)}} ont été rendues à leur paquet.`));
      return localizedMessage(`${del.length} card(s) from "${s.name}" returned to their deck`, `${del.length} carte(s) de « ${s.name} » rendue(s) à leur paquet`);
    }
  }
  throw new Error(localizedMessage(`Unknown action: ${a.action}`, `Action inconnue : ${a.action}`));
}
