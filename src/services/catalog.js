// 资讯品类。每日热门资讯按品类各自成一期：同一个日期每个品类一篇，
// 靠 slug 区分（daily-YYYY-MM-DD / daily-YYYY-MM-DD-<key>），digest_date 仍只记日期。
// 加品类只要往 CATALOG_LIST 里加一行，并在 source_sites 里给该品类配来源站点。
// label 可带也可不带“每日”：带了的（每日热搜）原样用，没带的由 dailyLabel 补上。
const CATALOG_LIST = [
  { key: "hot", label: "每日热搜" },
  { key: "tech", label: "热门技术" },
  { key: "finance", label: "财经快讯" },
  { key: "gear", label: "科技消费" },
  { key: "world-tech", label: "海外科技" },
  { key: "ai-security", label: "AI 安全" }
];

const CATALOGS = Object.fromEntries(CATALOG_LIST.map(({ key, label }) => [key, { key, label }]));

export const CATALOG_KEYS = CATALOG_LIST.map(({ key }) => key);

// 列表页最前面的「全部」：只用于筛选，不是真品类，不进 CATALOGS，生成流程和来源配置都看不到它。
export const ALL_CATALOG = "all";
export const ALL_LABEL = "全部";

export function listCatalogs() {
  return [{ key: ALL_CATALOG, label: ALL_LABEL }, ...CATALOG_LIST.map(({ key, label }) => ({ key, label }))];
}

// 列表筛选：认「全部」和所有品类，其余一律 null。
export function readCatalogFilter(value, fallback = "hot") {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === ALL_CATALOG) return ALL_CATALOG;
  return CATALOGS[String(value)] ? String(value) : null;
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

// 列表页、期数标题都用这个：label 自带“每日”就不再重复加。
// 前缀是中文、label 以中文开头的紧挨着写（每日热搜），以字母数字开头（AI 安全）的补一个空格。
export function withDailyPrefix(label) {
  if (label.startsWith("每日")) return label;
  return /^[A-Za-z0-9]/.test(label) ? `每日 ${label}` : `每日${label}`;
}

export function dailyLabel(key = "hot") {
  return withDailyPrefix(catalogLabel(key));
}

// 旧格式的资讯 slug 只有 daily-日期，按 hot 处理；其余从 daily-日期- 后面读品类。
export function catalogOfSlug(slug) {
  const match = /^daily-\d{4}-\d{2}-\d{2}-([a-z0-9-]+)$/.exec(String(slug ?? ""));
  return match && CATALOGS[match[1]] ? match[1] : "hot";
}

// 只取 slug 里的日期部分，同一天的各品类资讯按它归到一天。
export function dateOfSlug(slug) {
  return /^daily-(\d{4}-\d{2}-\d{2})/.exec(String(slug ?? ""))?.[1] ?? null;
}
