import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeCandidates, normalizeTitle, normalizeUrl, similarity } from "../../src/services/rank.js";

function result(siteId, candidates) {
  return { site_id: siteId, site_name: siteId, status: "ok", candidates };
}

test("normalizeUrl drops tracking params, fragments and trailing slash", () => {
  assert.equal(normalizeUrl("https://WWW.Example.com/a/?utm_source=x&id=3#top"), "https://example.com/a?id=3");
  assert.equal(normalizeUrl("ftp://example.com/a"), "");
  assert.equal(normalizeUrl("not a url"), "");
});

test("normalizeTitle removes punctuation and case", () => {
  assert.equal(normalizeTitle("GPT-5 发布！"), normalizeTitle("gpt5  发布"));
});

test("similarity is high for near-identical headlines", () => {
  const base = normalizeTitle("苹果公司今天发布新款手机");
  assert.ok(similarity(base, normalizeTitle("苹果公司今天发布新款手机，售价公布")) >= 0.85);
  assert.ok(similarity(normalizeTitle("苹果发布新款手机"), normalizeTitle("房价继续下跌")) < 0.5);
});

test("same story from several sites becomes one candidate with mention count", () => {
  const merged = mergeCandidates(
    [
      result("a", [{ title: "苹果发布会", url: "https://a.com/1", siteRank: 1 }]),
      result("b", [
        { title: "苹果发布会", url: "https://b.com/x", siteRank: 2 },
        { title: "无关新闻", url: "https://b.com/2", siteRank: 1 }
      ])
    ],
    new Map([["a", 1], ["b", 1]])
  );
  assert.equal(merged.length, 2);
  const story = merged.find((item) => item.title === "苹果发布会");
  assert.equal(story.mentionCount, 2);
  assert.equal(story.siteId, "a");
  assert.equal(story.siteRank, 1);
  assert.equal(story.score, 1 + 0.5);
});

test("ranking prefers higher weight and higher rank", () => {
  const merged = mergeCandidates(
    [
      result("heavy", [{ title: "甲新闻", url: "https://x.com/1", siteRank: 3 }]),
      result("light", [{ title: "乙新闻", url: "https://x.com/2", siteRank: 1 }])
    ],
    new Map([["heavy", 3], ["light", 1]])
  );
  assert.deepEqual(merged.map((item) => item.title), ["甲新闻", "乙新闻"]);
});

test("failed sites and invalid candidates are ignored", () => {
  const merged = mergeCandidates(
    [
      { site_id: "a", status: "failed", candidates: [] },
      result("b", [{ title: "", url: "https://b.com/1" }, { title: "ok", url: "" }, { title: "有效", url: "https://b.com/3" }])
    ],
    new Map()
  );
  assert.deepEqual(merged.map((item) => item.title), ["有效"]);
});

test("a site ordering is matched to the foreign order by headline similarity", () => {
  const merged = mergeCandidates(
    [
      result("alpha", [
        { title: "甲站热点新闻第1条", url: "https://alpha.test/1", siteRank: 1 },
        { title: "甲站热点新闻第2条", url: "https://alpha.test/2", siteRank: 2 }
      ]),
      result("beta", [
        { title: "乙站热点新闻第1条", url: "https://beta.test/1", siteRank: 1 },
        { title: "乙站热点新闻第2条", url: "https://beta.test/2", siteRank: 2 }
      ])
    ],
    new Map()
  );
  assert.deepEqual(merged.map((item) => [item.url, item.mentionCount]), [
    ["https://alpha.test/1", 2],
    ["https://alpha.test/2", 2]
  ]);
});

test("a site repeating a foreign url and other items does not reuse it", () => {
  const merged = mergeCandidates(
    [
      result("a", [{ title: "国家统计局发布前三季度经济数据", url: "https://a.test/stats", siteRank: 1 }]),
      result("b", [
        { title: "国家统计局发布前三季度经济数据", url: "https://b.test/stats", siteRank: 2 },
        { title: "某地推出新的消费补贴政策", url: "https://b.test/subsidy", siteRank: 1 }
      ])
    ],
    new Map()
  );
  assert.deepEqual(merged.map((item) => [item.url, item.mentionCount]).sort(), [
    ["https://a.test/stats", 2],
    ["https://b.test/subsidy", 1]
  ]);
});
