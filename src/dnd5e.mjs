// Logique D&D 5e (système dnd5e 5.x/6.x) calculée côté serveur, sans navigateur :
// dés, stats dérivées, utilisation d'objets/sorts, compendiums FR.
import crypto from "node:crypto";
import { FOUNDRY } from "./foundry.mjs";
import { setSafePath } from "./security.mjs";

// ====================== DÉS ======================
// Formules : 2d6+3, 1d20+5, 2d20kh1+4 (avantage), 2d20kl1 (désavantage), 4d6kh3, d8, 3d6-1, 1d4+1d6+2
export function rollFormula(formula, { flavor } = {}) {
  // les étiquettes de dégâts entre crochets (« 1d6[radiant] », « 2d8[on hit] ») ne font pas partie du jet
  const src = String(formula).replace(/\[[^\]]*\]/g, "").replace(/\s+/g, "");
  if (!/^[0-9dDkhl+\-*]+$/.test(src)) throw new Error(`Formule non supportée : ${formula}`);
  const tokens = src.match(/[+\-*]|[^+\-*]+/g) || [];
  const terms = [];
  let total = 0, op = "+";
  const dice = [];
  for (const t of tokens) {
    if ("+-*".includes(t)) {
      op = t;
      terms.push({ class: "OperatorTerm", options: {}, evaluated: true, operator: t });
      continue;
    }
    let val;
    const m = /^(\d*)[dD](\d+)(?:(kh|kl)(\d*))?$/.exec(t);
    if (m) {
      const number = Number(m[1] || 1), faces = Number(m[2]);
      if (number > 100 || faces > 1000 || faces < 1) throw new Error(`Dés hors limites : ${t}`);
      const results = Array.from({ length: number }, () => ({ result: crypto.randomInt(1, faces + 1), active: true }));
      const modifiers = [];
      if (m[3]) {
        const keep = Number(m[4] || 1);
        modifiers.push(m[3] + (m[4] || ""));
        const order = results.map((r, i) => [r.result, i]).sort((a, b) => m[3] === "kh" ? b[0] - a[0] : a[0] - b[0]);
        order.slice(keep).forEach(([, i]) => { results[i].active = false; results[i].discarded = true; });
      }
      val = results.filter(r => r.active).reduce((s, r) => s + r.result, 0);
      const die = { class: "Die", options: {}, evaluated: true, number, faces, modifiers, results };
      terms.push(die); dice.push({ formula: t, results: results.map(r => r.active ? r.result : `(${r.result})`) , faces });
    } else if (/^\d+$/.test(t)) {
      val = Number(t);
      terms.push({ class: "NumericTerm", options: {}, evaluated: true, number: val });
    } else throw new Error(`Terme non supporté : ${t}`);
    total = op === "+" ? total + val : op === "-" ? total - val : total * val;
  }
  const roll = { class: "Roll", options: flavor ? { flavor } : {}, dice: [], formula: src.replace(/([+\-*])/g, " $1 ").trim(), terms, total, evaluated: true };
  return { roll, total, dice, formula: roll.formula };
}

// liste depuis tableau, Set sérialisé, chaîne ou objet {clé: true}
const toList = v => Array.isArray(v) ? v : typeof v === "string" ? [v] : v && typeof v === "object" ? Object.keys(v).filter(k => v[k]) : [];
const sign = n => (n >= 0 ? `+${n}` : `${n}`);
const num = v => { const n = Number(String(v ?? "").replace(/\s/g, "")); return Number.isFinite(n) ? n : 0; };


// ====================== EFFETS ACTIFS ======================
const MODES = { 0: "custom", 1: "multiply", 2: "add", 3: "downgrade", 4: "upgrade", 5: "override" };
const getP = (o, p) => p.split(".").reduce((a, k) => a?.[k], o);
const setP = setSafePath;
const changesOf = e => (e.system?.changes || e.changes || []).map(c => ({ key: c.key, value: c.value, type: c.type || MODES[c.mode] || "add" }));

/** Effets actifs qui s'appliquent : effets de l'acteur + effets transférés des objets (équipés / harmonisés si requis). */
function activeChanges(actor) {
  const out = [];
  for (const e of actor.effects || []) if (!e.disabled) out.push(...changesOf(e));
  for (const i of actor.items || []) {
    const s = i.system || {};
    if (["equipment", "weapon", "consumable", "tool", "loot", "container"].includes(i.type) && s.equipped === false) continue;
    if (s.attunement === "required" && !s.attuned) continue;
    for (const e of i.effects || []) if (!e.disabled && e.transfer !== false && (e.type ?? "base") !== "enchantment") out.push(...changesOf(e));
  }
  return out;
}

/** Copie de l'acteur avec les effets actifs appliqués (approximation des règles de Foundry). */
export function withEffects(actor) {
  if (actor._effectsApplied) return actor;
  const a = structuredClone(actor);
  for (const c of activeChanges(actor)) {
    if (!c.key?.startsWith("system.") && !c.key?.startsWith("flags.")) continue;
    const cur = getP(a, c.key);
    const n = Number(c.value);
    if (c.type === "override") setP(a, c.key, c.value);
    else if (c.type === "upgrade") setP(a, c.key, Math.max(Number(cur) || 0, n));
    else if (c.type === "downgrade") setP(a, c.key, Math.min(Number(cur) ?? n, n));
    else if (c.type === "multiply") setP(a, c.key, (Number(cur) || 0) * n);
    else if (c.type === "add") {
      if (Array.isArray(cur)) cur.push(c.value);
      else if (typeof cur === "number") setP(a, c.key, cur + (Number.isFinite(n) ? n : 0));
      else setP(a, c.key, cur ? `${cur} + ${c.value}` : String(c.value));
    }
  }
  a._effectsApplied = true;
  return a;
}

