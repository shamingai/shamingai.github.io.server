import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { get, run } from "../../src/db.js";
import { createTestApp, createTestDatabase, seedSamples } from "../helpers.js";
import { seedSites } from "../../src/sources/index.js";
import { GenerateError } from "../../src/services/digest.js";

const SITES = [
  { id: "alpha", name: "甲站", home_url: "https://alpha.test/", hot_list_url: "https://alpha.test/hot", adapter: "links", weight: 1, max_candidates: 10 },
  { id: "beta", name: "乙站", home_url: "https://beta.test/", hot_list_url: "https://beta.test/hot", adapter: "links", weight: 2, max_candidates: 10 }
];

async function digestFixture() {
  const siteRepoDir = await mkdtemp(path.join(tmpdir(), "api-digest-"));
  const db = await createTestDatabase();
  const now = new Date().toISOString();
  await run(
    db,
    "INSERT INTO digests (digest_date, slug, title, item_count, note, status, generated_at, markdown_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ["2026-10-18", "daily-2026-10-18", "2026-10-18 资讯", 2, null, "generated", now, "blog/content/posts/daily-2026-10-18.md"]
  );
  await run(
    db,
    `INSERT INTO picked_items (digest_date, rank_no, url, title, site_id, site_name, site_rank, mention_count, summary, reason, published_at)
    VALUES ('2026-10-18', 1, 'https://alpha.test/1', '甲站首条', 'alpha', '甲站', 1, 2, '摘要一', '理由一', '2026-10-18T00:00:00.000Z')`
  );
  await run(
    db,
    `INSERT INTO picked_items (digest_date, rank_no, url, title, site_id, site_name, site_rank, mention_count, summary, reason, published_at)
    VALUES ('2026-10-18', 2, 'https://beta.test/2', '乙站第二条', 'beta', '乙站', 2, 1, '摘要二', '理由二', '2026-10-18T01:00:00.000Z')`
  );
  return { db, siteRepoDir };
}

async function readerApp() {
  const { db } = await digestFixture();
  await seedSamples(db);
  await seedSites(db, SITES);
  const app = await createTestApp({ db });
  return { db, siteRepoDir: null, ...app };
}

test("GET /api/health reports the database state, content directory and last sync", async () => {
  const { db } = await digestFixture();
  await seedSamples(db);
  const siteRepoDir = await mkdtemp(path.join(tmpdir(), "health-ok-"));
  await mkdir(path.join(siteRepoDir, "blog", "content", "posts"), { recursive: true });
  const { app } = await createTestApp({ db, config: { siteRepoDir } });
  const response = await app.inject({ method: "GET", url: "/api/health" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    status: "ok",
    db: "ok",
    content_dir: "ok",
    details: {
      content_dir: { status: "ok", site_repo_dir: siteRepoDir, posts_dir: path.join(siteRepoDir, "blog", "content", "posts") }
    },
    last_sync_at: "2026-10-17T00:00:00.000Z"
  });
  await app.close();
});

test("GET /api/health fails with 503 when the content directory does not match", async () => {
  const { db } = await digestFixture();
  await seedSamples(db);
  const missing = await mkdtemp(path.join(tmpdir(), "health-missing-"));
  const { app } = await createTestApp({ db, config: { siteRepoDir: missing } });
  const response = await app.inject({ method: "GET", url: "/api/health" });
  assert.equal(response.statusCode, 503);
  const body = response.json();
  assert.equal(body.status, "degraded");
  assert.equal(body.db, "ok");
  assert.equal(body.content_dir, "mismatch");
  assert.equal(body.details.content_dir.posts_dir, path.join(missing, "blog", "content", "posts"));
  await app.close();

  const unset = await createTestApp({ db });
  const unsetResponse = await unset.app.inject({ method: "GET", url: "/api/health" });
  assert.equal(unsetResponse.statusCode, 503);
  assert.equal(unsetResponse.json().content_dir, "unconfigured");
  await unset.app.close();
});

