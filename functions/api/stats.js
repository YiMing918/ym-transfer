// api/stats.js — 公开容量统计：站内已用字节与文件数（首页“已用 X / 10 GB”用）
// 不含任何敏感信息，无需鉴权。

import { json, fail, nowSec } from '../_lib/http.js';
import { first } from '../_lib/db.js';
import { TOTAL_CAP_BYTES, MAX_FILE_BYTES, PENDING_TTL_SEC, PENDING_CAP_BYTES } from '../_lib/consts.js';

export { TOTAL_CAP_BYTES, MAX_FILE_BYTES };

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return fail('method_not_allowed', '只支持 GET', 405);
  }
  const now = nowSec();
  // 配额口径与 upload-init 的 usedBytes 统一：ready 全额计、pending 部分
  // 封顶 PENDING_CAP_BYTES（consts.js 同一份常量），不再用无封顶 SUM
  // 各算各的——此前展示的已用量与实际准入口径对不上。
  const row = await first(env, `SELECT
      COALESCE(SUM(CASE WHEN status = 'ready' THEN size_bytes ELSE 0 END), 0) AS ready_total,
      COALESCE(SUM(CASE WHEN status = 'pending' THEN size_bytes ELSE 0 END), 0) AS pending_total,
      COUNT(*) AS n FROM files
    WHERE (status = 'ready' AND expires_at > ?)
       OR (status = 'pending' AND created_at > ? AND expires_at > ?)`,
    now, now - PENDING_TTL_SEC, now);
  return json({
    used_bytes: row ? row.ready_total + Math.min(row.pending_total, PENDING_CAP_BYTES) : 0,
    file_count: row ? row.n : 0,
    total_cap_bytes: TOTAL_CAP_BYTES,
    max_file_bytes: MAX_FILE_BYTES,
  });
}
