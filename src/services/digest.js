import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { get, run, transaction } from "../db.js";
import { createOpenAiClient, editCandidate, limitText } from "../llm/client.js";
import { collectAll, enabledSites } from "./collect.js";
import { filterReachable } from "./link-check.js";
import { mergeCandidates } from "./rank.js";
import { headingsOf, todayInShanghai } from "./sync.js";
import { DIGEST_CATEGORY, DIGEST_TAG, digestSlug, digestSummary, digestTitle, renderDigest } from "./render.js";

export class GenerateError extends Error {
  constructor(statusCode, code, message, extra) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.extra = extra;
  }
}

let sequence = 0;
export function newRunId(now = new Date()) {
  sequence = (sequence + 1) % 1000;
  return `run-${now.toISOString().replace(/[-:.TZ]/g, "")}-${String(sequence).padStart(3, "0")}`;
}

export function digestFile(siteRepoDir, date) {
  return path.join(siteRepoDir, "blog", "content", "posts", `${digestSlug(date)}.md`);
}

function defaultDeps(config) {
  const llm = config.llm ?? {};
  return {
    collect: (sites, options) => collectAll(sites, { ...config.collection, ...options }),
    fetch: globalThis.fetch,
    linkCheck: { fetch: globalThis.fetch, timeoutMs: config.linkCheck?.timeoutMs ?? 8000 },
    llm: createOpenAiClient(llm),
    log: (level, message) => {
      const line = `[digest] ${message}`;
      if (level === "warn") console.warn(line);
      else console.log(line);
    }
  };
}

function reasonOf(error) {
  return error?.message || String(error);
}

export async function startRun(db, kind, now = new Date().toISOString()) {
  const runId = newRunId(new Date(now));
  await run(db, "INSERT INTO runs (run_id, kind, started_at, site_results, dropped) VALUES (?, ?, ?, ?, ?)", [runId, kind, now, "[]", "[]"]);
  return runId;
}

export async function finishRun(db, runId, { siteResults = [], dropped = [], outcome }, now = new Date().toISOString()) {
  await run(db, "UPDATE runs SET finished_at = ?, site_results = ?, dropped = ?, outcome = ? WHERE run_id = ?", [
    now,
    JSON.stringify(siteResults),
    JSON.stringify(dropped),
    outcome,
    runId
  ]);
}
export async function getRun(db, runId) {
  if (!runId) return null;
  const row = await get(db, "SELECT * FROM runs WHERE run_id = ?", [runId]);
  if (!row) return null;
  return {
    run_id: row.run_id,
    kind: row.kind,
    started_at: row.started_at,
    finished_at: row.finished_at,
    site_results: JSON.parse(row.site_results),
    dropped: JSON.parse(row.dropped),
    outcome: row.outcome
  };
}

export async function digestExists(db, date) {
  return Boolean(await get(db, "SELECT 1 AS found FROM digests WHERE digest_date = ?", [date]));
}

