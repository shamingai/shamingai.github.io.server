import { stat, access } from "node:fs/promises";
import path from "node:path";
import { get } from "../db.js";
import {
  getAbout,
  getDigest,
  getPost,
  listArchive,
  listCategories,
  listCategoryPosts,
  listDigests,
  listHistory,
  listPosts,
  listTagPosts,
  listTags,
  searchPosts
} from "../services/article.js";

async function contentDirState(siteRepoDir) {
  if (!siteRepoDir) return { status: "unconfigured", site_repo_dir: null, posts_dir: null };
  const postsDir = path.join(siteRepoDir, "blog", "content", "posts");
  try {
    const info = await stat(postsDir);
    if (!info.isDirectory()) return { status: "mismatch", site_repo_dir: siteRepoDir, posts_dir: postsDir };
    await access(postsDir);
    return { status: "ok", site_repo_dir: siteRepoDir, posts_dir: postsDir };
  } catch {
    return { status: "mismatch", site_repo_dir: siteRepoDir, posts_dir: postsDir };
  }
}

export async function readerRoutes(app, { db, config = {} }) {
  app.get("/api/health", async (_request, reply) => {
    const checks = { db: "ok", content_dir: "ok" };
    let lastSyncAt = null;
    try {
      lastSyncAt = (await get(db, "SELECT value FROM site_meta WHERE meta_key = 'last_sync_at'"))?.value ?? null;
    } catch {
      checks.db = "error";
    }
    const content = await contentDirState(config.siteRepoDir);
    if (content.status !== "ok") checks.content_dir = content.status;
    const ok = checks.db === "ok" && checks.content_dir === "ok";
    const body = {
      status: ok ? "ok" : "degraded",
      db: checks.db,
      content_dir: checks.content_dir,
      details: { content_dir: content },
      last_sync_at: lastSyncAt
    };
    return reply.code(ok ? 200 : 503).send(body);
  });

  app.get("/api/posts", async (request) => listPosts(db, request.query ?? {}));
  app.get("/api/posts/:slug", async (request) => getPost(db, request.params.slug));
  app.get("/api/archive", async (request) => listArchive(db, request.query ?? {}));
  app.get("/api/categories", async () => ({ items: await listCategories(db) }));
  app.get("/api/categories/:path/posts", async (request) =>
    listCategoryPosts(db, request.params.path, request.query ?? {})
  );
  app.get("/api/tags", async () => ({ items: await listTags(db) }));
  app.get("/api/tags/:name/posts", async (request) => listTagPosts(db, request.params.name, request.query ?? {}));
  app.get("/api/search", async (request) => searchPosts(db, request.query ?? {}));
  app.get("/api/about", async () => getAbout(db));
  app.get("/api/history", async () => listHistory(db));
  app.get("/api/digests", async (request) => listDigests(db, request.query ?? {}));
  app.get("/api/digests/:date", async (request) => getDigest(db, request.params.date));
}