test("GET /api/posts returns the documented envelope and pages newest first", async () => {
  const { db } = await digestFixture();
  await seedSamples(db);
  const { app } = await createTestApp({ db });

  const response = await app.inject({ method: "GET", url: "/api/posts?page=1&page_size=2" });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.total, 3);
  assert.equal(body.page, 1);
  assert.equal(body.page_size, 2);
  assert.deepEqual(body.items.map((item) => item.slug), ["rec-001", "rec-002"]);
  const [first] = body.items;
  assert.deepEqual(Object.keys(first), [
    "slug", "kind", "title", "summary", "summary_generated", "category_path", "published_on",
    "word_count", "reading_minutes", "tags"
  ]);
  assert.equal(first.kind, "post");
  assert.equal(first.published_on, "2026-10-17");
  assert.deepEqual(first.tags, ["推荐系统", "入门"]);

  const second = (await app.inject({ method: "GET", url: "/api/posts?page=2&page_size=2" })).json();
  assert.deepEqual(second.items.map((item) => item.slug), ["life-001"]);
  await app.close();
});

test("GET /api/posts rejects invalid pagination", async () => {
  const { db } = await digestFixture();
  const { app } = await createTestApp({ db });
  for (const query of ["page=0", "page=abc", "page_size=0", "page_size=101"]) {
    const response = await app.inject({ method: "GET", url: `/api/posts?${query}` });
    assert.equal(response.statusCode, 400, query);
    assert.match(response.json().error.code, /^invalid_page/, query);
    assert.equal(typeof response.json().error.message, "string");
  }
  await app.close();
});

test("GET /api/posts/:slug returns body, headings and neighbours; unknown slugs are 404", async () => {
  const { db } = await digestFixture();
  await seedSamples(db);
  const { app } = await createTestApp({ db });

  const response = await app.inject({ method: "GET", url: "/api/posts/rec-001" });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.slug, "rec-001");
  assert.equal(body.body, "## 为什么需要推荐\n\n推荐系统解决信息过载。");
  assert.equal(body.next.slug, "rec-002");

  const missing = await app.inject({ method: "GET", url: "/api/posts/nope" });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error.code, "post_not_found");
  await app.close();
});

test("GET /api/tags, /api/categories and /api/search read the same articles", async () => {
  const { db } = await digestFixture();
  await seedSamples(db);
  const { app } = await createTestApp({ db });

  const tags = (await app.inject({ method: "GET", url: "/api/tags" })).json();
  assert.ok(tags.items.some((tag) => tag.name === "推荐系统"));

  const categories = (await app.inject({ method: "GET", url: "/api/categories" })).json();
  assert.ok(categories.items.some((item) => item.path === "技术 / 推荐系统"));

  const categoryPosts = (await app.inject({ method: "GET", url: "/api/categories/技术%20%2F%20推荐系统/posts" })).json();
  assert.equal(categoryPosts.total, 2);

  const found = (await app.inject({ method: "GET", url: "/api/search?q=推荐" })).json();
  assert.ok(found.items.length >= 1);
  assert.ok(found.items.every((item) => item.slug !== undefined));
  await app.close();
});

test("GET /api/digests lists digests newest first and GET /api/digests/:date returns items in rank order", async () => {
  const { db } = await digestFixture();
  const { app } = await createTestApp({ db });

  const list = (await app.inject({ method: "GET", url: "/api/digests" })).json();
  assert.equal(list.total, 1);
  assert.equal(list.page, 1);
  assert.equal(list.page_size, 10);
  assert.deepEqual(list.items, [
    {
      date: "2026-10-18",
      slug: "daily-2026-10-18",
      title: "2026-10-18 资讯",
      item_count: 2,
      status: "generated",
      generated_at: list.items[0].generated_at
    }
  ]);

  const detail = (await app.inject({ method: "GET", url: "/api/digests/2026-10-18" })).json();
  assert.equal(detail.slug, "daily-2026-10-18");
  assert.deepEqual(detail.items.map((item) => [item.rank, item.url]), [
    [1, "https://alpha.test/1"],
    [2, "https://beta.test/2"]
  ]);
  assert.deepEqual(Object.keys(detail.items[0]), [
    "rank", "url", "title", "site_id", "site_name", "site_rank", "mention_count", "summary", "reason", "published_at"
  ]);

  const missing = await app.inject({ method: "GET", url: "/api/digests/1999-01-01" });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error.code, "digest_not_found");
  await app.close();
});

