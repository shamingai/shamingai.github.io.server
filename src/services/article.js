import { all, get } from "../db.js";
import { badRequest, notFound } from "../errors.js";

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 100;

export function readPositiveInt(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) return null;
  return number;
}

export function paging(query = {}, defaultPageSize = DEFAULT_PAGE_SIZE) {
  const page = readPositiveInt(query.page, 1);
  const pageSize = readPositiveInt(query.page_size, defaultPageSize);
  if (page === null) throw badRequest("invalid_page", "page 必须是正整数");
  if (pageSize === null || pageSize > MAX_PAGE_SIZE) {
    throw badRequest("invalid_page_size", `page_size 必须是 1 到 ${MAX_PAGE_SIZE} 之间的整数`);
  }
  return { page, pageSize };
}

export async function articlesByIds(db, slugs) {
  const rows = [];
  for (const slug of slugs) {
    const article = await articleQuery(db, slug);
    if (article) rows.push(article);
  }
  return rows;
}

async function articleQuery(db, slug) {
  const row = await get(
    db,
    `SELECT slug, kind, title, summary, summary_generated, category_path, published_on,
            word_count, reading_minutes
       FROM articles WHERE slug = ?`,
    [slug]
  );
  if (!row) return null;
  return listItem(db, row);
}

async function listItem(db, row) {
  const tags = (await all(db, "SELECT name FROM article_tags WHERE slug = ? ORDER BY position, name", [row.slug])).map(
    (tag) => tag.name
  );
  return {
    slug: row.slug,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    summary_generated: Boolean(row.summary_generated),
    category_path: row.category_path,
    published_on: row.published_on,
    word_count: row.word_count,
    reading_minutes: row.reading_minutes,
    tags
  };
}

function orderedRows(db, kind = null) {
  if (kind) {
    return all(
      db,
      `SELECT slug, kind, title, summary, summary_generated, category_path, published_on,
              word_count, reading_minutes
         FROM articles
        WHERE kind = ?
        ORDER BY published_on DESC, slug DESC`,
      [kind]
    );
  }
  return all(
    db,
    `SELECT slug, kind, title, summary, summary_generated, category_path, published_on,
            word_count, reading_minutes
       FROM articles
      ORDER BY published_on DESC, slug DESC`
  );
}

async function orderedSlugs(db, kind = null) {
  return (await orderedRows(db, kind)).map((row) => row.slug);
}

async function pageOf(db, slugs, { page, pageSize }) {
  const start = (page - 1) * pageSize;
  const slice = slugs.slice(start, start + pageSize);
  return {
    items: await articlesByIds(db, slice),
    total: slugs.length,
    page,
    page_size: pageSize,
    page_count: Math.max(1, Math.ceil(slugs.length / pageSize))
  };
}

const POST_KINDS = new Set(["all", "post", "digest"]);

export function readKind(query = {}) {
  const kind = query.kind === undefined || query.kind === "" ? "all" : String(query.kind);
  if (!POST_KINDS.has(kind)) throw badRequest("invalid_kind", "kind 只能是 all、post 或 digest");
  return kind;
}

// 首页是否同时展示资讯与文章，取决于资讯在全部内容里的占比：
// 今天刚开始写日记时，资讯只占首页少数位置；资讯归档多起来，它就自然回到按日期混排。
// 向上取整保证首页上资讯只要存在就至少有一个位置；资讯占比超过 3/4 时它会占一半。
export function digestQuota(digestCount, postCount, pageSize) {
  if (digestCount === 0) return 0;
  if (postCount === 0) return pageSize;
  const share = Math.ceil((pageSize * digestCount) / (digestCount + postCount));
  return Math.min(Math.max(1, share), Math.floor(pageSize / 2));
}

