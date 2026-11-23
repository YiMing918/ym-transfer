// api/delete.js — 凭删除令牌删文件：上传建单时发给上传者的令牌（明文只在
// 建单响应里出现一次，库里只存 SHA-256 哈希），对上了就删 R2 对象 + 记录。
// 用途：下载链接泄露时不用等到期，上传者能主动撤回；传错了也能马上删。
// 老文件没有令牌（delete_token_hash 为空）→ 明确告知只能等到期自动删除，
// 下载与到期清理都不受影响。

import { json, fail, readJson, hitRateLimit, tokenHashMatches } from '../_lib/http.js';
import { first, run } from '../_lib/db.js';
import { stagingKeyForFinal } from '../_lib/r2sign.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') return fail('method_not_allowed', '只支持 POST', 405);
  let body;
  try {
    body = await readJson(request);
  } catch (e) {
    return fail(e.code || 'bad_request', e.message, e.status || 400);
  }
  if (!body || typeof body !== 'object') {
    return fail('bad_request', '请求体不合法', 400);
  }
  const id = String(body.id || '');
  if (!/^[0-9a-f]{32}$/.test(id)) return fail('bad_id', '链接 ID 不合法', 400);
  const token = typeof body.delete_token === 'string' ? body.delete_token : '';
  if (!token) return fail('bad_token', '请填写删除令牌', 400);

  // 轻量限流：同一 IP 每小时最多删 60 次（与 complete 同口径），防拿随机
  // ID/令牌反复撞本接口刷 D1。计数失败关门回 503，不 fail-open。
  const rl = await hitRateLimit(env, request, 'delete', 60);
  if (rl === false) return fail('rate_limited', '操作太频繁，请稍后再试', 429);
  if (rl === null) return fail('rate_limit_failed', '服务暂时不可用（限流计数失败），请稍后再试', 503);

  const row = await first(env, 'SELECT * FROM files WHERE id = ?', id);
  if (!row) return fail('not_found', '找不到这个文件（可能已经删掉或过期了）', 404);
  if (!row.delete_token_hash) {
    return fail('no_token', '这个文件是旧版上传的，没有删除令牌，只能等它到期自动删除', 400);
  }
  if (!(await tokenHashMatches(token, row.delete_token_hash))) {
    return fail('forbidden', '删除令牌不对', 403);
  }
  // 与 cleanup 同语义：先删 R2 对象，成功才删记录；对象删失败保留记录、
  // 回 500 让用户重试，不留「记录没了对象还在」的无主占用。
  try {
    await env.FILES.delete(row.r2_key);
  } catch {
    return fail('delete_failed', '删除失败，请稍后再试', 500);
  }
  // M11：正式文件可能有转正时没删掉的残留临时对象（攻击者拿旧上传地址
  // 重 PUT 也只会写回这个临时键），顺手一并删掉；删失败不影响删除结果，
  // 残留最终由定时清理/桶生命周期兜底。老文件键没有配对键，自动跳过。
  const stagingKey = stagingKeyForFinal(row.r2_key);
  if (stagingKey) { try { await env.FILES.delete(stagingKey); } catch { /* 兜底同上 */ } }
  // 记录删不掉时不能谎报成功：对象已经没了、记录还在的话，下载入口会
  // 照着记录去签直链、落到已删对象上（R2 原始 404，不是站内中文提示页），
  // 而定时清理只清过期/超时行，这行没过期前不会被兜底。故删行失败回 500
  // 让用户重试——重试时删对象是幂等的（删不存在的键照样成功），能自愈。
  try { await run(env, 'DELETE FROM files WHERE id = ?', id); }
  catch { return fail('delete_failed', '删除失败，请稍后再试', 500); }
  return json({ id, deleted: true });
}
