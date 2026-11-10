// smoke.mjs — 本地冒烟测试（Node 内置模块，零依赖）
// 覆盖：SigV4 预签名（独立验证器重算签名）、upload-init / upload-complete /
// 下载跳转 / 清理 / 统计 / 限流 / 容量上限 / 文件名清洗。
// 用法：node scripts/smoke.mjs；任一失败即 exit 1。
import assert from 'node:assert';
import { createHash, createHmac } from 'node:crypto';
import { createMockEnv, callHandler } from './mock.mjs';
import { presignPut, presignGet } from '../functions/_lib/r2sign.js';
import * as uploadInit from '../functions/api/upload-init.js';
import * as uploadComplete from '../functions/api/upload-complete.js';
import * as cleanupApi from '../functions/api/cleanup.js';
import * as statsApi from '../functions/api/stats.js';
import * as downloadRoute from '../functions/d/[id].js';

const SECRET = 'test-secret-access-key-0123456789abcdef';
const ENDPOINT = 'https://00000000000000000000000000000000.r2.cloudflarestorage.com';
const FIXED_NOW = new Date('2026-11-10T00:00:00.000Z');

const rfc3986 = (s) => encodeURIComponent(s).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

// 独立验证器：按 AWS SigV4 规范，用 node:crypto（与 r2sign.js 的 WebCrypto 是两套实现）
// 从预签名 URL 反推签名，比对是否一致。两套实现一致 → 签名算法大概率正确。
function verifyPresigned(urlStr, secretKey, { method, contentType }) {
  const url = new URL(urlStr);
  const params = new URLSearchParams(url.search);
  const sig = params.get('X-Amz-Signature');
  if (!sig) return { ok: false, reason: 'URL 里没有 X-Amz-Signature' };
  params.delete('X-Amz-Signature');
  const cq = [...params.keys()].sort().map((k) => `${rfc3986(k)}=${rfc3986(params.get(k))}`).join('&');
  const amzDate = params.get('X-Amz-Date');
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  let canonicalHeaders, signedHeaders;
  if (method === 'PUT') {
    canonicalHeaders = `content-type:${contentType}\nhost:${url.host}\n`;
    signedHeaders = 'content-type;host';
  } else {
    canonicalHeaders = `host:${url.host}\n`;
    signedHeaders = 'host';
  }
  const canonicalRequest = [method, url.pathname, cq, canonicalHeaders, signedHeaders, 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
  const h = (key, msg) => createHmac('sha256', key).update(msg).digest();
  const kDate = h('AWS4' + secretKey, dateStamp);
  const kRegion = h(kDate, 'auto');
  const kService = h(kRegion, 's3');
  const kSigning = h(kService, 'aws4_request');
  const calc = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return { ok: calc === sig, reason: calc === sig ? '' : `签名不符：重算=${calc}，URL里=${sig}` };
}

let pass = 0, fail = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    failures.push(name);
    console.log(`  ✗ ${name}\n    ${String(e.message || e).split('\n')[0]}`);
  }
}
const eq = (a, b, msg) => assert.strictEqual(a, b, msg || `期望 ${b}，实际 ${a}`);
const ok = (v, msg) => assert.ok(v, msg || '期望为真');

