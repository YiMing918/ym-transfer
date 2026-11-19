// api/upload-init.js — 创建上传：校验大小/有效期 → 查站内容量 → 限流 → 写元数据 → 签发 PUT 预签名 URL
// 文件字节不经过本接口，浏览器拿 URL 直接 PUT 到 R2（单次 PUT 上限 5GB）。

import { json, fail, readJson, nowSec, ipHash, randomToken, sha256Hex, HttpError } from '../_lib/http.js';
import { first, run } from '../_lib/db.js';
import { presignPut, newStagingKey } from '../_lib/r2sign.js';
import { MAX_FILE_BYTES, TOTAL_CAP_BYTES, UPLOAD_URL_TTL_SEC, PENDING_TTL_SEC, PENDING_CAP_BYTES } from '../_lib/consts.js';

export { MAX_FILE_BYTES, TOTAL_CAP_BYTES };
const RATE_LIMIT_PER_HOUR = 10;                            // 同一 IP 每小时最多创建 10 次上传

function cleanFileName(name) {
  let n = String(name ?? '未命名文件').replace(/[\u0000-\u001f\u007f]/g, '').replace(/[\\/]/g, '_').trim();
  if (!n) n = '未命名文件';
  // 按码点截断：用 length/slice 按 UTF-16 码元切，会把 Emoji 等代理对从中间
  // 切断、留半个坏字符；展开成码点数组再截就不会。
  const chars = [...n];
  if (chars.length > 200) n = chars.slice(0, 200).join('');
  return n;
}

