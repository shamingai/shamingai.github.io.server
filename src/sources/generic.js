import { textOf, toCandidates } from "./shared.js";

export function linksFrom($, itemSelector, linkSelector) {
  const items = [];
  $(itemSelector).each((_index, element) => {
    const node = $(element);
    const link = node.is(linkSelector) ? node.first() : node.find(linkSelector).first();
    const href = link.attr("href");
    if (!href) return;
    items.push({ title: textOf(link) || textOf($(element)), url: href });
  });
  return items;
}

function baiduBoard({ $, site }) {
  const items = [];
  $("[class*='category-wrap'] [class*='item-']").each((_index, element) => {
    const card = $(element);
    const link = card.find("a[href^='http']").first();
    const title = textOf(card.find("[class*='c-single-text-ellipsis']")) || textOf(link);
    if (!title || !link.attr("href")) return;
    items.push({ title, url: link.attr("href"), excerpt: textOf(card.find("[class*='hot-desc']")) });
  });
  return toCandidates(items, site);
}

function sspaiPopular({ $, site }) {
  const items = linksFrom($, "a[href^='/post/']", "a");
  const seen = new Set();
  return toCandidates(
    items.filter((item) => {
      if (item.title.length < 6 || seen.has(item.url)) return false;
      seen.add(item.url);
      return true;
    }),
    site
  );
}

export const adapters = {
  "baidu-board": async (ctx) => baiduBoard(ctx),
  "sspai-popular": async (ctx) => sspaiPopular(ctx),
  "links": async ({ $, site }) =>
    toCandidates(
      linksFrom($, site.item_selector ?? "a[href]", site.link_selector ?? "a"),
      site
    )
};
