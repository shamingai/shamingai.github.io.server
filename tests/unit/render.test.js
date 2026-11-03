import { test } from "node:test";
import assert from "node:assert/strict";
import { digestSlug, digestSummary, digestTitle, renderDigestBody } from "../../src/services/render.js";

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

test("renderDigestBody writes an article body without front-matter directives", () => {
  const body = renderDigestBody({ items });
  assert.doesNotMatch(body, /^date: /m);
  assert.doesNotMatch(body, /^category: /m);
  assert.match(body, /共收录 2 条/);
  assert.match(body, /## 1\. 第一条/);
  assert.match(body, /- 来源：微博热搜 第 1 名，共 2 个站点提及/);
  assert.match(body, /- 链接：\[原文\]\(https:\/\/a\.com\/1\)/);
  assert.match(body, /\*\*推荐理由\*\*：理由二/);
});

test("renderDigestBody includes notes and regeneration notice", () => {
  const body = renderDigestBody({ items, note: "本次只收录 2 条", regenerated: true });
  assert.match(body, /> 本次只收录 2 条/);
  assert.match(body, /重新生成版本/);
});

test("slug and summary helpers", () => {
  assert.equal(digestSlug("2026-10-18"), "daily-2026-10-18");
  assert.equal(digestSlug("2026-10-18", "tech"), "daily-2026-10-18-tech");
  assert.equal(digestTitle("2026-10-18"), "2026-10-18 每日热门前十");
  assert.equal(digestSummary([]), "热门前十");
  const summary = digestSummary(items);
  assert.match(summary, /今日热点：第一条/);
  assert.match(summary, /2 个来源站点/);
});
