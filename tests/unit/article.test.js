import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestDatabase, insertArticle } from "../helpers.js";
import { digestQuota, interleaveByDate, listPosts } from "../../src/services/article.js";

function row(slug, publishedOn, kind = "post") {
  return { slug, kind, published_on: publishedOn };
}

async function insertArticles(db, prefix, count, kind) {
  const slugs = [];
  for (let index = 1; index <= count; index += 1) {
    const day = String(29 - index).padStart(2, "0");
    const slug = kind === "digest" ? `daily-2026-08-${day}` : `${prefix}-${index}`;
    await insertArticle(db, { slug, kind, title: slug, publishedOn: `2026-08-${day}` });
    slugs.push(slug);
  }
  return slugs;
}

const DIGEST_SLUGS = ["daily-2026-08-28", "daily-2026-08-27", "daily-2026-08-26", "daily-2026-08-25"];

test("digest quota keeps room for posts and grows with the digests' share", () => {
  assert.equal(digestQuota(0, 100, 10), 0);
  assert.equal(digestQuota(4, 0, 10), 10);
  assert.equal(digestQuota(4, 12, 10), 3);
  assert.equal(digestQuota(4, 100, 10), 1);
  assert.equal(digestQuota(100, 100, 10), 5, "资讯和文章一样多时各占一半");
  assert.equal(digestQuota(1, 100, 10), 1);
});

test("interleaveByDate shows digests and posts even when digests are the newest", () => {
  const rows = [
    row("d3", "2026-10-19", "digest"),
    row("d2", "2026-10-18", "digest"),
    row("d1", "2026-10-17", "digest"),
    row("p1", "2026-10-16"),
    row("p2", "2025-01-02"),
    row("p3", "2025-01-01")
  ];
  const picked = interleaveByDate(rows, 10).map((item) => item.slug);
  assert.equal(picked[0], "d3");
  assert.equal(picked[1], "p1");
  assert.deepEqual([...picked].sort(), rows.map((item) => item.slug).sort());
  assert.equal(picked.length, 6);
});

test("interleaveByDate keeps date order inside each kind and fills the rest in order", () => {
  const rows = [
    row("d2", "2026-10-19", "digest"),
    row("d1", "2026-10-18", "digest"),
    row("p3", "2026-10-17"),
    row("p2", "2026-10-16"),
    row("p1", "2026-10-15")
  ];
  assert.deepEqual(interleaveByDate(rows, 4).map((item) => item.slug), ["d2", "p3", "d1", "p2", "p1"]);
});

test("interleaveByDate leaves the date order untouched when one kind is missing", () => {
  const postsOnly = [row("p2", "2026-10-19"), row("p1", "2026-10-18")];
  assert.deepEqual(interleaveByDate(postsOnly, 10).map((item) => item.slug), ["p2", "p1"]);
  const digestsOnly = [row("d2", "2026-10-19", "digest"), row("d1", "2026-10-18", "digest")];
  assert.deepEqual(interleaveByDate(digestsOnly, 10).map((item) => item.slug), ["d2", "d1"]);
});

test("interleaveByDate gives every digest a place when there are fewer digests than the page", () => {
  const rows = [
    row("d4", "2026-10-19", "digest"),
    row("d3", "2026-10-18", "digest"),
    row("d2", "2026-10-17", "digest"),
    row("d1", "2026-10-16", "digest"),
    row("p5", "2026-10-15"),
    row("p4", "2026-10-14"),
    row("p3", "2026-10-13"),
    row("p2", "2026-10-12"),
    row("p1", "2026-10-11")
  ];
  const picked = interleaveByDate(rows, 10).map((item) => item.slug);
  assert.equal(picked.length, 9);
  assert.equal(picked[0], "d4");
  assert.ok(picked.includes("d1"));
  assert.ok(picked.includes("p1"));
});

test("interleaveByDate keeps a digest next to the posts published on the same day", () => {
  const rows = [
    row("p4", "2026-10-23"),
    row("p3", "2026-10-22"),
    row("p2", "2026-10-19"),
    row("p1", "2026-10-18"),
    row("d1", "2026-10-23", "digest"),
    row("x1", "2026-10-14"),
    row("x2", "2026-10-13"),
    row("x3", "2026-10-12"),
    row("x4", "2026-10-11"),
    row("x5", "2026-10-10")
  ];
  const picked = interleaveByDate(rows, 10).map((item) => item.slug);
  assert.equal(picked[picked.indexOf("d1")], "d1");
  assert.ok(picked.indexOf("d1") <= picked.indexOf("p4") + 1, `资讯应与同一天的文章相邻：${picked}`);
  assert.deepEqual([...picked].sort(), rows.map((item) => item.slug).sort());
});

test("listPosts interleaves so a small archive of digests cannot push posts off the first page", async () => {
  const db = await createTestDatabase();
  await insertArticles(db, "daily", 4, "digest");
  await insertArticles(db, "rec", 12, "post");

  const first = await listPosts(db, {});
  assert.equal(first.items[0].slug, "rec-1", "最新的文章按日期排第一");
  assert.equal(first.items[1].slug, DIGEST_SLUGS[0], "资讯紧跟最新内容，只占一个位置");
  assert.ok(first.items.some((item) => item.kind === "post"), "首页必须有文章");
  assert.ok(first.items.some((item) => item.kind === "digest"), "首页必须有资讯");
  assert.equal(first.total, 16);
  assert.equal(first.page_count, 2);

  const all = [];
  for (let page = 1; page <= first.page_count; page += 1) {
    const result = await listPosts(db, { page });
    all.push(...result.items.map((item) => item.slug));
  }
  assert.equal(all.length, 16);
  assert.equal(new Set(all).size, 16);
  assert.equal(new Set(first.items.map((item) => item.slug)).size, first.items.length);
});

test("listPosts filters by kind and rejects unknown kinds", async () => {
  const db = await createTestDatabase();
  await insertArticles(db, "daily", 2, "digest");
  await insertArticles(db, "rec", 3, "post");

  const posts = await listPosts(db, { kind: "post" });
  assert.deepEqual(posts.items.map((item) => item.kind), ["post", "post", "post"]);
  const digests = await listPosts(db, { kind: "digest" });
  assert.deepEqual(digests.items.map((item) => item.slug), DIGEST_SLUGS.slice(0, 2));
  const all = await listPosts(db, { kind: "all" });
  assert.equal(all.total, 5);

  await assert.rejects(() => listPosts(db, { kind: "nope" }), (error) => {
    assert.equal(error.statusCode, 400);
    assert.equal(error.code, "invalid_kind");
    return true;
  });
});