function freshEnv() {
  return createMockEnv();
}
function apiHeaders(ip = '1.2.3.4') {
  return { 'Content-Type': 'application/json', 'cf-connecting-ip': ip };
}
async function initFile(mock, { name = '测试文件.zip', mime = 'application/zip', size = 1000, hours = 24, maxDownloads = null, ip = '1.2.3.4' } = {}) {
  return callHandler(uploadInit, {
    method: 'POST', url: 'http://localhost/api/upload-init',
    headers: apiHeaders(ip),
    body: { name, mime, size, expires_hours: hours, max_downloads: maxDownloads },
    env: mock.env, waitUntil: mock.waitUntil,
  });
}
function insertFileRow(mock, { id, r2Key, name = 'x.bin', mime = 'application/octet-stream', size = 1000, status = 'ready', expiresInSec = 86400, createdAgoSec = 0, downloads = 0, maxDownloads = null }) {
  const now = Math.floor(Date.now() / 1000);
  mock.env.DB.prepare(`INSERT INTO files (id, r2_key, orig_name, mime, size_bytes, status, expires_at, downloads, max_downloads, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, r2Key, name, mime, size, status, now + expiresInSec, downloads, maxDownloads, now - createdAgoSec).run();
}

console.log('— SigV4 预签名 —');
await test('presignPut：固定输入，独立验证器重算签名一致', async () => {
  const env = freshEnv().env;
  const s = await presignPut(env, 'f/2026/11/abc123', 'application/pdf', 21600, FIXED_NOW);
  ok(s.url.startsWith(ENDPOINT + '/ym-transfer-files/f/2026/11/abc123?'), 'URL 应指向 R2 端点与对象键');
  ok(s.url.includes('X-Amz-Expires=21600'), '过期时间应为 21600 秒');
  eq(s.headers['Content-Type'], 'application/pdf');
  const v = verifyPresigned(s.url, SECRET, { method: 'PUT', contentType: 'application/pdf' });
  ok(v.ok, v.reason);
});
await test('presignGet：中文文件名，response-content-disposition 编码正确且签名一致', async () => {
  const env = freshEnv().env;
  const name = '我的 文件（终版）.pdf';
  const s = await presignGet(env, 'f/2026/11/abc123', { contentType: 'application/pdf', filename: name, expiresSec: 3600, now: FIXED_NOW });
  const u = new URL(s.url);
  const disp = u.searchParams.get('response-content-disposition');
  ok(disp && disp.startsWith("attachment;filename*=UTF-8''"), '应带 RFC 5987 下载文件名');
  ok(!disp.includes(' '), 'disposition 值里不应有空格（避免 + 与 %20 歧义）');
  ok(u.searchParams.get('response-content-type') === 'application/pdf', '应带 response-content-type');
  const v = verifyPresigned(s.url, SECRET, { method: 'GET' });
  ok(v.ok, v.reason);
});
await test('presignPut：凭据缺失时抛错', async () => {
  const env = freshEnv().env;
  delete env.R2_SECRET_ACCESS_KEY;
  let threw = false;
  try { await presignPut(env, 'f/2026/11/x', 'text/plain', 600, FIXED_NOW); } catch { threw = true; }
  ok(threw, '应抛错');
});

console.log('— upload-init —');
await test('正常创建：返回 id、上传地址、下载链接，D1 里是 pending', async () => {
  const mock = freshEnv();
  const r = await initFile(mock, { name: '报告.pdf', mime: 'application/pdf', size: 12345, hours: 72 });
  eq(r.res.status, 200);
  ok(r.json.ok);
  ok(/^[0-9a-f]{32}$/.test(r.json.data.id), 'id 应为 32 位 hex');
  ok(r.json.data.upload_url.includes('X-Amz-Signature='), '应有签名');
  eq(r.json.data.download_url, `http://localhost/d/${r.json.data.id}`);
  eq(r.json.data.expires_at - Math.floor(Date.now() / 1000) > 72 * 3600 - 5, true, '有效期应约 72 小时');
  const row = mock.env.DB.prepare('SELECT * FROM files WHERE id = ?').bind(r.json.data.id).first();
  eq(row.status, 'pending');
  eq(row.orig_name, '报告.pdf');
  ok(/^f\/\d{4}\/\d{2}\/[0-9a-f]{32}$/.test(row.r2_key), 'R2 键应为 f/年/月/uuid，不含原文件名');
  ok(!row.r2_key.includes('报告'), 'R2 键不应含原文件名');
});
await test('大小校验：0、负数、超 5GB、非整数都 400', async () => {
  const mock = freshEnv();
  for (const size of [0, -1, 5 * 1024 * 1024 * 1024 + 1, 1.5, '100', null]) {
    const r = await initFile(mock, { size });
    eq(r.res.status, 400, `size=${size} 应 400`);
    eq(r.json.error.code, 'bad_size');
  }
});
await test('大小边界：正好 5GB 通过', async () => {
  const mock = freshEnv();
  const r = await initFile(mock, { size: 5 * 1024 * 1024 * 1024 });
  eq(r.res.status, 200);
});
await test('有效期校验：只能 1、6、12 小时或 1、3、7 天', async () => {
  const mock = freshEnv();
  for (const hours of [0, 2, 3, 5, 48, 100, '24', null]) {
    const r = await initFile(mock, { hours });
    eq(r.res.status, 400, `hours=${hours} 应 400`);
    eq(r.json.error.code, 'bad_expiry');
  }
  for (const hours of [1, 6, 12, 24, 72, 168]) {
    const r = await initFile(mock, { hours });
    eq(r.res.status, 200, `hours=${hours} 应通过`);
  }
});
await test('下载次数校验：只能不限、1、5、10 次，合法值存入 D1 并返回', async () => {
  const mock = freshEnv();
  for (const md of [0, 2, 3, 100, '5', -1]) {
    const r = await initFile(mock, { maxDownloads: md });
    eq(r.res.status, 400, `max_downloads=${md} 应 400`);
    eq(r.json.error.code, 'bad_max_downloads');
  }
  for (const md of [null, 1, 5, 10]) {
    const r = await initFile(mock, { maxDownloads: md });
    eq(r.res.status, 200, `max_downloads=${md} 应通过`);
    eq(r.json.data.max_downloads, md, '返回里应有 max_downloads');
    const row = mock.env.DB.prepare('SELECT max_downloads FROM files WHERE id = ?').bind(r.json.data.id).first();
    eq(row.max_downloads, md, `应存入 ${md}`);
  }
});
await test('容量上限：站内 9GB 时，传 2GB 拒绝、传 1GB 通过', async () => {
  const mock = freshEnv();
  insertFileRow(mock, { id: 'a'.repeat(32), r2Key: 'f/2026/11/aaa', size: 9 * 1024 * 1024 * 1024, status: 'ready' });
  const r2 = await initFile(mock, { size: 2 * 1024 * 1024 * 1024 });
  eq(r2.res.status, 413);
  eq(r2.json.error.code, 'quota_full');
  const r1 = await initFile(mock, { size: 1 * 1024 * 1024 * 1024 });
  eq(r1.res.status, 200, '9GB + 1GB = 10GB 整应通过');
});
await test('容量统计：已过期的 ready 不占容量，超时 pending 不占容量', async () => {
  const mock = freshEnv();
  insertFileRow(mock, { id: 'b'.repeat(32), r2Key: 'f/2026/11/bbb', size: 9 * 1024 * 1024 * 1024, status: 'ready', expiresInSec: -10 });
  insertFileRow(mock, { id: 'c'.repeat(32), r2Key: 'f/2026/11/ccc', size: 9 * 1024 * 1024 * 1024, status: 'pending', createdAgoSec: 7200 });
  const r = await initFile(mock, { size: 5 * 1024 * 1024 * 1024 });
  eq(r.res.status, 200, '过期与超时 pending 不应占容量');
});
await test('限流：同一 IP 每小时 10 次，第 11 次 429；不同 IP 不受影响', async () => {
  const mock = freshEnv();
  for (let i = 0; i < 10; i++) {
    const r = await initFile(mock, { size: 100, ip: '9.9.9.9' });
    eq(r.res.status, 200, `第 ${i + 1} 次应通过`);
  }
  const r11 = await initFile(mock, { size: 100, ip: '9.9.9.9' });
  eq(r11.res.status, 429);
  eq(r11.json.error.code, 'rate_limited');
  const other = await initFile(mock, { size: 100, ip: '8.8.8.8' });
  eq(other.res.status, 200, '不同 IP 不应被限');
});
await test('文件名清洗：路径分隔符与控制字符被去掉', async () => {
  const mock = freshEnv();
  const r = await initFile(mock, { name: '../../etc/passwd\u0001.apk', size: 100 });
  eq(r.res.status, 200);
  const row = mock.env.DB.prepare('SELECT orig_name FROM files WHERE id = ?').bind(r.json.data.id).first();
  ok(!row.orig_name.includes('/') && !row.orig_name.includes('\\'), '不应含路径分隔符');
  ok(!/[\u0000-\u001f]/.test(row.orig_name), '不应含控制字符');
});
await test('两次创建 id 与 R2 键都不相同', async () => {
  const mock = freshEnv();
  const a = await initFile(mock, { size: 100 });
  const b = await initFile(mock, { size: 100 });
  ok(a.json.data.id !== b.json.data.id, 'id 应不同');
  const ra = mock.env.DB.prepare('SELECT r2_key FROM files WHERE id = ?').bind(a.json.data.id).first();
  const rb = mock.env.DB.prepare('SELECT r2_key FROM files WHERE id = ?').bind(b.json.data.id).first();
  ok(ra.r2_key !== rb.r2_key, 'R2 键应不同');
});