export function interleaveByDate(rows, pageSize) {
  const pools = {
    digest: rows.filter((row) => row.kind === "digest"),
    post: rows.filter((row) => row.kind !== "digest")
  };
  const quota = digestQuota(pools.digest.length, pools.post.length, pageSize);
  const taken = { digest: 0, post: 0 };
  const picked = [];
  const head = (side) => pools[side][taken[side]];
  while (taken.digest < pools.digest.length || taken.post < pools.post.length) {
    if (taken.post >= pools.post.length) {
      picked.push(head("digest"));
      taken.digest += 1;
      continue;
    }
    if (taken.digest >= pools.digest.length) {
      picked.push(head("post"));
      taken.post += 1;
      continue;
    }
    const position = picked.length + 1;
    const digestQuotaSoFar = Math.min(quota, Math.round((position * quota) / pageSize));
    // 日期更近的一侧先出；只有资讯还欠配额时才让文章顶上去。
    const front = head("digest").published_on >= head("post").published_on ? "digest" : "post";
    // 资讯的日期比下一次配额节拍还近时提前放出，保证它和同一天的文章挨在一起。
    const nextBeat = Math.round(((position + 1) * quota) / pageSize);
    const digestDue = taken.digest >= digestQuotaSoFar && nextBeat > digestQuotaSoFar;
    const side = front === "digest" && !digestDue ? "digest" : "post";
    picked.push(head(side));
    taken[side] += 1;
  }
  return picked;
}

// 首页列表：资讯博客和其他文章都进入列表，按日期和份额混排。
// 只按日期排时，每日资讯永远最新，会把首页整页占满，用户就“只看到资讯、看不到文章”。
export async function listPosts(db, query) {
  const { page, pageSize } = paging(query);
  const kind = readKind(query);
  const rows = await orderedRows(db, kind === "all" ? null : kind);
  const ordered = kind === "all" ? interleaveByDate(rows, pageSize) : rows;
  return pageOf(db, ordered.map((row) => row.slug), { page, pageSize });
}

export async function neighborOf(db, slug) {
  const slugs = await orderedSlugs(db);
  const index = slugs.indexOf(slug);
  if (index === -1) return { previous: null, next: null };
  const brief = async (neighbor) => {
    if (!neighbor) return null;
    const row = await get(db, "SELECT slug, title FROM articles WHERE slug = ?", [neighbor]);
    return row ? { slug: row.slug, title: row.title } : null;
  };
  return { previous: await brief(slugs[index - 1]), next: await brief(slugs[index + 1]) };
}

export async function getPost(db, slug) {
  const item = await articleQuery(db, slug);
  if (!item) throw notFound("post_not_found", "文章不存在");
  const row = await get(db, "SELECT body FROM articles WHERE slug = ?", [slug]);
  const headings = (await all(db, "SELECT level, text, anchor FROM headings WHERE slug = ? ORDER BY position", [slug])).map(
    (heading) => ({ level: heading.level, text: heading.text, anchor: heading.anchor })
  );
  const neighbors = await neighborOf(db, slug);
  return { ...item, headings, body: row.body, previous: neighbors.previous, next: neighbors.next };
}

export async function listArchive(db, query) {
  const { page, pageSize } = paging(query);
  const ascending = (await orderedRows(db)).reverse();
  const slugs = ascending.map((row) => row.slug);
  const years = [];
  for (const row of ascending) {
    const name = row.published_on.slice(0, 4);
    const last = years[years.length - 1];
    if (last && last.name === name) last.articles.push(row.slug);
    else years.push({ name, articles: [row.slug] });
  }
  const result = await pageOf(db, slugs, { page, pageSize });
  return {
    total: result.total,
    page: result.page,
    page_size: result.page_size,
    years: await Promise.all(
      years.map(async (year) => ({ name: year.name, articles: await articlesByIds(db, year.articles) }))
    ),
    items: result.items
  };
}

function compareNames(left, right) {
  return left.localeCompare(right, "zh-Hans-CN");
}

function parentOf(path) {
  const separator = path.lastIndexOf(" / ");
  return separator === -1 ? null : path.slice(0, separator);
}

export async function listCategories(db) {
  const counts = new Map();
  for (const row of await all(db, "SELECT category_path FROM articles WHERE category_path IS NOT NULL")) {
    counts.set(row.category_path, (counts.get(row.category_path) ?? 0) + 1);
    for (let parent = parentOf(row.category_path); parent; parent = parentOf(parent)) {
      if (!counts.has(parent)) counts.set(parent, 0);
    }
  }
  return [...counts.keys()]
    .sort(compareNames)
    .map((path) => ({ name: path, path, parent: parentOf(path), article_count: counts.get(path), children: [] }));
}

