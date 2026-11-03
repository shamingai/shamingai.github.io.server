-- 旧库（以日期为主键那一版）升级用，最终 SQL 直接执行。
-- 资讯只存数据库，不再落 blog/content/posts 下的 md 文件；资讯按品类分成多期。

-- 正文路径列改成可空，生成流程不再写它。
ALTER TABLE digests MODIFY COLUMN markdown_path TEXT NULL;

-- 资讯分品类：source_sites.audience 决定站点进哪个品类，digests.catalog 记录这一期属于哪个品类。
-- 旧数据一律按「今日热门前十资讯」处理。
ALTER TABLE source_sites ADD COLUMN audience VARCHAR(16) NOT NULL DEFAULT 'hot';
ALTER TABLE digests ADD COLUMN catalog VARCHAR(16) NOT NULL DEFAULT 'hot';

-- 条目归属到具体一期（同一天可能有 hot 和 tech 两期）。旧条目都来自 hot 那一期，按日期回填。
ALTER TABLE picked_items ADD COLUMN slug VARCHAR(64) NOT NULL DEFAULT '';

UPDATE picked_items SET slug = CONCAT('daily-', digest_date) WHERE slug = '';

-- articles 原来限制一天只能有一篇资讯；改成按品类分多期后，资讯靠 slug 主键区分，这个唯一约束去掉。
ALTER TABLE articles DROP INDEX articles_digest_date;

-- digests 原来以日期为主键，一天只能一期；改以 slug 为主键，日期退成普通列。
-- 先补日期索引，否则主键一删，外键就没有可用的索引了。
ALTER TABLE digests ADD KEY digests_date (digest_date);
ALTER TABLE digests DROP PRIMARY KEY;
ALTER TABLE digests ADD PRIMARY KEY (slug);

-- picked_items 跟着改成按 slug 挂外键，主键与 URL 去重也都按一期来。
ALTER TABLE picked_items DROP FOREIGN KEY picked_items_digest;
ALTER TABLE picked_items DROP PRIMARY KEY;
ALTER TABLE picked_items ADD PRIMARY KEY (slug, rank_no);
ALTER TABLE picked_items DROP INDEX picked_items_url;
ALTER TABLE picked_items ADD UNIQUE KEY picked_items_url (slug, url_key);
ALTER TABLE picked_items ADD CONSTRAINT picked_items_digest FOREIGN KEY (slug) REFERENCES digests (slug) ON DELETE CASCADE;