console.log('— upload-complete —');
await test('正常确认：R2 有对象且大小一致 → ready，重复确认幂等', async () => {
  const mock = freshEnv();
  const init = await initFile(mock, { size: 1000 });
  const id = init.json.data.id;
  const row = mock.env.DB.prepare('SELECT r2_key FROM files WHERE id = ?').bind(id).first();
  await mock.env.FILES.put(row.r2_key, Buffer.alloc(1000, 7));
  const r = await callHandler(uploadComplete, { method: 'POST', url: 'http://localhost/api/upload-complete', headers: apiHeaders(), body: { id }, env: mock.env, waitUntil: mock.waitUntil });
  eq(r.res.status, 200);
  ok(r.json.data.download_url.endsWith('/d/' + id));
  const again = await callHandler(uploadComplete, { method: 'POST', url: 'http://localhost/api/upload-complete', headers: apiHeaders(), body: { id }, env: mock.env, waitUntil: mock.waitUntil });
  eq(again.res.status, 200, '重复确认应幂等成功');
});
await test('R2 里没有对象 → 400 not_uploaded', async () => {
  const mock = freshEnv();
  const init = await initFile(mock, { size: 1000 });
  const r = await callHandler(uploadComplete, { method: 'POST', url: 'http://localhost/api/upload-complete', headers: apiHeaders(), body: { id: init.json.data.id }, env: mock.env, waitUntil: mock.waitUntil });
  eq(r.res.status, 400);
  eq(r.json.error.code, 'not_uploaded');
});
await test('大小不一致 → 400 size_mismatch', async () => {
  const mock = freshEnv();
  const init = await initFile(mock, { size: 1000 });
  const id = init.json.data.id;
  const row = mock.env.DB.prepare('SELECT r2_key FROM files WHERE id = ?').bind(id).first();
  await mock.env.FILES.put(row.r2_key, Buffer.alloc(999, 7));
  const r = await callHandler(uploadComplete, { method: 'POST', url: 'http://localhost/api/upload-complete', headers: apiHeaders(), body: { id }, env: mock.env, waitUntil: mock.waitUntil });
  eq(r.res.status, 400);
  eq(r.json.error.code, 'size_mismatch');
});

