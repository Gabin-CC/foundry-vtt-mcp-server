// Offline, read-only retrieval for the complete D&D 2024 book corpus.
// The official SRD 5.2.1 is pinned; private books retain their own source
// identities so citations point to the PDF that supplied each passage.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { buildSearchData, isSearchDataShape, rankSearchData } from "./rules-search.mjs";

export const SOURCE = "https://media.dndbeyond.com/compendium-images/srd/5.2/SRD_CC_v5.2.1.pdf";
// SHA-256 of the official May 2025 PDF. A different source must be reviewed
// before its content or page numbers are attributed to this version.
export const SOURCE_SHA256 = "8974902d109d6e63672d7c490bde9ccf052410503d9cfa768237154fbc5e3d87";
// This index now contains all installed rulebooks and GM-only adventures,
// not merely the official SRD. Keep the old filename as a read-only fallback.
export const RULES_INDEX_FILENAME = "rules-index.json";
export const LEGACY_RULES_INDEX_FILENAME = "srd-5.2.1.json";
export const SEARCH_SIDECAR_NAME = "search-v1.json";
const searchCache = new WeakMap();

// Function words do not help distinguish one rule from another.
const STOP = new Set(`a an and are as at be by can do does for from has have how i if in is it its of on or the their then this to what when where which who why with you your
au aux avec ce ces cet cette comme dans de des du elle en est et ils il je la le les leur ma mais me mes mon ne nous ou par pas pour que quel quelle quels quelles qui quoi sa se ses si son sont sur ta te tes ton tu un une vos vous y`.split(/\s+/));

export function tokens(text) {
  return String(text).normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().match(/[a-z0-9]+/g)?.filter(word => word.length >= 3 && !STOP.has(word)) || [];
}

export function validateIndex(index) {
  if (index?.version !== "5.2.1" || index?.pdf_sha256 !== SOURCE_SHA256 ||
      !Array.isArray(index.pages) || !index.pages.length) {
    throw new Error("Invalid SRD 5.2.1 rules index; run npm run rules:setup");
  }
  const privateSources = index.private_sources || [];
  if (!Array.isArray(privateSources) || privateSources.length > 30) {
    throw new Error("Malformed private PDF source list");
  }
  const names = new Set();
  for (const item of privateSources) {
    if (!validPdfName(item?.name) || !/^[a-f0-9]{64}$/.test(item.sha256) || names.has(item.name)) {
      throw new Error("Malformed private PDF source metadata");
    }
    names.add(item.name);
  }
  for (const page of index.pages) {
    if (page.language !== "en" || !Number.isSafeInteger(page.page) || page.page < 1 ||
        typeof page.text !== "string" || !page.text.trim() ||
        (page.source !== "srd" && !names.has(page.source))) {
      throw new Error("Malformed SRD page in rules index");
    }
  }
  return index;
}

export function validPdfName(name) {
  return typeof name === "string" && name.length <= 180 &&
    /^[^/\\\x00-\x1f]+\.pdf$/i.test(name) && name[0] !== ".";
}

export function listRuleSources(index) {
  validateIndex(index);
  return [
    { id: "srd", name: "SRD 5.2.1 EN", kind: "official", url: SOURCE },
    ...(index.private_sources || []).map(item => ({
      id: item.name, name: item.name, kind: "user-provided PDF (not independently verified)", url: null
    }))
  ];
}

function reference(source, page, text) {
  return source === "srd"
    ? { source_id: "srd", source: "SRD 5.2.1 EN", kind: "official", page,
        url: `${SOURCE}#page=${page}`, text }
    : { source_id: source, source: source, kind: "user-provided PDF (not independently verified)",
        page, url: null, text };
}

export async function loadRules(path) {
  let text;
  try { text = await readFile(path, "utf8"); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    const filename = basename(path);
    const fallback = filename === RULES_INDEX_FILENAME ? LEGACY_RULES_INDEX_FILENAME
      : filename === LEGACY_RULES_INDEX_FILENAME ? RULES_INDEX_FILENAME : null;
    if (!fallback) throw error;
    text = await readFile(join(dirname(path), fallback), "utf8");
  }
  const index = validateIndex(JSON.parse(text));
  try {
    const sidecar = JSON.parse(await readFile(join(dirname(path), SEARCH_SIDECAR_NAME), "utf8"));
    if (sidecar.index_sha256 === createHash("sha256").update(text).digest("hex") &&
        isSearchDataShape(sidecar, index.pages.length)) {
      attachSearchData(index, sidecar);
    }
  } catch {
    // Pre-v0.3 and incomplete indexes still work. The in-memory lookup is
    // rebuilt once on demand and never accepts a stale/corrupt sidecar.
  }
  return index;
}

