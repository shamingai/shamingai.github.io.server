import * as cheerio from "cheerio";
import { all } from "../db.js";
import { adapterOf } from "../sources/index.js";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

async function readBody(response) {
  const text = await response.text();
  const type = response.headers.get("content-type") ?? "";
  const trimmed = text.trim();
  if (type.includes("json") || trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return { text, json: JSON.parse(trimmed) };
    } catch {
      return { text, json: null };
    }
  }
  return { text, json: null };
}

function describe(error) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return "请求超时";
  return error?.message || String(error);
}

export async function collectSite(site, options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const adapter = adapterOf(site.adapter);
  if (!adapter) {
    return { site_id: site.id, status: "failed", collected: 0, error: `未知适配器 ${site.adapter}` };
  }
  const retries = options.retries ?? 1;
  let lastError = "";
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchImpl(site.hot_list_url, {
        headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/json;q=0.9,*/*;q=0.8" },
        redirect: "follow",
        signal: AbortSignal.timeout(options.timeoutMs ?? 15000)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const { text, json } = await readBody(response);
      const candidates = await adapter({
        site,
        text,
        json,
        $: cheerio.load(text),
        fetch: fetchImpl,
        timeoutMs: options.timeoutMs ?? 15000
      });
      if (!candidates.length) throw new Error("热榜页面没有解析出条目（可能已改版或受限）");
      return { site_id: site.id, status: "ok", collected: candidates.length, error: null, candidates };
    } catch (error) {
      lastError = describe(error);
    }
  }
  return { site_id: site.id, status: "failed", collected: 0, error: lastError };
}

export async function collectAll(sites, options = {}) {
  const concurrency = Math.max(1, options.concurrency ?? 3);
  const results = [];
  let cursor = 0;
  async function worker() {
    while (cursor < sites.length) {
      const site = sites[cursor];
      cursor += 1;
      results.push(await collectSite(site, options));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, sites.length) }, worker));
  const order = new Map(sites.map((site, index) => [site.id, index]));
  results.sort((left, right) => order.get(left.site_id) - order.get(right.site_id));
  return results;
}

export function enabledSites(db) {
  return all(
    db,
    "SELECT id, name, home_url, hot_list_url, adapter, weight, max_candidates FROM source_sites WHERE enabled = 1 ORDER BY id"
  ).then((rows) => rows.map((row) => ({ ...row, weight: Number(row.weight), max_candidates: Number(row.max_candidates) })));
}
