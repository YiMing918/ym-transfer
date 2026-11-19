// api/cleanup.js — 定时清理：删除过期文件（R2 对象 + D1 记录）与超时未完成的 pending
// 由 GitHub Actions 定时调（见 .github/workflows/cleanup.yml），需带 X-Task-Secret 头。
// 删 R2 失败不阻塞：先尽力删对象，再删记录；下次清理会重试漏掉的。
// M11（v1.1.7）键覆盖检查：本清理一直是「按 D1 记录的 r2_key 删对象」，
// 没有、也不新增「按前缀扫桶找孤儿」的逻辑——新流程下 pending 记录的
// r2_key 就是临时键 staging/…、ready 记录的 r2_key 是正式键 files/…、
// 老记录仍是 f/…，三种键都由记录带着删，天然全覆盖；从未 complete 的
// 半截文件留在 staging/、按 pending 超时（PENDING_TTL）随记录一起清，
// 与旧流程半截文件留在正式键、同样按 pending 超时清的口径一致，不变差。
// 唯一记录带不到的是「转正时删临时对象失败」留下的残留：删 ready 记录
// 时顺手把配对的临时键也删一次（见循环内 counterpart），再兜底还有
// R2 桶 10 天生命周期。按前缀扫桶反而可能误删正在上传窗口内的临时
// 对象，风险大于收益，明确不做。

import { json, fail, nowSec } from '../_lib/http.js';
import { all, run } from '../_lib/db.js';
import { PENDING_TTL_SEC } from '../_lib/consts.js';
import { finalKeyForStaging, stagingKeyForFinal } from '../_lib/r2sign.js';

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
  // 第一分支只管 ready：pending 的 expires_at 是用户选的短有效期（最短
  // 1 小时），而上传窗口有 6 小时——若按 expires_at 清 pending，慢传大文件
  // 会在传完前被误删。pending 一律走第二分支、只按 PENDING_TTL（上传窗口
  // + 缓冲）判超时。ORDER BY 保证积压时先清最旧的，不会总清新行饿死旧行。
  const rows = await all(env, `SELECT id, r2_key FROM files
    WHERE (expires_at <= ? AND status = 'ready')
       OR (status = 'pending' AND created_at <= ?)
    ORDER BY expires_at ASC LIMIT 200`,
    now, now - PENDING_TTL_SEC);

  let deleted = 0;
  for (const row of rows) {
    try { await env.FILES.delete(row.r2_key); }
    catch { continue; } // 对象没删掉：记录先留着，下次清理会重试（记录只在对象删除成功后才删）
    // M11 配对键顺手清：ready 记录（正式键）可能有转正时没删掉的残留
    // 临时对象；pending 记录（临时键）可能有转正尝试留下的正式键复制。
    // 都只是尽力删，失败不影响主语义（记录删除与计数照旧）。
    const counterpart = finalKeyForStaging(row.r2_key) || stagingKeyForFinal(row.r2_key);
    if (counterpart) { try { await env.FILES.delete(counterpart); } catch { /* 残留由生命周期兜底 */ } }
    try { await run(env, 'DELETE FROM files WHERE id = ?', row.id); deleted++; }
    catch { /* 记录没删掉，下次再清 */ }
  }
  // 顺手清掉 7 天前的限流旧行
  try { await run(env, 'DELETE FROM rate_limits WHERE window_start < ?', now - 7 * 86400); } catch { /* 忽略 */ }

  return json({ deleted, checked_at: now });
}