// mime 与文件名同口径（C-42）：先清控制字符，再校验 token/token 形态。
// 控制字符（尤其 CRLF）若原样进 presignPut 的签名串/响应头，能污染规范
// 请求串；不合形态的串同样不许进。合法返回清洗后的值，不合法返回 null
//（由调用方按现有参数校验风格回 400 bad_mime）；未传/空串回落默认类型。
const MIME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+\/[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
function cleanMime(mime) {
  if (typeof mime !== 'string' || !mime) return 'application/octet-stream';
  const cleaned = mime.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
  if (!cleaned) return 'application/octet-stream';
  return MIME_RE.test(cleaned) ? cleaned : null;
}

// pending 占额封顶（C-12）：pending 只是「声明要传」还没传一字节，空声明
// 若按声明大小全额占容量，刷一批 pending 就能把全站 10GB 堵死。口径：
// usedBytes 里 pending 部分最多计总盘的 1/3（PENDING_CAP_BYTES，定义在
// consts.js、stats 共用同一口径），ready 全额计。正常慢传不受影响——
// 文件照样能建、照样传，封顶只影响「pending 能替别人堵多少容量」。
// 站内已用字节：未过期的 ready（全额）+ 保留期内新建的 pending（封顶
// PENDING_CAP_BYTES；超时 pending 不占容量，等清理删）
async function usedBytes(env, now) {
  const row = await first(env, `SELECT
      COALESCE(SUM(CASE WHEN status = 'ready' THEN size_bytes ELSE 0 END), 0) AS ready_total,
      COALESCE(SUM(CASE WHEN status = 'pending' THEN size_bytes ELSE 0 END), 0) AS pending_total
    FROM files
    WHERE (status = 'ready' AND expires_at > ?)
       OR (status = 'pending' AND created_at > ? AND expires_at > ?)`,
    now, now - PENDING_TTL_SEC, now);
  if (!row) return 0;
  return row.ready_total + Math.min(row.pending_total, PENDING_CAP_BYTES);
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
  const size = body.size;
  const expiresHours = body.expires_hours;
  const name = cleanFileName(body.name);
  const mime = cleanMime(body.mime);
  if (mime === null) {
    return fail('bad_mime', '文件类型不合法', 400);
  }
  // 下载次数上限：不传或 null = 不限；传了必须是 1、5 或 10
  const maxDownloads = body.max_downloads === undefined || body.max_downloads === null ? null : body.max_downloads;

  if (!Number.isInteger(size) || size < 1 || size > MAX_FILE_BYTES) {
    return fail('bad_size', '文件大小不合法（单个文件 1 字节～5GB）', 400);
  }
  if (![1, 6, 12, 24, 72, 168].includes(expiresHours)) {
    return fail('bad_expiry', '有效期只能是 1、6、12 小时或 1、3、7 天', 400);
  }
  if (maxDownloads !== null && ![1, 5, 10].includes(maxDownloads)) {
    return fail('bad_max_downloads', '下载次数只能是不限、1 次、5 次或 10 次', 400);
  }

  const now = nowSec();
  const ip = await ipHash(env, request);
  const windowStart = now - (now % 3600);
  const bucket = `upload:${ip}`;

  // 容量：站内已用 + 本次 <= 10GB，否则拒绝（放在限流占位之前，
  // 容量满的请求不消耗限流名额，与此前口径一致）
  const used = await usedBytes(env, now);
  if (used + size > TOTAL_CAP_BYTES) {
    return fail('quota_full', '站内空间不足（总共 10GB），请等旧文件过期删除后再试', 413);
  }

  // 限流（C-11）：同一 IP 每小时最多创建 10 次上传。改成先原子自增拿
  // RETURNING count 再判超限——单条语句完成「加 + 读」，并发请求各自
  // 拿到不同计数，不再像旧写法「先 SELECT 查、后 INSERT 加」那样一起
  // 过线。超限则回滚刚自增的那一下并回 429（与 d/[id] 先占位范式一致）；
  // 计数拿不到（数据库异常）关门回 503，不放行。
  let rlRow = null;
  try {
    rlRow = await first(env, `INSERT INTO rate_limits (bucket, window_start, count) VALUES (?, ?, 1)
      ON CONFLICT(bucket, window_start) DO UPDATE SET count = count + 1 RETURNING count`, bucket, windowStart);
  } catch { rlRow = null; }
  if (!rlRow || typeof rlRow.count !== 'number') {
    return fail('rate_limit_failed', '服务暂时不可用（限流计数失败），请稍后再试', 503);
  }
  if (rlRow.count > RATE_LIMIT_PER_HOUR) {
    try { await run(env, 'UPDATE rate_limits SET count = count - 1 WHERE bucket = ? AND window_start = ? AND count > 0', bucket, windowStart); } catch { /* 回滚失败由旧行 7 天清理兜底 */ }
    return fail('rate_limited', '操作太频繁，请稍后再试', 429);
  }

  const id = randomToken(16); // 32 位 hex，不可猜
  // M11：预签名 PUT 地址指向临时键 staging/<uuid>，不直接写正式位置。
  // 预签名地址没法提前作废（有效期仍是 6 小时、慢传口径不变），但确认
  // 上传时对象会被复制到正式键 files/<uuid> 并删掉临时对象（见
  // upload-complete.js）——之后这个地址就算漏出去，也只能往已废弃的
  // 临时位置写，动不了正式文件。pending 期间记录的 r2_key 就是临时键，
  // 定时清理按记录删键时删的正是它，与旧流程半截文件的清理口径一致。
  const r2Key = newStagingKey();
  const expiresAt = now + expiresHours * 3600;

  // 删除令牌（H4/M1）：建单时生成，明文只在这一次响应里给上传者，库里
  // 只存 SHA-256 哈希。凭它能提前删文件、complete 确认也要验它（所有权）。
  // 迁移 0004 没跑的库没有 delete_token_hash 列：带列 INSERT 会报缺列，
  // 退回不带列的老写法、这次不发令牌——上传/下载一切照旧，绝不让没迁移
  // 的库传不了文件（与 ym-mail email_verified 列同款兜底）。
  const deleteToken = randomToken(16);
  const deleteTokenHash = await sha256Hex(deleteToken);
  let tokenIssued = true;
  try {
    await run(env, `INSERT INTO files (id, r2_key, orig_name, mime, size_bytes, status, expires_at, downloads, max_downloads, created_at, delete_token_hash)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, 0, ?, ?, ?)`, id, r2Key, name, mime, size, expiresAt, maxDownloads, now, deleteTokenHash);
  } catch (e) {
    if (!/no such column|has no column/i.test(String((e && e.message) || e))) throw e;
    tokenIssued = false;
    await run(env, `INSERT INTO files (id, r2_key, orig_name, mime, size_bytes, status, expires_at, downloads, max_downloads, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, 0, ?, ?)`, id, r2Key, name, mime, size, expiresAt, maxDownloads, now);
  }

  // 容量复查（写入后再算一次）：前面的「先查后写」在并发下会一起过线，
  // 插入后把自己算进去重查，超了就删行拒绝——把超额收敛到单请求粒度内
  const usedAfter = await usedBytes(env, now);
  if (usedAfter > TOTAL_CAP_BYTES) {
    await run(env, 'DELETE FROM files WHERE id = ?', id);
    return fail('quota_full', '站内空间不足（总共 10GB），请等旧文件过期删除后再试', 413);
  }

  let signed;
  try {
    signed = await presignPut(env, r2Key, mime, UPLOAD_URL_TTL_SEC, new Date(), size);
  } catch (e) {
    // 签发失败：删掉刚建的 pending 行，不占容量。内部错误细节只记日志、
    // 不回吐给请求方（可能带凭据配置等内部信息）。
    console.error('presignPut failed:', e);
    await run(env, 'DELETE FROM files WHERE id = ?', id);
    return fail('sign_failed', '签发上传地址失败，请稍后再试', 500);
  }

  const base = new URL(request.url);
  return json({
    id,
    upload_url: signed.url,
    upload_headers: signed.headers,
    upload_expires_in: signed.expires_in,
    download_url: `${base.origin}/d/${id}`,
    delete_token: tokenIssued ? deleteToken : null,
    expires_at: expiresAt,
    max_downloads: maxDownloads,
    used_bytes: usedAfter,
    total_cap_bytes: TOTAL_CAP_BYTES,
    max_file_bytes: MAX_FILE_BYTES,
  });
}
