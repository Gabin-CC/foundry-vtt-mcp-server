/**
 * Textes des documents Foundry : énumération des champs textuels (nom, description, activités, pages de journal,
 * faces de cartes, résultats de tables, effets…), texte brut, heuristique de langue FR/EN, traduction Babele
 * appliquée à un document de compendium (pour l'audit, la recherche et les références).
 */

/** HTML Foundry → texte brut (liens @UUID[…]{libellé} → libellé, jets [[…]] retirés, balises Plutonium → nom). */
export function plain(html) {
  return String(html ?? "")
    .replace(/@(UUID|Compendium|Embed|Actor|Item|JournalEntry|RollTable|Scene|Macro)\[[^\]]*\](?:\{([^}]*)\})?/g, (_, __, label) => label ? ` ${label} ` : " ")
    .replace(/@\w+\[([^\]|]*)[^\]]*\](?:\{([^}]*)\})?/g, (_, n, label) => ` ${label || n} `)   // @spell[Fireball|XPHB], @item[…]
    .replace(/&Reference\[[^\]]*\](?:\{([^}]*)\})?/g, (_, l) => ` ${l || ""} `)
    .replace(/\[\[[^\]]*\]\](?:\{([^}]*)\})?/g, (_, l) => ` ${l || ""} `)
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&(#39|apos|rsquo|lsquo|#x27);/g, "'").replace(/&(quot|ldquo|rdquo|laquo|raquo);/g, "\"").replace(/&[a-z]+;|&#\d+;/g, " ")
    .replace(/\s+/g, " ").trim();
}

