// api/upload-complete.js — 上传完成确认：浏览器 PUT 到 R2 成功后调本接口
// 后端用 R2 HEAD 校验对象确实存在且大小与声明一致，才把状态从 pending 改为 ready。
// 幂等：已经是 ready 的重复调用直接返回成功。
// M11（v1.1.7）：新上传的对象在临时键 staging/<uuid> 上——校验通过后用
// S3 CopyObject 把它复制到正式键 files/<uuid>（字节只在 R2 内部搬、不经
// Worker 内存），对正式对象再 HEAD 验一次大小，然后把记录的 r2_key 改成
// 正式键、删掉临时对象。这样确认之后，原预签名 PUT 地址（没法提前作废、
// 有效期 6 小时）再 PUT 也只能写已废弃的临时位置，覆盖不了正式文件。
// 存量老上传（升级部署瞬间还在传的 pending，r2_key 是旧式 f/… 键、对象
// 就在正式位置）走原路径直接转 ready，不复制、不打断。
// v1.1.8：转 ready 时顺手把对象的 etag 存进 content_md5（单次 PUT 的
// etag 即内容 MD5，见 md5FromEtag）并在响应里带回，前端结果面板显示
// 一行指纹供核对；取不到或写不进（0005 没跑的老库）都留空，不影响确认。

import { json, fail, readJson, nowSec, hitRateLimit, tokenHashMatches } from '../_lib/http.js';
import { first, run } from '../_lib/db.js';
import { UPLOAD_URL_TTL_SEC } from '../_lib/consts.js';
import { isStagingKey, finalKeyForStaging, s3CopyObject } from '../_lib/r2sign.js';

