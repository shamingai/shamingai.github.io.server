const TRACKING_PARAMS = /^(utm_|spm$|from$|share_|_source$|sharefrom$|ref$|referer$|source$)/i;
const TITLE_SIMILARITY = 0.85;

export function normalizeUrl(value) {
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    return "";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "";
  url.hash = "";
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
  }
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) url.pathname = url.pathname.slice(0, -1);
  return url.href;
}

export function normalizeTitle(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

export function similarity(left, right) {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const a = new Set([...left]);
  const b = new Set([...right]);
  let shared = 0;
  for (const char of a) if (b.has(char)) shared += 1;
  return shared / Math.max(a.size, b.size);
}

function sourcesFrom(group, siteId) {
  return group.sources.filter((source) => source.siteId === siteId);
}

export function mergeCandidates(results, weights = new Map()) {
  const groups = [];
  for (const result of results) {
    if (result.status !== "ok") continue;
    for (const candidate of result.candidates ?? []) {
      const url = normalizeUrl(candidate.url);
      const title = String(candidate.title ?? "").trim();
      const titleKey = normalizeTitle(title);
      if (!url || !titleKey) continue;

      const uncited = groups.filter((entry) => !sourcesFrom(entry, result.site_id).length);
      let group = uncited.find((entry) => entry.url === url);
      if (!group) group = uncited.find((entry) => entry.titleKey === titleKey);
      if (!group && uncited.length) {
        const freed = uncited.some((entry) => similarity(entry.titleKey, titleKey) >= TITLE_SIMILARITY);
        const citesSite = groups.some((entry) => sourcesFrom(entry, result.site_id).length);
        if (freed || citesSite || uncited.length === 1) group = uncited.find((entry) => similarity(entry.titleKey, titleKey) >= TITLE_SIMILARITY);
      }
      if (!group) {
        group = { url, title, excerpt: "", titleKey, sources: [], score: 0, latest: "" };
        groups.push(group);
      }

      const rank = Number.isInteger(candidate.siteRank) && candidate.siteRank > 0 ? candidate.siteRank : group.sources.length + 1;
      group.sources.push({
        siteId: result.site_id,
        siteName: result.site_name ?? result.site_id,
        siteRank: rank,
        title,
        excerpt: candidate.excerpt ?? "",
        publishedAt: candidate.publishedAt ?? null
      });
      group.score += (weights.get(result.site_id) ?? 1) / rank;
      if ((candidate.publishedAt ?? "") > group.latest) group.latest = candidate.publishedAt ?? "";
      if (!group.excerpt && candidate.excerpt) group.excerpt = candidate.excerpt;
    }
  }

  return groups
    .map((group) => {
      const primary = [...group.sources].sort((left, right) => left.siteRank - right.siteRank)[0];
      return {
        url: group.url,
        title: primary.title,
        excerpt: group.excerpt,
        score: Math.round(group.score * 1000) / 1000,
        mentionCount: group.sources.length,
        publishedAt: group.latest || null,
        siteId: primary.siteId,
        siteName: primary.siteName,
        siteRank: primary.siteRank,
        sources: group.sources
      };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.mentionCount - left.mentionCount ||
        (right.publishedAt ?? "").localeCompare(left.publishedAt ?? "") ||
        left.title.localeCompare(right.title, "zh-Hans-CN")
    );
}
