import { toCandidates } from "./shared.js";

function weiboHotSearch({ json, site }) {
  const realtime = json?.data?.realtime ?? [];
  const pinned = new Set(json?.data?.hotgov?.word ? [json.data.hotgov.word] : []);
  const items = realtime
    .filter((entry) => entry.word && !entry.is_ad && !pinned.has(entry.word))
    .map((entry) => ({
      title: entry.note ?? entry.word,
      url: `https://s.weibo.com/weibo?q=%23${encodeURIComponent(entry.word)}%23`,
      excerpt: entry.word,
      siteRank: null
    }));
  return toCandidates(items, site);
}

function zhihuHotList({ json, site }) {
  const items = (json?.data ?? []).map((entry) => {
    const target = entry.target ?? {};
    let url = "";
    if (target.url) url = target.url.replace("://api.zhihu.com/questions/", "://www.zhihu.com/question/");
    else if (target.id) url = `https://www.zhihu.com/question/${target.id}`;
    return {
      title: target.title ?? "",
      url,
      excerpt: String(target.excerpt ?? "").replace(/\s+/g, " ").trim().slice(0, 400),
      siteRank: null
    };
  });
  return toCandidates(items, site);
}

function toutiaoHotBoard({ json, site }) {
  const items = (json?.data ?? []).map((entry) => {
    const raw = entry.Url ?? entry.url ?? "";
    // 头条链接带 log_pb 等追踪参数，去掉查询串只留 pathname。
    let url = raw;
    try {
      const parsed = new URL(raw);
      url = `${parsed.origin}${parsed.pathname}`;
    } catch {
      url = raw;
    }
    return {
      title: entry.Title ?? entry.title ?? "",
      url,
      excerpt: entry.LabelDesc ?? "",
      siteRank: null
    };
  });
  return toCandidates(items, site);
}

export const adapters = {
  "weibo-hot-search": async (ctx) => weiboHotSearch(ctx),
  "zhihu-hot-list": async (ctx) => zhihuHotList(ctx),
  "toutiao-hot-board": async (ctx) => toutiaoHotBoard(ctx)
};
