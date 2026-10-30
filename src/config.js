import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DEFAULT_CORS_ORIGINS = ["https://blog.zhaotong.fun"];

function stripComment(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return "";
  const quote = trimmed.search(/["']/);
  const hash = trimmed.indexOf("#");
  if (hash === -1 || (quote !== -1 && quote < hash)) return trimmed;
  return trimmed.slice(0, hash).trim();
}

export function readEnvFile(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return {};
  }
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const body = stripComment(line);
    if (!body) continue;
    const index = body.indexOf("=");
    if (index === -1) continue;
    const key = body.slice(0, index).trim();
    let value = body.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function absolute(value) {
  const expanded = value === "~" || value.startsWith("~/") ? path.join(homedir(), value.slice(1)) : value;
  return path.resolve(expanded);
}

const DB_PROFILES = { test: "MYSQL_TEST", prod: "MYSQL_PROD" };

function databaseConfig(env) {
  const profile = String(env.DB_PROFILE ?? "test").trim().toLowerCase();
  const prefix = DB_PROFILES[profile];
  if (!prefix) {
    throw new Error(`DB_PROFILE 只能是 ${Object.keys(DB_PROFILES).join(" / ")}，当前是 ${env.DB_PROFILE}`);
  }
  const host = env[`${prefix}_HOST`] ?? "";
  const user = env[`${prefix}_USER`] ?? "";
  const password = env[`${prefix}_PASSWORD`] ?? "";
  const database = env[`${prefix}_DATABASE`] ?? "";
  // 留空连接信息时回退到 SQLite 文件（DB_PATH），用于离线测试与本地快速试跑。
  const driver = host && user ? "mysql" : "sqlite";
  return {
    profile,
    driver,
    mysql: { host, port: Number(env[`${prefix}_PORT`] ?? 3306), user, password, database },
    sqlitePath: env.DB_PATH ? absolute(env.DB_PATH) : path.join(ROOT, "var", "blog.db")
  };
}

export function loadConfig(env = process.env) {
  const database = databaseConfig(env);
  return {
    port: Number(env.PORT ?? 8787),
    host: env.HOST ?? "127.0.0.1",
    database,
    siteRepoDir: env.SITE_REPO_DIR
      ? absolute(env.SITE_REPO_DIR)
      : env.CONTENT_REPO_DIR
        ? absolute(env.CONTENT_REPO_DIR)
        : "",
    apiToken: env.API_TOKEN ?? "",
    corsOrigins: env.CORS_ORIGINS
      ? env.CORS_ORIGINS.split(",").map((value) => value.trim()).filter(Boolean)
      : DEFAULT_CORS_ORIGINS,
    llm: {
      baseUrl: env.LLM_BASE_URL ?? "",
      apiKey: env.LLM_API_KEY ?? "",
      model: env.LLM_MODEL ?? "",
      timeoutMs: Number(env.LLM_TIMEOUT_MS ?? 120000)
    },
    schedule: {
      enabled: env.SCHEDULER !== "off",
      hour: Number(env.SCHEDULE_HOUR ?? 8),
      minute: Number(env.SCHEDULE_MINUTE ?? 0),
      timeZone: env.SCHEDULE_TIME_ZONE ?? "Asia/Shanghai"
    },
    logger: env.LOG_LEVEL !== "off",
    logLevel: env.LOG_LEVEL ?? "info",
    collection: {
      concurrency: Number(env.COLLECT_CONCURRENCY ?? 3),
      retries: Number(env.COLLECT_RETRIES ?? 1),
      timeoutMs: Number(env.COLLECT_TIMEOUT_MS ?? 15000)
    },
    linkCheck: {
      timeoutMs: Number(env.LINK_CHECK_TIMEOUT_MS ?? 8000)
    },
    digestSize: Number(env.DIGEST_SIZE ?? 10)
  };
}

export function loadEnv(envFile, environ = process.env) {
  const { ENV_FILE, ...overrides } = environ;
  const file = envFile ?? (ENV_FILE ? absolute(ENV_FILE) : path.join(ROOT, ".env"));
  const local = readEnvFile(file);
  // 只有显式设置 DB_PROFILE 时才叠加对应环境文件；默认用 test，避免误操作生产库。
  const profile = overrides.DB_PROFILE || local.DB_PROFILE || "test";
  const overlay = readEnvFile(path.join(path.dirname(file), `.env.${profile}`));
  return loadConfig({ ...local, ...overlay, ...overrides, DB_PROFILE: profile });
}
