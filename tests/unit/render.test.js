import { test } from "node:test";
import assert from "node:assert/strict";
import { digestSlug, digestSummary, digestTitle, renderDigest } from "../../src/services/render.js";

const items = [
  {
    title: "第一条",
    url: "https://a.com/1",
    summary: "摘要一",
    reason: "理由一",
    siteId: "weibo-hot",
    siteName: "微博热搜",
    siteRank: 1,
    mentionCount: 2,
    publishedAt: null
  },
  {
    title: "第二条",
    url: "https://b.com/2",
    summary: "摘要二",
    reason: "理由二",
    siteId: "zhihu-hot",
    siteName: "知乎热榜",
    siteRank: 3,
    mentionCount: 1,
    publishedAt: "2026-10-18T01:00:00Z"
  }
];

test("renderDigest writes front-matter directives accepted by the content parser", () => {
  const markdown = renderDigest({ date: "2026-10-18", title: digestTitle("2026-10-18"), summary: "今日热点：第一条", items });
  const lines = markdown.split("\n");
  assert.equal(lines[0], "2026-10-18 今日热门前十资讯");
  assert.equal(lines[2], "date: 2026-10-18");
  assert.equal(lines[3], "category: 资讯");
  assert.match(markdown, /## 1\. 第一条/);
  assert.match(markdown, /- 来源：微博热搜 第 1 名，共 2 个站点提及/);
  assert.match(markdown, /- 链接：\[原文\]\(https:\/\/a\.com\/1\)/);
  assert.match(markdown, /\*\*推荐理由\*\*：理由二/);
  assert.match(markdown, /共收录 2 条/);
});

test("renderDigest includes notes and regeneration notice", () => {
  const markdown = renderDigest({
    date: "2026-10-18",
    title: digestTitle("2026-10-18"),
    summary: "s",
    items,
    note: "本次只收录 2 条",
    regenerated: true
  });
  assert.match(markdown, /> 本次只收录 2 条/);
  assert.match(markdown, /重新生成版本/);
});

test("slug and summary helpers", () => {
  assert.equal(digestSlug("2026-10-18"), "daily-2026-10-18");
  assert.equal(digestSummary("2026-10-18", []), "2026-10-18 的今日热门前十资讯。");
  const summary = digestSummary("2026-10-18", items);
  assert.match(summary, /今日热点：第一条/);
  assert.match(summary, /2 个来源站点/);
});
