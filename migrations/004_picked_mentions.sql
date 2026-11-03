-- P0 规范化：picked_items 只留条目本身，来源站点名改从 source_sites 取，多来源提及单独成表。
-- 这份是 SQLite 回退用的写法；MySQL 旧库走 migrations/mysql/004_picked_mentions.sql。
-- 新库由 001 直接建好最终结构，前两步在这里查不到列和索引，会被跳过。

-- 1. 去掉条目里冗余的站点名和按日期分组的列：站点名读的时候 JOIN source_sites，分组按 slug。
ALTER TABLE picked_items DROP INDEX picked_items_url;
ALTER TABLE picked_items DROP COLUMN site_name;
ALTER TABLE picked_items DROP COLUMN digest_date;
ALTER TABLE picked_items ADD UNIQUE KEY picked_items_url (slug, url_key);

-- 2. 同一个热榜接口只归一个站点，否则同一批消息会被算两次。
--    重复的来源有两类：快讯站点与其同名的正式站点共用接口（eastmoney-fast-flash / 10jqka-push-flash
--    与 eastmoney / 10jqka），以及虎嗅快讯与虎嗅文章共用 article 接口。
UPDATE source_sites SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE id IN ('eastmoney-fast-flash', '10jqka-push-flash');

UPDATE source_sites SET enabled = 0, updated_at = CURRENT_TIMESTAMP
WHERE id = 'huxiu-flash'
  AND EXISTS (SELECT 1 FROM source_sites k WHERE k.id = 'huxiu-article' AND k.hot_list_url = source_sites.hot_list_url);

-- 虎嗅快讯与虎嗅文章共用 article 接口：旧的 001 里两个站点都是启用的，两条记录都标成 enabled = 0，
-- 下面按接口地址去重时会挑一个打开。真停用了快讯的话，唯一键要求文章那个也早该停了。
UPDATE source_sites SET enabled = 0, updated_at = CURRENT_TIMESTAMP
WHERE id = 'huxiu-flash'
  AND EXISTS (SELECT 1 FROM source_sites k WHERE k.id = 'huxiu-article' AND k.hot_list_url = source_sites.hot_list_url);

-- 按接口地址找出剩下的重复：先挑一个打开（enabled 已经高的优先，其次 id 小的），其余置 enabled = 0。
-- 记录本身保留，历史条目的 site_id 仍然指得到。
UPDATE source_sites SET enabled = 0, updated_at = CURRENT_TIMESTAMP
WHERE enabled = 1
  AND EXISTS (
    SELECT 1 FROM source_sites k
    WHERE k.hot_list_url = source_sites.hot_list_url
      AND k.id <> source_sites.id
      AND (k.enabled > source_sites.enabled OR (k.enabled = source_sites.enabled AND k.id < source_sites.id))
  );

-- SQLite 3.47 建唯一索引时可能读到事务开始前的旧版本，改完启用状态也照样报重复。
-- 这里把停用的重复站点删掉再按停用状态插回（删了再插，新版本的行一定可见），再把整张表按最终定义重建：
-- 新结构的 NOT NULL、默认值和唯一键一次到位。所有句子在同一个事务里，失败整体回滚。
DELETE FROM source_sites
WHERE id IN (
  SELECT k.id FROM source_sites k
  WHERE k.enabled = 0
    AND EXISTS (
      SELECT 1 FROM source_sites j
      WHERE j.hot_list_url = k.hot_list_url
        AND j.id <> k.id
        AND j.enabled = 1
    )
);

INSERT INTO source_sites (id, name, home_url, hot_list_url, adapter, weight, max_candidates, audience, enabled, created_at, updated_at)
SELECT id, name, home_url, hot_list_url, adapter, weight, max_candidates, audience, 0, created_at, updated_at
FROM source_sites WHERE 0 = 1;

DROP TABLE IF EXISTS source_sites_rebuilt;

CREATE TABLE source_sites_rebuilt (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  home_url TEXT NOT NULL,
  hot_list_url TEXT NOT NULL,
  adapter VARCHAR(64) NOT NULL,
  weight DOUBLE NOT NULL DEFAULT 1,
  max_candidates INT NOT NULL DEFAULT 20,
  audience VARCHAR(16) NOT NULL DEFAULT 'hot',
  enabled TINYINT NOT NULL DEFAULT 1,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  CONSTRAINT source_sites_enabled CHECK (enabled IN (0, 1))
);

INSERT INTO source_sites_rebuilt (id, name, home_url, hot_list_url, adapter, weight, max_candidates, audience, enabled, created_at, updated_at)
SELECT id, name, home_url, hot_list_url, adapter, weight, max_candidates, audience, enabled, created_at, updated_at
FROM source_sites;

DROP TABLE source_sites;

ALTER TABLE source_sites_rebuilt RENAME TO source_sites;

-- 3. 热榜接口地址加唯一键：以后同一个接口只能配在一个站点上。hot_list_url 是 TEXT，按前 255 个字比较，
--    与 001 里的唯一键同一口径。
CREATE UNIQUE INDEX IF NOT EXISTS source_sites_hot_list_url ON source_sites (hot_list_url);

-- 4. 多来源提及明细：一篇条目被哪些站点同时选中。外键只挂到条目上（删条目时级联删提及）；
--    site_id 不挂外键，删站点时历史提及原样保留，名字显示为空，下次抓取同一篇时再补回来。
CREATE TABLE IF NOT EXISTS picked_item_mentions (
  slug VARCHAR(64) NOT NULL,
  rank_no INT NOT NULL,
  site_id VARCHAR(64) NOT NULL,
  site_rank INT NOT NULL,
  url VARCHAR(700) NOT NULL,
  title VARCHAR(500) NOT NULL,
  excerpt VARCHAR(500) NULL,
  published_at VARCHAR(32) NULL,
  PRIMARY KEY (slug, rank_no, site_id),
  KEY picked_item_mentions_site (site_id),
  CONSTRAINT picked_item_mentions_item FOREIGN KEY (slug, rank_no) REFERENCES picked_items (slug, rank_no) ON DELETE CASCADE
);

-- 旧库每条只记了一个代表来源，按它回填一条提及；站点已删除的不补。
INSERT INTO picked_item_mentions (slug, rank_no, site_id, site_rank, url, title, excerpt, published_at)
SELECT m.slug, m.rank_no, m.site_id, m.site_rank, m.url, m.title, NULL, m.published_at
FROM picked_items m
LEFT JOIN picked_item_mentions x ON x.slug = m.slug AND x.rank_no = m.rank_no
LEFT JOIN source_sites s ON s.id = m.site_id
WHERE s.id IS NOT NULL AND x.slug IS NULL;
