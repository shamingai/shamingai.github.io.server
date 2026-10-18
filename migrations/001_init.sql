CREATE TABLE IF NOT EXISTS source_sites (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  home_url TEXT NOT NULL,
  hot_list_url TEXT NOT NULL,
  adapter VARCHAR(64) NOT NULL,
  weight DOUBLE NOT NULL DEFAULT 1,
  max_candidates INT NOT NULL DEFAULT 20,
  enabled TINYINT NOT NULL DEFAULT 1,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
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
  UNIQUE KEY articles_digest_date (digest_date),
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
  digest_date VARCHAR(10) NOT NULL PRIMARY KEY,
  slug VARCHAR(191) NOT NULL,
  title TEXT NOT NULL,
  item_count INT NOT NULL,
  note TEXT NULL,
  status VARCHAR(16) NOT NULL,
  generated_at VARCHAR(32) NOT NULL,
  markdown_path TEXT NOT NULL,
  UNIQUE KEY digests_slug (slug),
  CONSTRAINT digests_status CHECK (status IN ('generated', 'replaced', 'failed'))
);

CREATE TABLE IF NOT EXISTS picked_items (
  digest_date VARCHAR(10) NOT NULL,
  rank_no INT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  site_id VARCHAR(64) NOT NULL,
  site_name VARCHAR(120) NOT NULL,
  site_rank INT NOT NULL,
  mention_count INT NOT NULL DEFAULT 1,
  summary TEXT NOT NULL,
  reason TEXT NOT NULL,
  published_at VARCHAR(32) NULL,
  url_key VARCHAR(700) AS (LEFT(url, 700)) STORED,
  PRIMARY KEY (digest_date, rank_no),
  UNIQUE KEY picked_items_url (digest_date, url_key),
  CONSTRAINT picked_items_digest FOREIGN KEY (digest_date) REFERENCES digests (digest_date) ON DELETE CASCADE
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
