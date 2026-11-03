import { all, run } from "../db.js";
import { setMeta } from "../services/sync.js";
import { adapters as cn } from "./cn.js";
import { adapters as generic } from "./generic.js";
import { adapters as tech, postBodyOf } from "./tech.js";

export const adapters = new Map([...Object.entries(generic), ...Object.entries(cn), ...Object.entries(tech)]);

export const adapterKeys = [...adapters.keys()].sort();

export function adapterOf(key) {
  return adapters.get(key) ?? null;
}

export { postBodyOf };

export const DEFAULT_SITES = [
  {
    id: "baidu-hot",
    name: "百度热搜",
    home_url: "https://www.baidu.com/",
    hot_list_url: "https://top.baidu.com/api/board?platform=wise&tab=realtime",
    adapter: "baidu-board",
    audience: "hot",
    max_candidates: 20
  },
  {
    id: "weibo-hot",
    name: "微博热搜",
    home_url: "https://weibo.com/",
    // weibo.com/ajax/side/hotSearch 已对匿名请求返回 403，改走 tophub 的微博榜镜像。
    hot_list_url: "https://tophub.today/n/KqndgxeLl9",
    adapter: "tophub-hot",
    audience: "hot",
    max_candidates: 20
  },
  {
    id: "zhihu-hot",
    name: "知乎热榜",
    home_url: "https://www.zhihu.com/",
    // www.zhihu.com/api/v3 对匿名请求返回 401，公开的 api.zhihu.com 镜像仍可用。
    hot_list_url: "https://api.zhihu.com/topstory/hot-list?limit=50",
    adapter: "zhihu-hot-list",
    audience: "hot",
    max_candidates: 20
  },
  {
    id: "toutiao-hot",
    name: "头条热榜",
    home_url: "https://www.toutiao.com/",
    hot_list_url: "https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc",
    adapter: "toutiao-hot-board",
    audience: "hot",
    max_candidates: 20
  },
  {
    id: "sspai-hot",
    name: "少数派热门",
    home_url: "https://sspai.com/",
    hot_list_url: "https://sspai.com/",
    adapter: "sspai-popular",
    audience: "hot",
    max_candidates: 20
  },
  {
    id: "juejin-recommend",
    name: "掘金推荐",
    home_url: "https://juejin.cn/",
    hot_list_url: "https://api.juejin.cn/recommend_api/v1/article/recommend_all_feed",
    adapter: "juejin-recommend",
    audience: "tech",
    max_candidates: 20
  },
  {
    id: "hn-frontpage",
    name: "Hacker News",
    home_url: "https://news.ycombinator.com/",
    // 首页的 Algolia 索引，按首页顺序返回，带分数；网页本身是表格，JSON 更稳。
    hot_list_url: "https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=12",
    adapter: "hn-front-page",
    audience: "tech",
    max_candidates: 20
  },
  {
    id: "sspai-tech",
    name: "少数派推荐",
    home_url: "https://sspai.com/",
    // 少数派的文章列表 JSON 接口，比首页 HTML 稳定；首页那个留给「热门」品类。
    hot_list_url: "https://sspai.com/api/v1/article/index/page/get?limit=10&offset=0",
    adapter: "sspai-article-index",
    audience: "tech",
    max_candidates: 20
  }
];

// 旧版默认热榜地址已失效（百度 HTML 卡片改版、微博接口 403、知乎 api/v3 401）。
// seedSites 刻意不覆盖已有行，所以这里按版本号做一次性的地址升级，并记下标记避免反复覆盖人工改回的值。
const SOURCE_URL_REVISION = "source-urls-2026-11-audience";
const RETIRED_HOT_LIST_URLS = new Set([
  "https://top.baidu.com/board?tab=realtime",
  "https://weibo.com/ajax/side/hotSearch",
  "https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=50"
]);

export async function upgradeSiteUrls(db, sites = DEFAULT_SITES, now = new Date().toISOString()) {
  const [marker] = await all(db, "SELECT value FROM site_meta WHERE meta_key = ?", [`revision:${SOURCE_URL_REVISION}`]);
  if (marker) return 0;
  let updated = 0;
  for (const site of sites) {
    const [row] = await all(db, "SELECT hot_list_url, audience FROM source_sites WHERE id = ?", [site.id]);
    if (!row) continue;
    // 地址只动仍是已退役地址的行，人工自定义过的地址保持原样；品类按默认值对齐，旧库里一律是 hot。
    const urlRetired = RETIRED_HOT_LIST_URLS.has(row.hot_list_url);
    const audience = site.audience ?? "hot";
    if (!urlRetired && row.audience === audience) continue;
    const sets = ["audience = ?", "updated_at = ?"];
    const params = [audience, now];
    if (urlRetired) {
      sets.unshift("hot_list_url = ?", "adapter = ?");
      params.unshift(site.hot_list_url, site.adapter);
    }
    params.push(site.id);
    const result = await run(db, `UPDATE source_sites SET ${sets.join(", ")} WHERE id = ?`, params);
    updated += Number(result?.changes ?? 0);
  }
  await setMeta(db, `revision:${SOURCE_URL_REVISION}`, now);
  return updated;
}

export async function seedSites(db, sites = DEFAULT_SITES, now = new Date().toISOString()) {
  if (!sites.length) return 0;
  const before = Number((await all(db, "SELECT COUNT(*) AS n FROM source_sites"))[0].n);
  // 只补库里没有的站点，命中冲突时什么都不改：SQLite 那侧才不必把 ON DUPLICATE KEY UPDATE 折成 INSERT OR REPLACE。
  for (const site of sites) {
    await run(
      db,
      `INSERT INTO source_sites (id, name, home_url, hot_list_url, adapter, weight, max_candidates, audience, enabled, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM source_sites WHERE id = ?)`,
      [
        site.id,
        site.name,
        site.home_url,
        site.hot_list_url,
        site.adapter,
        site.weight ?? 1,
        site.max_candidates ?? 20,
        site.audience ?? "hot",
        site.enabled === 0 ? 0 : 1,
        now,
        now,
        site.id
      ]
    );
  }
  const after = Number((await all(db, "SELECT COUNT(*) AS n FROM source_sites"))[0].n);
  return after - before;
}