console.log('— 下载 /d/:id —');
await test('就绪且未过期 → 302 到预签名 GET，带原文件名，下载计数 +1', async () => {
  const mock = freshEnv();
  insertFileRow(mock, { id: 'd'.repeat(32), r2Key: 'f/2026/11/ddd', name: '合同（最终版）.pdf', mime: 'application/pdf', size: 500, status: 'ready' });
  await mock.env.FILES.put('f/2026/11/ddd', Buffer.alloc(500, 1));
  const r = await callHandler(downloadRoute, { method: 'GET', url: 'http://localhost/d/' + 'd'.repeat(32), params: { id: 'd'.repeat(32) }, env: mock.env, waitUntil: mock.waitUntil });
  eq(r.res.status, 302);
  const loc = r.res.headers.get('Location');
  ok(loc && loc.includes('X-Amz-Signature='), '应跳转到预签名 URL');
  const disp = new URL(loc).searchParams.get('response-content-disposition');
  ok(disp && disp.includes('UTF-8'), '应带原文件名下载');
  await mock.drainWaitUntil();
  const row = mock.env.DB.prepare('SELECT downloads FROM files WHERE id = ?').bind('d'.repeat(32)).first();
  eq(row.downloads, 1, '下载计数应 +1');
});
await test('已过期 → 404 中文页，且懒清理删掉 R2 对象与记录', async () => {
  const mock = freshEnv();
  insertFileRow(mock, { id: 'e'.repeat(32), r2Key: 'f/2026/11/eee', size: 500, status: 'ready', expiresInSec: -5 });
  await mock.env.FILES.put('f/2026/11/eee', Buffer.alloc(500, 1));
  const r = await callHandler(downloadRoute, { method: 'GET', url: 'http://localhost/d/' + 'e'.repeat(32), params: { id: 'e'.repeat(32) }, env: mock.env, waitUntil: mock.waitUntil });
  eq(r.res.status, 404);
  ok(r.text.includes('过期'), '应提示已过期');
  await mock.drainWaitUntil();
  eq(await mock.env.FILES.head('f/2026/11/eee'), null, 'R2 对象应被删');
  eq(mock.env.DB.prepare('SELECT * FROM files WHERE id = ?').bind('e'.repeat(32)).first(), null, 'D1 记录应被删');
});
await test('下载次数用完 → 404 中文页，且懒清理删掉 R2 对象与记录', async () => {
  const mock = freshEnv();
  insertFileRow(mock, { id: '9'.repeat(32), r2Key: 'f/2026/11/999', size: 500, status: 'ready', downloads: 5, maxDownloads: 5 });
  await mock.env.FILES.put('f/2026/11/999', Buffer.alloc(500, 1));
  const r = await callHandler(downloadRoute, { method: 'GET', url: 'http://localhost/d/' + '9'.repeat(32), params: { id: '9'.repeat(32) }, env: mock.env, waitUntil: mock.waitUntil });
  eq(r.res.status, 404);
  ok(r.text.includes('下载次数'), '应提示下载次数已用完');
  await mock.drainWaitUntil();
  eq(await mock.env.FILES.head('f/2026/11/999'), null, 'R2 对象应被删');
  eq(mock.env.DB.prepare('SELECT * FROM files WHERE id = ?').bind('9'.repeat(32)).first(), null, 'D1 记录应被删');
});
await test('下载次数未用完 → 302；不限次数时多次下载都放行', async () => {
  const mock = freshEnv();
  insertFileRow(mock, { id: 'a'.repeat(32), r2Key: 'f/2026/11/aaa', size: 100, status: 'ready', downloads: 4, maxDownloads: 5 });
  await mock.env.FILES.put('f/2026/11/aaa', Buffer.alloc(100, 1));
  const r1 = await callHandler(downloadRoute, { method: 'GET', url: 'http://localhost/d/' + 'a'.repeat(32), params: { id: 'a'.repeat(32) }, env: mock.env, waitUntil: mock.waitUntil });
  eq(r1.res.status, 302, '4/5 次应放行');
  insertFileRow(mock, { id: 'b'.repeat(32), r2Key: 'f/2026/11/bbb', size: 100, status: 'ready', downloads: 100, maxDownloads: null });
  await mock.env.FILES.put('f/2026/11/bbb', Buffer.alloc(100, 1));
  const r2 = await callHandler(downloadRoute, { method: 'GET', url: 'http://localhost/d/' + 'b'.repeat(32), params: { id: 'b'.repeat(32) }, env: mock.env, waitUntil: mock.waitUntil });
  eq(r2.res.status, 302, '不限次数时 100 次后仍应放行');
});
await test('未传完（pending）/不存在/非法 id → 404 中文页', async () => {
  const mock = freshEnv();
  insertFileRow(mock, { id: 'f'.repeat(32), r2Key: 'f/2026/11/fff', size: 100, status: 'pending' });
  const r1 = await callHandler(downloadRoute, { method: 'GET', url: 'http://localhost/d/' + 'f'.repeat(32), params: { id: 'f'.repeat(32) }, env: mock.env, waitUntil: mock.waitUntil });
  eq(r1.res.status, 404);
  ok(r1.text.includes('上传中'), 'pending 应提示还在上传');
  const r2 = await callHandler(downloadRoute, { method: 'GET', url: 'http://localhost/d/' + '0'.repeat(32), params: { id: '0'.repeat(32) }, env: mock.env, waitUntil: mock.waitUntil });
  eq(r2.res.status, 404);
  const r3 = await callHandler(downloadRoute, { method: 'GET', url: 'http://localhost/d/abc', params: { id: 'abc' }, env: mock.env, waitUntil: mock.waitUntil });
  eq(r3.res.status, 404);
});

