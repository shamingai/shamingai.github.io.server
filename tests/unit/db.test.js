import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { all, openDatabase, run } from "../../src/db.js";
import { createTestDatabase } from "../helpers.js";

test("migrations create the expected tables and drop the retired ones", async () => {
  const db = await createTestDatabase();
  const names = (await all(db, "SELECT name FROM sqlite_master WHERE type = 'table'")).map((row) => row.name);
  for (const table of ["source_sites", "articles", "article_tags", "headings", "digests", "picked_items", "runs", "site_meta"]) {
    assert.ok(names.includes(table), `${table} exists`);
  }
  for (const table of ["rejections", "candidates"]) {
    assert.ok(!names.includes(table), `${table} 不应存在`);
  }
});

test("one digest article per date", async () => {
  const db = await createTestDatabase();
  const insert = (slug) =>
    run(
      db,
      "INSERT INTO articles (slug, kind, title, summary, body, published_on, updated_at) VALUES (?, 'digest', ?, '', '', ?, 'now')",
      [slug, slug, "2026-10-18"]
    );
  await insert("daily-a");
  await assert.rejects(insert("daily-b"), /UNIQUE|duplicate/i);
});

test("openDatabase opens an SQLite file and reports its driver", async () => {
  const db = openDatabase(":memory:");
  assert.equal(db.driver, "sqlite");
  await run(db, "CREATE TABLE probe (id INTEGER PRIMARY KEY, name TEXT)");
  const inserted = await run(db, "INSERT INTO probe (name) VALUES (?)", ["x"]);
  assert.equal(inserted.changes, 1);
  assert.equal(inserted.lastId, 1);
});

test("paginated queries keep LIMIT placeholders working", async () => {
  const db = await createTestDatabase();
  await run(
    db,
    "INSERT INTO articles (slug, kind, title, summary, body, published_on, updated_at) VALUES ('a', 'post', 'A', '', '', '2026-01-01', 'now')"
  );
  const rows = await all(db, "SELECT slug FROM articles ORDER BY slug LIMIT ? OFFSET ?", [10, 0]);
  assert.deepEqual(
    rows.map((row) => row.slug),
    ["a"]
  );
});

test("CORS defaults to the production frontend origin and is overridable", async () => {
  const { loadConfig } = await import("../../src/config.js");
  assert.deepEqual(loadConfig({}).corsOrigins, ["https://blog.zhaotong.fun"]);
  assert.deepEqual(loadConfig({ CORS_ORIGINS: " https://blog.zhaotong.fun , http://localhost:5173 " }).corsOrigins, [
    "https://blog.zhaotong.fun",
    "http://localhost:5173"
  ]);
  assert.deepEqual(loadConfig({ CORS_ORIGINS: "" }).corsOrigins, ["https://blog.zhaotong.fun"]);
});

test("DB_PROFILE switches between the test and prod MySQL settings", async () => {
  const { loadConfig } = await import("../../src/config.js");
  const env = {
    MYSQL_TEST_HOST: "127.0.0.1",
    MYSQL_TEST_USER: "blog",
    MYSQL_TEST_PASSWORD: "test-secret",
    MYSQL_TEST_DATABASE: "shamingai_blog",
    MYSQL_PROD_HOST: "116.62.78.39",
    MYSQL_PROD_USER: "blog_prod",
    MYSQL_PROD_PASSWORD: "prod-secret",
    MYSQL_PROD_DATABASE: "prod"
  };
  const local = loadConfig(env).database;
  assert.equal(local.profile, "test");
  assert.equal(local.driver, "mysql");
  assert.deepEqual(local.mysql, { host: "127.0.0.1", port: 3306, user: "blog", password: "test-secret", database: "shamingai_blog" });

  const deployed = loadConfig({ ...env, DB_PROFILE: "prod" }).database;
  assert.equal(deployed.profile, "prod");
  assert.equal(deployed.mysql.host, "116.62.78.39");
  assert.equal(deployed.mysql.database, "prod");

  const fallback = loadConfig({ DB_PROFILE: "prod", DB_PATH: "/tmp/blog.db" }).database;
  assert.equal(fallback.driver, "sqlite");
  assert.equal(fallback.sqlitePath, "/tmp/blog.db");

  assert.throws(() => loadConfig({ DB_PROFILE: "staging" }), /DB_PROFILE/);
});

test("loadEnv reads the profile overlay from the env file's own directory", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cfg-"));
  await writeFile(path.join(dir, ".env"), "DB_PROFILE=test\nMYSQL_TEST_HOST=127.0.0.1\nMYSQL_TEST_USER=blog\nMYSQL_TEST_PASSWORD=a\n");
  await writeFile(path.join(dir, ".env.test"), "DB_PATH=/tmp/from-test-overlay.db\n");
  await writeFile(path.join(dir, ".env.prod"), "DB_PATH=/tmp/from-prod-overlay.db\n");
  const { loadEnv } = await import("../../src/config.js");

  const local = loadEnv(path.join(dir, ".env"), {});
  assert.equal(local.database.profile, "test");
  assert.equal(local.database.driver, "mysql");
  assert.equal(local.database.sqlitePath, "/tmp/from-test-overlay.db");

  const forced = loadEnv(path.join(dir, ".env"), { DB_PROFILE: "prod", MYSQL_PROD_HOST: "10.0.0.1", MYSQL_PROD_USER: "prod" });
  assert.equal(forced.database.profile, "prod");
  assert.equal(forced.database.sqlitePath, "/tmp/from-prod-overlay.db");

  const overridden = loadEnv(path.join(dir, ".env"), { DB_PROFILE: "test", DB_PATH: "/tmp/from-shell.db" });
  assert.equal(overridden.database.sqlitePath, "/tmp/from-shell.db");
});

test("cli honours ENV_FILE so a second config directory is not overlaid by the real one", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cfg-root-"));
  const scratch = await mkdtemp(path.join(tmpdir(), "cfg-scratch-"));
  await writeFile(path.join(root, ".env"), "PORT=8787\n");
  await writeFile(path.join(root, ".env.test"), "PORT=8787\nSCHEDULER=on\n");
  await writeFile(path.join(scratch, ".env"), "PORT=8788\n");
  await writeFile(path.join(scratch, ".env.test"), "SCHEDULER=off\n");
  const { loadConfig } = await import("../../src/config.js");

  assert.equal(loadConfig({ ENV_FILE: path.join(scratch, ".env"), PORT: "8787" }).port, 8787);

  const cli = spawnSync(process.execPath, ["--no-warnings", "-e", "import('./src/config.js').then(({ loadEnv }) => console.log(JSON.stringify({ port: loadEnv().port, scheduler: loadEnv().schedule.enabled })))"], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    env: { PATH: process.env.PATH, ENV_FILE: path.join(scratch, ".env") },
    encoding: "utf8"
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout), { port: 8788, scheduler: false });
});
