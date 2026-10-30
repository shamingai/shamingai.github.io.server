import { test } from "node:test";
import assert from "node:assert/strict";
import * as cheerio from "cheerio";
import { adapters } from "../../src/sources/generic.js";
import { linksFrom } from "../../src/sources/generic.js";
import { DEFAULT_SITES, seedSites, upgradeSiteUrls } from "../../src/sources/index.js";
import { all, run as query } from "../../src/db.js";
import { createTestDatabase } from "../helpers.js";

const site = { id: "alpha", name: "甲站", home_url: "https://alpha.test/", max_candidates: 10 };

function run(adapter, html, extra = {}) {
  return adapter({ site: { ...site, ...extra }, text: html, json: null, $: cheerio.load(html) });
}

test("linksFrom accepts a selector that matches the links themselves", () => {
  const $ = cheerio.load('<ul><li><a href="/a">甲站一号热点</a></li><li><a href="/b">甲站二号热点</a></li></ul>');
  assert.deepEqual(linksFrom($, "a[href]", "a"), [
    { title: "甲站一号热点", url: "/a" },
    { title: "甲站二号热点", url: "/b" }
  ]);
});

test("linksFrom looks inside container selectors", () => {
  const $ = cheerio.load('<div class="item"><h3><a href="/a">甲站一号热点</a></h3></div>');
  assert.deepEqual(linksFrom($, ".item", "a"), [{ title: "甲站一号热点", url: "/a" }]);
});

test("links adapter honors custom selectors and absolutizes urls", async () => {
  const html = '<ul><li><a class="hot" href="/post/1">甲站一号热点</a></li><li><a href="/skip/2">跳过</a></li></ul>';
  const items = await run(adapters.links, html, { item_selector: "a.hot", link_selector: "a" });
  assert.deepEqual(
    items.map((item) => [item.title, item.url, item.siteRank]),
    [["甲站一号热点", "https://alpha.test/post/1", 1]]
  );
});

test("sspai adapter keeps only long titles and drops duplicates", async () => {
  const html =
    '<div><a href="/post/1">这是一个足够长的标题</a><a href="/post/1">这是一个足够长的标题</a><a href="/post/2">短</a></div>';
  const items = await run(adapters["sspai-popular"], html);
  assert.deepEqual(items.map((item) => item.url), ["https://alpha.test/post/1"]);
});

test("baidu adapter reads the board JSON API", async () => {
  const json = {
    data: {
      cards: [
        {
          content: [
            {
              content: [
                { word: "置顶条目", url: "https://m.baidu.com/s?word=a", isTop: true },
                { word: "热榜条目", url: "https://m.baidu.com/s?word=b", index: 1 }
              ]
            }
          ]
        }
      ]
    }
  };
  const items = await adapters["baidu-board"]({ site, text: "", json, $: cheerio.load("") });
  assert.deepEqual(
    items.map((item) => [item.title, item.url, item.siteRank]),
    [
      ["置顶条目", "https://m.baidu.com/s?word=a", 1],
      ["热榜条目", "https://m.baidu.com/s?word=b", 2]
    ]
  );
});

test("baidu adapter reads title, link and description", async () => {
  const html = `
    <div class="category-wrap"><div class="category-wrap-i1"><div class="item-1">
      <div class="c-single-text-ellipsis">甲站头条热点</div>
      <div class="hot-desc">说明文字</div>
      <a href="https://news.test/1">查看</a>
    </div></div></div>`;
  const items = await run(adapters["baidu-board"], html);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "甲站头条热点");
  assert.equal(items[0].url, "https://news.test/1");
  assert.equal(items[0].excerpt, "说明文字");
});

test("upgradeSiteUrls replaces retired hot-list urls once", async () => {
  const db = await createTestDatabase();
  const sites = DEFAULT_SITES;
  await query(
    db,
    "INSERT INTO source_sites (id, name, home_url, hot_list_url, adapter, weight, max_candidates, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 20, 1, ?, ?)",
    ["zhihu-hot", "知乎热榜", "https://www.zhihu.com/", "https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=50", "zhihu-hot-list", "2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z"]
  );
  await query(
    db,
    "INSERT INTO source_sites (id, name, home_url, hot_list_url, adapter, weight, max_candidates, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 20, 1, ?, ?)",
    ["custom-hot", "自定义", "https://custom.test/", "https://custom.test/hot", "links", "2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z"]
  );
  assert.equal(await upgradeSiteUrls(db, sites), 1);
  const [row] = await all(db, "SELECT hot_list_url FROM source_sites WHERE id = ?", ["zhihu-hot"]);
  assert.equal(row.hot_list_url, "https://api.zhihu.com/topstory/hot-list?limit=50");
  // 标记写入后即使有人手动改回旧地址也不再覆盖。
  await query(db, "UPDATE source_sites SET hot_list_url = ? WHERE id = ?", ["https://example.test/old", "zhihu-hot"]);
  assert.equal(await upgradeSiteUrls(db, sites), 0);
  const [again] = await all(db, "SELECT hot_list_url FROM source_sites WHERE id = ?", ["zhihu-hot"]);
  assert.equal(again.hot_list_url, "https://example.test/old");
  db.raw.close();
});

test("seedSites leaves existing rows alone when run twice", async () => {
  // 种子用 INSERT ... SELECT ... WHERE NOT EXISTS，冲突时什么都不改：SQLite 那侧不会把它折成 INSERT OR REPLACE，
  // 所以不管走哪个驱动，都只该补新增站点、保留库里的人工调整。
  const db = await createTestDatabase();
  const sites = [{ id: "alpha", name: "甲站", home_url: "https://alpha.test/", hot_list_url: "https://alpha.test/hot", adapter: "links" }];
  assert.equal(await seedSites(db, sites), 1);
  await query(db, "UPDATE source_sites SET name = ? WHERE id = ?", ["甲站（改）", "alpha"]);
  assert.equal(await seedSites(db, sites), 0);
  const [row] = await all(db, "SELECT name FROM source_sites WHERE id = ?", ["alpha"]);
  assert.equal(row.name, "甲站（改）");
  db.raw.close();
});