// 从 R2 对象 etag 里取内容指纹：单次预签名 PUT 的对象 etag 就是内容
// MD5（32 位十六进制，绑定给的 etag 不带引号、httpEtag 带引号，两
// 种都剥掉再验格式）。多段上传的 etag 带「-段数」后缀、对不上格式，
// 一律当没取到返回 null——留空不显示，胜过存个错指纹误导核对。
function md5FromEtag(etag) {
  const s = String(etag ?? '').replace(/["\s]/g, '').toLowerCase();
  return /^[0-9a-f]{32}$/.test(s) ? s : null;
}

// 指纹落库只是尽力而为：0005 迁移没跑的库没有 content_md5 列，写入
// 会抛错——吞掉。确认成功与否只看原有的大小校验，指纹缺失不许把
// complete 打成失败（与删除令牌「没跑迁移就不生效、其余照旧」同口径）。
async function saveContentMd5(env, id, md5) {
  if (!md5) return;
  try { await run(env, 'UPDATE files SET content_md5 = ? WHERE id = ?', md5, id); } catch { /* 老库没这列：跳过 */ }
}

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
    // 幂等重确认：存过指纹就一并带回（老文件没存过则不带这个字段）
    const savedMd5 = md5FromEtag(row.content_md5);
    return json({ id, download_url: downloadUrl, expires_at: row.expires_at, max_downloads: row.max_downloads, name: row.orig_name, size: row.size_bytes, ...(savedMd5 ? { content_md5: savedMd5 } : {}) });
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
      // M11：新流程的 pending 若此前有过一次转正尝试、正式键上可能留了
      // 一份复制，顺手一并删掉（删不到/没有也不影响主语义）
      const fk = finalKeyForStaging(row.r2_key);
      if (fk) { try { await env.FILES.delete(fk); } catch { /* 兜底同上 */ } }
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

  if (isStagingKey(row.r2_key)) {
    // —— M11 新流程：临时对象转正 ——
    const stagingKey = row.r2_key;
    const finalKey = finalKeyForStaging(stagingKey);
    // 复制失败不转 ready、不删临时对象：记录还是 pending、临时对象还在，
    // 用户重试确认即可接着转正，不用重传（复制是 R2 内部搬字节，可重试）。
    try {
      await s3CopyObject(env, stagingKey, finalKey);
    } catch (e) {
      console.error('s3CopyObject failed:', e);
      return fail('copy_failed', '文件确认失败（转存出错），请稍后重试确认，不用重新上传', 500);
    }
    // 复制后对正式对象再 HEAD 验一次大小（短重试兜住存储侧短暂延迟）：
    // 验不过就删掉这份坏复制、保留临时对象与 pending 记录，等重试。
    let finalHead = null;
    for (let i = 0; i < 3 && !finalHead; i++) {
      try { finalHead = await env.FILES.head(finalKey); } catch { finalHead = null; }
      if (!finalHead && i < 2) await new Promise((r) => setTimeout(r, 200));
    }
    if (!finalHead || finalHead.size !== row.size_bytes) {
      try { await env.FILES.delete(finalKey); } catch { /* 坏复制删不掉时由清理兜底 */ }
      return fail('copy_failed', '文件确认失败（转存校验没过），请稍后重试确认，不用重新上传', 500);
    }
    // 指纹取正式对象的 etag（复制不改字节，与临时对象同一份内容）
    const contentMd5 = md5FromEtag(finalHead.etag);
    // 先把记录转 ready 并把 r2_key 换成正式键，再删临时对象：顺序反过来
    // （先删临时、后改记录）一旦改记录失败，记录会指着已删的临时键、
    // 正式对象反而成了无记录孤儿。临时对象删失败不阻塞成功返回——它已
    // 不被任何记录引用，删文件的各路径会顺手再删一次（见 delete/cleanup），
    // 最终还有 R2 桶 10 天生命周期兜底。
    const upd2 = await run(env, "UPDATE files SET status = 'ready', expires_at = ?, r2_key = ? WHERE id = ? AND status = 'pending'", newExpiresAt, finalKey, id);
    await saveContentMd5(env, id, contentMd5);
    try { await env.FILES.delete(stagingKey); } catch { /* 残留临时对象由删文件路径顺手清 + 生命周期兜底 */ }
    if (upd2 && upd2.meta && upd2.meta.changes === 0) {
      const fresh = await first(env, 'SELECT * FROM files WHERE id = ?', id);
      if (fresh && fresh.status === 'ready') {
        const freshMd5 = md5FromEtag(fresh.content_md5) || contentMd5;
        return json({ id, download_url: downloadUrl, expires_at: fresh.expires_at, max_downloads: fresh.max_downloads, name: fresh.orig_name, size: fresh.size_bytes, ...(freshMd5 ? { content_md5: freshMd5 } : {}) });
      }
    }
    return json({ id, download_url: downloadUrl, expires_at: newExpiresAt, max_downloads: row.max_downloads, name: row.orig_name, size: row.size_bytes, ...(contentMd5 ? { content_md5: contentMd5 } : {}) });
  }

  // 老路径（存量旧式键）：指纹取这份已验过大小的对象的 etag
  const contentMd5 = md5FromEtag(head.etag);
  const upd = await run(env, "UPDATE files SET status = 'ready', expires_at = ? WHERE id = ? AND status = 'pending'", newExpiresAt, id);
  await saveContentMd5(env, id, contentMd5);
  // 并发 complete：若本次 UPDATE 没改到行（changes=0），说明另一个请求已
  // 先转 ready 并写了它的到期时间——回读库里的真实值返回，不拿本地算的
  // newExpiresAt 冒充，避免返回值与库内不一致。
  if (upd && upd.meta && upd.meta.changes === 0) {
    const fresh = await first(env, 'SELECT * FROM files WHERE id = ?', id);
    if (fresh && fresh.status === 'ready') {
      const freshMd5 = md5FromEtag(fresh.content_md5) || contentMd5;
      return json({ id, download_url: downloadUrl, expires_at: fresh.expires_at, max_downloads: fresh.max_downloads, name: fresh.orig_name, size: fresh.size_bytes, ...(freshMd5 ? { content_md5: freshMd5 } : {}) });
    }
  }
  return json({ id, download_url: downloadUrl, expires_at: newExpiresAt, max_downloads: row.max_downloads, name: row.orig_name, size: row.size_bytes, ...(contentMd5 ? { content_md5: contentMd5 } : {}) });
}
