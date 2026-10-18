import { all, run } from "../db.js";
import { adapters as cn } from "./cn.js";
import { adapters as generic } from "./generic.js";

export const adapters = new Map([...Object.entries(generic), ...Object.entries(cn)]);

export const adapterKeys = [...adapters.keys()].sort();

export function adapterOf(key) {
  return adapters.get(key) ?? null;
}

export const DEFAULT_SITES = [
  {
    id: "baidu-hot",
    name: "百度热搜",
    home_url: "https://www.baidu.com/",
    hot_list_url: "https://top.baidu.com/board?tab=realtime",
    adapter: "baidu-board",
    max_candidates: 20
  },
  {
    id: "weibo-hot",
    name: "微博热搜",
    home_url: "https://weibo.com/",
    hot_list_url: "https://weibo.com/ajax/side/hotSearch",
    adapter: "weibo-hot-search",
    max_candidates: 20
  },
  {
    id: "zhihu-hot",
    name: "知乎热榜",
    home_url: "https://www.zhihu.com/",
    hot_list_url: "https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=50",
    adapter: "zhihu-hot-list",
    max_candidates: 20
  },
  {
    id: "toutiao-hot",
    name: "头条热榜",
    home_url: "https://www.toutiao.com/",
    hot_list_url: "https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc",
    adapter: "toutiao-hot-board",
    max_candidates: 20
  },
  {
    id: "sspai-hot",
    name: "少数派热门",
    home_url: "https://sspai.com/",
    hot_list_url: "https://sspai.com/",
    adapter: "sspai-popular",
    max_candidates: 20
  }
];

export async function seedSites(db, sites = DEFAULT_SITES, now = new Date().toISOString()) {
  if (!sites.length) return 0;
  const before = Number((await all(db, "SELECT COUNT(*) AS n FROM source_sites"))[0].n);
  // 只补库里没有的站点，命中冲突时什么都不改：SQLite 那侧才不必把 ON DUPLICATE KEY UPDATE 折成 INSERT OR REPLACE。
  for (const site of sites) {
    await run(
      db,
      `INSERT INTO source_sites (id, name, home_url, hot_list_url, adapter, weight, max_candidates, enabled, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM source_sites WHERE id = ?)`,
      [
        site.id,
        site.name,
        site.home_url,
        site.hot_list_url,
        site.adapter,
        site.weight ?? 1,
        site.max_candidates ?? 20,
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