/** Évalue une formule de bonus simple : nombres, + - * /, max/min/floor/ceil, @abilities.x.mod, @prof, @details.level */
export function evalBonus(v, actor) {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return v;
  const abil = actor?.system?.abilities || {};
  const lvl = (actor?.items || []).filter(i => i.type === "class").reduce((s, c) => s + (Number(c.system?.levels) || 0), 0) || 1;
  let f = String(v)
    .replace(/@abilities\.(\w+)\.mod/g, (_, k) => Math.floor(((Number(abil[k]?.value) || 10) - 10) / 2))
    .replace(/@abilities\.(\w+)\.value/g, (_, k) => Number(abil[k]?.value) || 10)
    .replace(/@prof/g, Math.ceil(lvl / 4) + 1)
    .replace(/@(details\.level|classes\.\w+\.levels)/g, lvl)
    .replace(/\b(max|min|floor|ceil|round|abs)\(/g, "Math.$1(");
  if (/@/.test(f) || !/^[\d\s+\-*/().,]*$/.test(f.replace(/Math\.(max|min|floor|ceil|round|abs)/g, ""))) return 0;
  try { const r = Function(`"use strict";return (${f});`)(); return Number.isFinite(r) ? r : 0; } catch { return 0; }
}

// ====================== STATS DÉRIVÉES ======================
export const ABIL = { str: "FOR", dex: "DEX", con: "CON", int: "INT", wis: "SAG", cha: "CHA" };
export const SKILLS = { acr: ["dex", "Acrobaties"], ani: ["wis", "Dressage"], arc: ["int", "Arcanes"], ath: ["str", "Athlétisme"],
  dec: ["cha", "Tromperie"], his: ["int", "Histoire"], ins: ["wis", "Perspicacité"], itm: ["cha", "Intimidation"],
  inv: ["int", "Investigation"], med: ["wis", "Médecine"], nat: ["int", "Nature"], prc: ["wis", "Perception"],
  prf: ["cha", "Représentation"], per: ["cha", "Persuasion"], rel: ["int", "Religion"], slt: ["dex", "Escamotage"],
  ste: ["dex", "Discrétion"], sur: ["wis", "Survie"] };

export function derive(actor) {
  actor = withEffects(actor);
  const s = actor.system || {};
  const items = actor.items || [];
  const classes = items.filter(i => i.type === "class");
  const level = actor.type === "npc" ? Math.max(1, Math.round(num(s.details?.cr) || 1)) : classes.reduce((a, c) => a + num(c.system?.levels), 0) || 1;
  const prof = actor.type === "npc" && s.details?.cr != null ? Math.max(2, Math.floor((num(s.details.cr) + 7) / 4)) : Math.ceil(level / 4) + 1;
  const mod = k => Math.floor((num(s.abilities?.[k]?.value) - 10) / 2);
  const mods = Object.fromEntries(Object.keys(ABIL).map(k => [k, mod(k)]));
  const scClass = classes.find(c => c.system?.spellcasting?.ability && c.system.spellcasting.progression !== "none");
  const scAbility = s.attributes?.spellcasting || scClass?.system?.spellcasting?.ability || "int";
  const scMod = mods[scAbility] ?? 0;
  const spellAttack = prof + scMod + evalBonus(s.bonuses?.rsak?.attack, actor);
  const spellDC = 8 + prof + scMod + evalBonus(s.bonuses?.spell?.dc, actor);
  return { level, prof, mods, scAbility, scMod, spellAttack, spellDC, classes };
}

export function checkBonus(actor, kind, key) {
  actor = withEffects(actor);
  const d = derive(actor), s = actor.system, ev = v => evalBonus(v, actor);
  if (kind === "ability") return { bonus: d.mods[key] + ev(s.bonuses?.abilities?.check) + ev(s.abilities?.[key]?.bonuses?.check) + ev(s.abilities?.[key]?.check?.roll?.bonus), label: `Test de ${ABIL[key]}` };
  if (kind === "save") {
    const p = num(s.abilities?.[key]?.proficient);
    return { bonus: d.mods[key] + Math.floor(p * d.prof) + ev(s.abilities?.[key]?.bonuses?.save) + ev(s.abilities?.[key]?.save?.roll?.bonus) + ev(s.bonuses?.abilities?.save), label: `Sauvegarde de ${ABIL[key]}` };
  }
  if (kind === "skill") {
    const sk = s.skills?.[key]; const [ab, name] = SKILLS[key] || [];
    if (!ab) throw new Error(`Compétence inconnue : ${key}`);
    const abil = sk?.ability || ab;
    return { bonus: d.mods[abil] + Math.floor(num(sk?.value) * d.prof) + ev(sk?.bonuses?.check) + ev(sk?.roll?.bonus) + ev(s.bonuses?.abilities?.skill) + ev(s.bonuses?.abilities?.check), label: `Test de ${name} (${ABIL[abil]})` };
  }
  if (kind === "initiative") {
    const alert = s.attributes?.init?.prof || actor.flags?.dnd5e?.initiativeAlert;
    return { bonus: d.mods[s.attributes?.init?.ability || "dex"] + ev(s.attributes?.init?.bonus) + (alert ? d.prof : 0) + ev(s.bonuses?.abilities?.check), label: "Initiative" };
  }
  throw new Error(`Type de test inconnu : ${kind}`);
}

function armorClass(actor, d) {
  const s = actor.system, items = actor.items || [];
  const ac = s.attributes?.ac || {};
  if (ac.calc === "flat" && ac.flat != null) return num(ac.flat);
  const eq = items.filter(i => i.type === "equipment" && i.system?.equipped);
  const armor = eq.find(i => ["light", "medium", "heavy"].includes(i.system?.type?.value));
  const shield = eq.find(i => i.system?.type?.value === "shield");
  let base = 10 + d.mods.dex;
  if (ac.calc === "unarmoredMonk") base = 10 + d.mods.dex + d.mods.wis;
  if (ac.calc === "unarmoredBarb") base = 10 + d.mods.dex + d.mods.con;
  if (ac.calc === "natural" && ac.flat != null) base = num(ac.flat);
  if (armor) {
    const t = armor.system.type.value, a = armor.system.armor || {};
    const dexCap = t === "heavy" ? 0 : t === "medium" ? (a.dex ?? 2) : Infinity;
    base = num(a.value) + num(a.magicalBonus) + Math.min(d.mods.dex, dexCap);
  }
  if (shield) base += num(shield.system.armor?.value) + num(shield.system.armor?.magicalBonus);
  return base + evalBonus(ac.bonus, actor);
}

const SLOTS = [[], [2], [3], [4, 2], [4, 3], [4, 3, 2], [4, 3, 3], [4, 3, 3, 1], [4, 3, 3, 2], [4, 3, 3, 3, 1], [4, 3, 3, 3, 2],
  [4, 3, 3, 3, 2, 1], [4, 3, 3, 3, 2, 1], [4, 3, 3, 3, 2, 1, 1], [4, 3, 3, 3, 2, 1, 1], [4, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 2, 1, 1, 1],
  [4, 3, 3, 3, 2, 1, 1, 1, 1], [4, 3, 3, 3, 3, 1, 1, 1, 1], [4, 3, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 3, 2, 2, 1, 1]];
/** Max d'emplacements : { spell1..spell9, pact, pactLevel } (override de la fiche prioritaire) */
export function slotMax(actor) {
  const classes = (actor.items || []).filter(i => i.type === "class" || i.type === "subclass");
  const cls = classes.filter(i => i.type === "class");
  const single = cls.filter(c => (c.system?.spellcasting?.progression || "none") !== "none").length === 1;
  let lvl = 0, pactLvl = 0;
  for (const c of cls) {
    let prog = c.system?.spellcasting?.progression || "none";
    const sub = classes.find(x => x.type === "subclass" && x.system?.classIdentifier === c.system?.identifier);
    if (prog === "none" && sub?.system?.spellcasting?.progression) prog = sub.system.spellcasting.progression;
    const L = num(c.system.levels);
    if (prog === "full") lvl += L;
    else if (prog === "half") lvl += single ? Math.ceil(L / 2) : Math.floor(L / 2);
    else if (prog === "third") lvl += single ? Math.ceil(L / 3) : Math.floor(L / 3);
    else if (prog === "artificer") lvl += Math.ceil(L / 2);
    else if (prog === "pact") pactLvl += L;
  }
  const r = {};
  const row = SLOTS[Math.min(20, lvl)] || [];
  for (let i = 1; i <= 9; i++) {
    const ov = actor.system?.spells?.[`spell${i}`]?.override;
    const m = ov ?? row[i - 1] ?? 0;
    if (m) r[`spell${i}`] = m;
  }
  if (pactLvl || actor.system?.spells?.pact?.override) {
    r.pact = actor.system?.spells?.pact?.override ?? (pactLvl >= 17 ? 4 : pactLvl >= 11 ? 3 : pactLvl >= 2 ? 2 : 1);
    r.pactLevel = Math.min(5, Math.ceil(pactLvl / 2)) || 1;
  }
  return r;
}

export function sheet(actor) {
  actor = withEffects(actor);
  const d = derive(actor), s = actor.system, items = actor.items || [];
  const hp = s.attributes?.hp || {};
  const hpMax = hp.max ?? estimateHpMax(actor, d);
  const spells = {};
  for (const i of items.filter(i => i.type === "spell")) (spells[i.system.level] ??= []).push(i.name);
  return {
    _id: actor._id, nom: actor.name, type: actor.type,
    classes: d.classes.map(c => `${c.name} ${c.system.levels}`).join(" / ") || null,
    niveau: d.level, bonus_maitrise: d.prof,
    pv: { actuels: hp.value, max: hpMax, temp: hp.temp || 0 },
    ca_estimee: armorClass(actor, d),
    caracs: Object.fromEntries(Object.entries(ABIL).map(([k, l]) => [l, `${s.abilities?.[k]?.value} (${sign(d.mods[k])})${num(s.abilities?.[k]?.proficient) ? " ★sauv" : ""}`])),
    sauvegardes: Object.fromEntries(Object.entries(ABIL).map(([k, l]) => [l, sign(checkBonus(actor, "save", k).bonus)])),
    initiative: sign(checkBonus(actor, "initiative").bonus),
    perception_passive: 10 + checkBonus(actor, "skill", "prc").bonus,
    competences_maitrisees: Object.entries(s.skills || {}).filter(([, v]) => num(v.value) > 0).map(([k, v]) => `${SKILLS[k]?.[1] || k} ${sign(checkBonus(actor, "skill", k).bonus)}${num(v.value) >= 2 ? " (expertise)" : ""}`),
    incantation: d.classes.some(c => c.system?.spellcasting?.progression && c.system.spellcasting.progression !== "none")
      ? { carac: ABIL[d.scAbility], attaque: sign(d.spellAttack), dd: d.spellDC } : null,
    emplacements: (() => { const mx = slotMax(actor); return Object.fromEntries(Object.entries(mx).filter(([k]) => k !== "pactLevel").map(([k, m]) => [k === "pact" ? `pacte (niv. ${mx.pactLevel})` : k.replace("spell", "niv. "), `${num(s.spells?.[k]?.value)}/${m}`])); })(),
    sorts_par_niveau: spells,
    objets: items.filter(i => !["spell", "class", "subclass", "feat", "race", "background"].includes(i.type))
      .map(i => `${i.name}${num(i.system?.quantity) > 1 ? " ×" + i.system.quantity : ""}${i.system?.equipped ? " [équipé]" : ""}${i.system?.attuned ? " [harmonisé]" : ""} (${i._id})`),
    aptitudes: items.filter(i => ["feat", "race", "background", "subclass"].includes(i.type)).map(i => i.name),
    monnaie: s.currency,
    xp: s.details?.xp?.value,
  };
}

function estimateHpMax(actor, d) {
  // Approximation : 1er niveau au max puis moyenne, + CON × niveau
  let hp = 0, first = true;
  for (const c of d.classes) {
    const die = num(String(c.system?.hd?.denomination || c.system?.hitDice || "d8").replace("d", "")) || 8;
    for (let l = 0; l < num(c.system.levels); l++) { hp += first ? die : die / 2 + 1; first = false; }
  }
  return hp + d.mods.con * d.level;
}

// ====================== UTILISATION D'OBJETS / SORTS ======================
function resolveFormulaVars(f, actor, d, item, castLevel = null) {
  return String(f ?? "").replace(/@mod/g, item?.type === "spell" ? d.scMod : d.mods[weaponAbility(item, d)] ?? 0)
    .replace(/@prof/g, d.prof).replace(/@abilities\.(\w+)\.mod/g, (_, k) => d.mods[k] ?? 0)
    .replace(/@abilities\.(\w+)\.mod/g, (_, k) => d.mods[k] ?? 0)
    .replace(/@details\.level|@classes\.\w+\.levels/g, d.level)
    .replace(/@attributes\.spell\.level|@attributes\.spell\.dc/g, castLevel ?? spellLevel ?? 0);
  const fn = (name, args) => {
    const vals = args.map(v => Number(String(v).trim()));
    if (vals.some(v => !Number.isFinite(v))) return 0;
    if (name === "max") return Math.max(...vals);
    if (name === "min") return Math.min(...vals);
    if (name === "floor") return Math.floor(vals[0]);
    if (name === "ceil") return Math.ceil(vals[0]);
    if (name === "round") return Math.round(vals[0]);
    return Math.abs(vals[0]);
  };
  let s = String(f ?? "");
  for (let i = 0; i < 6 && /\b(max|min|floor|ceil|round|abs)\s*\(/.test(s); i++) {
    const next = s.replace(/\b(max|min|floor|ceil|round|abs)\s*\(([^()]*)\)/g, (_, name, args) => String(fn(name, args.split(","))));
    if (next === s) break;
    s = next;
  }
  return s.replace(/\s+/g, "");
}

function weaponAbility(item, d) {
  const s = item?.system || {};
  if (s.ability) return s.ability;
  const props = new Set(s.properties || []);
  const ranged = ["simpleR", "martialR"].includes(s.type?.value) || s.range?.long;
  if (props.has("fin")) return d.mods.dex >= d.mods.str ? "dex" : "str";
  return ranged && !props.has("thr") ? "dex" : "str";
}

/** Arme équipée qui servira de base à une attaque de sort classée « weapon » (True Strike, Shillelagh…). */
function mainWeapon(actor, kind) {
  const weapons = (actor.items || []).filter(i => i.type === "weapon" && i.system?.equipped !== false && i.system?.damage?.base);
  if (!weapons.length) return null;
  const wantRanged = kind === "ranged";
  const score = w => {
    const ranged = ["simpleR", "martialR"].includes(w.system?.type?.value) || !!w.system?.range?.long;
    const off = w.system?.weaponType === "offhand" || w.system?.properties?.includes?.("off");
    return (ranged === wantRanged ? 4 : 0) + (off ? 0 : 2) + (w.system?.type?.value === "martialM" ? 1 : 0);
  };
  return weapons.slice().sort((a, b) => score(b) - score(a))[0];
}

/** Formule de dégâts/soins utilisable par rollFormula : « max(…) », floor/ceil et divisions ramenés à ses termes. */
export function toRollFormula(f) {
  const nums = s => String(s).split(",").map(v => Number(String(v).trim()));
  const fn = (name, args) => {
    const vals = nums(args);
    if (vals.some(v => !Number.isFinite(v))) return NaN;
    if (name === "max") return Math.max(...vals);
    if (name === "min") return Math.min(...vals);
    if (name === "floor") return Math.floor(vals[0]);
    if (name === "ceil") return Math.ceil(vals[0]);
    if (name === "round") return Math.round(vals[0]);
    return Math.abs(vals[0]);
  };
  // « 2d6/2 » → dés répartis
  const diceDiv = txt => txt.replace(/(\d*)d(\d+)\/(\d+)/g, (_, n, faces, d) => {
    const k = Number(d) || 1;
    if (k <= 1) return `${n || 1}d${faces}`;
    return (Number(n || 1) % k === 0) ? `${Number(n || 1) / k}d${faces}` : `${n || 1}d${faces}`;
  });
  const closeOf = (t, i) => { let d = 0; for (let j = i; j < t.length; j++) { if (t[j] === "(") d++; else if (t[j] === ")" && --d === 0) return j; } return -1; };
  let s = diceDiv(String(f ?? "").trim().replace(/\s+/g, ""));
  // la parenthèse la plus interne est évaluée (fonction appliquée), division « / n » incluse
  for (let pass = 0; pass < 24 && s.includes("("); pass++) {
    let hit = null;
    for (let i = 0; i < s.length; i++) {
      if (s[i] !== "(") continue;
      const close = closeOf(s, i);
      if (close < 0) break;
      const fm = /(floor|ceil|round|abs|max|min)$/.exec(s.slice(0, i));
      const start = fm ? i - fm[1].length : i;
      const inner = s.slice(i + 1, close);            // sans parenthèses (la plus interne)
      const rest = s.slice(close + 1);
      const lead = rest.length - rest.replace(/^\s+/, "").length;
      const div = /^\/(\d+)/.exec(rest.slice(lead)) || /^(\d+)/.exec(rest.slice(lead));
      let v = fm ? fn(fm[1], inner) : NaN;
      if (!Number.isFinite(v) && !fm) {
        // parenthèse numérique : « (5+0) », « (5) »… (somme simple)
        if (/^[\d\s+*/-]+$/.test(inner)) {
          try { const r = Function(`"use strict";return (${inner})`)(); v = Number(r); } catch { v = NaN; }
        }
      }
      if (!Number.isFinite(v)) continue;
      if (div) v = Math.floor(v / (Number(div[1]) || 1));
      hit = { start, end: close + 1 + lead + (div ? div[0].length : 0), rep: String(v) };
      break;
    }
    if (!hit) break;
    s = diceDiv(s.slice(0, hit.start) + hit.rep + s.slice(hit.end));
  }
  // divisions restantes : « 2d6/2 » → dés répartis ; « 8/2 » → entier
  s = s.replace(/(\d*)d(\d+)\/(\d+)/g, (_, n, faces, d) => {
    const k = Number(d) || 1;
    if (k <= 1) return `${n || 1}d${faces}`;
    return (Number(n || 1) % k === 0) ? `${Number(n || 1) / k}d${faces}` : `${n || 1}d${faces}`;
  }).replace(/(\d+)\/(\d+)/g, (m, a, b) => {
    const k = Number(b) || 1;
    return k > 1 ? String(Math.floor(Number(a) / k)) : m;
  });
  return s.replace(/Math\.Math\./g, "Math.");
}

function partFormula(p, { actor, d, item, spellLevel, castLevel }) {
  const rv = v => resolveFormulaVars(v, actor, d, item, castLevel);
  if (p.custom?.enabled && p.custom.formula) return rv(p.custom.formula);
  let n = num(p.number);
  if (!n || !p.denomination) return rv(p.bonus) || "0";
  if (item.type === "spell" && spellLevel === 0) n *= 1 + (d.level >= 5) + (d.level >= 11) + (d.level >= 17);
  if (item.type === "spell" && castLevel > spellLevel && p.scaling?.number) {
    const steps = p.scaling.mode === "half" ? Math.floor((castLevel - spellLevel) / 2) : castLevel - spellLevel;
    n += num(p.scaling.number) * steps;
  }
  let f = `${n}d${p.denomination}`;
  const b = rv(p.bonus);
  if (b && b !== "0") f += (/^[+-]/.test(b) ? "" : "+") + b;
  return f;
}

const DMG_FR = { acid: "acide", bludgeoning: "contondant", cold: "froid", fire: "feu", force: "force", lightning: "foudre",
  necrotic: "nécrotique", piercing: "perforant", poison: "poison", psychic: "psychique", radiant: "radiant",
  slashing: "tranchant", thunder: "tonnerre", healing: "soins", temphp: "PV temporaires" };

/** Prépare l'utilisation : jets + mises à jour de consommation. Ne touche pas Foundry. */
export function useItem(rawActor, item, { activityId, slotLevel, advantage, disadvantage, consume = true, versatile }) {
  const actor = withEffects(rawActor);
  const d = derive(actor);
  const acts = Object.values(item.system?.activities || {}).sort((a, b) => (a.sort || 0) - (b.sort || 0));
  const act = activityId ? acts.find(a => a._id === activityId || (a.name || "").toLowerCase() === String(activityId).toLowerCase()) : acts[0];
  const spellLevel = item.type === "spell" ? num(item.system.level) : null;
  const castLevel = item.type === "spell" ? Math.max(num(slotLevel) || spellLevel, spellLevel) : null;
  const out = { lignes: [], rolls: [], actorUpdate: {}, itemUpdate: {}, deleteItem: false, crit: false };

  // --- consommation ---
  if (consume) {
    if (item.type === "spell" && spellLevel > 0 && (act?.consumption?.spellSlot ?? true) && !["innate", "atwill", "ritual"].includes(item.system.method || item.system.preparation?.mode)) {
      const method = item.system.method || item.system.preparation?.mode;
      const key = method === "pact" ? "pact" : `spell${castLevel}`;
      if (method === "pact") { const pl = slotMax(actor).pactLevel || castLevel; if (castLevel < pl) out.lignes.push(`Lancé au niveau de pacte ${pl}`); }
      const slot = actor.system.spells?.[key];
      if (!slot || num(slot.value) <= 0) throw new Error(`Plus d'emplacement de niveau ${castLevel} disponible (${key} : ${slot?.value ?? 0}). Précise un autre slot_level ou consume=false.`);
      out.actorUpdate[`system.spells.${key}.value`] = num(slot.value) - 1;
      out.lignes.push(`Emplacement ${method === "pact" ? "de pacte" : "niv. " + castLevel} utilisé (${num(slot.value) - 1} restant(s))`);
    }
    const uses = item.system?.uses;
    if (uses?.max && act?.consumption?.targets?.some(t => t.type === "itemUses") || (uses?.max && item.type === "consumable")) {
      const left = num(uses.max) - num(uses.spent);
      if (left <= 0) throw new Error(`${item.name} n'a plus d'utilisation disponible.`);
      out.itemUpdate["system.uses.spent"] = num(uses.spent) + 1;
      out.lignes.push(`Utilisations : ${left - 1}/${uses.max}`);
      if (left - 1 <= 0 && uses.autoDestroy && item.type === "consumable") {
        if (num(item.system.quantity) > 1) { out.itemUpdate["system.quantity"] = num(item.system.quantity) - 1; out.itemUpdate["system.uses.spent"] = 0; }
        else out.deleteItem = true;
      }
    } else if (item.type === "consumable" && num(item.system.quantity) > 0) {
      const q = num(item.system.quantity) - 1;
      if (q <= 0) out.deleteItem = true; else out.itemUpdate["system.quantity"] = q;
      out.lignes.push(`Quantité restante : ${q}`);
    }
  }

  if (!act) { out.lignes.push("(Aucune activité : rien à lancer)"); return out; }
  out.activity = { _id: act._id, type: act.type, effects: (act.effects || []).map(e => e._id).filter(Boolean) };
  const ctx = { actor, d, item, spellLevel, castLevel };

  // --- attaque ---
  const weapon = act.type === "attack" && act.attack?.classification === "weapon" ? mainWeapon(actor, act.attack?.type?.value) : null;
  if (act.type === "attack") {
    // classification « weapon » (dnd5e 5/6 : True Strike, Shillelagh, Booming Blade…) : jet et dégâts de l'arme
    let bonus;
    if (act.attack?.classification === "weapon") {
      const ab = act.attack?.ability && act.attack.ability !== "none" ? act.attack.ability : (weapon ? weaponAbility(weapon, d) : (d.scAbility || "dex"));
      const prof = weapon ? weapon.system?.proficient !== 0 : true;
      bonus = d.mods[ab] + (prof ? d.prof : 0) + num(act.attack?.bonus)
        + (weapon ? num(weapon.system?.magicalBonus) : 0)
        + evalBonus(actor.system.bonuses?.[(act.attack?.type?.value === "ranged" ? "r" : "m") + "wak"]?.attack, actor);
      if (weapon) out.lignes.push(`Arme : ${weapon.name}${num(weapon.system?.magicalBonus) ? ` (+${weapon.system.magicalBonus})` : ""}`);
    } else if (item.type === "spell") bonus = d.prof + d.scMod + evalBonus(actor.system.bonuses?.[(act.attack?.type?.value === "melee" ? "m" : "r") + "sak"]?.attack, actor);
    else {
      const ab = act.attack?.ability && act.attack.ability !== "none" ? act.attack.ability : weaponAbility(item, d);
      const proficient = item.system?.proficient !== 0;
      bonus = d.mods[ab] + (proficient ? d.prof : 0) + num(item.system?.magicalBonus) + num(item.system?.attack?.bonus) + num(act.attack?.bonus)
        + evalBonus(actor.system.bonuses?.[(act.attack?.type?.value === "ranged" ? "r" : "m") + "wak"]?.attack, actor);
    }
    const dice = advantage && !disadvantage ? "2d20kh1" : disadvantage && !advantage ? "2d20kl1" : "1d20";
    const r = rollFormula(`${dice}${sign(bonus)}`, { flavor: `${item.name} — attaque` });
    const nat = r.roll.terms[0].results.filter(x => x.active)[0].result;
    out.crit = nat >= num(act.attack?.critical?.threshold || 20);
    out.attack = { total: r.total, nat, crit: out.crit, arme: weapon?.name || null };
    out.rolls.push(r);
    out.lignes.push(`Attaque : ${r.total} (d20=${nat}${sign(bonus)})${out.crit ? " — CRITIQUE !" : nat === 1 ? " — échec critique" : ""}`);
  }

  // --- sauvegarde ---
  if (act.type === "save") {
    const dc = act.save?.dc?.calculation === "spellcasting" || (!act.save?.dc?.formula && item.type === "spell") ? d.spellDC
      : act.save?.dc?.calculation && ABIL[act.save.dc.calculation] ? 8 + d.prof + d.mods[act.save.dc.calculation]
      : num(resolveFormulaVars(act.save?.dc?.formula, actor, d, item)) || d.spellDC;
    out.save = { abilities: toList(act.save?.ability), dc, onSave: act.damage?.onSave || "none" };
    out.lignes.push(`Jet de sauvegarde de ${toList(act.save?.ability).map(a => ABIL[a] || a).join("/")} DD ${dc}${act.damage?.onSave === "half" ? " (moitié des dégâts si réussi)" : ""}`);
  }

  // --- dégâts ---
  const parts = [...(act.damage?.parts || [])];
  if (act.damage?.includeBase) {
    // arme (dnd5e 5/6 : True Strike, Booming Blade) ou base de l'objet (arme/objet avec dégâts propres)
    const holder = weapon || (item.system?.damage?.base ? item : null);
    if (holder) {
      const base = { ...holder.system.damage.base };
      if (holder === item && versatile && item.system.damage.versatile?.denomination) Object.assign(base, item.system.damage.versatile, { number: item.system.damage.versatile.number || base.number });
      const ab = weaponAbility(holder, d);
      const extra = (holder.type === "spell" ? 0 : d.mods[ab]) + num(holder.system?.magicalBonus);
      parts.unshift({ ...base, bonus: [base.bonus, extra ? String(extra) : ""].filter(Boolean).join("+") });
    }
  }
  if (weapon && !parts.length) {
    const base = { ...weapon.system.damage.base };
    const ab = weaponAbility(weapon, d);
    const extra = d.mods[ab] + num(weapon.system?.magicalBonus);
    parts.push({ ...base, bonus: [base.bonus, extra ? String(extra) : ""].filter(Boolean).join("+") });
  }
  for (const p of parts) {
    let f = toRollFormula(partFormula(p, ctx));
    f = toRollFormula(f.replace(/\[[^\]]*\]/g, ""));
    if (out.crit) f = f.replace(/(\d+)d(\d+)/g, (_, n, fa) => `${2 * n}d${fa}`);
    if (f === "0") continue;
    const types = (p.types || []).map(t => DMG_FR[t] || t).join("/");
    const r = rollFormula(f, { flavor: `${item.name} — dégâts ${types}` });
    out.rolls.push(r);
    (out.damage ??= []).push({ total: r.total, types: p.types || [], formula: r.formula });
    out.lignes.push(`Dégâts : ${r.total} ${types} (${r.formula})`);
  }

  // --- soins ---
  if (act.type === "heal" && act.healing) {
    const f = partFormula(act.healing, ctx);
    const r = rollFormula(f, { flavor: `${item.name} — ${DMG_FR[act.healing.types?.[0]] || "soins"}` });
    out.rolls.push(r);
    out.healing = { total: r.total, temp: (act.healing.types || []).includes("temphp"), formula: r.formula };
    out.lignes.push(`Soins : ${r.total} (${r.formula})`);
  }

  // --- jet libre (activité utility avec formule) ---
  if (act.type === "utility" && act.roll?.formula) {
    const r = rollFormula(resolveFormulaVars(act.roll.formula, actor, d, item), { flavor: `${item.name} — ${act.roll.name || "jet"}` });
    out.rolls.push(r);
    out.lignes.push(`${act.roll.name || "Jet"} : ${r.total} (${r.formula})`);
  }
  if (act.duration?.concentration) out.lignes.push("⚠ Concentration");
  return out;
}

// ====================== COMPENDIUMS + TRADUCTION FR ======================
const trCache = new Map(); // packId -> {entries} | null
// Sources de traduction Babele, par ordre de priorité : "module/dossier,module/dossier"
// (défaut : le module FR officiel du système). Chaque dossier contient <packId>.json.
const TR_SOURCES = (process.env.TRANSLATION_SOURCES
  || `${process.env.TRANSLATION_MODULE || "dnd5e_fr-FR"}/${process.env.TRANSLATION_DIR || "compendium_fr"}`)
  .split(",").map(s => s.trim()).filter(Boolean);
const TR_TTL = 10 * 60 * 1000;
export async function translations(packId) {
  const c = trCache.get(packId);
  if (c && Date.now() - c.at < TR_TTL) return c.t;
  let t = null;
  for (const src of TR_SOURCES) {
    try {
      const r = await fetch(`${FOUNDRY}/modules/${src}/${encodeURIComponent(packId)}.json`);
      if (!r.ok) continue;
      const e = (await r.json()).entries || {};
      t = { ...e, ...(t || {}) }; // la première source gagne
    } catch { /* source absente */ }
  }
  trCache.set(packId, { t, at: Date.now() });
  return t;
}
/** Entrée de traduction d'un document : clé _id d'abord, puis nom (même ordre que Babele). */
export const trFor = (tr, doc) => tr?.[doc?._id] ?? tr?.[doc?.name];

// ---- unités métriques (réglages dnd5e « metric*Units ») : même conversion que le module dnd5e_fr-FR ----
export const UNITS = { length: false, weight: false, volume: false, at: 0 };
/** Relit les réglages métriques du monde (cache 1 min). */
export async function refreshUnits(fs) {
  if (Date.now() - UNITS.at < 60000) return UNITS;
  try {
    for (const [k, key] of [["length", "dnd5e.metricLengthUnits"], ["weight", "dnd5e.metricWeightUnits"], ["volume", "dnd5e.metricVolumeUnits"]]) {
      const d = (await fs.doc("get", "Setting", { query: { key } })).find(x => x.key === key);
      UNITS[k] = d ? JSON.parse(d.value) === true : false;
    }
    UNITS.at = Date.now();
  } catch { /* réglages illisibles : on garde les précédents */ }
  return UNITS;
}
const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
const ftToM = v => (!UNITS.length || !v || isNaN(parseInt(v))) ? v : round2(parseInt(v) * 0.3);
const miToKm = v => (!UNITS.length || !v || isNaN(parseInt(v))) ? v : round2(parseInt(v) * 1.5);
const lbToKg = v => (!UNITS.weight || !v) ? v : parseInt(v) / 2;
const cfToL = v => (!UNITS.volume || !v) ? v : round2(parseFloat(v) * 28.3);
const CONV = () => ({ ft: [ftToM, UNITS.length ? "m" : "ft"], mi: [miToKm, UNITS.length ? "km" : "mi"], mph: [miToKm, UNITS.length ? "kph" : "mph"],
  lb: [lbToKg, UNITS.weight ? "kg" : "lb"], cubicFoot: [cfToL, UNITS.volume ? "liter" : "cubicFoot"] });
/** Convertit un bloc d'unités dnd5e (portée, gabarit, vitesses, sens, poids…) ; renvoie null si rien à changer. */
export function toMetric(value) {
  if (!value || typeof value !== "object") return null;
  const u = value.units ?? value.template?.units ?? "ft";
  const c = CONV()[u];
  if (!c || c[1] === u) return null;   // déjà converti, ou réglage métrique inactif
  const [f, unit] = c, out = structuredClone(value);
  for (const k of ["value", "long", "reach", "distance", "bright", "dim", "range"]) if (out[k]) out[k] = f(out[k]);
  if (out.units !== undefined) out.units = unit;
  if (out.template) { for (const k of ["size", "height", "width"]) if (out.template[k]) out.template[k] = f(out.template[k]); out.template.units = unit; }
  for (const grp of ["ranges", "paces", "speeds"]) if (out[grp]) for (const k of Object.keys(out[grp])) if (typeof out[grp][k] !== "object") out[grp][k] = f(out[grp][k]);
  for (const k of ["walk", "fly", "swim", "climb", "burrow", "darkvision", "blindsight", "tremorsense", "truesight"]) if (typeof out[k] === "number" || (typeof out[k] === "string" && out[k])) out[k] = f(out[k]);
  if (out.template && !value.template?.units && !["size", "height", "width"].some(k => value.template?.[k])) out.template.units = value.template.units;
  return JSON.stringify(out) === JSON.stringify(value) ? null : out;   // rien à convertir
}
/** Champs d'unités d'un objet (et de ses activités), convertis ; renvoie un objet d'updates en notation pointée. */
export function itemMetricUpdates(it) {
  const up = {};
  for (const path of ["system.movement", "system.weight", "system.range", "system.capacity.weight", "system.senses", "system.target", "system.capacity.volume"]) {
    const v = path.split(".").reduce((o, k) => o?.[k], it);
    const c = toMetric(v); if (c) up[path] = c;
  }
  for (const [id, act] of Object.entries(it.system?.activities || {})) for (const k of ["range", "target"]) {
    const c = toMetric(act?.[k]); if (c) up[`system.activities.${id}.${k}`] = c;
  }
  return up;
}
/** Champs d'unités d'un acteur (déplacement, sens, vision du jeton). */
export function actorMetricUpdates(a) {
  const up = {};
  for (const path of ["system.attributes.movement", "system.attributes.senses", "system.attributes.travel", "system.traits.languages.communication.telepathy"]) {
    const v = path.split(".").reduce((o, k) => o?.[k], a);
    const c = toMetric(v); if (c) up[path] = c;
  }
  const sight = a.prototypeToken?.sight;
  if (sight?.range && UNITS.length && !a.flags?.dnd5e?.metricToken) { up["prototypeToken.sight.range"] = ftToM(sight.range); up["flags.dnd5e.metricToken"] = true; }
  return up;
}

export async function translateDoc(packId, doc) {
  const t = trFor(await translations(packId), doc);
  if (!t) return withMetric(doc);
  return withMetric(applyTr(doc, t));
}
function withMetric(doc) {
  const up = doc?.system ? itemMetricUpdates(doc) : {};
  if (!Object.keys(up).length) return doc;
  const c = structuredClone(doc);
  for (const [p, v] of Object.entries(up)) { const ks = p.split("."); let o = c; ks.slice(0, -1).forEach(k => { o = o[k] ??= {}; }); o[ks.at(-1)] = v; }
  return c;
}
function applyTr(doc, t) {
  const c = structuredClone(doc);
  if (t.name) c.name = t.name;
  if (t.description && c.system?.description) c.system.description.value = t.description;
  if (t.description && c.text) c.text.content = t.description; // pages de journal
  if (t.materials && c.system?.materials) c.system.materials.value = t.materials;   // composantes matérielles
  if (t.effects && Array.isArray(c.effects))   // effets : clé = nom anglais de l'effet (comme Babele)
    for (const e of c.effects) { const te = t.effects[e._id] ?? t.effects[e.name]; if (te?.name) e.name = te.name; if (te?.description) e.description = te.description; }
  return c;
}
/** Traduction d'un objet d'acteur d'après sa source de compendium (comme la traduction à la demande de Babele). */
// Objets importés par Plutonium sans lien de compendium : Plutonium garde sa propre référence
// (flags.plutonium.hash + source, ex. « bless_xphb » / « XPHB »), présente aussi sur les entrées des
// compendiums importés par Plutonium. Index hash|source -> UUID de compendium (cache 30 min).
const PLUT = { map: new Map(), at: 0 };
async function plutoniumSource(fs, it) {
  const p = it.flags?.plutonium;
  if (!p?.hash || !fs) return null;
  if (!PLUT.map.size || Date.now() - PLUT.at > 30 * 60 * 1000) {
    const map = new Map();
    const packs = ((await fs.worldData()).packs || []).filter(x => x.type === "Item");
    for (const pk of packs) {
      let idx = [];
      try { idx = await fs.doc("get", "Item", { pack: pk.id, query: {}, index: true, indexFields: ["_id", "name", "flags.plutonium.hash", "flags.plutonium.source"] }); } catch { /* */ }
      for (const x of idx) {
        const h = x.flags?.plutonium?.hash;
        if (!h) continue;
        const k = `${h}|${x.flags.plutonium.source || ""}`;
        if (!map.has(k)) map.set(k, `Compendium.${pk.id}.Item.${x._id}`);
      }
    }
    Object.assign(PLUT, { map, at: Date.now() });
  }
  return PLUT.map.get(`${p.hash}|${p.source || ""}`) || null;
}

export async function localizeItem(it, fs) {
  const src = it._stats?.compendiumSource || it.flags?.core?.sourceId || it.flags?.dnd5e?.sourceId || await plutoniumSource(fs, it);
  const m = /^Compendium\.([^.]+\.[^.]+)\.(?:Item\.)?([A-Za-z0-9]{16})$/.exec(src || "");
  const up = {};
  if (m) {
    const tr = await translations(m[1]);
    let t = tr?.[m[2]] ?? tr?.[it.name];
    if (!t && tr && fs) {   // traductions indexées par le nom anglais : nom d'origine lu dans le compendium source
      try {
        const idx = await fs.doc("get", "Item", { pack: m[1], query: { _id: m[2] }, index: true, indexFields: ["_id", "name"] });
        const src = idx.find(x => x._id === m[2]);
        if (src) t = tr[src.name];
      } catch { /* compendium absent */ }
    }
    if (t?.name && t.name !== it.name) up.name = t.name;
    // comparaison sur le texte seul : Foundry réécrit le HTML à l'enregistrement (guillemets, entités, attributs)
    // un « < » littéral (ex. jet [[/r 1d100cs<26]]) n'est pas une balise : Foundry l'enregistre en &lt;
    const txt = x => String(x || "").replace(/<(?![A-Za-z\/!])/g, "&lt;").replace(/<[^>]+>/g, " ")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&(amp|#x27|#39|quot|apos|nbsp);/g, "").replace(/['’"&]/g, "").replace(/\s+/g, " ").trim();
    const same = (x, y) => txt(x) === txt(y);
    if (t?.description && it.system?.description && !same(t.description, it.system.description.value)) up["system.description.value"] = t.description;
    if (t?.materials && it.system?.materials && !same(t.materials, it.system.materials.value)) up["system.materials.value"] = t.materials;
    // effets de l'objet : nom anglais retrouvé dans le compendium source (l'effet sur la fiche peut déjà être renommé)
    if (t?.effects && (it.effects || []).length) {
      let srcEff = null;
      try { srcEff = (await fs.doc("get", "Item", { pack: m[1], query: { _id: m[2] } })).find(x => x._id === m[2])?.effects || []; } catch { srcEff = []; }
      const effUp = [];
      for (const e of it.effects) {
        const se = srcEff.find(x => x._id === e._id) || srcEff.find(x => x.name === e.name);
        const te = t.effects[se?.name ?? e.name] ?? t.effects[e.name];
        if (!te) continue;
        const u = { _id: e._id };
        if (te.name && te.name !== e.name) u.name = te.name;
        if (te.description && !same(te.description, e.description)) u.description = te.description;
        if (Object.keys(u).length > 1) effUp.push(u);
      }
      if (effUp.length) Object.defineProperty(up, "__effects", { value: effUp, enumerable: false });
    }
  }
  return Object.assign(up, itemMetricUpdates(it));
}