export const norm = t => String(t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[’']/g, "'").trim();

// Mots-outils (et quelques termes de règles) propres à chaque langue ; les mots ambigus (a, on, or, plus, car,
// action, bonus, minute…) sont exclus.
const EN = new Set(("the of and to is are was were be been being you your yours it its this that these those with for from by which who whom " +
  "when where while if then than can cannot each any other into onto upon within without until must may might would should could will " +
  "has have had their they them there here what such only also but not no all one two three four five six seven eight nine ten an as in at " +
  "creature creatures target targets damage hit saving throw throws attack attacks feet foot spell spells level levels turn gain gains " +
  "instead equal half up out over regains next end start success failure ability check checks advantage disadvantage weapon weapons armor").split(" "));
const FR = new Set(("le la les de des du un une et est sont dans pour qui que quoi sur par au aux avec vous votre vos nous notre il elle ils " +
  "elles ne pas se sa son ses ce cet cette ces leur leurs lors chaque jusqu lorsque quand si mais ou où donc comme peut peuvent être avoir " +
  "fait faire tout tous toute toutes entre sans sous aussi même dont cible cibles créature créatures sort sorts dégâts jet jets sauvegarde " +
  "attaque attaques niveau mètres mètre heure heures jour jours réussite échec arme armes armure avantage désavantage en").split(" "));
const ACCENT = /[àâçéèêëîïôûùüÿœæ]/;

/**
 * Langue d'un texte (heuristique mots-outils FR/EN + élisions + accents).
 * @returns {{lang: "fr"|"en"|"mixte"|"?", fr: number, en: number}}
 */
export function detectLang(text) {
  const t = String(text || "").toLowerCase().replace(/’/g, "'");
  let fr = 0, en = 0;
  fr += (t.match(/\b(?:l|d|qu|n|s|j|c|m|t|jusqu|lorsqu|puisqu)'(?=\p{L})/gu) || []).length;
  en += (t.match(/\p{L}+'(?:s|t|re|ve|ll|d)\b/gu) || []).length;
  for (const w of t.split(/[^\p{L}]+/u)) {
    if (!w) continue;
    if (EN.has(w)) en++;
    else if (FR.has(w)) fr++;
    else if (ACCENT.test(w)) fr += 0.5;
  }
  const tot = fr + en;
  if (tot < 2) return { lang: "?", fr, en };
  const r = fr / tot, minority = Math.min(fr, en);
  if (r >= 0.8 || (r > 0.5 && minority < 3)) return { lang: "fr", fr, en };
  if (r <= 0.2 || (r < 0.5 && minority < 3)) return { lang: "en", fr, en };
  return { lang: "mixte", fr, en };
}

const str = v => typeof v === "string" && v.trim() ? v : null;
const getPath = (o, p) => p.split(".").reduce((a, k) => a?.[k], o);

/**
 * Champs textuels d'un document (y compris documents embarqués), avec l'UUID du (sous-)document.
 * @returns {{uuid, champ, categorie, valeur, html}[]}
 */
export function textFields(doc, type, uuid) {
  const res = [];
  const add = (u, champ, categorie, v, html = false) => { if (str(v)) res.push({ uuid: u, champ, categorie, valeur: v, html }); };
  add(uuid, "name", "nom", doc.name);
  const effects = (d, u) => {
    for (const e of d.effects || []) {
      const eu = `${u}.ActiveEffect.${e._id}`;
      add(eu, "name", "effet", e.name);
      add(eu, "description", "effet", e.description, true);
    }
  };
  const item = (d, u) => {
    const s = d.system || {};
    add(u, "system.description.value", "description", s.description?.value, true);
    add(u, "system.description.chat", "description", s.description?.chat, true);
    add(u, "system.unidentified.description", "description", s.unidentified?.description, true);
    add(u, "system.materials.value", "description", s.materials?.value);
    for (const [id, act] of Object.entries(s.activities || {})) {
      add(u, `system.activities.${id}.name`, "activite", act?.name);
      add(u, `system.activities.${id}.description.chatFlavor`, "activite", act?.description?.chatFlavor);
    }
    effects(d, u);
  };
  switch (type) {
    case "Item": item(doc, uuid); break;
    case "Actor":
      add(uuid, "system.details.biography.value", "description", doc.system?.details?.biography?.value, true);
      add(uuid, "system.details.biography.public", "description", doc.system?.details?.biography?.public, true);
      add(uuid, "system.description.full", "description", doc.system?.description?.full, true);   // groupes / véhicules
      effects(doc, uuid);
      for (const it of doc.items || []) { const u = `${uuid}.Item.${it._id}`; add(u, "name", "nom", it.name); item(it, u); }
      break;
    case "JournalEntry":
      for (const p of doc.pages || []) {
        const u = `${uuid}.JournalEntryPage.${p._id}`;
        add(u, "name", "page", p.name);
        add(u, "text.content", "page", p.text?.content, true);
        add(u, "image.caption", "page", p.image?.caption);
      }
      break;
    case "RollTable":
      add(uuid, "description", "description", doc.description, true);
      for (const r of doc.results || []) {
        const u = `${uuid}.TableResult.${r._id}`;
        add(u, "name", "resultat", r.name);
        add(u, "description", "resultat", r.description ?? r.text, true);
      }
      break;
    case "Cards":
      add(uuid, "description", "description", doc.description, true);
      for (const c of doc.cards || []) {
        const u = `${uuid}.Card.${c._id}`;
        add(u, "name", "carte", c.name);
        add(u, "description", "carte", c.description, true);
        (c.faces || []).forEach((f, i) => { add(u, `faces.${i}.name`, "carte", f?.name); add(u, `faces.${i}.text`, "carte", f?.text, true); });
        add(u, "back.name", "carte", c.back?.name);
        add(u, "back.text", "carte", c.back?.text, true);
      }
      break;
    case "Playlist": add(uuid, "description", "description", doc.description); break;
    case "Adventure": add(uuid, "description", "description", doc.description, true); add(uuid, "caption", "description", doc.caption, true); break;
    case "Macro": add(uuid, "command", "description", doc.command); break;   // pour la recherche / les références seulement
    default: break;
  }
  return res;
}

/**
 * Applique une entrée de traduction Babele à une copie du document (nom, description, matériaux, effets,
 * activités, objets d'acteur, pages de journal, résultats de table, cartes) — même logique de clés que Babele
 * (identifiant puis nom anglais).
 */
export function applyBabele(doc, t, type) {
  if (!t) return doc;
  const c = structuredClone(doc);
  const tr = (map, d, extra) => map?.[d._id] ?? map?.[d.name] ?? (extra ? map?.[extra] : undefined);
  const item = (d, ti) => {
    if (!ti) return;
    if (ti.name) d.name = ti.name;
    if (ti.description && d.system?.description) d.system.description.value = ti.description;
    if (ti.materials && d.system?.materials) d.system.materials.value = ti.materials;
    for (const e of d.effects || []) { const te = tr(ti.effects, e); if (te?.name) e.name = te.name; if (te?.description) e.description = te.description; }
    for (const [id, act] of Object.entries(d.system?.activities || {})) {
      const ta = ti.activities?.[id] ?? (act?.name ? ti.activities?.[act.name] : undefined);
      if (ta?.name) act.name = ta.name;
      if (ta?.chatFlavor && act.description) act.description.chatFlavor = ta.chatFlavor;
    }
  };
  if (type === "Item") item(c, t);
  else if (type === "Actor") {
    if (t.name) c.name = t.name;
    if (t.description && c.system?.details?.biography) c.system.details.biography.value = t.description;
    for (const it of c.items || []) item(it, tr(t.items, it));
    for (const e of c.effects || []) { const te = tr(t.effects, e); if (te?.name) e.name = te.name; }
  } else if (type === "JournalEntry") {
    if (t.name) c.name = t.name;
    for (const p of c.pages || []) {
      const tp = tr(t.pages, p);
      if (!tp) continue;
      if (tp.name) p.name = tp.name;
      if (tp.text && p.text) p.text.content = tp.text;
      if (tp.caption && p.image) p.image.caption = tp.caption;
    }
  } else if (type === "RollTable") {
    if (t.name) c.name = t.name;
    if (t.description) c.description = t.description;
    for (const r of c.results || []) {
      const tres = tr(t.results, r, Array.isArray(r.range) ? `${r.range[0]}-${r.range[1]}` : undefined);
      if (!tres) continue;
      if (typeof tres === "string") { if (r.description != null) r.description = tres; else r.name = tres; continue; }
      if (tres.name) r.name = tres.name;
      if (tres.description || tres.text) r.description = tres.description || tres.text;
    }
  } else if (type === "Cards") {
    if (t.name) c.name = t.name;
    if (t.description) c.description = t.description;
    for (const cd of c.cards || []) {
      const tc = tr(t.cards, cd);
      if (!tc) continue;
      if (tc.name) cd.name = tc.name;
      if (tc.description) cd.description = tc.description;
      (tc.faces || []).forEach((f, i) => { if (cd.faces?.[i]) Object.assign(cd.faces[i], Object.fromEntries(Object.entries(f).filter(([k]) => ["name", "text"].includes(k)))); });
    }
  } else if (t.name) c.name = t.name;
  return c;
}

export const fieldValue = (doc, type, uuid, champ, subUuid) => textFields(doc, type, uuid).find(f => f.uuid === subUuid && f.champ === champ)?.valeur;
export { getPath };

/** Extrait autour de la première occurrence (texte brut). */
export function snippet(text, q, n = 160) {
  const t = plain(text);
  if (!q) return t.length > n ? t.slice(0, n) + "…" : t;
  const i = norm(t).indexOf(norm(q));
  if (i < 0) return t.length > n ? t.slice(0, n) + "…" : t;
  const a = Math.max(0, i - Math.floor(n / 2)), b = Math.min(t.length, a + n);
  return (a > 0 ? "…" : "") + t.slice(a, b) + (b < t.length ? "…" : "");
}
