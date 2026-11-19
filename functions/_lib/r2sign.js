// r2sign.js — R2 的 S3 预签名 URL 签发（浏览器直传，文件字节绝不经过 Worker）
// 做法：用 WebCrypto 手写 SigV4 查询串签名（aws4fetch 同款轻量路线，不引重 SDK）。
// 凭据只从环境变量读：R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_S3_ENDPOINT / R2_S3_BUCKET。
// 注意（官方限制）：预签名 URL 只能用 S3 API 域名，不能用自定义域名签名——上传域名与访问域名分离是正常形态。
// 对象键铁律：不用原始文件名（避中文名/重名/隐私）、不用自增 ID（防枚举），一律 uuid。
// 查询串铁律：按 AWS SigV4 要求，键按字节序排序、值按 RFC 3986 编码（空格是 %20 不是 +），
// 规范查询串与最终 URL 用同一份构建结果，签名才对得上。

const enc = new TextEncoder();
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? enc.encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}
async function sha256HexOf(text) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const hexOf = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
// RFC 3986 编码：encodeURIComponent 再补编 ! ' ( ) *（SigV4 要求这些也编码）
const uriEnc = (s) => encodeURIComponent(s).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

// 构建规范查询串：键排序、值 RFC 3986 编码；返回的串直接拼进最终 URL，签名与 URL 严格一致
function buildQuery(params) {
  return Object.keys(params).sort().map((k) => `${uriEnc(k)}=${uriEnc(String(params[k]))}`).join('&');
}

async function signRequest({ method, url, canonicalQuery, signedHeaders, canonicalHeaders, payloadHash, accessKey, secretKey, amzDate, dateStamp }) {
  const region = 'auto';
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const canonicalRequest = [method, url.pathname, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256HexOf(canonicalRequest)].join('\n');
  const kDate = await hmac('AWS4' + secretKey, dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, 's3');
  const kSigning = await hmac(kService, 'aws4_request');
  return hexOf(await hmac(kSigning, stringToSign));
}

function getCreds(env) {
  const endpoint = (env.R2_S3_ENDPOINT || '').replace(/\/$/, '');
  const bucket = env.R2_S3_BUCKET;
  const accessKey = env.R2_ACCESS_KEY_ID;
  const secretKey = env.R2_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKey || !secretKey) {
    throw new Error('R2 S3 凭据未配置（R2_S3_ENDPOINT / R2_S3_BUCKET / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY）');
  }
  return { endpoint, bucket, accessKey, secretKey };
}

function amzDates(now = new Date()) {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

function objectUrl(endpoint, bucket, key) {
  return new URL(`${endpoint}/${bucket}/${key.split('/').map(uriEnc).join('/')}`);
}

// 对象键（旧）：f/<年>/<月>/<uuid>，不含原文件名。
// v1.1.7 起新上传不再用这个键：上传先落 staging/ 临时键、确认后复制到
// files/ 正式键（见下面三个函数），堵预签名 PUT 地址在确认后仍能覆盖
// 正式文件的口子（M11）。本函数只留作存量老记录键形态的说明，新代码
// 不要再调用它生成键。
export function newObjectKey() {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const uuid = crypto.randomUUID().replace(/-/g, '');
  return `f/${yyyy}/${mm}/${uuid}`;
}

// 对象键（新，M11）：临时键 staging/<uuid> 与正式键 files/<uuid> 共用同一
// 个随机 uuid 后缀——正式键能由临时键换前缀直接算出，不用多存一列、也不
// 用链接 ID 当键（链接 ID 是下载凭证，写进上传地址路径会顺带把下载凭证
// 漏给拿到上传地址的人；uuid 后缀与链接 ID 互相独立、谁也不含谁）。
export function newStagingKey() {
  const uuid = crypto.randomUUID().replace(/-/g, '');
  return `staging/${uuid}`;
}
export function isStagingKey(key) {
  return typeof key === 'string' && key.startsWith('staging/');
}
export function finalKeyForStaging(stagingKey) {
  return isStagingKey(stagingKey) ? `files/${stagingKey.slice('staging/'.length)}` : null;
}
export function stagingKeyForFinal(finalKey) {
  return typeof finalKey === 'string' && finalKey.startsWith('files/')
    ? `staging/${finalKey.slice('files/'.length)}`
    : null;
}

// 签发一个 PUT 预签名 URL：签名里锁死 Content-Type，类型不符上传会被 S3 拒绝
// expiresSec 最长 7 天；传大文件要留足时间，默认 6 小时
// nowDate 仅供本地测试固定时间用，生产调用不传
// contentLength（可选）：传入时一并签进签名头——S3 侧会核对实际上传字节数，
// 声明大小与实传不符在 PUT 时就被拒，不再等 complete 才发现（v1.0 只签了
// content-type，声明 1 字节实传 5GB 也能过）
// 进签名串/响应头之前清控制字符（C-42 第二道防线）：contentType 会原样
// 拼进规范请求串与 Content-Type 头，CRLF 等控制字符能污染签名串结构。
// upload-init 已做 token/token 形态校验，这里再兜底清洗一遍。
function cleanContentType(contentType) {
  const cleaned = String(contentType ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return cleaned || 'application/octet-stream';
}

export async function presignPut(env, key, contentType, expiresSec = 21600, nowDate = new Date(), contentLength = null) {
  contentType = cleanContentType(contentType);
  const { endpoint, bucket, accessKey, secretKey } = getCreds(env);
  const { amzDate, dateStamp } = amzDates(nowDate);
  const url = objectUrl(endpoint, bucket, key);
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const hasLen = contentLength !== null && contentLength !== undefined;
  const signedHeaders = hasLen ? 'content-length;content-type;host' : 'content-type;host';
  const query = buildQuery({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKey}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresSec),
    'X-Amz-SignedHeaders': signedHeaders,
  });
  const canonicalHeaders =
    (hasLen ? `content-length:${contentLength}\n` : '') +
    `content-type:${contentType}\nhost:${url.host}\n`;
  const signature = await signRequest({
    method: 'PUT', url, canonicalQuery: query, signedHeaders,
    canonicalHeaders, payloadHash: 'UNSIGNED-PAYLOAD', accessKey, secretKey, amzDate, dateStamp,
  });
  const headers = { 'Content-Type': contentType };
  if (hasLen) headers['Content-Length'] = String(contentLength);
  return { url: `${url.origin}${url.pathname}?${query}&X-Amz-Signature=${signature}`, headers, expires_in: expiresSec };
}

