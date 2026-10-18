# shamingai 博客后端

为 [shamingai.github.io](https://shamingai.com) 提供数据接口，并每天生成一篇「今日热门前十资讯」。

- 每日 08:00（Asia/Shanghai）采集百度热搜、微博热搜、知乎热榜、头条热榜、少数派热门；
- 跨站去重合并、按热度加权排序，LLM 生成标题/摘要/推荐理由，逐条检查原文链接可达；
- 选出前 10 条，写成 `daily-YYYY-MM-DD.md`（标签、分类都是「资讯」）放进本站仓库的 `blog/content/posts/`；
- 同时写入 MySQL，前端通过 `/api/digests`、`/api/digests/:date` 读取；
- 前端（`blog/app`）的开发服务器把 `/api` 代理到这里。

技术栈：Node.js ≥ 22.5、Fastify 5、cheerio、mysql2、OpenAI 兼容 LLM 接口。数据库用 MySQL，两套连接信息按 `DB_PROFILE` 切换（见下文「数据库」）；所选环境没有填主机或账号时回退到内置 `node:sqlite` 单文件，方便离线试跑。

## 目录

```
src/
  cli.js            migrate / sync / generate / serve / run
  config.js         .env + 环境变量
  app.js            路由注册、错误格式、CORS
  routes/reader.js  公开读接口
  routes/admin.js   管理接口（Bearer 令牌）
  db.js             驱动层：MySQL 优先，缺连接信息时回退 node:sqlite；SQL 方言转换在这里
  services/         collect 采集、rank 合并排序、digest 生成、sync 导入、article 查询、render 渲染
  sources/          各站点热榜适配器
migrations/         MySQL 方言的迁移（SQLite 回退时自动改写）
tests/              unit + contract（node --test）
deploy/             systemd unit、nginx.conf、可选 Dockerfile
```

## 数据库

两套连接信息都写在 `.env.example` 里，选哪套由 `DB_PROFILE` 决定，真实账号密码放各自的后端根目录文件，不进仓库：

| `DB_PROFILE` | 叠加载入的配置文件 | 连接变量前缀 | 用途 |
| --- | --- | --- | --- |
| `test`（默认） | `.env.test` | `MYSQL_TEST_*` | 本地 MySQL |
| `prod` | `.env.prod` | `MYSQL_PROD_*` | 部署机连 `116.62.78.39` |

加载顺序是 `.env` → `.env.$DB_PROFILE` → 进程环境变量，后者覆盖前者。所选环境的 `HOST` 或 `USER` 为空时，后端回退到 `DB_PATH` 指向的 SQLite 文件（`node:sqlite` 实验特性），只用于离线试跑；MySQL 是主路径。

`migrate` 只建表，不建库，库要事先建好，并给连接账号授权：

```sql
CREATE DATABASE IF NOT EXISTS shamingai_blog DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
GRANT ALL PRIVILEGES ON shamingai_blog.* TO 'admin'@'localhost';
```

授权后用连接账号确认能看到这个库（`SHOW GRANTS FOR CURRENT_USER;` 至少要有库级权限），否则 `migrate` 会报 `ERROR 1044`。

迁移脚本按 MySQL 写（`ON DUPLICATE KEY UPDATE`、`AS incoming` 别名、生成列、`LEFT()`），回退到 SQLite 时由 `db.js` 改写：单行 upsert 变成 `INSERT OR REPLACE`，多行 upsert 只允许"更新项都写回自身"（等价于保留旧行），生成列降级为普通列。

## 快速开始

```bash
npm ci
cp .env.example .env          # 至少填 DB_PROFILE、SITE_REPO_DIR、LLM_BASE_URL、LLM_API_KEY、LLM_MODEL
cp .env.example .env.test     # 再填 MYSQL_TEST_HOST / MYSQL_TEST_USER / MYSQL_TEST_PASSWORD
npm run migrate               # 建表 + 播种默认来源站点（可重复执行）
npm run sync                  # 从 SITE_REPO_DIR 导入已有文章
npm start                     # 启动 http://127.0.0.1:8787
```

生成当天资讯：

```bash
npm run generate                            # 等价于 curl -X POST /api/digests
npm run generate -- --date 2026-10-18
npm run generate -- --date 2026-10-18 --regenerate
npm run generate -- --date 2026-10-18 --dry-run   # 纯预览：不写数据库，也不写文件
```

前端联调：在 `blog/app` 下 `npm run dev`，Vite 会把 `/api` 代理到 `http://127.0.0.1:8787`（走代理，不涉及 CORS）。

正式前端是 <https://blog.zhaotong.fun/>。跨域白名单由 `.env` 的 `CORS_ORIGINS` 控制，不配置时只放行这个域名；本地直连后端时追加 `http://localhost:5173`。

## 接口

错误统一为 `{"error":{"code":"...","message":"...","details":{...}}}`。

### 公开

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | `{status, db, content_dir, details, last_sync_at}`；`db` 或 `content_dir` 不是 `ok` 时整体 `degraded` 并返回 503 |
| GET | `/api/posts?page=&page_size=` | 文章分页（默认 10，最大 100），`{items, total, page, page_size}` |
| GET | `/api/posts/:slug` | 正文 Markdown、标题锚点、上一篇/下一篇 |
| GET | `/api/archive`、`/api/categories`、`/api/categories/:path/posts` | 归档与分类 |
| GET | `/api/tags`、`/api/tags/:name/posts` | 标签 |
| GET | `/api/search?q=` | 标题/摘要/正文搜索 |
| GET | `/api/about`、`/api/history` | 关于与时间线 |
| GET | `/api/digests?page=&page_size=` | 资讯列表，按日期倒序 |
| GET | `/api/digests/:date` | 某天的资讯条目（含摘要、推荐理由、链接） |
| GET | `/api/source-sites` | 来源站点清单 |

### 管理（需要 `Authorization: Bearer $API_TOKEN`）

未配置 `API_TOKEN` 时全部返回 503 `admin_disabled`；令牌错误返回 401 `unauthorized`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/source-sites` | 新增站点，201 |
| PATCH | `/api/source-sites/:id` | 修改，如 `{"enabled":false}` |
| DELETE | `/api/source-sites/:id` | 删除，204 |
| POST | `/api/content-syncs` | 后台导入文章，202 `{run_id}` |
| GET | `/api/runs/:runId` | 运行报告 |
| POST | `/api/digests` | 生成资讯。body：`{date?, regenerate?}`。新生成 201；同日已存在 409 `duplicate_date`（带 `details.run_id`）；`regenerate:true` 覆盖并返回 200 |

可用的 `adapter`：`baidu-board`、`weibo-hot-search`、`zhihu-hot-list`、`toutiao-hot-board`、`sspai-popular`、`links`（通用：抓取页面上的链接并按 `item_selector`/`link_selector` 匹配）。

## 部署

后端单独部署，前端仍是 GitHub Pages 上的静态站点（<https://blog.zhaotong.fun/>）。后端对外域名是 <https://api.zhaotong.fun>，由 Nginx 反代到本机的 `127.0.0.1:8787`，Node 进程不直接对公网监听。

```bash
git clone git@github_shamingai.com:shamingai/shamingai.github.io.server.git /srv/shamingai.github.io.server
cd /srv/shamingai.github.io.server && npm ci --omit=dev && cp .env.example .env   # 填好
# 数据库：.env 里写 DB_PROFILE=prod，并把 MYSQL_PROD_* 填进 .env.prod（部署机连 116.62.78.39）
# 另需一份本站仓库检出供写入文章：
git clone git@github_shamingai.com:shamingai/shamingai.github.io.git /srv/site
# 其他必填：SITE_REPO_DIR=/srv/site、HOST=127.0.0.1、SCHEDULER=off（每日生成由本地调度器 POST /api/digests 触发）
npm run migrate                    # 首次建表
sudo cp deploy/shamingai-server.service /etc/systemd/system/
sudo systemctl enable --now shamingai-server
```

### Nginx 反代

`deploy/nginx.conf` 是 `api.zhaotong.fun` 的完整 server 块，只把 `/api/` 转发给后端，其余路径返回 404：

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/api.zhaotong.fun
sudo ln -s /etc/nginx/sites-available/api.zhaotong.fun /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d api.zhaotong.fun      # 申请并自动启用 HTTPS
```

要点：

- 跨域响应头由后端（`@fastify/cors`）生成，Nginx 不要再加 `add_header Access-Control-*`，否则会出现重复头，浏览器判定失败；
- 生成接口会同步调 LLM、采集和查链接，配置里把 `proxy_read_timeout` 放宽到 600s；
- 管理接口仍由后端校验 `Authorization: Bearer $API_TOKEN`，Nginx 不做鉴权。

上线前先在本机验证配置语法（不触碰系统 Nginx，只做 `-t` 检查）：

```bash
# 把 deploy/nginx.conf 的 listen 80 临时换成高位端口（如 18080），再用临时配置检查
nginx -t -c <临时 nginx.conf>      # 该临时 nginx.conf 的 http {} 里 include 上面的 server 块
```

然后用真实后端（`PORT=8787`）跑一遍 `curl -H 'Host: api.zhaotong.fun' http://127.0.0.1:<端口>/api/digests`，确认 200 且带 `access-control-allow-origin: https://blog.zhaotong.fun`，`/` 返回 404。

### 前端指向后端

正式前端构建时设置 `VITE_API_BASE_URL=https://api.zhaotong.fun`（见 `blog/app/.env.production`），浏览器直接跨域请求后端，白名单默认只放行 `https://blog.zhaotong.fun`。本地开发用 Vite 代理，不需要 CORS；要直连后端时把 `http://localhost:5173` 追加到 `CORS_ORIGINS`。

Docker 方式见 `deploy/Dockerfile` 顶部注释（容器里同样建议 `HOST=0.0.0.0` 并由 Nginx 反代容器端口）。

### 生成之后要 commit

生成器只写文件，不执行 git。作者本地每天 08:00 由调度器 `POST /api/digests` 触发生成后，再手动推送：

```bash
cd "$SITE_REPO_DIR"
git add blog/content/posts/daily-*.md
git commit -m "daily: $(date +%F) 资讯"
git push
```

推送后由站点现有的构建流程发布。可选：本机 crontab 在生成之后补一步推送（生产后端 `SCHEDULER=off`，不要把 cron 放在服务器上重复生成）：

```cron
10 8 * * * cd "$HOME/jekyll/shamingai.github.io" && git pull --rebase --autostash && git add blog/content/posts/daily-*.md && git commit -m "daily: $(date +\%F) 资讯" && git push || true
```

反代配置见上文的 `deploy/nginx.conf` 一节。

## 测试

```bash
npm test          # 72 个用例：unit + contract
npm run coverage  # 行 89.30% / 分支 79.73% / 函数 87.69%
```
