CREATE TABLE IF NOT EXISTS source_sites (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  home_url TEXT NOT NULL,
  hot_list_url TEXT NOT NULL,
  adapter VARCHAR(64) NOT NULL,
  weight DOUBLE NOT NULL DEFAULT 1,
  max_candidates INT NOT NULL DEFAULT 20,
  -- 来源站点进哪个资讯品类：hot = 每日热门前十资讯，tech = 每日热门技术资讯。
  audience VARCHAR(16) NOT NULL DEFAULT 'hot',
  enabled TINYINT NOT NULL DEFAULT 1,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  -- 同一个热榜接口只归一个站点，否则同一批消息会被算两次；hot_list_url 是 TEXT，按前 255 个字比较。
  UNIQUE KEY source_sites_hot_list_url (hot_list_url(255)),
  CONSTRAINT source_sites_enabled CHECK (enabled IN (0, 1))
);

CREATE TABLE IF NOT EXISTS articles (
  slug VARCHAR(191) NOT NULL PRIMARY KEY,
  kind VARCHAR(16) NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  summary_generated TINYINT NOT NULL DEFAULT 0,
  body LONGTEXT NOT NULL,
  category_path VARCHAR(255) NULL,
  published_on VARCHAR(10) NOT NULL,
  word_count INT NOT NULL DEFAULT 0,
  reading_minutes INT NOT NULL DEFAULT 1,
  digest_date VARCHAR(10) AS (IF(kind = 'digest', published_on, NULL)) STORED,
  updated_at VARCHAR(32) NOT NULL,
  CONSTRAINT articles_kind CHECK (kind IN ('post', 'digest')),
  KEY articles_published (published_on, title(64))
);

CREATE TABLE IF NOT EXISTS article_tags (
  slug VARCHAR(191) NOT NULL,
  name VARCHAR(64) NOT NULL,
  position INT NOT NULL DEFAULT 0,
  PRIMARY KEY (slug, name),
  KEY article_tags_name (name),
  CONSTRAINT article_tags_slug FOREIGN KEY (slug) REFERENCES articles (slug) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS headings (
  slug VARCHAR(191) NOT NULL,
  position INT NOT NULL,
  level INT NOT NULL,
  text TEXT NOT NULL,
  anchor TEXT NOT NULL,
  PRIMARY KEY (slug, position),
  CONSTRAINT headings_slug FOREIGN KEY (slug) REFERENCES articles (slug) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS site_meta (
  meta_key VARCHAR(64) NOT NULL PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS history_entries (
  position INT NOT NULL PRIMARY KEY,
  occurred_on VARCHAR(10) NOT NULL,
  text TEXT NOT NULL,
  article_slug VARCHAR(191) NULL
);

CREATE TABLE IF NOT EXISTS digests (
  slug VARCHAR(64) NOT NULL PRIMARY KEY,
  digest_date VARCHAR(10) NOT NULL,
  title TEXT NOT NULL,
  item_count INT NOT NULL,
  note TEXT NULL,
  status VARCHAR(16) NOT NULL,
  generated_at VARCHAR(32) NOT NULL,
  markdown_path TEXT NULL,
  -- 资讯品类：hot = 每日热门前十资讯，tech = 每日热门技术资讯。一天可以有多个品类，digest_date 只记日期。
  catalog VARCHAR(16) NOT NULL DEFAULT 'hot',
  KEY digests_date (digest_date),
  CONSTRAINT digests_status CHECK (status IN ('generated', 'replaced', 'failed'))
);

CREATE TABLE IF NOT EXISTS picked_items (
  -- 一期资讯的 slug 形如 daily-2026-11-03-tech，64 字足够；配合 url_key 建唯一索引也不会超长。
  slug VARCHAR(64) NOT NULL,
  rank_no INT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  site_id VARCHAR(64) NOT NULL,
  site_rank INT NOT NULL,
  mention_count INT NOT NULL DEFAULT 1,
  summary TEXT NOT NULL,
  reason TEXT NOT NULL,
  published_at VARCHAR(32) NULL,
  url_key VARCHAR(700) AS (LEFT(url, 700)) STORED,
  PRIMARY KEY (slug, rank_no),
  UNIQUE KEY picked_items_url (slug, url_key),
  CONSTRAINT picked_items_digest FOREIGN KEY (slug) REFERENCES digests (slug) ON DELETE CASCADE
);

-- 一条条目被哪些站点同时选中：site_id / site_rank 是与 picked_items 代表来源并列的其他来源，
-- 代表来源的 url / title / published_at 在 picked_items 里。site_id 不挂外键：删站点时历史提及原样保留，
-- 名字显示为空，下次抓到同一篇再补回来。
CREATE TABLE IF NOT EXISTS picked_item_mentions (
  slug VARCHAR(64) NOT NULL,
  rank_no INT NOT NULL,
  site_id VARCHAR(64) NOT NULL,
  site_rank INT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  excerpt TEXT NULL,
  published_at VARCHAR(32) NULL,
  PRIMARY KEY (slug, rank_no, site_id),
  KEY picked_item_mentions_site (site_id),
  CONSTRAINT picked_item_mentions_item FOREIGN KEY (slug, rank_no) REFERENCES picked_items (slug, rank_no) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS runs (
  run_id VARCHAR(64) NOT NULL PRIMARY KEY,
  kind VARCHAR(16) NOT NULL,
  started_at VARCHAR(32) NOT NULL,
  finished_at VARCHAR(32) NULL,
  site_results TEXT NOT NULL,
  dropped TEXT NOT NULL,
  outcome VARCHAR(32) NULL,
  CONSTRAINT runs_kind CHECK (kind IN ('daily', 'manual', 'regenerate', 'sync', 'collection'))
);
