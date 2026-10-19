import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { all, get, run, transaction } from "../db.js";

const DIGEST_PREFIX = "daily-";

export async function readContentDir(siteRepoDir) {
  const contentDir = path.join(siteRepoDir, "blog", "content");
  const site = JSON.parse(await readFile(path.join(contentDir, "site.json"), "utf8"));
  const postsDir = path.join(contentDir, "posts");
  const names = (await readdir(postsDir).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  })).filter((name) => name.endsWith(".md")).sort();
  const posts = await Promise.all(
    names.map(async (name) => ({
      id: name.replace(/\.md$/, ""),
      text: await readFile(path.join(postsDir, name), "utf8")
    }))
  );
  return { site, posts };
}

export function parsePost(id, text) {
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  const title = (lines[0] ?? "").trim();
  const directives = {};
  let index = 1;
  while (lines[index] !== undefined && lines[index].trim() === "") index += 1;
  for (; index < lines.length; index += 1) {
    const match = /^([a-z_]+):\s*(.*)$/.exec(lines[index].trim());
    if (!match) break;
    directives[match[1]] = match[2].trim();
  }
  if (Object.keys(directives).length === 0) {
    const blank = lines.indexOf("", 1);
    index = blank === -1 ? lines.length : blank;
  }
  return {
    slug: id,
    title,
    body: lines.slice(index).join("\n").trim(),
    kind: id.startsWith(DIGEST_PREFIX) ? "digest" : "post",
    directives
  };
}

// 锚点与前端 contentBlocks 用同一规则（tests/unit/sync.test.js 与 blog/app/tests/article-page.test.js 各钉了一份）：
// 转小写，非字母数字的连续片段折成 "-"。中文按字母处理会原样保留，标题 "3. HRV：…" 得到 "hrv" 这样的合法 id。
export function anchorOf(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "") || "section";
}

export function headingsOf(body) {
  const seen = new Map();
  return String(body ?? "")
    .split(/\r?\n/)
    .map((line) => /^(#{2,6})\s+(\S.*?)\s*$/.exec(line))
    .filter(Boolean)
    .map((match) => {
      const base = anchorOf(match[2]);
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      return { level: match[1].length, text: match[2], anchor: count ? `${base}-${count + 1}` : base };
    });
}

export function firstParagraph(body) {
  return (
    String(body ?? "")
      .replace(/^#+\s+.*$/gm, "")
      .split(/\n{2,}/)
      .map((block) => block.trim())
      .find(Boolean) ?? ""
  );
}

export function bodyText(body) {
  return String(body ?? "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
}

function summaryOf(body) {
  return bodyText(firstParagraph(body)).replace(/\s+/g, " ").slice(0, 120);
}

export function todayInShanghai(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function tagsOf(post) {
  if (post.kind !== "digest") return [];
  const suffix = /\]\s*(.+)$/.exec(post.title)?.[1] ?? "";
  return ["资讯", ...suffix.split(/[,，、·]/).map((tag) => tag.trim()).filter(Boolean)];
}

async function upsertArticle(db, article, now) {
  const words = bodyText(article.body).replace(/\s+/g, "").length;
  await run(
    db,
    `INSERT INTO articles (slug, kind, title, summary, summary_generated, body, category_path, published_on, word_count, reading_minutes, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) AS incoming
     ON DUPLICATE KEY UPDATE
       kind = incoming.kind, title = incoming.title, summary = incoming.summary,
       summary_generated = incoming.summary_generated, body = incoming.body,
       category_path = incoming.category_path, published_on = incoming.published_on,
       word_count = incoming.word_count, reading_minutes = incoming.reading_minutes,
       updated_at = incoming.updated_at`,
    [
      article.slug,
      article.kind,
      article.title,
      article.summary,
      article.summaryGenerated ? 1 : 0,
      article.body,
      article.category ?? null,
      article.publishedOn,
      words,
      Math.max(1, Math.ceil(words / 400)),
      now
    ]
  );
  await run(db, "DELETE FROM article_tags WHERE slug = ?", [article.slug]);
  for (const [index, name] of [...new Set(article.tags ?? [])].entries()) {
    await run(db, "INSERT INTO article_tags (slug, name, position) VALUES (?, ?, ?)", [article.slug, name, index]);
  }
  await run(db, "DELETE FROM headings WHERE slug = ?", [article.slug]);
  for (const [index, heading] of headingsOf(article.body).entries()) {
    await run(db, "INSERT INTO headings (slug, position, level, text, anchor) VALUES (?, ?, ?, ?, ?)", [
      article.slug,
      index,
      heading.level,
      heading.text,
      heading.anchor
    ]);
  }
}

export async function syncContent(db, siteRepoDir, now = new Date().toISOString()) {
  if (!siteRepoDir) throw new Error("SITE_REPO_DIR 未配置");
  const { site, posts } = await readContentDir(siteRepoDir);
  const syncedOn = todayInShanghai(new Date(now));
  return transaction(db, async (db) => {
    const fromRepository = new Set();
    for (const raw of posts) {
      const post = parsePost(raw.id, raw.text);
      const summary = post.directives.summary ?? summaryOf(post.body);
      await upsertArticle(
        db,
        {
          slug: post.slug,
          kind: post.kind,
          title: post.title,
          summary,
          summaryGenerated: post.directives.summary ? 0 : 1,
          body: post.body,
          category: post.directives.category ?? (post.kind === "digest" ? "资讯" : null),
          publishedOn: post.directives.date ?? syncedOn,
          tags: post.directives.tags
            ? post.directives.tags.split(/[,，、·]/).map((tag) => tag.trim()).filter(Boolean)
            : tagsOf(post)
        },
        now
      );
      fromRepository.add(post.slug);
    }

    const existingDigests = new Set((await all(db, "SELECT slug FROM digests")).map((row) => row.slug));
    for (const row of await all(db, "SELECT slug FROM articles")) {
      if (fromRepository.has(row.slug) || existingDigests.has(row.slug)) continue;
      await run(db, "DELETE FROM articles WHERE slug = ?", [row.slug]);
    }
    for (const slug of existingDigests) {
      if (!fromRepository.has(slug)) await run(db, "DELETE FROM digests WHERE slug = ?", [slug]);
    }

    for (const article of site.articles ?? []) {
      if (fromRepository.has(article.id)) continue;
      fromRepository.add(article.id);
      const body = article.body ?? "";
      await upsertArticle(
        db,
        {
          slug: article.id,
          kind: "post",
          title: article.title,
          summary: article.summary ?? summaryOf(body),
          summaryGenerated: article.summary ? 0 : 1,
          body,
          category: article.category,
          publishedOn: article.publishedOn,
          tags: article.tags ?? []
        },
        now
      );
    }

    await run(db, "DELETE FROM history_entries");
    for (const [index, entry] of (site.history ?? []).entries()) {
      await run(db, "INSERT INTO history_entries (position, occurred_on, text, article_slug) VALUES (?, ?, ?, ?)", [
        index,
        entry.date,
        entry.text,
        entry.articleId && fromRepository.has(entry.articleId) ? entry.articleId : null
      ]);
    }
    await setMeta(db, "about", site.about ?? "");
    await setMeta(db, "last_sync_at", now);
    return { imported: fromRepository.size };
  });
}

export async function setMeta(db, key, value) {
  await run(db, "INSERT INTO site_meta (meta_key, value) VALUES (?, ?) AS incoming ON DUPLICATE KEY UPDATE value = incoming.value", [
    key,
    value
  ]);
}

export { DIGEST_PREFIX };
