import { toCandidates } from "./shared.js";

// IT之家列表混着导购稿（「XX 元起」「限时」「联合会员」），这些不进资讯。
const AD_LIKE = /(\d+\s*元起|限时|联合会员|券后|领券|促销|秒杀|直降)/;

function ithomeNewsList({ json, site }) {
  const items = (json?.newslist ?? [])
    .filter((entry) => !AD_LIKE.test(String(entry.title ?? "")))
    .map((entry) => ({
      title: entry.title ?? "",
      url: entry.url ?? "",
      excerpt: entry.description ?? "",
      publishedAt: String(entry.postdate ?? "").slice(0, 10) || null,
      siteRank: null
    }));
  return toCandidates(items, site);
}

function ifanrFeed({ json, site }) {
  const items = (json?.objects ?? []).map((entry) => ({
    title: entry.post_title ?? "",
    url: entry.post_url ?? "",
    excerpt: entry.post_excerpt ?? "",
    publishedAt: entry.created_at ? new Date(Number(entry.created_at) * 1000).toISOString().slice(0, 10) : null,
    siteRank: null
  }));
  return toCandidates(items, site);
}

// 虎嗅列表带阅读数，可作为热度；share_url 是 m 站地址，换成 www 的文章页。
function huxiuList({ json, site }) {
  const items = (json?.data?.dataList ?? []).map((entry) => ({
    title: entry.title ?? "",
    url: entry.aid ? `https://www.huxiu.com/article/${entry.aid}.html` : entry.share_url ?? "",
    excerpt: entry.summary ?? "",
    publishedAt: entry.dateline ? new Date(Number(entry.dateline) * 1000).toISOString().slice(0, 10) : null,
    siteRank: null
  }));
  return toCandidates(items, site);
}

// 36氪快讯要 POST，且请求体里带当前毫秒时间戳，见 sources/index.js 的 postBodyOf。
function kr36Newsflash({ json, site }) {
  const items = (json?.data?.itemList ?? []).map((entry) => {
    const material = entry.templateMaterial ?? {};
    return {
      title: material.widgetTitle ?? "",
      url: material.itemId ? `https://36kr.com/newsflashes/${material.itemId}` : "",
      excerpt: material.widgetContent ?? "",
      publishedAt: material.publishTime ? new Date(Number(material.publishTime)).toISOString().slice(0, 10) : null,
      siteRank: null
    };
  });
  return toCandidates(items, site);
}

export const adapters = {
  "ithome-news-list": async (ctx) => ithomeNewsList(ctx),
  "ifanr-feed": async (ctx) => ifanrFeed(ctx),
  "huxiu-list": async (ctx) => huxiuList(ctx),
  "36kr-newsflash": async (ctx) => kr36Newsflash(ctx)
};