export function compileRulesSearch(index) {
  return buildSearchData(validateIndex(index).pages, tokens);
}

function attachSearchData(index, data) {
  const pageLookup = new Map(index.pages.map(page => [
    `${page.source}\u0000${page.page}`, page.text
  ]));
  const normalized = new Map();
  const headings = new Map();
  const pageText = (source, page) => {
    const key = `${source}\u0000${page}`;
    if (!pageLookup.has(key)) return undefined;
    if (!normalized.has(key)) normalized.set(key, pageLookup.get(key).replace(/\s+/g, " ").trim());
    return normalized.get(key);
  };
  const headingBoost = (source, page, start, end, terms) => {
    const key = `${source}\u0000${page}`;
    const raw = pageLookup.get(key);
    if (!raw) return 0;
    if (!headings.has(key)) {
      headings.set(key, raw.split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line.length >= 3 && line.length <= 60 &&
          /^[A-Z]/.test(line) && !/[.!?]$/.test(line))
        .map(line => ({ phrase: line.toLowerCase(), terms: tokens(line) }))
        .filter(item => item.terms.length >= 1 && item.terms.length <= 4));
    }
    const excerpt = pageText(source, page).slice(start, end).toLowerCase();
    for (const heading of headings.get(key)) {
      const exact = heading.terms.join(" ") === terms.join(" ");
      const prefix = heading.terms.length === 1 && heading.terms[0] === terms[0];
      if ((exact || prefix) && excerpt.includes(heading.phrase)) return exact ? 12 : 8;
    }
    return 0;
  };
  searchCache.set(index, { data, pageText, headingBoost });
}

function getSearchCache(index) {
  if (!searchCache.has(index)) attachSearchData(index, compileRulesSearch(index));
  return searchCache.get(index);
}

// A filtered view shares the precomputed postings, but only has page text
// for sources permitted by its own index. Search also checks that allowlist.
export function inheritRulesSearch(original, filtered) {
  attachSearchData(filtered, getSearchCache(original).data);
  return filtered;
}

// Split pages into short, overlapping passages to keep both retrieval and the
// resulting OpenCode context manageable. Page numbers remain PDF page numbers.
export function passages(index, size = 1300, overlap = 200) {
  const results = [];
  for (const { source, page, text } of validateIndex(index).pages) {
    const clean = text.replace(/\s+/g, " ").trim();
    for (let start = 0; start < clean.length;) {
      let end = Math.min(start + size, clean.length);
      if (end < clean.length) {
        const boundary = clean.lastIndexOf(" ", end);
        if (boundary > start + size / 2) end = boundary;
      }
      results.push({ source, page, text: clean.slice(start, end) });
      if (end >= clean.length) break;
      start = Math.max(start + 1, end - overlap);
    }
  }
  return results;
}

export function searchRules(index, query, { limit = 4, source = "all",
  preferredSources = [] } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
    throw new RangeError("Invalid rules search options");
  }
  if (source !== "all" && !listRuleSources(index).some(item => item.id === source)) {
    throw new RangeError("Unknown rule source; call list_rule_sources");
  }
  const terms = [...new Set(tokens(query))];
  if (!terms.length) return [];
  const { data, pageText, headingBoost } = getSearchCache(index);
  const allowedSources = new Set(["srd", ...(index.private_sources || []).map(item => item.name)]);
  const preferred = new Set(preferredSources);
  return rankSearchData(data, terms, { source, limit, allowedSources,
    preferredSources: preferred,
    pageText, headingBoost })
    .map(item => reference(item.source, item.page, item.text));
}

export function readRulePage(index, page, source = "srd") {
  validateIndex(index);
  if (!Number.isSafeInteger(page) || page < 1) return null;
  const found = index.pages.find(item => item.source === source && item.page === page);
  return found ? reference(source, page, found.text) : null;
}
