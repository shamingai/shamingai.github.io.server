import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateDigest, getRun, GenerateError } from "../../src/services/digest.js";
import { seedSites } from "../../src/sources/index.js";
import { all, get } from "../../src/db.js";
import { createTestDatabase } from "../helpers.js";

const SITES = [
  { id: "alpha", name: "甲站", home_url: "https://alpha.test", hot_list_url: "https://alpha.test/hot", adapter: "generic", weight: 1, max_candidates: 20 },
  { id: "beta", name: "乙站", home_url: "https://beta.test", hot_list_url: "https://beta.test/hot", adapter: "generic", weight: 1, max_candidates: 20 }
];

async function fixture({ size = 3, sites = SITES, collect } = {}) {
  const siteRepoDir = await mkdtemp(path.join(tmpdir(), "digest-repo-"));
  const db = await createTestDatabase();
  await seedSites(db, sites);
  const config = { siteRepoDir, digestSize: size, collection: {}, linkCheck: { timeoutMs: 1000 } };
  const calls = { collect: 0, fetched: [] };
  const deps = {
    collect:
      collect ??
      (async () =>
        sites.map((site, siteIndex) => ({
          site_id: site.id,
          status: "ok",
          collected: 5,
          error: null,
          candidates: Array.from({ length: 5 }, (_, index) => ({
            url: `https://${site.id}.test/${index + 1}`,
            title: `${site.name}${["A","B","C","D","E","F"][index]}号热点`,
            siteRank: index + 1
          }))
        }))),
    fetch: async (url) => {
      calls.fetched.push(url);
      return new Response("", { status: 200 });
    },
    linkCheck: { fetch: async (url) => (url.includes("dead") ? new Response("", { status: 404 }) : new Response("", { status: 200 })), timeoutMs: 1000 },
    llm: {
      chat: async (messages) => {
        const url = /原文链接：(\S+)/.exec(messages[1].content)[1];
        return JSON.stringify({ title: `编辑标题 ${url}`, summary: `摘要 ${url}`, reason: "推荐理由" });
      }
    }
  };
  return { db, config, deps, calls, siteRepoDir };
}

async function expectGenerateError(promise, statusCode, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof GenerateError, "应为 GenerateError");
    assert.equal(error.statusCode, statusCode);
    assert.equal(error.code, code);
    return true;
  });
}

