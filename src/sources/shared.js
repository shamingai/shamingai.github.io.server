function normalize(raw, site, index, maxCandidates) {
  const title = String(raw?.title ?? "").replace(/\s+/g, " ").trim();
  const url = String(raw?.url ?? "").trim();
  if (!title || !url) return null;
  return {
    title,
    url,
    siteRank: Number.isInteger(raw.siteRank) && raw.siteRank > 0 ? raw.siteRank : index + 1,
    publishedAt: raw.publishedAt ?? null,
    excerpt: String(raw.excerpt ?? "").replace(/\s+/g, " ").trim()
  };
}

export function toCandidates(rawItems, site, limit = site.max_candidates ?? 20, baseUrl = site.home_url) {
  const seen = new Set();
  const result = [];
  rawItems.forEach((raw, index) => {
    if (result.length >= limit) return;
    const candidate = normalize(raw, site, index, limit);
    if (!candidate) return;
    candidate.url = absoluteUrl(candidate.url, baseUrl);
    if (!candidate.url || seen.has(candidate.url)) return;
    seen.add(candidate.url);
    result.push(candidate);
  });
  return result;
}

export function absoluteUrl(value, base) {
  try {
    return new URL(value, base).href;
  } catch {
    return "";
  }
}

export function textOf(node) {
  return node?.text().replace(/\s+/g, " ").trim() ?? "";
}
