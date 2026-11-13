-- ym-transfer 数据库迁移 0003：删除冗余索引
-- idx_files_expiry (status, expires_at) 是 idx_files_active
-- (status, expires_at, size_bytes) 的前缀子集，后者完全覆盖前者的查询，
-- 0001 当时两个都建了。删掉子集索引，少一份写入维护开销，查询计划不变。
-- 在 D1 控制台对 ym-transfer-db 执行本文件一次即可；不执行也不影响功能。
DROP INDEX IF EXISTS idx_files_expiry;
