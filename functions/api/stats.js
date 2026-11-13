// api/stats.js — 公开容量统计：站内已用字节与文件数（首页“已用 X / 10 GB”用）
// 不含任何敏感信息，无需鉴权。

import { json, nowSec } from '../_lib/http.js';
import { first } from '../_lib/db.js';
import { TOTAL_CAP_BYTES, MAX_FILE_BYTES, PENDING_TTL_SEC } from '../_lib/consts.js';

export { TOTAL_CAP_BYTES, MAX_FILE_BYTES };

export async function onRequest(context) {
  const { env } = context;
  const now = nowSec();
  const row = await first(env, `SELECT COALESCE(SUM(size_bytes),0) AS total, COUNT(*) AS n FROM files
    WHERE (status = 'ready' AND expires_at > ?)
       OR (status = 'pending' AND created_at > ? AND expires_at > ?)`,
    now, now - PENDING_TTL_SEC, now);
  return json({
    used_bytes: row ? row.total : 0,
    file_count: row ? row.n : 0,
    total_cap_bytes: TOTAL_CAP_BYTES,
    max_file_bytes: MAX_FILE_BYTES,
  });
}