// S3 CopyObject（服务端签名调用，M11）：把对象在 R2 内部从 srcKey 复制到
// dstKey，文件字节只在 R2 内部搬、不流经 Worker 内存（大文件也不会爆）。
// R2 的绑定 API 没有 copy 操作，只能走 S3 API：用与预签名同一套 SigV4，
// 改成 Authorization 头签名（非查询串预签名）。复制会连源对象的
// Content-Type 等元数据一起带过去（COPY 语义），与直传时的类型一致。
// 成功返回 true；HTTP 非 2xx 或网络失败抛错，由调用方决定重试口径。
export async function s3CopyObject(env, srcKey, dstKey) {
  const { endpoint, bucket, accessKey, secretKey } = getCreds(env);
  const { amzDate, dateStamp } = amzDates(new Date());
  const url = objectUrl(endpoint, bucket, dstKey);
  const copySource = `/${bucket}/${srcKey.split('/').map(uriEnc).join('/')}`;
  const payloadHash = await sha256HexOf('');
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-copy-source;x-amz-date';
  const canonicalHeaders =
    `host:${url.host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-copy-source:${copySource}\n` +
    `x-amz-date:${amzDate}\n`;
  const signature = await signRequest({
    method: 'PUT', url, canonicalQuery: '', signedHeaders,
    canonicalHeaders, payloadHash, accessKey, secretKey, amzDate, dateStamp,
  });
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const res = await fetch(url.toString(), {
    method: 'PUT',
    headers: {
      Authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
      'x-amz-copy-source': copySource,
    },
  });
  if (!res.ok) {
    // 错误体可能含内部细节：只把状态码带进异常给调用方记日志，不回吐请求方
    try { await res.text(); } catch { /* 忽略 */ }
    throw new Error(`CopyObject 失败（HTTP ${res.status}）`);
  }
  try { await res.text(); } catch { /* 忽略 */ }
  return true;
}

// RFC 5987 文件名编码（下载时 Content-Disposition 用）：UTF-8 百分号编码，只留 attr-char
export function rfc5987(name) {
  return encodeURIComponent(String(name)).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

// 签发一个 GET 预签名 URL：下载时浏览器直接从 R2 取文件，不经过 Worker
// filename：下载时保存的文件名（原文件名，RFC 5987 编码进 response-content-disposition）
// contentType：下载时的 Content-Type
// now 仅供本地测试固定时间用，生产调用不传
export async function presignGet(env, key, { contentType, filename, expiresSec = 3600, now } = {}) {
  const { endpoint, bucket, accessKey, secretKey } = getCreds(env);
  const { amzDate, dateStamp } = amzDates(now || new Date());
  const url = objectUrl(endpoint, bucket, key);
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const params = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKey}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresSec),
    'X-Amz-SignedHeaders': 'host',
  };
  if (filename) params['response-content-disposition'] = `attachment;filename*=UTF-8''${rfc5987(filename)}`;
  if (contentType) params['response-content-type'] = cleanContentType(contentType);
  const query = buildQuery(params);
  const canonicalHeaders = `host:${url.host}\n`;
  const signature = await signRequest({
    method: 'GET', url, canonicalQuery: query, signedHeaders: 'host',
    canonicalHeaders, payloadHash: 'UNSIGNED-PAYLOAD', accessKey, secretKey, amzDate, dateStamp,
  });
  return { url: `${url.origin}${url.pathname}?${query}&X-Amz-Signature=${signature}`, expires_in: expiresSec };
}
