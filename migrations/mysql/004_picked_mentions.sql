-- 这份是 MySQL 最终写法，migrate() 原样执行（不再按 SQLite 改写）。
-- 新库由 001 直接建好最终结构，这里只补已经在用的 MySQL 旧库；每句都会先查再执行，重跑也不报错。

-- 1. 去掉条目里冗余的站点名和按日期分组的列：站点名读的时候 JOIN source_sites，分组按 slug。
ALTER TABLE picked_items DROP INDEX picked_items_url;
ALTER TABLE picked_items DROP COLUMN site_name;
ALTER TABLE picked_items DROP COLUMN digest_date;
ALTER TABLE picked_items ADD UNIQUE KEY picked_items_url (slug, url_key);

-- 2. 多来源提及明细，先建出来：下面按清单删站点时，历史提及的清理也要靠它。
--    site_id 不挂外键，删站点时历史提及原样保留，名字显示为空，下次抓取同一篇时再补回来。
--    新建表沿用连接的默认排序规则（本地是 utf8mb4_bin），外键两边不一致会报 incompatible；
--    slug 和 rank_no 要跟 picked_items 对上，显式写成和业务表一样的字符集。
CREATE TABLE IF NOT EXISTS picked_item_mentions (
  slug VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  rank_no INT NOT NULL,
  site_id VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  site_rank INT NOT NULL,
  url VARCHAR(700) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  title VARCHAR(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  excerpt VARCHAR(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
  published_at VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
  PRIMARY KEY (slug, rank_no, site_id),
  KEY picked_item_mentions_site (site_id),
  CONSTRAINT picked_item_mentions_item FOREIGN KEY (slug, rank_no) REFERENCES picked_items (slug, rank_no) ON DELETE CASCADE
);

-- 3. 同一个热榜接口只归一个站点，否则同一批消息会被算两次。
--    快讯站点和正式站点共用接口：东方财富快讯 / 东方财富7×24、同花顺快讯 / 同花顺7×24、虎嗅快讯 / 虎嗅，
--    36氪快讯则是同接口的另一条来源。启用状态带数字大的留下，一样大时按 id 拼大小，id 小的留下
--    （'-' 排在数字和字母前面，所以带 -flash 的那几条总是输）。留下的正是种子里的正式来源。
--    接在同接口上的历史条目都指向留下的那个站点，删掉的来源没有单独的历史条目要搬。
--    MySQL 不允许在子查询里直接读正在 UPDATE 的表（ER_UPDATE_TABLE_USED：You can't specify target
--    table ... for update in FROM clause）。实测 MySQL 8.0.30 下，「派生表里挑出 id、外层 UPDATE ...
--    WHERE id IN (派生表)」这种间接引用可以被识别出来，而 UPDATE 直接 JOIN 派生表、子查询里比较的列
--    又恰好是要更新表的新值时，会被判成循环引用；hot_list_url 又是 TEXT，在派生表里会变成 BLOB，
--    比较结果不稳定。这里干脆拆成单条语句：先用 SELECT 把要删的 id 写进一张临时清单表，再按清单删。
--    清单表只在一处建、一处读，DELETE 本身不碰任何子查询。临时表只在当前连接里有效，
--    重跑时先清空再算，不会残留上一次的结果；migrate() 跑完这份迁移会把它删掉。
CREATE TEMPORARY TABLE IF NOT EXISTS p0_site_dedupe (
  id VARCHAR(64) NOT NULL PRIMARY KEY
) ENGINE = InnoDB;

INSERT INTO p0_site_dedupe (id)
SELECT s.id
FROM source_sites s
WHERE EXISTS (
  SELECT 1
  FROM source_sites k
  WHERE k.hot_list_url = s.hot_list_url
    AND k.id <> s.id
    AND (k.enabled > s.enabled OR (k.enabled = s.enabled AND k.id < s.id))
);

DELETE FROM source_sites WHERE id IN (SELECT id FROM p0_site_dedupe);
DELETE FROM p0_site_dedupe;

-- 4. 热榜接口地址加唯一键：以后同一个接口只能配在一个站点上。hot_list_url 从 TEXT 改成 VARCHAR(700)，
--    在 utf8mb4 下正好是一整列唯一键能放下的长度；取前 255 个字比较的前缀键在 MySQL 8 上反而建不起来
--    （插入时报 DUPLICATE ENTRY ''），现有最长的接口地址 211 个字，700 够用。
--    两条 ALTER 分开写：建键那句不和 MODIFY 合并，runMigrationStatement 才能先查重再交给数据库。
ALTER TABLE source_sites MODIFY COLUMN hot_list_url VARCHAR(700) NOT NULL;
ALTER TABLE source_sites ADD UNIQUE KEY source_sites_hot_list_url (hot_list_url);

-- 5. 旧库每条只记了一个代表来源，按它回填一条提及；站点已删除的不补。
-- 这张表刚刚建好，不可能已经有提到同一篇的行，所以用 NOT EXISTS 不会碰到「同表读不到已插入行」的问题。
INSERT INTO picked_item_mentions (slug, rank_no, site_id, site_rank, url, title, excerpt, published_at)
SELECT m.slug, m.rank_no, m.site_id, m.site_rank, m.url, m.title, NULL, m.published_at
FROM picked_items m
WHERE m.site_id <> ''
  AND m.site_id IN (SELECT id FROM source_sites)
  AND NOT EXISTS (SELECT 1 FROM picked_item_mentions x WHERE x.slug = m.slug AND x.rank_no = m.rank_no);
