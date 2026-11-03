import { all, run } from "../db.js";
import { setMeta } from "../services/sync.js";
import { adapters as cn } from "./cn.js";
import { adapters as generic } from "./generic.js";
import { adapters as tech, postBodyOf } from "./tech.js";
import { adapters as finance } from "./finance.js";
import { adapters as gear } from "./gear.js";
import { adapters as world } from "./world.js";
import { adapters as security, HN_SECURITY_FILTERS } from "./security.js";

export const adapters = new Map([
  ...Object.entries(generic),
  ...Object.entries(cn),
  ...Object.entries(tech),
  ...Object.entries(finance),
  ...Object.entries(gear),
  ...Object.entries(world),
  ...Object.entries(security)
]);

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
  },
  {
    id: "yicai-rank",
    name: "第一财经",
    home_url: "https://www.yicai.com/",
    // 周榜接口，数组顺序就是名次，是这次加的财经源里唯一有真实排名的。
    hot_list_url: "https://www.yicai.com/api/ajax/getranklistbykeys?keys=newsRank",
    adapter: "yicai-rank",
    audience: "finance",
    max_candidates: 20
  },
  {
    id: "caixin-home",
    name: "财新网",
    home_url: "https://www.caixin.com/",
    hot_list_url: "https://gateway.caixin.com/api/extapi/homeInterface.jsp?subject=100589266&start=0&count=10&picdim=_266_177&type=2",
    adapter: "caixin-home",
    audience: "finance",
    max_candidates: 20
  },
  {
    id: "eastmoney-fast",
    name: "东方财富7×24",
    home_url: "https://finance.eastmoney.com/",
    hot_list_url: "https://np-listapi.eastmoney.com/comm/web/getFastNewsList?client=web&biz=web_724&fastColumn=102&sortEnd=&pageSize=20&req_trace=1",
    adapter: "eastmoney-fast-news",
    audience: "finance",
    max_candidates: 20
  },
  {
    id: "10jqka-push",
    name: "同花顺7×24",
    home_url: "https://news.10jqka.com.cn/",
    hot_list_url: "https://news.10jqka.com.cn/tapp/news/push/stock/?page=1&tag=&track=website&pagesize=20",
    adapter: "10jqka-push",
    audience: "finance",
    max_candidates: 20
  },
  {
    id: "ithome-news",
    name: "IT之家",
    home_url: "https://www.ithome.com/",
    hot_list_url: "https://api.ithome.com/json/newslist/news",
    adapter: "ithome-news-list",
    audience: "gear",
    max_candidates: 20
  },
  {
    id: "ifanr-feed",
    name: "爱范儿",
    home_url: "https://www.ifanr.com/",
    hot_list_url: "https://sso.ifanr.com/api/v5/wp/web-feed/?position=index_list&limit=20&offset=0",
    adapter: "ifanr-feed",
    audience: "gear",
    max_candidates: 20
  },
  {
    id: "huxiu-article",
    name: "虎嗅",
    home_url: "https://www.huxiu.com/",
    // 文章列表 JSON，返回固定的 22 条，分页参数不起作用。
    hot_list_url: "https://api-article.huxiu.com/web/article/articleList?platform=www&pageSize=30",
    adapter: "huxiu-list",
    audience: "gear",
    max_candidates: 20
  },
  {
    id: "36kr-newsflash",
    name: "36氪快讯",
    home_url: "https://36kr.com/",
    // POST 接口，请求体在 tech.js 的 POST_BODIES 里按需生成。
    hot_list_url: "https://gateway.36kr.com/api/mis/nav/newsflash/flow",
    adapter: "36kr-newsflash",
    audience: "flash",
    max_candidates: 20
  },
  {
    id: "eastmoney-fast-flash",
    name: "东方财富快讯",
    home_url: "https://finance.eastmoney.com/",
    // 和财经品类同一个接口，快讯品类单独计一条来源。
    hot_list_url: "https://np-listapi.eastmoney.com/comm/web/getFastNewsList?client=web&biz=web_724&fastColumn=102&sortEnd=&pageSize=20&req_trace=1",
    adapter: "eastmoney-fast-news",
    audience: "flash",
    max_candidates: 20
  },
  {
    id: "10jqka-push-flash",
    name: "同花顺快讯",
    home_url: "https://news.10jqka.com.cn/",
    hot_list_url: "https://news.10jqka.com.cn/tapp/news/push/stock/?page=1&tag=&track=website&pagesize=20",
    adapter: "10jqka-push",
    audience: "flash",
    max_candidates: 20
  },
  {
    id: "huxiu-flash",
    name: "虎嗅快讯",
    home_url: "https://www.huxiu.com/",
    hot_list_url: "https://api-article.huxiu.com/web/article/articleList?platform=www&pageSize=30",
    adapter: "huxiu-list",
    audience: "flash",
    max_candidates: 20
  },
  {
    id: "techcrunch",
    name: "TechCrunch",
    home_url: "https://techcrunch.com/",
    hot_list_url: "https://techcrunch.com/wp-json/wp/v2/posts?per_page=20&_fields=id,date,link,title,excerpt,jetpack_featured_media_url",
    adapter: "techcrunch-posts",
    audience: "world-tech",
    max_candidates: 20
  },
  {
    id: "the-verge",
    name: "The Verge",
    home_url: "https://www.theverge.com/",
    hot_list_url: "https://www.theverge.com/rss/index.xml",
    adapter: "verge-atom",
    audience: "world-tech",
    max_candidates: 20
  },
  {
    id: "hn-security-ai",
    name: "Hacker News 安全",
    home_url: "https://news.ycombinator.com/",
    // Algolia 按分数搜帖子，适配器再按标题里的 AI 关键词筛一遍、按热度排序。
    hot_list_url: `https://hn.algolia.com/api/v1/search?query=security&tags=(story,ask_hn,show_hn)&${HN_SECURITY_FILTERS}&hitsPerPage=50&attributesToRetrieve=title,url,story_text,points,created_at,objectID`,
    adapter: "hn-security-ai",
    audience: "ai-security",
    max_candidates: 20
  },
  {
    id: "gbhackers",
    name: "GBHackers",
    home_url: "https://gbhackers.com/",
    // WordPress RSS，按发布时间排列，适配器只留标题沾 AI 的。
    hot_list_url: "https://gbhackers.com/feed/",
    adapter: "security-rss",
    audience: "ai-security",
    max_candidates: 20
  },
  {
    id: "embracethered",
    name: "Embrace The Red",
    home_url: "https://embracethered.com/blog/",
    // Johann Rehberger 的 AI 攻击面博客（提示注入、Copilot 等），全是 AI 安全文章，不用过滤。
    hot_list_url: "https://embracethered.com/blog/index.xml",
    adapter: "embracethered-rss",
    audience: "ai-security",
    max_candidates: 20
  }
  // Ars Technica 的 RSS 能取到条目，但文章页对任何匿名请求都返回 405，会被链接检查整批拒掉，不接入。
];

// 旧版默认热榜地址已失效（百度 HTML 卡片改版、微博接口 403、知乎 api/v3 401）。
// seedSites 刻意不覆盖已有行，所以这里按版本号做一次性的地址升级，并记下标记避免反复覆盖人工改回的值。
const SOURCE_URL_REVISION = "source-urls-2026-11-catalogs3";
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
