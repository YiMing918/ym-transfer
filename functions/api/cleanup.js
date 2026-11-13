// api/cleanup.js — 定时清理：删除过期文件（R2 对象 + D1 记录）与超时未完成的 pending
// 由 GitHub Actions 定时调（见 .github/workflows/cleanup.yml），需带 X-Task-Secret 头。
// 删 R2 失败不阻塞：先尽力删对象，再删记录；下次清理会重试漏掉的。

import { json, fail, nowSec } from '../_lib/http.js';
import { all, run } from '../_lib/db.js';
import { PENDING_TTL_SEC } from '../_lib/consts.js';

// 密钥比较走「先哈希再恒定时间比对」，不用 === 直接比原文（计时侧信道）
async function secretMatches(given, expected) {
  if (!expected) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(given || '')),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ]);
  const av = new Uint8Array(a), bv = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < av.length; i++) diff |= av[i] ^ bv[i];
  return diff === 0;
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') return fail('method_not_allowed', '只支持 POST', 405);
  const secret = request.headers.get('X-Task-Secret') || '';
  if (!(await secretMatches(secret, env.TASK_SECRET || ''))) {
    return fail('unauthorized', '密钥不对', 401);
  }
  const now = nowSec();
  const rows = await all(env, `SELECT id, r2_key FROM files
    WHERE (expires_at <= ? AND status IN ('pending','ready'))
       OR (status = 'pending' AND created_at <= ?) LIMIT 200`,
    now, now - PENDING_TTL_SEC);

  let deleted = 0;
  for (const row of rows) {
    try { await env.FILES.delete(row.r2_key); }
    catch { continue; } // 对象没删掉：记录先留着，下次清理会重试（记录只在对象删除成功后才删）
    try { await run(env, 'DELETE FROM files WHERE id = ?', row.id); deleted++; }
    catch { /* 记录没删掉，下次再清 */ }
  }
  // 顺手清掉 7 天前的限流旧行
  try { await run(env, 'DELETE FROM rate_limits WHERE window_start < ?', now - 7 * 86400); } catch { /* 忽略 */ }

  return json({ deleted, checked_at: now });
}