test("unknown routes return the not_found error envelope", async () => {
  const { db } = await digestFixture();
  const { app } = await createTestApp({ db });
  const response = await app.inject({ method: "GET", url: "/api/does-not-exist" });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json().error.code, "not_found");
  await app.close();
});

test("GET /api/source-sites is public and maps rows to the documented shape", async () => {
  const { db } = await digestFixture();
  await seedSites(db, SITES);
  const { app } = await createTestApp({ db });
  const response = await app.inject({ method: "GET", url: "/api/source-sites" });
  assert.equal(response.statusCode, 200);
  const { items } = response.json();
  assert.deepEqual(items.map((item) => item.id), ["alpha", "beta"]);
  assert.equal(items[0].enabled, true);
  assert.equal(items[1].weight, 2);
  assert.deepEqual(Object.keys(items[0]), [
    "id", "name", "home_url", "hot_list_url", "adapter", "weight", "max_candidates", "enabled", "created_at", "updated_at"
  ]);
  await app.close();
});

test("admin routes are disabled with 503 when API_TOKEN is not configured", async () => {
  const { db } = await digestFixture();
  const { app } = await createTestApp({ db });
  const calls = [
    { method: "POST", url: "/api/source-sites", payload: {} },
    { method: "PATCH", url: "/api/source-sites/alpha", payload: {} },
    { method: "DELETE", url: "/api/source-sites/alpha" },
    { method: "POST", url: "/api/content-syncs" },
    { method: "POST", url: "/api/digests", payload: {} },
    { method: "GET", url: "/api/runs/run-1" }
  ];
  for (const call of calls) {
    const response = await app.inject(call);
    assert.equal(response.statusCode, 503, `${call.method} ${call.url}`);
    assert.equal(response.json().error.code, "admin_disabled", `${call.method} ${call.url}`);
  }
  await app.close();
});

test("admin routes reject a wrong or missing bearer token with 401", async () => {
  const { db } = await digestFixture();
  await seedSites(db, SITES);
  const { app } = await createTestApp({ db, config: { apiToken: "secret" } });
  for (const headers of [{}, { authorization: "Bearer nope" }]) {
    const response = await app.inject({ method: "POST", url: "/api/source-sites", headers, payload: {} });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error.code, "unauthorized");
  }
  const publicRead = await app.inject({ method: "GET", url: "/api/source-sites" });
  assert.equal(publicRead.statusCode, 200);
  await app.close();
});

test("POST/PATCH/DELETE /api/source-sites runs the full admin lifecycle", async () => {
  const { db } = await digestFixture();
  const { app } = await createTestApp({ db, config: { apiToken: "secret" } });
  const auth = { authorization: "Bearer secret" };

  const created = await app.inject({
    method: "POST",
    url: "/api/source-sites",
    headers: auth,
    payload: { id: "gamma", name: "丙站", home_url: "https://gamma.test/", hot_list_url: "https://gamma.test/hot", adapter: "links" }
  });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().id, "gamma");
  assert.equal(created.json().enabled, true);
  assert.equal(created.json().weight, 1);
  assert.equal(created.json().max_candidates, 20);

  const duplicate = await app.inject({
    method: "POST",
    url: "/api/source-sites",
    headers: auth,
    payload: { id: "gamma", name: "丙站", home_url: "https://gamma.test/", hot_list_url: "https://gamma.test/hot", adapter: "links" }
  });
  assert.equal(duplicate.statusCode, 409);
  assert.equal(duplicate.json().error.code, "site_exists");

  const invalidAdapter = await app.inject({
    method: "POST",
    url: "/api/source-sites",
    headers: auth,
    payload: { id: "delta", name: "丁站", home_url: "https://delta.test/", hot_list_url: "https://delta.test/hot", adapter: "nope" }
  });
  assert.equal(invalidAdapter.statusCode, 400);
  assert.equal(invalidAdapter.json().error.code, "invalid_adapter");

  const patched = await app.inject({
    method: "PATCH",
    url: "/api/source-sites/gamma",
    headers: auth,
    payload: { enabled: false, weight: 3 }
  });
  assert.equal(patched.statusCode, 200);
  assert.equal(patched.json().enabled, false);
  assert.equal(patched.json().weight, 3);
  assert.equal(patched.json().home_url, "https://gamma.test/");

  const patchedMissing = await app.inject({ method: "PATCH", url: "/api/source-sites/nope", headers: auth, payload: { weight: 2 } });
  assert.equal(patchedMissing.statusCode, 404);
  assert.equal(patchedMissing.json().error.code, "site_not_found");

  const removed = await app.inject({ method: "DELETE", url: "/api/source-sites/gamma", headers: auth });
  assert.equal(removed.statusCode, 204);
  assert.equal(removed.body, "");

  const removedAgain = await app.inject({ method: "DELETE", url: "/api/source-sites/gamma", headers: auth });
  assert.equal(removedAgain.statusCode, 404);
  await app.close();
});

