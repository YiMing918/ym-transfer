// api/upload-complete.js — 上传完成确认：浏览器 PUT 到 R2 成功后调本接口
// 后端用 R2 HEAD 校验对象确实存在且大小与声明一致，才把状态从 pending 改为 ready。
// 幂等：已经是 ready 的重复调用直接返回成功。

import { json, fail, readJson, nowSec } from '../_lib/http.js';
import { first, run } from '../_lib/db.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') return fail('method_not_allowed', '只支持 POST', 405);
  let body;
  try {
    body = await readJson(request);
  } catch (e) {
    return fail(e.code || 'bad_request', e.message, e.status || 400);
  }
  const id = String(body.id || '');
  if (!/^[0-9a-f]{32}$/.test(id)) return fail('bad_id', '链接 ID 不合法', 400);

  const row = await first(env, 'SELECT * FROM files WHERE id = ?', id);
  if (!row) return fail('not_found', '找不到这个上传', 404);
  const now = nowSec();
  const base = new URL(request.url);
  const downloadUrl = `${base.origin}/d/${id}`;
  if (row.status === 'ready') {
    return json({ id, download_url: downloadUrl, expires_at: row.expires_at, max_downloads: row.max_downloads, name: row.orig_name, size: row.size_bytes });
  }
  if (row.status !== 'pending') return fail('bad_status', '这个上传已失效', 410);
  if (row.expires_at <= now) return fail('expired', '这个上传已过期', 410);

  let head = null;
  try { head = await env.FILES.head(row.r2_key); } catch { head = null; }
  if (!head) return fail('not_uploaded', '文件还没传到服务器，请重新上传', 400);
  if (head.size !== row.size_bytes) {
    return fail('size_mismatch', `文件大小不一致（应为 ${row.size_bytes} 字节，实际 ${head.size} 字节），请重新上传`, 400);
  }

  await run(env, "UPDATE files SET status = 'ready' WHERE id = ? AND status = 'pending'", id);
  return json({ id, download_url: downloadUrl, expires_at: row.expires_at, max_downloads: row.max_downloads, name: row.orig_name, size: row.size_bytes });
}
