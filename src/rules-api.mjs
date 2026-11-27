/** Read-only D&D 2024 rules retrieval shared by all MCP clients. */
import { stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { GM_ROLE } from "./gm.mjs";
import { RULES_INDEX_FILENAME, LEGACY_RULES_INDEX_FILENAME,
  loadRules, listRuleSources, readRulePage, searchRules } from "./rules/rules.mjs";
import { loadAccessPolicy, visibleRulesIndex } from "./rules/rules-access.mjs";

const WINDOW = 6000;
const INDEX_PATH = process.env.RULES_INDEX_PATH || join(process.cwd(), ".rules", RULES_INDEX_FILENAME);
const ACCESS_PATH = process.env.RULES_ACCESS_FILE || join(process.cwd(), "rules-private", "access.json");
const cache = new Map();
const filteredCache = new WeakMap();

async function revisionOf(path) {
  let statPath = path;
  let info;
  try { info = await stat(path); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    const name = basename(path);
    const other = name === RULES_INDEX_FILENAME ? LEGACY_RULES_INDEX_FILENAME
      : name === LEGACY_RULES_INDEX_FILENAME ? RULES_INDEX_FILENAME : null;
    if (!other) throw error;
    statPath = join(dirname(path), other);
    info = await stat(statPath);
  }
  return `${statPath}:${info.size}:${info.mtimeMs}`;
}

async function corpus(path) {
  const revision = await revisionOf(path);
  const existing = cache.get(path);
  if (existing?.revision === revision) return existing.promise;
  const promise = loadRules(path);
  cache.set(path, { revision, promise });
  try { return await promise; }
  catch (error) { cache.delete(path); throw error; }
}

/** The HTTP audience header can only REDUCE rights granted by Foundry auth. */
export function effectiveRulesRole(foundryRole, audience) {
  if ((Number(foundryRole) || 0) < GM_ROLE) return "player";
  return audience === "player" ? "player" : "gm";
}

function viewFor(index, policy, role) {
  if (role === "gm") return index;
  const key = JSON.stringify([...policy.rules_for_all].sort());
  let views = filteredCache.get(index);
  if (!views) { views = new Map(); filteredCache.set(index, views); }
  if (!views.has(key)) {
    // One filtered passage lookup per policy revision, not per query.
    // Shared BM25 postings are still checked against this view's source allowlist.
    views.clear();
    views.set(key, visibleRulesIndex(index, policy, role));
  }
  return views.get(key);
}

export async function rulesQuery(name, args = {}, { foundryRole = 0,
  audience, indexPath = INDEX_PATH, accessPath = ACCESS_PATH } = {}) {
  const started = performance.now();
  const policy = await loadAccessPolicy(accessPath);
  const role = effectiveRulesRole(foundryRole, audience);
  const index = viewFor(await corpus(indexPath), policy, role);
  let result;
  if (name === "rules_list_sources") {
    result = listRuleSources(index);
  } else if (name === "rules_search") {
    const { query, source = "all", limit = 4 } = args;
    if (typeof query !== "string" || query.trim().length < 2 || query.length > 500 ||
        typeof source !== "string" || !Number.isInteger(limit) || limit < 1 || limit > 8)
      throw new Error("Invalid rules search query, source or limit.");
    result = searchRules(index, query, { source, limit,
      preferredSources: ["srd", ...policy.rules_for_all] });
  } else if (name === "rules_read_page") {
    const { source = "srd", page, offset = 0 } = args;
    if (typeof source !== "string" || !Number.isInteger(page) || page < 1 ||
        !Number.isSafeInteger(offset) || offset < 0)
      throw new Error("Invalid rules page, source or offset.");
    const full = readRulePage(index, page, source);
    const end = full ? Math.min(full.text.length, offset + WINDOW) : 0;
    result = full && offset < full.text.length
      ? { ...full, text: full.text.slice(offset, end),
        total_characters: full.text.length, next_offset: end < full.text.length ? end : null }
      : { available: false, note: "Page unavailable or inaccessible; do not cite it." };
  } else throw new Error("Unknown rules tool.");
  if (process.env.RULES_SEARCH_METRICS === "1")
    console.error(`[rules-mcp] ${name} ${Math.round(performance.now() - started)}ms`);
  return result;
}
