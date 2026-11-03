-- 资讯正文只存数据库，不再落 blog/content/posts 下的 md 文件。
-- 站点内容一律从 articles / picked_items 读取，这里把文件路径列改成可空，生成流程不再写它。
-- 新库由 001 直接建成可空；这条只修已经有数据的旧库。
ALTER TABLE digests MODIFY COLUMN markdown_path TEXT NULL;
