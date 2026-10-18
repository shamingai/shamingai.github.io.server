import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateDigest, getRun, GenerateError } from "../../src/services/digest.js";
import { seedSites } from "../../src/sources/index.js";
import { syncContent } from "../../src/services/sync.js";
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

test("generateDigest writes markdown, article, digest and picked items", async () => {
  const { db, config, deps, siteRepoDir } = await fixture();
  const result = await generateDigest(db, config, { date: "2026-10-18", deps });

  assert.equal(result.status, "generated");
  assert.equal(result.item_count, 3);
  assert.equal(result.markdown_path, path.join("blog", "content", "posts", "daily-2026-10-18.md"));

  const markdown = await readFile(path.join(siteRepoDir, result.markdown_path), "utf8");
  assert.match(markdown, /^2026-10-18 今日热门前十资讯\n\ndate: 2026-10-18\ncategory: 资讯\n/);
  assert.match(markdown, /## 1\. 编辑标题 https:\/\/alpha\.test\/1/);
  assert.match(markdown, /\*\*推荐理由\*\*：推荐理由/);

  const article = await get(db, "SELECT kind, category_path, published_on FROM articles WHERE slug = 'daily-2026-10-18'");
  assert.deepEqual({ ...article }, { kind: "digest", category_path: "资讯", published_on: "2026-10-18" });
  assert.deepEqual(
    (await all(db, "SELECT name FROM article_tags WHERE slug = 'daily-2026-10-18'")).map((row) => row.name),
    ["资讯"]
  );
  const digest = await get(db, "SELECT item_count, status FROM digests WHERE digest_date = '2026-10-18'");
  assert.deepEqual({ ...digest }, { item_count: 3, status: "generated" });
  assert.equal((await get(db, "SELECT COUNT(*) AS n FROM picked_items WHERE digest_date = '2026-10-18'")).n, 3);
  assert.equal((await get(db, "SELECT url FROM picked_items WHERE digest_date = '2026-10-18' AND rank_no = 1")).url, "https://alpha.test/1");

  const run = await getRun(db, result.run_id);
  assert.equal(run.outcome, "created");
  assert.equal(run.site_results.length, 2);
  assert.ok(run.finished_at);
});

test("generateDigest refuses a duplicate date without regenerate", async () => {
  const { db, config, deps } = await fixture();
  await generateDigest(db, config, { date: "2026-10-18", deps });
  await expectGenerateError(generateDigest(db, config, { date: "2026-10-18", deps }), 409, "duplicate_date");
  assert.equal((await get(db, "SELECT COUNT(*) AS n FROM digests")).n, 1);
  const skipped = await get(db, "SELECT run_id, outcome FROM runs ORDER BY started_at DESC, run_id DESC LIMIT 1");
  assert.equal(skipped.outcome, "skipped_existing");
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

test("generateDigest round-trips through syncContent", async () => {
  const { db, config, deps, siteRepoDir } = await fixture();
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(path.join(siteRepoDir, "blog", "content"), { recursive: true });
  await writeFile(path.join(siteRepoDir, "blog", "content", "site.json"), JSON.stringify({ articles: [] }));
  const generated = await generateDigest(db, config, { date: "2026-10-18", deps });

  const fresh = await createTestDatabase();
  await syncContent(fresh, siteRepoDir);
  const row = await get(fresh, "SELECT kind, category_path, summary FROM articles WHERE slug = 'daily-2026-10-18'");
  assert.equal(row.kind, "digest");
  assert.equal(row.category_path, "资讯");
  assert.match(row.summary, /今日热点/);
  assert.equal((await get(fresh, "SELECT COUNT(*) AS n FROM headings WHERE slug = 'daily-2026-10-18'")).n, 3);
  assert.equal(generated.item_count, 3);
});

test("generateDigest with dryRun is a pure preview: no database rows, no files", async () => {
  const { db, config, deps, siteRepoDir } = await fixture();
  const result = await generateDigest(db, config, { date: "2026-10-18", deps, dryRun: true });

  assert.equal(result.dry_run, true);
  assert.equal(result.item_count, 3);
  assert.equal(result.markdown_path, path.join("blog", "content", "posts", "daily-2026-10-18.md"));
  assert.match(result.markdown, /## 1\. /);
  await assert.rejects(readFile(path.join(siteRepoDir, result.markdown_path), "utf8"), /ENOENT/);

  assert.equal((await get(db, "SELECT COUNT(*) AS n FROM digests")).n, 0);
  assert.equal((await get(db, "SELECT COUNT(*) AS n FROM picked_items")).n, 0);
  assert.equal((await get(db, "SELECT COUNT(*) AS n FROM articles")).n, 0);
  assert.equal((await get(db, "SELECT outcome FROM runs WHERE run_id = ?", [result.run_id])).outcome, "dry_run");

  const real = await generateDigest(db, config, { date: "2026-10-18", deps });
  assert.equal(real.status, "generated");
});
