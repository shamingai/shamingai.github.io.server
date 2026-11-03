// 资讯品类。每日热门资讯按品类各自成一期：同一个日期可以有 hot 和 tech 两篇，
// 靠 slug 区分（daily-YYYY-MM-DD / daily-YYYY-MM-DD-tech），digest_date 仍只记日期。
const CATALOGS = {
  hot: { label: "今日热门前十资讯" },
  tech: { label: "每日热门技术资讯" }
};

export const CATALOG_KEYS = Object.keys(CATALOGS);

export function catalogOf(key) {
  return CATALOGS[key] ?? null;
}

export function readCatalog(value, fallback = "hot") {
  if (value === undefined || value === null || value === "") return fallback;
  return CATALOGS[String(value)] ? String(value) : null;
}

export function catalogLabel(key = "hot") {
  return CATALOGS[key]?.label ?? CATALOGS.hot.label;
}

// 旧格式的资讯 slug 只有 daily-日期，按 hot 处理；其余从 daily-日期- 后面读品类。
export function catalogOfSlug(slug) {
  const match = /^daily-\d{4}-\d{2}-\d{2}-([a-z0-9]+)$/.exec(String(slug ?? ""));
  return match && CATALOGS[match[1]] ? match[1] : "hot";
}

// 只取 slug 里的日期部分，picked_items 靠 digest_date 按天分组。
export function dateOfSlug(slug) {
  return /^daily-(\d{4}-\d{2}-\d{2})/.exec(String(slug ?? ""))?.[1] ?? null;
}