export async function generateDigest(db, config, { deps: overrides, ...options }) {
  const { date = todayInShanghai(), regenerate = false, dryRun = false, kind = "manual", now = new Date() } = options;
  const deps = { ...defaultDeps(config), ...(overrides ?? {}) };
  const startedAt = now.toISOString();
  const runId = await startRun(db, regenerate ? "regenerate" : kind, startedAt);
  const report = { site_results: [], dropped: [] };

  try {
    if ((await digestExists(db, date)) && !regenerate) {
      await finishRun(db, runId, { siteResults: report.site_results, dropped: report.dropped, outcome: "skipped_existing" });
      throw new GenerateError(409, "duplicate_date", `${date} 已有资讯博客；如需替换请传 regenerate: true`, { run_id: runId });
    }
    const sites = await enabledSites(db);
    if (!sites.length) {
      throw new GenerateError(422, "insufficient_content", "站点清单为空，未启用任何来源站点", { run_id: runId });
    }

    const weights = new Map(sites.map((site) => [site.id, site.weight]));
    const collected = await deps.collect(sites, { fetch: deps.fetch });
    report.site_results = collected.map((result) => ({
      site_id: result.site_id,
      status: result.status,
      collected: result.collected,
      error: result.error ?? null,
      hot_list_url: result.hot_list_url ?? null
    }));
    for (const result of report.site_results.filter((item) => item.status === "failed")) {
      deps.log?.("warn", `来源站点 ${result.site_id} 采集失败：${result.error ?? "未知原因"}`);
    }
    const live = collected.map((result) => ({ ...result, site_name: sites.find((site) => site.id === result.site_id)?.name }));

    const ranked = mergeCandidates(live, weights);
    if (!ranked.length) {
      const failures = report.site_results.filter((result) => result.status === "failed").length;
      await finishRun(db, runId, { siteResults: report.site_results, dropped: report.dropped, outcome: "failed" });
      throw new GenerateError(
        422,
        "insufficient_content",
        failures === sites.length ? "所有来源站点采集失败" : "采集到的候选条目均不可用",
        { run_id: runId, site_results: report.site_results }
      );
    }

    if (!deps.llm) {
      await finishRun(db, runId, { siteResults: report.site_results, dropped: report.dropped, outcome: "failed" });
      throw new GenerateError(503, "llm_not_configured", "未配置语言模型（LLM_BASE_URL / LLM_MODEL）", { run_id: runId });
    }

    const picked = [];
    const checked = [];
    let cursor = 0;
    const size = config.digestSize;
    while (picked.length < size && cursor < ranked.length) {
      const batch = ranked.slice(cursor, cursor + size);
      cursor += batch.length;
      for (const candidate of batch) {
        try {
          checked.push({ ...candidate, ...(await editCandidate(deps.llm, candidate)) });
        } catch (error) {
          report.dropped.push({ url: candidate.url, title: candidate.title, reason: `无法可靠生成摘要：${reasonOf(error)}` });
        }
      }
      if (checked.length) {
        const { accepted, rejected } = await filterReachable(checked, deps.linkCheck);
        checked.length = 0;
        picked.push(...accepted);
        report.dropped.push(...rejected);
      }
    }

    if (!picked.length) {
      await finishRun(db, runId, { siteResults: report.site_results, dropped: report.dropped, outcome: "failed" });
      throw new GenerateError(422, "insufficient_content", "没有通过校验与链接检查的条目，未生成博客", { run_id: runId });
    }

    const note = picked.length < size ? `本次只收录 ${picked.length} 条：${describeShortfall(report)}。` : null;
    const regenerated = await digestExists(db, date);
    const summary = digestSummary(date, picked);
    const title = digestTitle(date);
    const file = digestFile(config.siteRepoDir, date);
    const markdown = renderDigest({ date, title: digestTitle(date), summary, items: picked, note });
    const relativePath = path.relative(config.siteRepoDir, file);
    const status = regenerated ? "replaced" : "generated";
    if (dryRun) {
      await finishRun(db, runId, { siteResults: report.site_results, dropped: report.dropped, outcome: "dry_run" });
      return {
        run_id: runId,
        date,
        slug: digestSlug(date),
        item_count: picked.length,
        note,
        status,
        dry_run: true,
        markdown_path: relativePath,
        site_results: report.site_results,
        dropped: report.dropped,
        markdown
      };
    }
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, markdown, "utf8");

    const updatedAt = new Date().toISOString();
    await transaction(db, async (tx) => {
      await upsertDigestArticle(tx, { date, title, summary, body: markdown, updatedAt });
      await run(tx, "DELETE FROM picked_items WHERE digest_date = ?", [date]);
      await run(tx, "DELETE FROM digests WHERE digest_date = ?", [date]);
      await run(
        tx,
        `INSERT INTO digests (digest_date, slug, title, item_count, note, status, generated_at, markdown_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [date, digestSlug(date), title, picked.length, note, status, updatedAt, relativePath]
      );
      for (const [index, item] of picked.entries()) {
        await run(
          tx,
          `INSERT INTO picked_items (digest_date, rank_no, url, title, site_id, site_name, site_rank, mention_count, summary, reason, published_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            date,
            index + 1,
            item.url,
            limitText(item.title, 120),
            item.siteId,
            item.siteName,
            item.siteRank,
            item.mentionCount,
            item.summary,
            item.reason,
            item.publishedAt
          ]
        );
      }
    });
    await finishRun(db, runId, { siteResults: report.site_results, dropped: report.dropped, outcome: "created" });
    return {
      run_id: runId,
      date,
      slug: digestSlug(date),
      item_count: picked.length,
      note,
      status,
      markdown_path: relativePath,
      site_results: report.site_results,
      dropped: report.dropped
    };
  } catch (error) {
    if (error instanceof GenerateError) throw error;
    await finishRun(db, runId, { siteResults: report.site_results, dropped: report.dropped, outcome: "failed" });
    throw new GenerateError(500, "generate_failed", `生成失败：${reasonOf(error)}`, { run_id: runId });
  }
}

export async function upsertDigestArticle(db, { date, title, summary, body, updatedAt }) {
  const slug = digestSlug(date);
  const words = String(body ?? "").replace(/\s+/g, "").length;
  await run(
    db,
    `INSERT INTO articles (slug, kind, title, summary, summary_generated, body, category_path, published_on, word_count, reading_minutes, updated_at)
     VALUES (?, 'digest', ?, ?, 1, ?, ?, ?, ?, ?, ?) AS incoming
     ON DUPLICATE KEY UPDATE
       title = incoming.title, summary = incoming.summary, summary_generated = incoming.summary_generated,
       body = incoming.body, category_path = incoming.category_path, published_on = incoming.published_on,
       word_count = incoming.word_count, reading_minutes = incoming.reading_minutes, updated_at = incoming.updated_at`,
    [slug, title, summary, body, DIGEST_CATEGORY, date, words, Math.max(1, Math.ceil(words / 400)), updatedAt]
  );
  await run(db, "DELETE FROM article_tags WHERE slug = ?", [slug]);
  await run(db, "INSERT INTO article_tags (slug, name, position) VALUES (?, ?, ?)", [slug, DIGEST_TAG, 0]);
  await run(db, "DELETE FROM headings WHERE slug = ?", [slug]);
  for (const [index, heading] of headingsOf(body).entries()) {
    await run(db, "INSERT INTO headings (slug, position, level, text, anchor) VALUES (?, ?, ?, ?, ?)", [
      slug,
      index,
      heading.level,
      heading.text,
      heading.anchor
    ]);
  }
  return slug;
}

function describeShortfall(report) {
  const failed = report.site_results.filter((result) => result.status === "failed");
  const parts = [];
  if (failed.length) {
    parts.push(`${failed.length} 个站点采集失败（${failed.map((item) => item.site_id).join("、")}），请检查来源地址是否仍可访问`);
  }
  if (report.dropped.length) parts.push(`${report.dropped.length} 条未通过内容校验或链接检查`);
  if (!parts.length) parts.push("可用热点不足十条，可启用更多来源站点后重新生成");
  return parts.join("；");
}

export async function readDigestMarkdown(config, date) {
  return readFile(digestFile(config.siteRepoDir, date), "utf8");
}
