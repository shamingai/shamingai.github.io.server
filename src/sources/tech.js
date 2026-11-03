import { toCandidates } from "./shared.js";

function juejinRecommend({ json, site }) {
  const items = (json?.data ?? [])
    .map((entry) => entry?.item_info?.article_info)
    .filter(Boolean)
    .map((article) => ({
      title: article.title ?? "",
      url: `https://juejin.cn/post/${article.article_id}`,
      excerpt: article.brief_content ?? "",
      publishedAt: article.ctime ? new Date(Number(article.ctime) * 1000).toISOString().slice(0, 10) : null,
      siteRank: null
    }));
  return toCandidates(items, site);
}

function hnFrontPage({ json, site }) {
  const items = (json?.hits ?? []).map((hit) => ({
    title: hit.title ?? hit.story_title ?? "",
    // 招聘帖、Ask HN 没有外链，指回讨论页。
    url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
    excerpt: hit.story_text ? String(hit.story_text).replace(/<[^>]+>/g, " ").trim().slice(0, 400) : `${hit.points ?? 0} 分`,
    publishedAt: hit.created_at ? String(hit.created_at).slice(0, 10) : null,
    siteRank: null
  }));
  return toCandidates(items, site);
}

function sspaiArticleIndex({ json, site }) {
  const items = (json?.data ?? []).map((article) => ({
    title: article.title ?? "",
    url: `https://sspai.com/post/${article.id}`,
    excerpt: article.summary ?? "",
    publishedAt: article.released_time ? new Date(Number(article.released_time) * 1000).toISOString().slice(0, 10) : null,
    siteRank: null
  }));
  return toCandidates(items, site);
}

export const adapters = {
  "juejin-recommend": async (ctx) => juejinRecommend(ctx),
  "hn-front-page": async (ctx) => hnFrontPage(ctx),
  "sspai-article-index": async (ctx) => sspaiArticleIndex(ctx)
};

// 部分接口只接受 POST。采集时改发 POST 并把请求体按 JSON 发出，适配器本身只负责解析返回值。
// 值可以是对象，也可以是函数：36氪的请求体每次都要带当前毫秒时间戳，不能写死。
const POST_BODIES = new Map([
  ["juejin-recommend", { id_type: 2, client_type: 2608, sort_type: 200, cursor: "0", limit: 10 }],
  [
    "36kr-newsflash",
    () => ({
      partner_id: "wap",
      param: { siteId: 1, platformId: 2, pageSize: 20, pageEvent: 0, pageCallback: "", slideEvent: "" },
      timestamp: Date.now()
    })
  ]
]);

export function postBodyOf(adapter) {
  const body = POST_BODIES.get(adapter);
  if (typeof body === "function") return body();
  return body ?? null;
}
