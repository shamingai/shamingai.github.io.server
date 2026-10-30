import { loadEnv } from "./config.js";
import { closeDatabase, migrate } from "./db.js";
import { GenerateError, generateDigest, getRun } from "./services/digest.js";
import { syncContent, todayInShanghai } from "./services/sync.js";
import { seedSites, upgradeSiteUrls } from "./sources/index.js";

const USAGE = `用法：node src/cli.js <命令> [选项]

命令：
  migrate                 应用迁移并播种默认来源站点
  sync                    从 SITE_REPO_DIR 的内容仓库导入文章
  generate [--date 日期] [--regenerate] [--dry-run]
                          生成指定日期的资讯博客（默认上海时间今天）
                          --dry-run 只预览：不写数据库，也不写文件
  serve                   启动 HTTP 服务
  run <run_id>            查看一次运行报告

所有配置来自环境变量，见 .env.example；数据库由 DB_PROFILE 选择 test / prod 两套配置。`;

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === "--regenerate") options.regenerate = true;
    else if (token === "--dry-run") options.dryRun = true;
    else if (token.startsWith("--")) {
      options[token.slice(2)] = rest[index + 1];
      index += 1;
    } else {
      (options._ ??= []).push(token);
    }
  }
  return { command, options };
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const positional = options._ ?? [];
  if (!command || command === "help" || command === "-h" || command === "--help") {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const config = loadEnv();
  if (command === "serve") {
    const { serve } = await import("./server.js");
    await serve({ config });
    return;
  }

  const { openConfiguredDatabase } = await import("./server.js");
  const db = openConfiguredDatabase(config);
  try {
    switch (command) {
      case "migrate": {
        const applied = await migrate(db);
        const seeded = await seedSites(db);
        const upgraded = await upgradeSiteUrls(db);
        process.stdout.write(
          `数据库：${config.database.profile}/${config.database.driver}；已应用迁移：${applied.join("、") || "（无新增）"}；新增来源站点：${seeded}；升级来源地址：${upgraded}\n`
        );
        break;
      }
      case "sync": {
        if (!config.siteRepoDir) throw new Error("请先设置 SITE_REPO_DIR 指向本站仓库的检出目录");
        const result = await syncContent(db, config.siteRepoDir);
        process.stdout.write(`已导入 ${result.imported} 篇文章\n`);
        break;
      }
      case "generate": {
        if (!config.siteRepoDir) throw new Error("请先设置 SITE_REPO_DIR 指向本站仓库的检出目录");
        const date = options.date ?? todayInShanghai();
        const result = await generateDigest(db, config, {
          date,
          regenerate: Boolean(options.regenerate),
          dryRun: Boolean(options.dryRun),
          kind: "manual"
        });
        if (options.dryRun) {
          process.stderr.write(`预览模式：未写入数据库，也未写入文件（run_id=${result.run_id}）\n`);
          process.stdout.write(`${result.markdown}\n`);
          break;
        }
        process.stdout.write(
          `已生成 ${result.slug}（${result.status}，${result.item_count} 条），写入 ${result.markdown_path}；run_id=${result.run_id}\n`
        );
        if (result.note) process.stdout.write(`说明：${result.note}\n`);
        break;
      }
      case "run": {
        const run = await getRun(db, positional[0]);
        if (!run) throw new Error(`没有运行记录 ${positional[0] ?? "(未给出 run_id)"}`);
        process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
        break;
      }
      default:
        process.stderr.write(`未知命令：${command}\n\n${USAGE}\n`);
        process.exitCode = 2;
    }
  } catch (error) {
    if (error instanceof GenerateError) {
      process.exitCode = 1;
      process.stderr.write(`生成失败（${error.code}）：${error.message}\n`);
      if (error.extra?.run_id) process.stderr.write(`run_id=${error.extra.run_id}\n`);
    } else {
      throw error;
    }
  } finally {
    await closeDatabase(db);
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