test("generateDigest writes the article, digest and picked items to the database only", async () => {
  const { db, config, deps } = await fixture();
  const result = await generateDigest(db, config, { date: "2026-10-18", deps });

  assert.equal(result.status, "generated");
  assert.equal(result.item_count, 3);
  assert.equal(result.slug, "daily-2026-10-18");
  assert.equal(result.markdown_path, undefined);

  const article = await get(db, "SELECT title, kind, category_path, published_on, body FROM articles WHERE slug = 'daily-2026-10-18'");
  assert.equal(article.title, "2026-10-18 今日热门前十资讯");
  assert.equal(article.kind, "digest");
  assert.equal(article.category_path, "资讯");
  assert.equal(article.published_on, "2026-10-18");
  assert.match(article.body, /^共收录 3 条/);
  assert.doesNotMatch(article.body, /^date: /m);
  assert.match(article.body, /## 1\. 编辑标题 https:\/\/alpha\.test\/1/);
  assert.match(article.body, /\*\*推荐理由\*\*：推荐理由/);
  assert.deepEqual(
    (await all(db, "SELECT name FROM article_tags WHERE slug = 'daily-2026-10-18'")).map((row) => row.name),
    ["资讯"]
  );
  const digest = await get(db, "SELECT slug, item_count, status, markdown_path FROM digests WHERE digest_date = '2026-10-18'");
  assert.deepEqual({ ...digest }, { slug: "daily-2026-10-18", item_count: 3, status: "generated", markdown_path: null });
  assert.equal((await get(db, "SELECT COUNT(*) AS n FROM picked_items WHERE digest_date = '2026-10-18'")).n, 3);
  assert.equal((await get(db, "SELECT url FROM picked_items WHERE digest_date = '2026-10-18' AND rank_no = 1")).url, "https://alpha.test/1");

  const run = await getRun(db, result.run_id);
  assert.equal(run.outcome, "created");
  assert.equal(run.site_results.length, 2);
  assert.ok(run.finished_at);
});

test("generateDigest names today's digest when the caller omits the date", async () => {
  const { db, config, deps } = await fixture({ size: 1 });
  const result = await generateDigest(db, config, { deps });

  assert.match(result.slug, /^daily-\d{4}-\d{2}-\d{2}$/);
  assert.equal((await get(db, "SELECT slug FROM digests WHERE slug = ?", [result.slug])).slug, result.slug);
});

test("generateDigest refuses a duplicate date without regenerate", async () => {
  const { db, config, deps } = await fixture();
  await generateDigest(db, config, { date: "2026-10-18", deps });
  await expectGenerateError(generateDigest(db, config, { date: "2026-10-18", deps }), 409, "duplicate_date");
  assert.equal((await get(db, "SELECT COUNT(*) AS n FROM digests")).n, 1);
  const skipped = await get(db, "SELECT run_id, outcome FROM runs ORDER BY started_at DESC, run_id DESC LIMIT 1");
  assert.equal(skipped.outcome, "skipped_existing");
});

test("generateDigest keeps hot and tech digests apart on the same day", async () => {
  const sites = [
    { ...SITES[0], audience: "hot" },
    { ...SITES[1], audience: "tech" }
  ];
  const { db, config, deps } = await fixture({ sites });
  const collected = deps.collect;
  const seen = [];
  deps.collect = async (sites, options) => {
    seen.push(sites.map((site) => site.id));
    return (await collected()).filter((row) => sites.some((site) => site.id === row.site_id));
  };
  const hot = await generateDigest(db, config, { date: "2026-10-18", deps });
  const tech = await generateDigest(db, config, { date: "2026-10-18", catalog: "tech", deps });

  assert.deepEqual(seen, [["alpha"], ["beta"]], "每个品类只采集自己的站点");
  assert.deepEqual(tech.site_results.map((row) => row.site_id), ["beta"]);

  assert.equal(hot.slug, "daily-2026-10-18");
  assert.equal(tech.slug, "daily-2026-10-18-tech");
  assert.equal(tech.item_count, 3);
  assert.equal((await get(db, "SELECT title FROM articles WHERE slug = ?", [tech.slug])).title, "2026-10-18 每日热门技术资讯");
  assert.deepEqual(
    (await all(db, "SELECT slug, catalog FROM digests ORDER BY slug")).map((row) => ({ ...row })),
    [
      { slug: "daily-2026-10-18", catalog: "hot" },
      { slug: "daily-2026-10-18-tech", catalog: "tech" }
    ]
  );
  assert.equal((await get(db, "SELECT COUNT(*) AS n FROM picked_items WHERE slug = ?", [tech.slug])).n, 3);
  assert.deepEqual(
    (await all(db, "SELECT DISTINCT site_id FROM picked_items WHERE slug = ?", [tech.slug])).map((row) => row.site_id),
    ["beta"]
  );
  await expectGenerateError(generateDigest(db, config, { date: "2026-10-18", catalog: "tech", deps }), 409, "duplicate_date");
});

test("generateDigest rejects an unknown catalog", async () => {
  const { db, config, deps } = await fixture();
  await expectGenerateError(generateDigest(db, config, { date: "2026-10-18", catalog: "sports", deps }), 400, "invalid_catalog");
});

test("generateDigest with regenerate replaces the existing digest", async () => {
  const { db, config, deps } = await fixture();
  await generateDigest(db, config, { date: "2026-10-18", deps });
  const first = await get(db, "SELECT generated_at FROM digests WHERE digest_date = '2026-10-18'");
  const result = await generateDigest(db, config, { date: "2026-10-18", deps, regenerate: true });
  assert.equal(result.status, "replaced");
  assert.equal((await get(db, "SELECT COUNT(*) AS n FROM digests")).n, 1);
  assert.equal((await get(db, "SELECT COUNT(*) AS n FROM picked_items WHERE digest_date = '2026-10-18'")).n, 3);
  assert.equal((await get(db, "SELECT COUNT(*) AS n FROM articles WHERE slug = 'daily-2026-10-18'")).n, 1);
  assert.equal((await get(db, "SELECT COUNT(*) AS n FROM headings WHERE slug = 'daily-2026-10-18'")).n, 3);
  assert.ok((await get(db, "SELECT generated_at FROM digests WHERE digest_date = '2026-10-18'")).generated_at >= first.generated_at);
  assert.equal((await getRun(db, result.run_id)).kind, "regenerate");
});

test("generateDigest drops dead links and keeps the rest", async () => {
  const { db, config, deps } = await fixture({ size: 10 });
  const dead = (url) => ["https://alpha.test/1", "https://alpha.test/2", "https://beta.test/1"].includes(url);
  deps.linkCheck = {
    fetch: async (url) => new Response("", { status: dead(url) ? 404 : 200 }),
    timeoutMs: 1000
  };
  deps.collect = async () =>
    SITES.map((site) => ({
      site_id: site.id,
      status: "ok",
      collected: 6,
      error: null,
      candidates: Array.from({ length: 6 }, (_, index) => ({
        url: `https://${site.id}.test/${index + 1}`,
        title: `${site.name}${["A","B","C","D","E","F"][index]}号热点`,
        siteRank: index + 1
      }))
    }));
  const result = await generateDigest(db, config, { date: "2026-10-18", deps });
  assert.equal(result.item_count, 9);
  assert.equal(result.dropped.filter((item) => /404/.test(item.reason)).length, 3);
  assert.equal((await get(db, "SELECT COUNT(*) AS n FROM picked_items WHERE url LIKE 'https://%.test/1'")).n, 0);
});

test("generateDigest drops items the model cannot summarise", async () => {
  const { db, config, deps } = await fixture({ size: 3 });
  deps.llm = {
    chat: async (messages) => {
      const url = /原文链接：(\S+)/.exec(messages[1].content)[1];
      if (url.includes("/1")) return "不是 JSON";
      return JSON.stringify({ title: "标题", summary: "摘要", reason: "理由" });
    }
  };
  const result = await generateDigest(db, config, { date: "2026-10-18", deps });
  assert.equal(result.item_count, 4);
  assert.ok(result.dropped.some((item) => /无法可靠生成摘要/.test(item.reason)));
  assert.equal(result.note, null);
});

test("generateDigest notes the shortfall when too few items survive", async () => {
  const { db, config, deps } = await fixture({ size: 3 });
  deps.llm = {
    chat: async (messages) => {
      const url = /原文链接：(\S+)/.exec(messages[1].content)[1];
      if (!url.includes("/2")) return "不是 JSON";
      return JSON.stringify({ title: "标题", summary: "摘要", reason: "理由" });
    }
  };
  deps.collect = async () => [
    {
      site_id: "alpha",
      status: "ok",
      collected: 2,
      error: null,
      candidates: [
        { url: "https://alpha.test/1", title: "会被剔除", siteRank: 1 },
        { url: "https://alpha.test/2", title: "保留", siteRank: 2 }
      ]
    }
  ];
  const result = await generateDigest(db, config, { date: "2026-10-18", deps });
  assert.equal(result.item_count, 1);
  assert.match(result.note, /只收录 1 条/);
  assert.match(result.note, /1 条未通过内容校验或链接检查/);
});

test("generateDigest logs a warning per failed site and keeps the url in site_results", async () => {
  const { db, config, deps } = await fixture();
  const logs = [];
  deps.log = (level, message) => logs.push([level, message]);
  const calls = [];
  deps.collect = async (sites) =>
    sites.map((site, index) => {
      calls.push(site.id);
      return index === 1
        ? { site_id: site.id, status: "failed", collected: 0, error: "HTTP 403（https://beta.test/hot）", hot_list_url: "https://beta.test/hot" }
        : { site_id: site.id, status: "ok", collected: 1, error: null, candidates: [{ url: `https://${site.id}.test/1`, title: `${site.name}一号热点`, siteRank: 1 }] };
    });
  const result = await generateDigest(db, config, { date: "2026-10-18", deps });
  assert.equal(result.item_count, 1);
  assert.match(result.note, /1 个站点采集失败（beta）/);
  assert.match(result.note, /重新生成|检查来源地址/);
  assert.deepEqual(logs.map(([level, message]) => [level, message.includes("beta")]), [["warn", true]]);
  const failed = result.site_results.find((item) => item.site_id === "beta");
  assert.equal(failed.hot_list_url, "https://beta.test/hot");
  assert.match(failed.error, /HTTP 403/);
});

test("generateDigest fails with 422 when every site fails", async () => {
  const { db, config, deps } = await fixture();
  deps.collect = async () =>
    SITES.map((site) => ({ site_id: site.id, status: "failed", collected: 0, error: "请求超时" }));
  await expectGenerateError(generateDigest(db, config, { date: "2026-10-18", deps }), 422, "insufficient_content");
  assert.equal((await get(db, "SELECT outcome FROM runs ORDER BY started_at DESC, run_id DESC LIMIT 1")).outcome, "failed");
  assert.equal((await get(db, "SELECT COUNT(*) AS n FROM digests")).n, 0);
});

test("generateDigest fails with 422 when no item passes link checks", async () => {
  const { db, config, deps } = await fixture();
  deps.linkCheck = { fetch: async () => new Response("", { status: 404 }), timeoutMs: 1000 };
  await expectGenerateError(generateDigest(db, config, { date: "2026-10-18", deps }), 422, "insufficient_content");
  assert.equal((await get(db, "SELECT COUNT(*) AS n FROM articles")).n, 0);
});

test("generateDigest reports llm_not_configured when no client is available", async () => {
  const { db, config, deps } = await fixture();
  deps.llm = null;
  deps.linkCheck = { fetch: async () => new Response("", { status: 200 }), timeoutMs: 1000 };
  await expectGenerateError(
    generateDigest(db, { ...config, llm: {} }, { date: "2026-10-18", deps }),
    503,
    "llm_not_configured"
  );
});

test("generateDigest reads back through the API without a markdown round-trip", async () => {
  const { db, config, deps } = await fixture();
  const generated = await generateDigest(db, config, { date: "2026-10-18", deps });

  const row = await get(db, "SELECT kind, category_path, summary FROM articles WHERE slug = 'daily-2026-10-18'");
  assert.equal(row.kind, "digest");
  assert.equal(row.category_path, "资讯");
  assert.match(row.summary, /今日热点/);
  assert.equal((await get(db, "SELECT COUNT(*) AS n FROM headings WHERE slug = 'daily-2026-10-18'")).n, 3);
  assert.equal(generated.item_count, 3);
});

test("generateDigest with dryRun is a pure preview: no database rows, no files", async () => {
  const { db, config, deps } = await fixture();
  const result = await generateDigest(db, config, { date: "2026-10-18", deps, dryRun: true });

  assert.equal(result.dry_run, true);
  assert.equal(result.item_count, 3);
  assert.equal(result.markdown_path, undefined);
  assert.match(result.markdown, /## 1\. /);
  assert.doesNotMatch(result.markdown, /^date: /m);

  assert.equal((await get(db, "SELECT COUNT(*) AS n FROM digests")).n, 0);
  assert.equal((await get(db, "SELECT COUNT(*) AS n FROM picked_items")).n, 0);
  assert.equal((await get(db, "SELECT COUNT(*) AS n FROM articles")).n, 0);
  assert.equal((await get(db, "SELECT outcome FROM runs WHERE run_id = ?", [result.run_id])).outcome, "dry_run");

  const real = await generateDigest(db, config, { date: "2026-10-18", deps });
  assert.equal(real.status, "generated");
});
