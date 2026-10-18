import { all, get, run } from "../db.js";
import { ApiError, badRequest, conflict, notFound } from "../errors.js";
import { adapterKeys } from "../sources/index.js";
import { todayInShanghai } from "../services/sync.js";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[a-z0-9][a-z0-9-]{1,63}$/;

export function toSite(row) {
  return {
    id: row.id,
    name: row.name,
    home_url: row.home_url,
    hot_list_url: row.hot_list_url,
    adapter: row.adapter,
    weight: Number(row.weight),
    max_candidates: Number(row.max_candidates),
    enabled: Boolean(row.enabled),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

async function readSite(db, id) {
  const row = await get(db, "SELECT * FROM source_sites WHERE id = ?", [id]);
  if (!row) throw notFound("site_not_found", "来源站点不存在");
  return row;
}

function httpUrl(value, field) {
  try {
    const url = new URL(String(value ?? ""));
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("protocol");
    return url.href;
  } catch {
    throw badRequest("invalid_site", `${field} 必须是 http(s) 地址`);
  }
}

function writeSite(db, body, existing = {}) {
  const id = existing.id ?? body.id;
  if (!ID.test(String(id ?? ""))) throw badRequest("invalid_site", "id 只能包含小写字母、数字和连字符");
  const name = String(body.name ?? existing.name ?? "").trim();
  if (!name) throw badRequest("invalid_site", "name 不能为空");
  const adapter = String(body.adapter ?? existing.adapter ?? "");
  if (!adapterKeys.includes(adapter)) {
    throw badRequest("invalid_adapter", `未知适配器 ${adapter || "(空)"}；可用：${adapterKeys.join("、")}`);
  }
  const weight = Number(body.weight ?? existing.weight ?? 1);
  if (!Number.isFinite(weight) || weight < 0) throw badRequest("invalid_site", "weight 必须是非负数");
  const maxCandidates = Number(body.max_candidates ?? existing.max_candidates ?? 20);
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 100) {
    throw badRequest("invalid_site", "max_candidates 必须是 1 到 100 的整数");
  }
  const enabled = body.enabled === undefined ? (existing.enabled ?? 1) : body.enabled ? 1 : 0;
  return {
    id,
    name,
    home_url: body.home_url === undefined && existing.home_url ? existing.home_url : httpUrl(body.home_url, "home_url"),
    hot_list_url:
      body.hot_list_url === undefined && existing.hot_list_url
        ? existing.hot_list_url
        : httpUrl(body.hot_list_url, "hot_list_url"),
    adapter,
    weight,
    max_candidates: maxCandidates,
    enabled
  };
}

function compactSql(body) {
  const assignments = Object.entries(body)
    .filter(([key]) => key !== "id")
    .map(([key]) => `${key} = ?`);
  return { sql: assignments.join(", "), values: Object.entries(body).filter(([key]) => key !== "id").map(([, value]) => value) };
}

export async function adminRoutes(app, { db, config, deps }) {
  app.addHook("onRequest", async (request) => {
    const pathname = request.url.split("?")[0];
    const protectedRoute =
      ((request.method !== "GET" && request.method !== "HEAD") &&
        (pathname === "/api/source-sites" || pathname.startsWith("/api/source-sites/"))) ||
      pathname === "/api/content-syncs" || pathname === "/api/digests" || pathname.startsWith("/api/runs/");
    if (!protectedRoute) return;
    if (!config.apiToken) {
      throw new ApiError(503, "admin_disabled", "未配置 API_TOKEN，管理接口已停用");
    }
    const header = request.headers.authorization ?? "";
    if (header !== `Bearer ${config.apiToken}`) {
      throw new ApiError(401, "unauthorized", "需要有效的管理令牌");
    }
  });

  app.get("/api/source-sites", async () => ({
    items: (await all(db, "SELECT * FROM source_sites ORDER BY id")).map(toSite)
  }));

  app.post("/api/source-sites", async (request, reply) => {
    const site = writeSite(db, request.body ?? {});
    if (await get(db, "SELECT 1 AS found FROM source_sites WHERE id = ?", [site.id])) {
      throw conflict("site_exists", `来源站点 ${site.id} 已存在`);
    }
    const now = new Date().toISOString();
    await run(
      db,
      `INSERT INTO source_sites (id, name, home_url, hot_list_url, adapter, weight, max_candidates, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [site.id, site.name, site.home_url, site.hot_list_url, site.adapter, site.weight, site.max_candidates, site.enabled, now, now]
    );
    return reply.code(201).send(toSite(await readSite(db, site.id)));
  });

  app.patch("/api/source-sites/:id", async (request) => {
    const existing = await readSite(db, request.params.id);
    const merged = writeSite(db, request.body ?? {}, existing);
    const { sql, values } = compactSql({ ...merged, updated_at: new Date().toISOString() });
    await run(db, `UPDATE source_sites SET ${sql} WHERE id = ?`, [...values, existing.id]);
    return toSite(await readSite(db, existing.id));
  });

  app.delete("/api/source-sites/:id", async (request, reply) => {
    await readSite(db, request.params.id);
    await run(db, "DELETE FROM source_sites WHERE id = ?", [request.params.id]);
    return reply.code(204).send();
  });

  app.post("/api/content-syncs", async (_request, reply) => {
    const runId = deps.startSync();
    return reply.code(202).send({ run_id: runId });
  });

  app.post("/api/digests", async (request, reply) => {
    const body = request.body ?? {};
    const date = body.date ?? todayInShanghai();
    if (!DATE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
      throw badRequest("invalid_date", "date 必须是 YYYY-MM-DD");
    }
    const result = await deps.generate({ date, regenerate: Boolean(body.regenerate), kind: "manual" });
    return reply.code(result.status === "replaced" ? 200 : 201).send({
      run_id: result.run_id,
      date: result.date,
      slug: result.slug,
      item_count: result.item_count,
      note: result.note,
      status: result.status,
      markdown_path: result.markdown_path,
      site_results: result.site_results,
      dropped: result.dropped
    });
  });

  app.get("/api/runs/:runId", async (request) => {
    const run = await deps.getRun(db, request.params.runId);
    if (!run) throw notFound("run_not_found", "没有这次运行记录");
    return run;
  });
}
