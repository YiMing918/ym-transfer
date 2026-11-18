// test-c-fixes.mjs — 对抗复读 C 部分定向测试（C-1 / C-11 / C-12 / C-34 / C-35 / C-42）
// 用法：node scripts/test-c-fixes.mjs；任一失败即 exit 1。
import assert from 'node:assert';
import { createMockEnv, callHandler } from './mock.mjs';
import { presignPut } from '../functions/_lib/r2sign.js';
import { TOTAL_CAP_BYTES } from '../functions/_lib/consts.js';
import * as uploadInit from '../functions/api/upload-init.js';
import * as uploadComplete from '../functions/api/upload-complete.js';
import * as downloadRoute from '../functions/d/[id].js';

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n    ${String(e.message || e).split('\n')[0]}`); }
}
const eq = (a, b, msg) => assert.strictEqual(a, b, msg || `期望 ${b}，实际 ${a}`);
const ok = (v, msg) => assert.ok(v, msg || '期望为真');
const nowSec = () => Math.floor(Date.now() / 1000);
const apiHeaders = (ip = '1.2.3.4') => ({ 'Content-Type': 'application/json', 'cf-connecting-ip': ip });

function insertFileRow(mock, { id, r2Key, size = 1000, status = 'ready', expiresInSec = 86400, createdAgoSec = 0, downloads = 0, maxDownloads = null, mime = 'application/octet-stream' }) {
  const now = nowSec();
  mock.env.DB.prepare(`INSERT INTO files (id, r2_key, orig_name, mime, size_bytes, status, expires_at, downloads, max_downloads, created_at)
    VALUES (?, ?, 'x.bin', ?, ?, ?, ?, ?, ?, ?)`).bind(id, r2Key, mime, size, status, now + expiresInSec, downloads, maxDownloads, now - createdAgoSec).run();
}
async function getDownload(mock, id, { ua = 'Mozilla/5.0', method = 'GET' } = {}) {
  return callHandler(downloadRoute, { method, url: 'http://localhost/d/' + id, headers: { 'user-agent': ua }, params: { id }, env: mock.env, waitUntil: mock.waitUntil });
}
function downloadsOf(mock, id) {
  const row = mock.env.DB.prepare('SELECT downloads FROM files WHERE id = ?').bind(id).first();
  return row ? row.downloads : null;
}
async function initFile(mock, { name = 'a.bin', mime = 'application/octet-stream', size = 100, hours = 24, maxDownloads = null, ip = '1.2.3.4' } = {}) {
  return callHandler(uploadInit, { method: 'POST', url: 'http://localhost/api/upload-init', headers: apiHeaders(ip), body: { name, mime, size, expires_hours: hours, max_downloads: maxDownloads }, env: mock.env, waitUntil: mock.waitUntil });
}

console.log('— C-1 预览/扫描 UA 不得绕过限次计数 —');
await test('限 1 次：TelegramBot UA 的 GET 也计数，第 2 次打开被拒', async () => {
  const mock = createMockEnv();
  const id = 'a'.repeat(32);
  insertFileRow(mock, { id, r2Key: 'f/t/c1a', maxDownloads: 1 });
  const r1 = await getDownload(mock, id, { ua: 'TelegramBot (like TwitterBot)' });
  eq(r1.res.status, 302, '第 1 次应发链');
  await mock.drainWaitUntil();
  eq(downloadsOf(mock, id), 1, '预览 UA 的 GET 必须计数');
  const r2 = await getDownload(mock, id, { ua: 'Mozilla/5.0' });
  eq(r2.res.status, 404, '名额被预览耗掉后普通打开应 404');
});
await test('限 1 次：带 bot/scanner 字样的 UA 并发伪装不能超发（顺序模拟）', async () => {
  const mock = createMockEnv();
  const id = 'b'.repeat(32);
  insertFileRow(mock, { id, r2Key: 'f/t/c1b', maxDownloads: 1 });
  const r1 = await getDownload(mock, id, { ua: 'SomeScanner/1.0 preview bot' });
  eq(r1.res.status, 302);
  const r2 = await getDownload(mock, id, { ua: 'facebookexternalhit/1.1' });
  eq(r2.res.status, 404, '第 2 个伪装 UA 应被原子计数拦下');
});
await test('HEAD 请求不计数：限 1 次文件 HEAD 后 GET 仍可下', async () => {
  const mock = createMockEnv();
  const id = 'c'.repeat(32);
  insertFileRow(mock, { id, r2Key: 'f/t/c1c', maxDownloads: 1 });
  const rh = await getDownload(mock, id, { method: 'HEAD' });
  eq(rh.res.status, 302, 'HEAD 应回跳转');
  await mock.drainWaitUntil();
  eq(downloadsOf(mock, id), 0, 'HEAD 不应计数');
  const rg = await getDownload(mock, id, {});
  eq(rg.res.status, 302, 'HEAD 之后的那次 GET 应仍有名额');
  eq(downloadsOf(mock, id), 1);
});

console.log('— C-35 不限次文件不再逐次写计数 —');
await test('不限次：GET 后 downloads 保持 0（不写 D1 计数）', async () => {
  const mock = createMockEnv();
  const id = 'd'.repeat(32);
  insertFileRow(mock, { id, r2Key: 'f/t/c35', maxDownloads: null });
  const r = await getDownload(mock, id, {});
  eq(r.res.status, 302);
  await mock.drainWaitUntil();
  eq(downloadsOf(mock, id), 0, '不限次文件不应逐次 +1');
});
await test('限次文件只计一次（不双计）：限 5 次 GET 一次 downloads=1', async () => {
  const mock = createMockEnv();
  const id = 'e'.repeat(32);
  insertFileRow(mock, { id, r2Key: 'f/t/c35b', maxDownloads: 5 });
  const r = await getDownload(mock, id, {});
  eq(r.res.status, 302);
  await mock.drainWaitUntil();
  eq(downloadsOf(mock, id), 1, '限次计数只能来自占位更新一处');
});

console.log('— C-11 上传限流原子自增 —');
await test('并发 15 次同 IP 创建：最多 10 次成功，其余 429，计数回滚停在 10', async () => {
  const mock = createMockEnv();
  // 模拟真实并发（多 isolate 并行）：限流 SELECT 的结果按调用时刻快照、延迟 30ms 才交付——
  // 「先查后加」写法下 15 个请求会一起查到旧计数、一起过线；原子自增写法不受快照影响。
  const origPrepare = mock.env.DB.prepare.bind(mock.env.DB);
  mock.env.DB.prepare = (sql) => {
    const bound = origPrepare(sql);
    const isRateSelect = /^\s*SELECT/i.test(sql) && sql.includes('rate_limits');
    if (!isRateSelect) return bound;
    const origBind = bound.bind.bind(bound);
    const wrapped = {
      bind(...p) { origBind(...p); return wrapped; },
      run: () => bound.run(),
      all: () => bound.all(),
      async first() { const v = bound.first(); await new Promise((r) => setTimeout(r, 30)); return v; },
    };
    return wrapped;
  };
  const results = await Promise.all(Array.from({ length: 15 }, () => initFile(mock, { size: 100, ip: '7.7.7.7' })));
  const okCount = results.filter((r) => r.res.status === 200).length;
  const limited = results.filter((r) => r.res.status === 429).length;
  eq(okCount, 10, `并发下应只有 10 次成功，实际 ${okCount}`);
  eq(limited, 5, `其余应 429，实际 ${limited}`);
  const rows = mock.env.DB.prepare('SELECT count FROM rate_limits').all().results;
  const total = rows.reduce((s, r) => s + r.count, 0);
  eq(total, 10, `超限回滚后限流计数应停在 10，实际 ${total}`);
});
await test('顺序限流仍成立：第 11 次 429 且不污染计数', async () => {
  const mock = createMockEnv();
  for (let i = 0; i < 10; i++) eq((await initFile(mock, { size: 100, ip: '6.6.6.6' })).res.status, 200);
  eq((await initFile(mock, { size: 100, ip: '6.6.6.6' })).res.status, 429);
  eq((await initFile(mock, { size: 100, ip: '6.6.6.6' })).res.status, 429, '回滚后再次尝试仍应 429');
});

console.log('— C-12 pending 空声明占额封顶（总盘 1/3）—');
await test('9GB 全是新鲜 pending 空声明时，传 5GB 仍应通过（pending 计入封顶 1/3）', async () => {
  const mock = createMockEnv();
  for (let i = 0; i < 3; i++) {
    insertFileRow(mock, { id: String(i).padStart(32, '0'), r2Key: 'f/t/c12-' + i, size: 3 * 1024 * 1024 * 1024, status: 'pending', expiresInSec: 86400 });
  }
  const r = await initFile(mock, { size: 5 * 1024 * 1024 * 1024, ip: '5.5.5.5' });
  eq(r.res.status, 200, `pending 封顶后 3.33GB+5GB 应通过，实际 ${r.res.status} ${JSON.stringify(r.json)}`);
  ok(r.json.data.used_bytes <= Math.floor(TOTAL_CAP_BYTES / 3), `used_bytes 中 pending 部分应封顶 1/3，实际 ${r.json.data.used_bytes}`);
});
await test('ready 占额不封顶：9GB ready 时传 2GB 仍拒绝', async () => {
  const mock = createMockEnv();
  insertFileRow(mock, { id: 'f'.repeat(32), r2Key: 'f/t/c12r', size: 9 * 1024 * 1024 * 1024, status: 'ready' });
  const r = await initFile(mock, { size: 2 * 1024 * 1024 * 1024, ip: '5.5.5.6' });
  eq(r.res.status, 413);
});

console.log('— C-34 upload-complete 位移封顶 —');
async function seedPending(mock, { id, createdAt, expiresAt, size = 1000 }) {
  const r2Key = `f/test/${id}`;
  await mock.env.DB.prepare(`INSERT INTO files (id, r2_key, orig_name, mime, size_bytes, status, expires_at, downloads, max_downloads, created_at)
     VALUES (?, ?, '大文件.zip', 'application/zip', ?, 'pending', ?, 0, NULL, ?)`).bind(id, r2Key, size, expiresAt, createdAt).run();
  mock.store.set(r2Key, { size, body: Buffer.alloc(size) });
  return r2Key;
}
async function complete(mock, id) {
  return callHandler(uploadComplete, { method: 'POST', url: 'http://localhost/api/upload-complete', headers: apiHeaders(), body: { id }, env: mock.env, waitUntil: mock.waitUntil });
}
await test('拖 10 天才 complete：位移封顶后判过期，删对象+删记录回 410', async () => {
  const mock = createMockEnv();
  const id = '1'.repeat(32);
  const createdAt = nowSec() - 10 * 86400;
  const r2Key = await seedPending(mock, { id, createdAt, expiresAt: createdAt + 3600 });
  const r = await complete(mock, id);
  eq(r.res.status, 410, `期望 410，实际 ${r.res.status} ${JSON.stringify(r.json)}`);
  eq(mock.store.has(r2Key), false, 'R2 对象应删');
  eq(mock.env.DB.prepare('SELECT id FROM files WHERE id = ?').bind(id).first(), null, '记录应删');
});
await test('慢传 5 小时（窗口内）complete：仍拿满所选 1 小时有效期', async () => {
  const mock = createMockEnv();
  const id = '2'.repeat(32);
  const createdAt = nowSec() - 5 * 3600;
  await seedPending(mock, { id, createdAt, expiresAt: createdAt + 3600 });
  const r = await complete(mock, id);
  eq(r.res.status, 200, `期望 200，实际 ${r.res.status}`);
  const drift = Math.abs(r.json.data.expires_at - (nowSec() + 3600));
  ok(drift <= 5, `新 expires_at 应≈完成时刻+1h，偏差 ${drift}s`);
});

console.log('— C-42 mime 控制字符 / 形态校验 —');
await test('mime 带 CRLF 注入 → 400 bad_mime', async () => {
  const mock = createMockEnv();
  const r = await initFile(mock, { mime: 'text/plain\r\nX-Evil: 1' });
  eq(r.res.status, 400, `期望 400，实际 ${r.res.status}`);
  eq(r.json.error.code, 'bad_mime');
});
await test('mime 不是 token/token 形态 → 400 bad_mime', async () => {
  const mock = createMockEnv();
  for (const mime of ['notamime', 'text/', '/plain', 'text/pl ain', 'text/plain; charset=utf-8\u0001']) {
    const r = await initFile(mock, { mime });
    eq(r.res.status, 400, `mime=${JSON.stringify(mime)} 应 400`);
    eq(r.json.error.code, 'bad_mime');
  }
});
await test('正常 mime 通过；空 mime 回落 application/octet-stream', async () => {
  const mock = createMockEnv();
  const r1 = await initFile(mock, { mime: 'image/png' });
  eq(r1.res.status, 200);
  const r2 = await callHandler(uploadInit, { method: 'POST', url: 'http://localhost/api/upload-init', headers: apiHeaders('4.4.4.4'), body: { name: 'x', size: 10, expires_hours: 24 }, env: mock.env, waitUntil: mock.waitUntil });
  eq(r2.res.status, 200, '不传 mime 应回落默认类型并通过');
  const row = mock.env.DB.prepare('SELECT mime FROM files WHERE id = ?').bind(r2.json.data.id).first();
  eq(row.mime, 'application/octet-stream');
});
await test('presignPut：脏 contentType 进签名串前被清掉控制字符', async () => {
  const mock = createMockEnv();
  const s = await presignPut(mock.env, 'f/2026/11/zzz', 'text/plain\r\nX-Evil: 1', 600, new Date('2026-11-10T00:00:00.000Z'));
  ok(!/[\u0000-\u001f\u007f]/.test(s.headers['Content-Type']), `签名头不应含控制字符，实际 ${JSON.stringify(s.headers['Content-Type'])}`);
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
