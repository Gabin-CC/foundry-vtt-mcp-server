// Compact, deterministic lexical retrieval data. The corpus text stays in
// the original private rules index; the sidecar stores only passage offsets
// and posting lists, never another copy of a commercial PDF's paragraphs.
export const SEARCH_DATA_VERSION = 1;

export function buildSearchData(pages, tokenize, { size = 1300, overlap = 200 } = {}) {
  const documents = [];
  const postings = new Map();
  let totalLength = 0;

  for (const { source, page, text } of pages) {
    const clean = text.replace(/\s+/g, " ").trim();
    for (let start = 0; start < clean.length;) {
      let end = Math.min(start + size, clean.length);
      if (end < clean.length) {
        const boundary = clean.lastIndexOf(" ", end);
        if (boundary > start + size / 2) end = boundary;
      }
      const counts = new Map();
      const words = tokenize(clean.slice(start, end));
      for (const word of words) counts.set(word, (counts.get(word) || 0) + 1);
      const id = documents.length;
      documents.push([source, page, start, end, words.length]);
      totalLength += words.length;
      for (const [word, count] of counts) {
        let list = postings.get(word);
        if (!list) { list = []; postings.set(word, list); }
        list.push([id, count]);
      }
      if (end >= clean.length) break;
      start = Math.max(start + 1, end - overlap);
    }
  }

  return {
    version: SEARCH_DATA_VERSION,
    page_count: pages.length,
    documents,
    avg_length: totalLength / (documents.length || 1),
    postings: Object.fromEntries(postings)
  };
}

export function isSearchDataShape(data, pageCount) {
  return data?.version === SEARCH_DATA_VERSION && data.page_count === pageCount &&
    Array.isArray(data.documents) && data.documents.length > 0 &&
    Number.isFinite(data.avg_length) && data.avg_length > 0 &&
    data.postings !== null && typeof data.postings === "object" &&
    !Array.isArray(data.postings);
}

export function rankSearchData(data, terms, { allowedSources, source = "all", limit = 4,
  preferredSources = new Set(), pageText, headingBoost = () => 0 }) {
  const scores = new Map();
  const documentCount = data.documents.length;
  const average = data.avg_length || 1;
  const k1 = 1.2;
  const b = 0.75;
  for (const term of terms) {
    const matches = Object.hasOwn(data.postings, term) ? data.postings[term] : [];
    if (!Array.isArray(matches) || !matches.length) continue;
    const idf = Math.log(1 + (documentCount - matches.length + 0.5) / (matches.length + 0.5));
    for (const [id, frequency] of matches) {
      const document = data.documents[id];
      if (!document || !allowedSources.has(document[0]) ||
          (source !== "all" && document[0] !== source)) continue;
      const denominator = frequency + k1 * (1 - b + b * document[4] / average);
      const part = idf * frequency * (k1 + 1) / denominator;
      const record = scores.get(id) || { score: 0, matched: 0 };
      record.score += part * (preferredSources.has(document[0]) ? 1.15 : 1);
      record.matched++;
      scores.set(id, record);
    }
  }
  const minimumMatches = Math.min(2, terms.length);
  const ranked = [];
  for (const [id, record] of scores) {
    if (record.matched < minimumMatches) continue;
    const document = data.documents[id];
    ranked.push({ id, ...record, document });
  }
  // Give exact phrases an explicit boost. Only qualifying passages are read;
  // no full-corpus tokenization occurs at query time.
  if (terms.length > 1) {
    const phrase = terms.join(" ");
    for (const record of ranked) {
      if (record.matched !== terms.length) continue;
      const [src, page, start, end] = record.document;
      const full = pageText(src, page);
      if (full && full.slice(start, end).toLowerCase().includes(phrase)) {
        record.score += terms.length * 3;
      }
    }
  }
  for (const record of ranked) {
    const [src, page, start, end] = record.document;
    record.score += headingBoost(src, page, start, end, terms);
  }
  ranked.sort((a, b) => b.score - a.score || b.matched - a.matched ||
    a.document[1] - b.document[1] || a.id - b.id);

  const uniquePages = new Set();
  const results = [];
  for (const record of ranked) {
    const [src, page, start, end] = record.document;
    const key = `${src}\u0000${page}`;
    if (uniquePages.has(key)) continue;
    const full = pageText(src, page);
    if (typeof full !== "string") continue;
    uniquePages.add(key);
    results.push({ source: src, page, text: full.slice(start, end) });
    if (results.length >= limit) break;
  }
  return results;
}
