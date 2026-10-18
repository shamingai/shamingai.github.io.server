import cors from "@fastify/cors";
import Fastify from "fastify";
import { closeDatabase, run } from "./db.js";
import { ApiError } from "./errors.js";
import { adminRoutes } from "./routes/admin.js";
import { readerRoutes } from "./routes/reader.js";
import { collectAll } from "./services/collect.js";
import { GenerateError, finishRun, generateDigest, getRun, newRunId } from "./services/digest.js";
import { syncContent } from "./services/sync.js";

async function backgroundSync(db, config, runId) {
  const startedAt = new Date().toISOString();
  await run(db, "DELETE FROM runs WHERE run_id = ?", [runId]);
  await run(db, "INSERT INTO runs (run_id, kind, started_at) VALUES (?, 'sync', ?)", [runId, startedAt]);
  setImmediate(async () => {
    try {
      const result = await syncContent(db, config.siteRepoDir);
      await finishRun(db, runId, { outcome: "created", siteResults: [{ site_id: "content", status: "ok", collected: result.imported }] });
    } catch (error) {
      await finishRun(db, runId, { outcome: "failed", siteResults: [{ site_id: "content", status: "failed", collected: 0, error: error.message }] });
    }
  });
  return runId;
}

export function defaultDeps(config) {
  return {
    getRun,
    collectAll: (sites, options) => collectAll(sites, { ...config.collection, ...options }),
    startSync: (db) => backgroundSync(db, config, newRunId())
  };
}

export async function buildApp({ config, db, deps = {} }) {
  const app = Fastify({ logger: config.logger === false ? false : { level: config.logLevel ?? "info" }, bodyLimit: 256 * 1024 });
  const merged = { ...defaultDeps(config), ...deps };

  if (config.corsOrigins.length) {
    await app.register(cors, {
      origin: (origin, callback) => {
        if (!origin || config.corsOrigins.includes(origin)) callback(null, true);
        else callback(null, false);
      },
      methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"]
    });
  }

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError || error instanceof GenerateError) {
      const body = { error: { code: error.code, message: error.message } };
      if (error.extra) body.error.details = error.extra;
      return reply.code(error.statusCode).send(body);
    }
    if (error.statusCode && error.statusCode < 500) {
      const code = error.validation ? "invalid_request" : error.code ?? "bad_request";
      return reply.code(error.statusCode).send({ error: { code, message: error.message } });
    }
    request.log.error({ err: error }, "request failed");
    return reply.code(500).send({ error: { code: "internal_error", message: "服务器内部错误" } });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({ error: { code: "not_found", message: `没有这个接口：${request.method} ${request.url}` } })
  );

  app.addHook("onClose", async () => {
    if (deps.ownsDatabase) await closeDatabase(db);
  });

  await app.register(readerRoutes, { db, config });
  await app.register(adminRoutes, {
    config,
    db,
    deps: {
      ...merged,
      startSync: () => merged.startSync(db),
      // deps 里带 db 是为了让「生成 → 导出」这条链路的事务与默认依赖共用同一个连接池句柄。
      generate: (options = {}) => (merged.generateDigest ?? generateDigest)(db, config, { ...options, deps: { ...deps, db } })
    }
  });
  return app;
}