test("POST /api/content-syncs starts an asynchronous sync and reports 202", async () => {
  const { db } = await digestFixture();
  let started = 0;
  const { app } = await createTestApp({
    db,
    config: { apiToken: "secret" },
    deps: { startSync: () => { started += 1; return "run-sync-1"; } }
  });
  const response = await app.inject({ method: "POST", url: "/api/content-syncs", headers: { authorization: "Bearer secret" } });
  assert.equal(response.statusCode, 202);
  assert.deepEqual(response.json(), { run_id: "run-sync-1" });
  assert.equal(started, 1);
  await app.close();
});

test("POST /api/digests returns 201, 409 on duplicates and 200 on regenerate", async () => {
  const { db, siteRepoDir } = await digestFixture();
  await seedSites(db, SITES);
  const generate = async (database, _config, { date, regenerate }) => {
    const slug = `daily-${date}`;
    if ((await get(database, "SELECT 1 FROM digests WHERE digest_date = ?", [date])) && !regenerate) {
      throw new GenerateError(409, "duplicate_date", `${date} 已有资讯博客`, { run_id: "run-dup" });
    }
    const status = regenerate ? "replaced" : "generated";
    await run(database, "DELETE FROM digests WHERE digest_date = ?", [date]);
    await run(
      database,
      "INSERT INTO digests (digest_date, slug, title, item_count, note, status, generated_at, markdown_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [date, slug, `${date} 资讯`, 10, null, status, new Date().toISOString(), `blog/content/posts/${slug}.md`]
    );
    return {
      run_id: `run-${regenerate ? "2" : "1"}`,
      date,
      slug,
      item_count: 10,
      note: null,
      status,
      markdown_path: `blog/content/posts/${slug}.md`,
      site_results: [{ site_id: "alpha", status: "ok", collected: 10, error: null }],
      dropped: []
    };
  };
  const { app } = await createTestApp({
    db,
    config: { apiToken: "secret", siteRepoDir },
    deps: { generateDigest: generate, generate }
  });
  const auth = { authorization: "Bearer secret" };

  const first = await app.inject({ method: "POST", url: "/api/digests", headers: auth, payload: { date: "2026-10-20" } });
  assert.equal(first.statusCode, 201);
  assert.equal(first.json().status, "generated");
  assert.equal(first.json().slug, "daily-2026-10-20");
  assert.equal(first.json().run_id, "run-1");

  const again = await app.inject({ method: "POST", url: "/api/digests", headers: auth, payload: { date: "2026-10-20", regenerate: true } });
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().status, "replaced");

  const stored = (await app.inject({ method: "GET", url: "/api/digests" })).json();
  assert.equal(stored.items[0].date, "2026-10-20");
  assert.equal(stored.items[0].status, "replaced");

  const invalidDate = await app.inject({ method: "POST", url: "/api/digests", headers: auth, payload: { date: "2026-13-01" } });
  assert.equal(invalidDate.statusCode, 400);
  assert.equal(invalidDate.json().error.code, "invalid_date");
  await app.close();
});

