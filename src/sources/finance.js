import { absoluteUrl, toCandidates } from "./shared.js";

// 第一财经的周榜有真实名次，数组顺序即名次；时间字段缺失时留空。
function yicaiRank({ json, site }) {
  const week = json?.newsRank?.week ?? [];
  const items = week.map((entry) => ({
    title: entry.NewsTitle ?? "",
    url: absoluteUrl(entry.url ?? "", "https://www.yicai.com"),
    siteRank: null
  }));
  return toCandidates(items, site);
}

// 财新的标题在 desc 字段（不是 title），链接是绝对地址。
function caixinHome({ json, site }) {
  const items = (json?.datas ?? []).map((entry) => ({
    title: entry.desc ?? "",
    url: entry.link ?? "",
    excerpt: Array.isArray(entry.keyword) ? entry.keyword.join("、") : entry.keyword ?? "",
    publishedAt: String(entry.time ?? "").slice(0, 10) || null,
    siteRank: Number.isFinite(entry.prio) && entry.prio > 0 ? entry.prio : null
  }));
  return toCandidates(items, site);
}

// 东财 7×24 不返回文章链接，按 code 拼到 finance.eastmoney.com 的文章页。
function eastmoneyFastNews({ json, site }) {
  const items = (json?.data?.fastNewsList ?? []).map((entry) => ({
    title: entry.title ?? "",
    url: entry.code ? `https://finance.eastmoney.com/a/${entry.code}.html` : "",
    excerpt: entry.summary ?? "",
    publishedAt: String(entry.showTime ?? "").slice(0, 10) || null,
    siteRank: null
  }));
  return toCandidates(items, site);
}

// 同花顺 7×24 的时间是 Unix 秒（rtime/ctime），接口不带 UA 会 403。
function tenthousandqkaPush({ json, site }) {
  const items = (json?.data?.list ?? []).map((entry) => ({
    title: entry.title ?? "",
    url: entry.url ?? "",
    excerpt: entry.digest ?? "",
    publishedAt: entry.rtime || entry.ctime ? new Date(Number(entry.rtime || entry.ctime) * 1000).toISOString().slice(0, 10) : null,
    siteRank: null
  }));
  return toCandidates(items, site);
}

export const adapters = {
  "yicai-rank": async (ctx) => yicaiRank(ctx),
  "caixin-home": async (ctx) => caixinHome(ctx),
  "eastmoney-fast-news": async (ctx) => eastmoneyFastNews(ctx),
  "10jqka-push": async (ctx) => tenthousandqkaPush(ctx)
};
