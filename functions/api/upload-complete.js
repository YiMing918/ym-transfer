// api/upload-complete.js — 上传完成确认：浏览器 PUT 到 R2 成功后调本接口
// 后端用 R2 HEAD 校验对象确实存在且大小与声明一致，才把状态从 pending 改为 ready。
// 幂等：已经是 ready 的重复调用直接返回成功。

import { json, fail, readJson, nowSec, hitRateLimit, tokenHashMatches } from '../_lib/http.js';
import { first, run } from '../_lib/db.js';
import { UPLOAD_URL_TTL_SEC } from '../_lib/consts.js';

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

  // 轻量限流：同一 IP 每小时最多确认 60 次（正常上传确认只需 1 次，含重试
  // 也绰绰有余），防拿随机 ID 反复撞本接口刷 D1/R2。计数失败关门回 503，
  // 与 upload-init 的限流口径一致，不 fail-open。
  const rl = await hitRateLimit(env, request, 'complete', 60);
  if (rl === false) return fail('rate_limited', '操作太频繁，请稍后再试', 429);
  if (rl === null) return fail('rate_limit_failed', '服务暂时不可用（限流计数失败），请稍后再试', 503);

  const row = await first(env, 'SELECT * FROM files WHERE id = ?', id);
  if (!row) return fail('not_found', '找不到这个上传', 404);
  // 所有权校验（M1，与 H4 删除令牌同根）：建单时发了删除令牌的文件
  // （delete_token_hash 非空），确认必须带对令牌才放行——否则任何人知道
  // 链接 ID 就能替别人确认、挪动到期时间、甚至触发大小不符删对象。
  // 老文件该列为空（含迁移 0004 没跑时整列不存在）按原规矩不验，正在
  // 传的老上传不会被这次升级打断。
  if (row.delete_token_hash) {
    const given = typeof body.delete_token === 'string' ? body.delete_token : '';
    if (!(await tokenHashMatches(given, row.delete_token_hash))) {
      return fail('forbidden', '删除令牌不对，无法确认这个上传', 403);
    }
  }
  const now = nowSec();
  const base = new URL(request.url);
  const downloadUrl = `${base.origin}/d/${id}`;
  if (row.status === 'ready') {
    return json({ id, download_url: downloadUrl, expires_at: row.expires_at, max_downloads: row.max_downloads, name: row.orig_name, size: row.size_bytes });
  }
  if (row.status !== 'pending') return fail('bad_status', '这个上传已失效', 410);

  // 有效期从「上传完成」起算：init 时写下的 expires_at 把上传耗时也算了
  // 进去，慢传大文件选 1 小时有效期会传完即过期。必须先按已耗时间整体
  // 后移再判过期——先判后移的话慢传请求在判过期那一步就被打回，后移
  // 逻辑永远执行不到（v1.1.1 及以前的 bug）。
  // 位移封顶（C-34）：位移量最多是实际上传窗口（预签名 PUT 有效期
  // UPLOAD_URL_TTL_SEC，6 小时）——文件最晚在窗口内传完，complete 再晚
  // 调用也不该把到期时间无限往后推（旧写法拖 10 天才 complete 能白拿
  // 10 天 + 满时长）。封顶后 newExpiresAt <= created_at + 上传窗口 +
  // 用户选定时长；窗口内（6 小时）传完的慢传不受影响，仍拿满时长。
  const shift = Math.min(Math.max(0, now - row.created_at), UPLOAD_URL_TTL_SEC);
  const newExpiresAt = row.expires_at + shift;
  if (newExpiresAt <= now) {
    // 位移后仍过期（异常行）：与 cleanup 同语义——先删 R2 对象，删成功
    // 才删记录；对象删失败时保留记录，等定时清理重试。记录先删掉的话
    // cleanup 就无从查起，对象只能等 R2 桶生命周期兜底、成孤儿。
    let objectDeleted = true;
    try { await env.FILES.delete(row.r2_key); } catch { objectDeleted = false; }
    if (objectDeleted) {
      try { await run(env, 'DELETE FROM files WHERE id = ?', id); } catch { /* 记录没删掉，下次清理再清 */ }
    }
    return fail('expired', '这个上传已过期', 410);
  }

  let head = null;
  try { head = await env.FILES.head(row.r2_key); } catch { head = null; }
  if (!head) return fail('not_uploaded', '文件还没传到服务器，请重新上传', 400);
  if (head.size !== row.size_bytes) {
    // 大小对不上的对象直接删掉：留着就是无主占用（记录还是 pending，
    // 不删它最长要等 pending 超时清理才回收），删失败也不阻塞报错返回
    try { await env.FILES.delete(row.r2_key); } catch { /* 下次清理兜底 */ }
    return fail('size_mismatch', `文件大小不一致（应为 ${row.size_bytes} 字节，实际 ${head.size} 字节），请重新上传`, 400);
  }

  const upd = await run(env, "UPDATE files SET status = 'ready', expires_at = ? WHERE id = ? AND status = 'pending'", newExpiresAt, id);
  // 并发 complete：若本次 UPDATE 没改到行（changes=0），说明另一个请求已
  // 先转 ready 并写了它的到期时间——回读库里的真实值返回，不拿本地算的
  // newExpiresAt 冒充，避免返回值与库内不一致。
  if (upd && upd.meta && upd.meta.changes === 0) {
    const fresh = await first(env, 'SELECT * FROM files WHERE id = ?', id);
    if (fresh && fresh.status === 'ready') {
      return json({ id, download_url: downloadUrl, expires_at: fresh.expires_at, max_downloads: fresh.max_downloads, name: fresh.orig_name, size: fresh.size_bytes });
    }
  }
  return json({ id, download_url: downloadUrl, expires_at: newExpiresAt, max_downloads: row.max_downloads, name: row.orig_name, size: row.size_bytes });
}
