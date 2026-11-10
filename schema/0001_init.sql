-- ym-transfer 数据库迁移 0001：文件元数据表与限流表
-- 约定：时间存 Unix 秒；布尔用 0/1；不使用 FTS5。
-- 改表须新增编号迁移文件，不要改本文件（已部署的库不会重跑本文件）。

-- 文件：下载链接的元数据（文件本体在 R2，对象键与原文件名解耦）
CREATE TABLE IF NOT EXISTS files (
  id           TEXT PRIMARY KEY,              -- 随机链接 ID：32 位 hex（16 字节随机），不可猜、不可枚举
  r2_key       TEXT UNIQUE NOT NULL,          -- R2 对象键：f/<年>/<月>/<uuid>，不含原文件名
  orig_name    TEXT NOT NULL,                 -- 原文件名（仅展示与下载时用，不作存储路径）
  mime         TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes   INTEGER NOT NULL,              -- 声明大小；complete 时用 R2 HEAD 校验
  status       TEXT NOT NULL DEFAULT 'pending', -- pending 上传中 / ready 可下载 / deleted 已删
  expires_at   INTEGER NOT NULL,              -- 过期时间（Unix 秒）
  downloads    INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);
-- 清理主查询：按状态 + 过期时间找过期文件
CREATE INDEX IF NOT EXISTS idx_files_expiry ON files(status, expires_at);
-- 容量统计主查询：未过期且未删的文件求和
CREATE INDEX IF NOT EXISTS idx_files_active ON files(status, expires_at, size_bytes);

-- 限流：按 IP 哈希 + 小时窗口计数（防刷爆 10GB）
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket       TEXT NOT NULL,                 -- 如 upload:<ip_hash>
  window_start INTEGER NOT NULL,             -- 小时窗口起始（Unix 秒，向下取整到小时）
  count        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);
