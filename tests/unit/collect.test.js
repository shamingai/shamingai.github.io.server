import { test } from "node:test";
import assert from "node:assert/strict";
import * as cheerio from "cheerio";
import { collectAll, collectSite } from "../../src/services/collect.js";
import { adapters } from "../../src/sources/index.js";

const site = {
  id: "weibo-hot",
  name: "微博热搜",
  home_url: "https://weibo.com/",
  hot_list_url: "https://weibo.com/ajax/side/hotSearch",
  adapter: "weibo-hot-search",
  max_candidates: 3
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("weibo adapter turns hot search JSON into ranked candidates", async () => {
  const fetch = async () =>
    jsonResponse({
      data: {
        realtime: [
          { word: "甲", note: "甲事件", num: 900 },
          { word: "广告", is_ad: 1 },
          { word: "乙", num: 800 },
          { word: "丙" },
          { word: "丁" }
        ]
      }
    });
  const result = await collectSite(site, { fetch, retries: 0, timeoutMs: 1000 });
  assert.equal(result.status, "ok");
  assert.equal(result.collected, 3);
  assert.deepEqual(result.candidates.map((item) => item.title), ["甲事件", "乙", "丙"]);
  assert.equal(result.candidates[0].siteRank, 1);
  assert.equal(result.candidates[0].url, `https://s.weibo.com/weibo?q=%23${encodeURIComponent("甲")}%23`);
});

test("zhihu adapter rewrites api links", async () => {
  const adapter = adapters.get("zhihu-hot-list");
  const items = await adapter({
    site: { ...site, adapter: "zhihu-hot-list", max_candidates: 5 },
    json: { data: [{ target: { url: "https://api.zhihu.com/questions/42", title: "问题", excerpt: "  描述  " } }] }
  });
  assert.deepEqual(items, [
    { title: "问题", url: "https://www.zhihu.com/question/42", siteRank: 1, publishedAt: null, excerpt: "描述" }
  ]);
});

test("toutiao adapter reads Title/Url fields", async () => {
  const adapter = adapters.get("toutiao-hot-board");
  const items = await adapter({
    site: { ...site, adapter: "toutiao-hot-board" },
    json: { data: [{ Title: "头条", Url: "https://www.toutiao.com/article/1/", LabelDesc: "热" }] }
  });
  assert.equal(items[0].title, "头条");
  assert.equal(items[0].excerpt, "热");
});

test("toutiao adapter strips tracking query strings from links", async () => {
  const adapter = adapters.get("toutiao-hot-board");
  const items = await adapter({
    site: { ...site, adapter: "toutiao-hot-board" },
    json: { data: [{ Title: "条目", Url: "https://toutiao.com/trending/1?log_pb=%7B%22title%22%3A%22x%22%7D&topic_id=1" }] }
  });
  assert.equal(items[0].url, "https://toutiao.com/trending/1");
});

test("tophub adapter reads weibo rows from the mirror table", async () => {
  const adapter = adapters.get("tophub-hot");
  const html = `<table class="table"><tbody>
    <tr><td>1.</td><td><a href="https://s.weibo.com/weibo?q=%E7%94%B2">甲条热搜</a></td><td class="ws">42万</td><td></td></tr>
    <tr><td>2.</td><td><a href="https://s.weibo.com/weibo?q=%E4%B9%99">乙条热搜</a></td><td class="ws">30万</td><td></td></tr>
  </tbody></table>`;
  const items = await adapter({ site, text: html, json: null, $: cheerio.load(html) });
  assert.deepEqual(
    items.map((item) => [item.title, item.siteRank, item.excerpt]),
    [
      ["甲条热搜", 1, "42万"],
      ["乙条热搜", 2, "30万"]
    ]
  );
});

test("unknown adapter fails without throwing", async () => {
  const result = await collectSite({ ...site, adapter: "nope" }, { fetch: async () => jsonResponse({}), retries: 0 });
  assert.equal(result.status, "failed");
  assert.match(result.error, /未知适配器/);
});

test("HTTP errors are retried and reported", async () => {
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    return new Response("blocked", { status: 403 });
  };
  const result = await collectSite(site, { fetch, retries: 1, timeoutMs: 1000 });
  assert.equal(calls, 2);
  assert.equal(result.status, "failed");
  assert.equal(result.error, "HTTP 403（https://weibo.com/ajax/side/hotSearch）");
});

test("collectAll isolates failures and keeps registry order", async () => {
  const fetch = async (url) => {
    if (url.includes("weibo")) return jsonResponse({ data: { realtime: [{ word: "甲" }] } });
    throw new Error("network down");
  };
  const results = await collectAll([site, { ...site, id: "zhihu-hot", hot_list_url: "https://zhihu.com/hot", adapter: "zhihu-hot-list" }], {
    fetch,
    retries: 0,
    concurrency: 2,
    timeoutMs: 1000
  });
  assert.deepEqual(results.map((item) => [item.site_id, item.status]), [
    ["weibo-hot", "ok"],
    ["zhihu-hot", "failed"]
  ]);
  assert.equal(results[1].error, "network down（https://zhihu.com/hot）");
});

test("empty list is reported as failure", async () => {
  const result = await collectSite(site, { fetch: async () => jsonResponse({ data: { realtime: [] } }), retries: 0 });
  assert.equal(result.status, "failed");
  assert.match(result.error, /没有解析出条目/);
});
