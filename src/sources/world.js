import * as cheerio from "cheerio";
import { toCandidates } from "./shared.js";

// collect.js 按 HTML 模式解析响应，RSS/Atom 里的 <link> 会被当成空元素丢掉，这里自己按 XML 重新解析。
function xmlOf(text) {
  return cheerio.load(text ?? "", { xmlMode: true }, false);
}

function decodeEntities(value) {
  return String(value ?? "")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

// TechCrunch 的 WP REST 接口，顶层是数组，title 在 title.rendered。
// 默认响应会把每篇的正文、SEO 字段全带上，动辄几百 KB，这里只要展示用得到的字段。
function techcrunchPosts({ json, site }) {
  const items = (Array.isArray(json) ? json : []).map((entry) => ({
    title: decodeEntities(entry.title?.rendered ?? ""),
    url: entry.link ?? "",
    excerpt: decodeEntities(String(entry.excerpt?.rendered ?? "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim().slice(0, 400),
    // 有封面图的排在前面：TechCrunch 自己的列表页也是先图文后纯文字。
    siteRank: entry.jetpack_featured_media_url ? 1 : 2,
    publishedAt: String(entry.date ?? "").slice(0, 10) || null
  }));
  return toCandidates(items, site);
}

// The Verge 是 Atom：/feed/entry[]，链接在 link[rel=alternate] 的 href 上。
function vergeAtom({ text, site }) {
  const $ = xmlOf(text);
  const items = [];
  $("feed > entry").each((_index, element) => {
    const entry = $(element);
    const link = entry.find("link[rel='alternate']").attr("href") ?? entry.find("link").first().attr("href");
    items.push({
      title: decodeEntities(entry.find("title").first().text()),
      url: link ?? "",
      // content 是内嵌 HTML，先去标签再解实体。
      excerpt: decodeEntities(entry.find("content").first().text().replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim().slice(0, 400),
      publishedAt: entry.find("published").first().text().slice(0, 10),
      siteRank: null
    });
  });
  return toCandidates(items, site);
}

export const adapters = {
  "techcrunch-posts": async (ctx) => techcrunchPosts(ctx),
  "verge-atom": async (ctx) => vergeAtom(ctx)
};
