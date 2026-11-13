// api/upload-init.js — 创建上传：校验大小/有效期 → 查站内容量 → 限流 → 写元数据 → 签发 PUT 预签名 URL
// 文件字节不经过本接口，浏览器拿 URL 直接 PUT 到 R2（单次 PUT 上限 5GB）。

import { json, fail, readJson, nowSec, ipHash, randomToken, HttpError } from '../_lib/http.js';
import { first, run } from '../_lib/db.js';
import { presignPut, newObjectKey } from '../_lib/r2sign.js';
import { MAX_FILE_BYTES, TOTAL_CAP_BYTES, UPLOAD_URL_TTL_SEC, PENDING_TTL_SEC } from '../_lib/consts.js';

export { MAX_FILE_BYTES, TOTAL_CAP_BYTES };
const RATE_LIMIT_PER_HOUR = 10;                            // 同一 IP 每小时最多创建 10 次上传

function cleanFileName(name) {
  let n = String(name ?? '未命名文件').replace(/[\u0000-\u001f\u007f]/g, '').replace(/[\\/]/g, '_').trim();
  if (!n) n = '未命名文件';
  if (n.length > 200) n = n.slice(0, 200);
  return n;
}

// 站内已用字节：未过期的 ready + 保留期内新建的 pending（超时 pending 不占容量，等清理删）
async function usedBytes(env, now) {
  const row = await first(env, `SELECT COALESCE(SUM(size_bytes),0) AS total FROM files
    WHERE (status = 'ready' AND expires_at > ?)
       OR (status = 'pending' AND created_at > ? AND expires_at > ?)`,
    now, now - PENDING_TTL_SEC, now);
  return row ? row.total : 0;
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
  const mime = typeof body.mime === 'string' && body.mime ? body.mime.slice(0, 200) : 'application/octet-stream';
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

  // 限流：同一 IP 每小时最多创建 10 次上传
  const now = nowSec();
  const ip = await ipHash(env, request);
  const windowStart = now - (now % 3600);
  const bucket = `upload:${ip}`;
  const rl = await first(env, 'SELECT count FROM rate_limits WHERE bucket = ? AND window_start = ?', bucket, windowStart);
  if (rl && rl.count >= RATE_LIMIT_PER_HOUR) {
    return fail('rate_limited', '操作太频繁，请稍后再试', 429);
  }

  // 容量：站内已用 + 本次 <= 10GB，否则拒绝
  const used = await usedBytes(env, now);
  if (used + size > TOTAL_CAP_BYTES) {
    return fail('quota_full', '站内空间不足（总共 10GB），请等旧文件过期删除后再试', 413);
  }

  const id = randomToken(16); // 32 位 hex，不可猜
  const r2Key = newObjectKey();
  const expiresAt = now + expiresHours * 3600;

  await run(env, `INSERT INTO rate_limits (bucket, window_start, count) VALUES (?, ?, 1)
    ON CONFLICT(bucket, window_start) DO UPDATE SET count = count + 1`, bucket, windowStart);
  await run(env, `INSERT INTO files (id, r2_key, orig_name, mime, size_bytes, status, expires_at, downloads, max_downloads, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, 0, ?, ?)`, id, r2Key, name, mime, size, expiresAt, maxDownloads, now);

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
    // 签发失败：删掉刚建的 pending 行，不占容量
    await run(env, 'DELETE FROM files WHERE id = ?', id);
    return fail('sign_failed', '签发上传地址失败：' + e.message, 500);
  }

  const base = new URL(request.url);
  return json({
    id,
    upload_url: signed.url,
    upload_headers: signed.headers,
    upload_expires_in: signed.expires_in,
    download_url: `${base.origin}/d/${id}`,
    expires_at: expiresAt,
    max_downloads: maxDownloads,
    used_bytes: used,
    total_cap_bytes: TOTAL_CAP_BYTES,
    max_file_bytes: MAX_FILE_BYTES,
  });
}