export async function listCategoryPosts(db, categoryPath, query) {
  const slugs = (await orderedRows(db)).filter((row) => row.category_path === categoryPath).map((row) => row.slug);
  return pageOf(db, slugs, paging(query));
}

export async function listTags(db) {
  const counts = await all(db, "SELECT name, COUNT(*) AS count FROM article_tags GROUP BY name");
  return counts
    .map((row) => ({ name: row.name, article_count: Number(row.count) }))
    .sort((left, right) => compareNames(left.name, right.name));
}

export async function listTagPosts(db, name, query) {
  const slugs = (await all(db, "SELECT slug FROM article_tags WHERE name = ?", [name])).map((row) => row.slug);
  const wanted = new Set(slugs);
  const ordered = (await orderedSlugs(db)).filter((slug) => wanted.has(slug));
  return pageOf(db, ordered, paging(query));
}

function likePattern(value) {
  return `%${value.replace(/[!%_]/g, (char) => `!${char}`)}%`;
}

function excerptOf(body, keyword) {
  const text = String(body ?? "");
  const index = text.toLocaleLowerCase().indexOf(keyword);
  if (index === -1) return "";
  const start = Math.max(0, index - 40);
  const sliced = text.slice(start, start + 120).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${sliced}${start + 120 < text.length ? "…" : ""}`;
}

export async function searchPosts(db, query) {
  const keyword = String(query.q ?? "").trim();
  if (!keyword) throw badRequest("empty_query", "请输入搜索关键词");
  const { page, pageSize } = paging(query);
  const pattern = likePattern(keyword.toLocaleLowerCase());
  const rows = await all(
    db,
    `SELECT slug, body FROM articles
      WHERE lower(title) LIKE ? ESCAPE '!' OR lower(summary) LIKE ? ESCAPE '!' OR lower(body) LIKE ? ESCAPE '!'
      ORDER BY published_on DESC, slug DESC`,
    [pattern, pattern, pattern]
  );
  const bodies = new Map(rows.map((row) => [row.slug, row.body]));
  const result = await pageOf(db, rows.map((row) => row.slug), { page, pageSize });
  const items = result.items.map((item) => ({ ...item, excerpt: excerptOf(bodies.get(item.slug), keyword.toLocaleLowerCase()) }));
  return { items, total: rows.length, page, page_size: pageSize };
}

export async function getAbout(db) {
  const row = await get(db, "SELECT value FROM site_meta WHERE meta_key = 'about'");
  if (!row || !row.value.trim()) throw notFound("about_not_written", "还没有写关于");
  return { about: row.value };
}

export async function listHistory(db) {
  const rows = await all(db, "SELECT occurred_on, text, article_slug FROM history_entries ORDER BY occurred_on DESC, position ASC");
  return {
    items: rows.map((row) => ({ date: row.occurred_on, text: row.text, articleId: row.article_slug }))
  };
}

export async function listDigests(db, query) {
  const { page, pageSize } = paging(query);
  const total = Number((await get(db, "SELECT COUNT(*) AS n FROM digests")).n);
  const rows = await all(
    db,
    "SELECT digest_date, slug, title, item_count, status, generated_at FROM digests ORDER BY digest_date DESC LIMIT ? OFFSET ?",
    [pageSize, (page - 1) * pageSize]
  );
  return {
    items: rows.map((row) => ({
      date: row.digest_date,
      slug: row.slug,
      title: row.title,
      item_count: row.item_count,
      status: row.status,
      generated_at: row.generated_at
    })),
    total,
    page,
    page_size: pageSize
  };
}

export async function getDigest(db, date) {
  const row = await get(
    db,
    "SELECT digest_date, slug, title, item_count, note, status, generated_at FROM digests WHERE digest_date = ?",
    [date]
  );
  if (!row) throw notFound("digest_not_found", "这一天没有资讯博客");
  const items = await all(
    db,
    `SELECT rank_no, url, title, site_id, site_name, site_rank, mention_count, summary, reason, published_at
       FROM picked_items WHERE digest_date = ? ORDER BY rank_no`,
    [date]
  );
  return {
    date: row.digest_date,
    slug: row.slug,
    title: row.title,
    item_count: row.item_count,
    note: row.note,
    status: row.status,
    generated_at: row.generated_at,
    items: items.map(({ rank_no, ...item }) => ({ rank: rank_no, ...item }))
  };
}