test("POST /api/digests surfaces duplicate_date as 409 and generation failures as error envelopes", async () => {
  const { db, siteRepoDir } = await digestFixture();
  await seedSites(db, SITES);
  const { app } = await createTestApp({
    db,
    config: { apiToken: "secret", siteRepoDir, collection: { concurrency: 2, retries: 0, timeoutMs: 1000 }, llm: {} },
    deps: {
      linkCheck: { fetch: async () => new Response("", { status: 200 }), timeoutMs: 1000 },
      collect: async (sites) =>
        sites.map((site) => ({
          site_id: site.id,
          status: "ok",
          collected: 1,
          error: null,
          candidates: [{ url: `${site.home_url}item`, title: `${site.name}热点`, siteRank: 1 }]
        }))
    }
  });
  const auth = { authorization: "Bearer secret" };

  const duplicate = await app.inject({ method: "POST", url: "/api/digests", headers: auth, payload: { date: "2026-10-18" } });
  assert.equal(duplicate.statusCode, 409);
  assert.equal(duplicate.json().error.code, "duplicate_date");
  assert.equal(typeof duplicate.json().error.details.run_id, "string");
  const duplicateRun = await app.inject({ method: "GET", url: `/api/runs/${duplicate.json().error.details.run_id}`, headers: auth });
  assert.equal(duplicateRun.json().outcome, "skipped_existing");

  const noLlm = await app.inject({ method: "POST", url: "/api/digests", headers: auth, payload: { date: "2026-10-19" } });
  assert.equal(noLlm.statusCode, 503);
  assert.equal(noLlm.json().error.code, "llm_not_configured");
  assert.equal(typeof noLlm.json().error.details.run_id, "string");
  assert.equal((await app.inject({ method: "GET", url: "/api/digests/2026-10-19" })).statusCode, 404);

  const run = await app.inject({ method: "GET", url: `/api/runs/${noLlm.json().error.details.run_id}`, headers: auth });
  assert.equal(run.statusCode, 200);
  assert.equal(run.json().outcome, "failed");
  await app.close();
});

test("GET /api/runs/:runId returns the stored report or 404", async () => {
  const { db } = await digestFixture();
  await run(
    db,
    "INSERT INTO runs (run_id, kind, started_at, finished_at, site_results, dropped, outcome) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      "run-known",
      "manual",
      "2026-10-18T00:00:00.000Z",
      "2026-10-18T00:01:00.000Z",
      "[]",
      "[]",
      "created"
    ]
  );
  const { app } = await createTestApp({ db, config: { apiToken: "secret" } });
  const auth = { authorization: "Bearer secret" };

  const known = await app.inject({ method: "GET", url: "/api/runs/run-known", headers: auth });
  assert.equal(known.statusCode, 200);
  assert.equal(known.json().run_id, "run-known");
  assert.equal(known.json().outcome, "created");
  assert.deepEqual(known.json().site_results, []);

  const missing = await app.inject({ method: "GET", url: "/api/runs/run-none", headers: auth });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().error.code, "run_not_found");
  await app.close();
});

test("CORS is only answered for the configured origins", async () => {
  const { db } = await digestFixture();
  const { app } = await createTestApp({ db, config: { corsOrigins: ["https://blog.example.com"] } });

  const allowed = await app.inject({
    method: "GET",
    url: "/api/posts",
    headers: { origin: "https://blog.example.com" }
  });
  assert.equal(allowed.headers["access-control-allow-origin"], "https://blog.example.com");

  const preflight = await app.inject({
    method: "OPTIONS",
    url: "/api/digests",
    headers: { origin: "https://blog.example.com", "access-control-request-method": "GET" }
  });
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.headers["access-control-allow-origin"], "https://blog.example.com");

  const denied = await app.inject({ method: "GET", url: "/api/posts", headers: { origin: "https://evil.example.com" } });
  assert.equal(denied.statusCode, 200);
  assert.equal(denied.headers["access-control-allow-origin"], undefined);
  await app.close();
});
