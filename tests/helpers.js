import { migrate, openDatabase, run } from "../src/db.js";

export async function createTestDatabase() {
  const db = openDatabase(":memory:");
  await migrate(db);
  return db;
}

export async function insertArticle(db, article) {
  const slug = article.slug ?? article.id;
  await run(
    db,
    `INSERT INTO articles (slug, kind, title, summary, summary_generated, body, category_path, published_on, word_count, reading_minutes, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      slug,
      article.kind ?? "post",
      article.title,
      article.summary ?? "",
      article.summaryGenerated ? 1 : 0,
      article.body ?? "",
      article.category ?? null,
      article.publishedOn,
      (article.body ?? "").replace(/\s+/g, "").length,
      article.readingMinutes ?? 1,
      article.updatedAt ?? `${article.publishedOn}T00:00:00.000Z`
    ]
  );
  let position = 0;
  for (const name of article.tags ?? []) {
    await run(db, "INSERT INTO article_tags (slug, name, position) VALUES (?, ?, ?)", [slug, name, position]);
    position += 1;
  }
  return slug;
}

export function testConfig(overrides = {}) {
  return {
    port: 0,
    host: "127.0.0.1",
    database: {
      profile: "test",
      driver: "sqlite",
      mysql: { host: "", port: 3306, user: "", password: "", database: "" },
      sqlitePath: ":memory:"
    },
    siteRepoDir: "",
    apiToken: "",
    corsOrigins: [],
    llm: { baseUrl: "", apiKey: "", model: "", timeoutMs: 5000 },
    schedule: { enabled: false, hour: 8, minute: 0, timeZone: "Asia/Shanghai" },
    collection: { concurrency: 2, retries: 0, timeoutMs: 1000 },
    linkCheck: { timeoutMs: 1000 },
    digestSize: 10,
    logger: false,
    ...overrides
  };
}

export async function seedSamples(db) {
  await insertArticle(db, {
    slug: "rec-001",
    title: "推荐系统入门",
    summary: "推荐系统的第一课",
    body: "## 为什么需要推荐\n\n推荐系统解决信息过载。",
    category: "技术 / 推荐系统",
    publishedOn: "2026-10-17",
    tags: ["推荐系统", "入门"]
  });
  await insertArticle(db, {
    slug: "rec-002",
    title: "排序模型笔记",
    body: "## 召回与排序\n\n两阶段排序。",
    category: "技术 / 推荐系统",
    publishedOn: "2026-09-02",
    tags: ["推荐系统"]
  });
  await insertArticle(db, {
    slug: "life-001",
    title: "周末散步",
    body: "沿着河边走了一圈。",
    category: "生活",
    publishedOn: "2025-03-01",
    tags: ["生活"]
  });
  await run(db, "INSERT INTO history_entries (position, occurred_on, text, article_slug) VALUES (0, '2025-03-01', '开始写博客', 'life-001')");
  await run(db, "INSERT INTO site_meta (meta_key, value) VALUES ('about', '一个写推荐系统的工程师。')");
  await run(db, "INSERT INTO site_meta (meta_key, value) VALUES ('last_sync_at', '2026-10-17T00:00:00.000Z')");
}

export async function createTestApp(options = {}) {
  const { buildApp } = await import("../src/app.js");
  const db = options.db ?? (await createTestDatabase());
  const config = testConfig(options.config);
  const app = await buildApp({ config, db, deps: options.deps });
  return { app, db, config };
}
