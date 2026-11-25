/**
 * Locale selection for MCP-owned human-readable messages.
 *
 * Legacy French is the default until a versioned response migration. Schema
 * keys, enum values and Foundry document data must never be translated here.
 */
export function normalizeLocale(value, fallback = "fr") {
  const language = String(value || "").trim().toLowerCase().split("-")[0];
  return language === "en" || language === "fr" ? language : fallback;
}

export function currentLocale() {
  return normalizeLocale(process.env.MCP_LOCALE);
}

/** Choose the first supported language by HTTP quality, with the configured fallback. */
export function browserLocale(acceptLanguage, fallback = currentLocale()) {
  if (typeof acceptLanguage !== "string") return fallback;
  const ranges = acceptLanguage.split(",").map((entry, index) => {
    const [tag, ...parameters] = entry.trim().split(";");
    const quality = parameters.find(part => /^\s*q=/i.test(part));
    const q = quality ? Number(quality.split("=")[1]) : 1;
    return { language: normalizeLocale(tag, ""), quality: Number.isFinite(q) && q >= 0 && q <= 1 ? q : 0, index };
  }).filter(entry => entry.language && entry.quality > 0);
  ranges.sort((a, b) => b.quality - a.quality || a.index - b.index);
  return ranges[0]?.language || fallback;
}

/** The arguments are explicit, audited English and legacy French messages. */
export function message(english, french, locale = currentLocale()) {
  return locale === "en" ? english : french;
}
