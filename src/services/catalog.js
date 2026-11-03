// 资讯品类。每日热门资讯按品类各自成一期：同一个日期每个品类一篇，
// 靠 slug 区分（daily-YYYY-MM-DD / daily-YYYY-MM-DD-<key>），digest_date 仍只记日期。
// 加品类只要往 CATALOG_LIST 里加一行，并在 source_sites 里给该品类配来源站点。
// label 只写品类本身，不带“每日”：列表页标题是「每日」+ label，期数标题是日期 + label。
const CATALOG_LIST = [
  { key: "hot", label: "热门前十" },
  { key: "tech", label: "热门技术" },
  { key: "finance", label: "财经前十" },
  { key: "gear", label: "科技消费前十" },
  { key: "flash", label: "热门快讯" },
  { key: "world-tech", label: "海外科技前十" },
  { key: "ai-security", label: "AI 安全前十" }
];

const CATALOGS = Object.fromEntries(CATALOG_LIST.map(({ key, label }) => [key, { key, label }]));

export const CATALOG_KEYS = CATALOG_LIST.map(({ key }) => key);

export function listCatalogs() {
  return CATALOG_LIST.map(({ key, label }) => ({ key, label }));
}

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
  const match = /^daily-\d{4}-\d{2}-\d{2}-([a-z0-9-]+)$/.exec(String(slug ?? ""));
  return match && CATALOGS[match[1]] ? match[1] : "hot";
}

// 只取 slug 里的日期部分，picked_items 靠 digest_date 按天分组。
export function dateOfSlug(slug) {
  return /^daily-(\d{4}-\d{2}-\d{2})/.exec(String(slug ?? ""))?.[1] ?? null;
}