console.log('— 清理 /api/cleanup —');
await test('密钥不对/缺失 → 401', async () => {
  const mock = freshEnv();
  const r1 = await callHandler(cleanupApi, { method: 'POST', url: 'http://localhost/api/cleanup', headers: { 'X-Task-Secret': 'wrong' }, env: mock.env, waitUntil: mock.waitUntil });
  eq(r1.res.status, 401);
  const r2 = await callHandler(cleanupApi, { method: 'POST', url: 'http://localhost/api/cleanup', headers: {}, env: mock.env, waitUntil: mock.waitUntil });
  eq(r2.res.status, 401);
});
await test('正确密钥：删过期 ready、过期 pending、超时 pending；保留新鲜的', async () => {
  const mock = freshEnv();
  insertFileRow(mock, { id: '1'.repeat(32), r2Key: 'f/2026/11/111', size: 100, status: 'ready', expiresInSec: -10 });
  insertFileRow(mock, { id: '2'.repeat(32), r2Key: 'f/2026/11/222', size: 100, status: 'pending', expiresInSec: -10 });
  insertFileRow(mock, { id: '3'.repeat(32), r2Key: 'f/2026/11/333', size: 100, status: 'pending', expiresInSec: 86400, createdAgoSec: 7200 });
  insertFileRow(mock, { id: '4'.repeat(32), r2Key: 'f/2026/11/444', size: 100, status: 'ready', expiresInSec: 86400 });
  insertFileRow(mock, { id: '5'.repeat(32), r2Key: 'f/2026/11/555', size: 100, status: 'pending', expiresInSec: 86400, createdAgoSec: 100 });
  for (const k of ['111', '222', '333', '444', '555']) await mock.env.FILES.put('f/2026/11/' + k, Buffer.alloc(100, 2));
  const r = await callHandler(cleanupApi, { method: 'POST', url: 'http://localhost/api/cleanup', headers: { 'X-Task-Secret': 'test-task-secret' }, env: mock.env, waitUntil: mock.waitUntil });
  eq(r.res.status, 200);
  eq(r.json.data.deleted, 3, '应删 3 个');
  for (const k of ['111', '222', '333']) eq(await mock.env.FILES.head('f/2026/11/' + k), null, `R2 对象 ${k} 应被删`);
  for (const k of ['444', '555']) ok(await mock.env.FILES.head('f/2026/11/' + k), `R2 对象 ${k} 应保留`);
  eq(mock.env.DB.prepare('SELECT COUNT(*) AS n FROM files').first().n, 2, 'D1 应剩 2 行');
});

console.log('— 统计 /api/stats —');
await test('返回已用字节与文件数', async () => {
  const mock = freshEnv();
  insertFileRow(mock, { id: '6'.repeat(32), r2Key: 'f/2026/11/666', size: 1000, status: 'ready' });
  insertFileRow(mock, { id: '7'.repeat(32), r2Key: 'f/2026/11/777', size: 2000, status: 'ready' });
  insertFileRow(mock, { id: '8'.repeat(32), r2Key: 'f/2026/11/888', size: 9999, status: 'ready', expiresInSec: -5 });
  const r = await callHandler(statsApi, { method: 'GET', url: 'http://localhost/api/stats', env: mock.env, waitUntil: mock.waitUntil });
  eq(r.res.status, 200);
  eq(r.json.data.used_bytes, 3000, '过期文件不应计入');
  eq(r.json.data.file_count, 2);
  eq(r.json.data.total_cap_bytes, 10 * 1024 * 1024 * 1024);
  eq(r.json.data.max_file_bytes, 5 * 1024 * 1024 * 1024);
});

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
if (fail) {
  console.log('失败的用例：' + failures.join('；'));
  process.exit(1);
}
console.log('全部通过 ✓');
