-- 「财经快讯」并入「财经前十」：只保留 finance 一个品类，来源站点合并到它下面。
-- 36氪快讯、虎嗅快讯原本只供快讯品类，改挂 finance；
-- 东方财富快讯、同花顺快讯与 finance 下的同名站点是同一个接口，停用免得同一批消息算两次。

UPDATE source_sites SET audience = 'finance' WHERE id IN ('36kr-newsflash', 'huxiu-flash', 'eastmoney-fast-flash', '10jqka-push-flash');
UPDATE source_sites SET enabled = 0 WHERE id IN ('eastmoney-fast-flash', '10jqka-push-flash');
