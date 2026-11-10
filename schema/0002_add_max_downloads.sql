-- ym-transfer 数据库迁移 0002：下载次数上限
-- max_downloads 为 NULL 表示不限次数；设为数字时，下载次数达到该数后链接失效。
-- 改表须新增编号迁移文件，不要改 0001（已部署的库不会重跑旧文件）。
ALTER TABLE files ADD COLUMN max_downloads INTEGER;
