import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { filterReachable } from "../../src/services/link-check.js";
import { normalizeUrl } from "../../src/services/rank.js";
import { parsePost, syncContent } from "../../src/services/sync.js";
import { all, get } from "../../src/db.js";
import { createTestDatabase } from "../helpers.js";

async function fixtureRepo() {
  const dir = await mkdtemp(path.join(tmpdir(), "blog-repo-"));
  const content = path.join(dir, "blog", "content");
  await mkdir(path.join(content, "posts"), { recursive: true });
  await writeFile(
    path.join(content, "site.json"),
    JSON.stringify({
      about: "关于我",
      history: [{ date: "2025-01-01", text: "开张", articleId: "old" }],
      articles: [{ id: "legacy", title: "旧文", body: "正文", category: "杂谈", publishedOn: "2024-05-01", tags: ["杂谈"] }]
    })
  );
  await writeFile(
    path.join(content, "posts", "rec-001.md"),
    "推荐系统入门\n\ncategory: 技术 / 推荐系统\ndate: 2026-10-17\n\n## 为什么需要推荐\n\n推荐系统解决信息过载。"
  );
  await writeFile(
    path.join(content, "posts", "daily-2026-10-18.md"),
    "2026-10-18 今日热门前十资讯\n\ndate: 2026-10-18\ncategory: 资讯\nsummary: 今日热点\n\n## 1. 甲\n\n- 链接：[原文](https://a.com/1)\n\n**摘要**：摘要一\n"
  );
  return dir;
}

test("parsePost reads title, directives and body", () => {
  const post = parsePost("daily-2026-10-18", "标题\ndate: 2026-10-18\ncategory: 资讯\n\n## 1. 甲\n正文");
  assert.equal(post.title, "标题");
  assert.equal(post.kind, "digest");
  assert.equal(post.directives.category, "资讯");
  assert.equal(post.body, "## 1. 甲\n正文");
});

test("parsePost keeps a directive-free body starting at the blank line", () => {
  const post = parsePost("rec-001", "001. 标题\n\n分类：SDD\n\n## 小节\n正文");
  assert.deepEqual(post.directives, {});
  assert.equal(post.body, "分类：SDD\n\n## 小节\n正文");
});

test("syncContent imports posts, digests and legacy articles", async () => {
  const dir = await fixtureRepo();
  const db = await createTestDatabase();
  const result = await syncContent(db, dir);
  assert.equal(result.imported, 3);
  const digest = await get(db, "SELECT kind, category_path, published_on FROM articles WHERE slug = 'daily-2026-10-18'");
  assert.deepEqual({ ...digest }, { kind: "digest", category_path: "资讯", published_on: "2026-10-18" });
  assert.deepEqual(
    (await all(db, "SELECT name FROM article_tags WHERE slug = 'daily-2026-10-18' ORDER BY position")).map((row) => row.name),
    ["资讯"]
  );
  assert.equal((await get(db, "SELECT COUNT(*) AS n FROM headings WHERE slug = 'rec-001'")).n, 1);
  assert.equal((await get(db, "SELECT value FROM site_meta WHERE meta_key = 'about'")).value, "关于我");
});

test("syncContent replaces an article whose markdown changed", async () => {
  const dir = await fixtureRepo();
  const db = await createTestDatabase();
  await syncContent(db, dir);
  await writeFile(path.join(dir, "blog", "content", "posts", "rec-001.md"), "推荐系统入门\n\ndate: 2026-10-17\n\n改过的正文");
  await syncContent(db, dir);
  assert.equal((await get(db, "SELECT body FROM articles WHERE slug = 'rec-001'")).body, "改过的正文");
});

test("syncContent falls back to site-data.json for directives-free posts", async () => {
  const dir = await fixtureRepo();
  await mkdir(path.join(dir, "site"), { recursive: true });
  await writeFile(
    path.join(dir, "site", "site-data.json"),
    JSON.stringify({
      articles: [
        { id: "rec-001", summary: "旧摘要", category: "规格驱动开发", tags: ["规格驱动开发", "码云"], publishedOn: "2026-10-14" }
      ]
    })
  );
  const db = await createTestDatabase();
  await syncContent(db, dir, "2026-10-18T00:00:00.000Z");
  await writeFile(path.join(dir, "blog", "content", "posts", "rec-001.md"), "推荐系统入门\n\n分类：SDD\n\n改过的正文");
  await writeFile(
    path.join(dir, "blog", "content", "posts", "rec-002.md"),
    "002. 什么是规格驱动开发\n\n分类：SDD\n\n规格驱动开发的重点。"
  );
  await syncContent(db, dir, "2026-10-18T00:00:00.000Z");
  const row = await get(db, "SELECT category_path, published_on, summary FROM articles WHERE slug = 'rec-001'");
  assert.deepEqual(
    { ...row },
    { category_path: "规格驱动开发", published_on: "2026-10-14", summary: "旧摘要" }
  );
  assert.deepEqual(
    (await all(db, "SELECT name FROM article_tags WHERE slug = 'rec-001' ORDER BY position")).map((tag) => tag.name),
    ["规格驱动开发", "码云"]
  );
  const bare = await get(db, "SELECT category_path, published_on, summary FROM articles WHERE slug = 'rec-002'");
  assert.deepEqual({ ...bare }, { category_path: null, published_on: "2026-10-18", summary: "分类：SDD" });
});

test("syncContent tolerates a missing posts directory", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "blog-empty-"));
  await mkdir(path.join(dir, "blog", "content"), { recursive: true });
  await writeFile(path.join(dir, "blog", "content", "site.json"), JSON.stringify({ articles: [] }));
  const db = await createTestDatabase();
  assert.equal((await syncContent(db, dir)).imported, 0);
});

test("filterReachable rejects errors, 4xx and unparsable links", async () => {
  const responses = {
    "https://ok.com/1": new Response("", { status: 200 }),
    "https://gone.com/2": new Response("", { status: 404 }),
    "https://head-blocked.com/3": undefined
  };
  const fetch = async (url, options) => {
    if (url === "https://head-blocked.com/3") {
      if (options.method === "HEAD") return new Response("", { status: 405 });
      return new Response("", { status: 200 });
    }
    if (url === "https://down.com/4") throw new Error("ECONNREFUSED");
    return responses[url];
  };
  const { accepted, rejected } = await filterReachable(
    [
      { url: "https://ok.com/1", title: "ok" },
      { url: "https://gone.com/2", title: "gone" },
      { url: "https://head-blocked.com/3", title: "fallback" },
      { url: "https://down.com/4", title: "down" }
    ],
    { fetch, timeoutMs: 1000, concurrency: 2 }
  );
  assert.deepEqual(accepted.map((item) => item.title), ["ok", "fallback"]);
  assert.deepEqual(rejected.map((item) => item.title), ["gone", "down"]);
  assert.match(rejected[0].reason, /HTTP 404/);
});

test("checkLink normalizes nothing but reports 5xx as unreachable", async () => {
  const { checkLink } = await import("../../src/services/link-check.js");
  const result = await checkLink("https://x.com", { fetch: async () => new Response("", { status: 500 }) });
  assert.deepEqual(result, { ok: false, reason: "HTTP 500" });
  assert.equal(normalizeUrl("https://x.com/a#b"), "https://x.com/a");
});

