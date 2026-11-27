// Book visibility for the locally indexed D&D rules corpus. Player access is
// allowlisted: an unclassified private PDF is GM-only, including new campaigns.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { inheritRulesSearch, validPdfName, validateIndex } from "./rules.mjs";

const EMPTY_POLICY = Object.freeze({ version: 1, rules_for_all: [] });

export function accessRole(foundryRole) {
  return foundryRole === 3 || foundryRole === 4 ? "gm" : "player";
}

export function parseRulesAccessRole(role) {
  if (role === undefined || role === "") return "player";
  if (role === "gm" || role === "player") return role;
  throw new Error("RULES_ACCESS_ROLE must be player or gm");
}

export function validateAccessPolicy(policy) {
  if (!policy || policy.version !== 1 || !Array.isArray(policy.rules_for_all) ||
      !policy.rules_for_all.every(validPdfName) ||
      new Set(policy.rules_for_all).size !== policy.rules_for_all.length ||
      Object.keys(policy).some(key => !["version", "rules_for_all"].includes(key))) {
    throw new Error("Invalid rules access policy: expected {version:1, rules_for_all:[PDF filenames]}");
  }
  return policy;
}

export async function loadAccessPolicy(path) {
  let content;
  try { content = await readFile(path, "utf8"); }
  catch (error) {
    if (error.code === "ENOENT") return EMPTY_POLICY;
    throw error;
  }
  return validateAccessPolicy(JSON.parse(content));
}

export async function accessPolicyRevision(path) {
  const policy = await loadAccessPolicy(path);
  return createHash("sha256").update(JSON.stringify([...policy.rules_for_all].sort())).digest("hex");
}

export function visibleRulesIndex(index, policy = EMPTY_POLICY, role = "player") {
  validateIndex(index);
  validateAccessPolicy(policy);
  if (role !== "gm" && role !== "player") throw new Error("Unknown rules access role");
  if (role === "gm") return index;
  const allowed = new Set(policy.rules_for_all);
  return inheritRulesSearch(index, {
    ...index,
    private_sources: (index.private_sources || []).filter(item => allowed.has(item.name)),
    pages: index.pages.filter(page => page.source === "srd" || allowed.has(page.source))
  });
}
