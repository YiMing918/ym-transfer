// http.js — 请求/响应小工具：JSON 响应、错误、读 body、取 IP、时间
// 全站接口的响应格式都从这里出（{ok:true,data} / {ok:false,error}）。

export const nowSec = () => Math.floor(Date.now() / 1000);

// 基础安全响应头：所有 JSON/错误响应统一带上（静态首页另有 public/_headers 一份）
export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify({ ok: true, data }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...extraHeaders },
  });
}

export function fail(code, message, status = 400) {
  return new Response(JSON.stringify({ ok: false, error: { code, message } }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS },
  });
}

// 业务代码里 throw new HttpError(...)，由各路由转成 fail 响应
export class HttpError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
export const badRequest = (msg) => new HttpError('bad_request', msg, 400);
export const unauthorized = (msg = '密钥不对') => new HttpError('unauthorized', msg, 401);
export const notFound = (msg = '不存在') => new HttpError('not_found', msg, 404);
export const tooMany = (msg = '操作太频繁，请稍后再试') => new HttpError('rate_limited', msg, 429);

export async function readJson(request) {
  try {
    const t = await request.text();
    if (!t) return {};
    return JSON.parse(t);
  } catch { throw badRequest('请求内容不是合法 JSON'); }
}

// 客户端 IP：只信 Cloudflare 注入的 cf-connecting-ip。x-forwarded-for 是
// 请求方自己能写的头、可以伪造（换个 IP 就能绕限流），不再拿它兜底；
// 没有 cf-connecting-ip（本地测试等）时统一记 0.0.0.0。
export function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || '0.0.0.0';
}

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// IP 只存哈希，不落明文。盐只从环境变量 IP_SALT 读，不再用写死在代码里
// 的公开默认值兜底——公开的盐等于没盐（谁都能离线反推 IP）；没配 IP_SALT
// 时哈希仍能用于限流计数，只是少了这层隐私保护，部署时强烈建议配。
export async function ipHash(env, request) {
  return sha256Hex((env.IP_SALT || '') + '|' + clientIp(request));
}

// 轻量限流（复用 rate_limits 表，与 upload-init 同范式）：按 IP 哈希 + 小时
// 窗口原子自增拿计数，超限回滚刚自增的那一下。返回 true=放行、false=超限、
// null=计数失败（调用方按各自口径关门处理，不 fail-open 放行）。
export async function hitRateLimit(env, request, scope, limitPerHour) {
  const ip = await ipHash(env, request);
  const now = nowSec();
  const windowStart = now - (now % 3600);
  const bucket = `${scope}:${ip}`;
  let row = null;
  try {
    row = await env.DB.prepare(`INSERT INTO rate_limits (bucket, window_start, count) VALUES (?, ?, 1)
      ON CONFLICT(bucket, window_start) DO UPDATE SET count = count + 1 RETURNING count`).bind(bucket, windowStart).first();
  } catch { row = null; }
  if (!row || typeof row.count !== 'number') return null;
  if (row.count > limitPerHour) {
    try {
      await env.DB.prepare('UPDATE rate_limits SET count = count - 1 WHERE bucket = ? AND window_start = ? AND count > 0').bind(bucket, windowStart).run();
    } catch { /* 回滚失败由 cleanup 的旧行清理兜底 */ }
    return false;
  }
  return true;
}

export function randomToken(bytes = 32) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function isoOf(sec) { return sec ? new Date(sec * 1000).toISOString() : null; }

// HTML 转义：一切不可信文本进页面前必过
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export const escAttr = esc;
