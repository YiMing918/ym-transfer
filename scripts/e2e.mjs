// e2e.mjs — 端到端测试：跑真实 HTTP，串起完整流程
// 假 R2（本地 HTTP 服务，接受 PUT、提供 GET，模拟 R2 的 response-* 覆盖行为）
// + 假 Functions 服务（把真实 handler 挂到 HTTP 上，D1 用真 SQLite、R2 用共享内存 Map）
// 流程：upload-init → 浏览器直 PUT 到假 R2 → upload-complete → 打开下载链接 → 302 到预签名 GET → 下载字节比对
// 测一个 5MB 小文件与一个 150MB 大文件（>100MB，证明上传绕过 Worker/Function、直达 R2）。
// 用法：node scripts/e2e.mjs；任一失败即 exit 1。
import assert from 'node:assert';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import { createMockEnv } from './mock.mjs';
import * as uploadInit from '../functions/api/upload-init.js';
import * as uploadComplete from '../functions/api/upload-complete.js';
import * as cleanupApi from '../functions/api/cleanup.js';
import * as statsApi from '../functions/api/stats.js';
import * as downloadRoute from '../functions/d/[id].js';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function main() {
  const mock = createMockEnv();
  const store = mock.store; // 与 mock FILES 绑定共用的 R2 对象表
  const putLog = []; // 记录假 R2 收到的 PUT（方法、Content-Type、大小）

  // —— 假 R2：PUT 存对象，GET 按 response-* 查询参数回 Content-Disposition/Type ——
  const fakeR2 = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const m = u.pathname.match(/^\/ym-transfer-files\/(.+)$/);
    if (!m) { res.writeHead(404); res.end('no such bucket/key'); return; }
    const key = decodeURIComponent(m[1]);
    if (req.method === 'PUT') {
      const body = await readBody(req);
      putLog.push({ key, contentType: req.headers['content-type'], size: body.length });
      store.set(key, { size: body.length, body });
      res.writeHead(200, { ETag: '"fake-etag"' });
      res.end();
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      const o = store.get(key);
      if (!o) { res.writeHead(404); res.end('not found'); return; }
      const headers = { 'Content-Length': o.size };
      const disp = u.searchParams.get('response-content-disposition');
      if (disp) headers['Content-Disposition'] = disp;
      const ct = u.searchParams.get('response-content-type');
      if (ct) headers['Content-Type'] = ct;
      res.writeHead(200, headers);
      if (req.method === 'GET') res.end(o.body); else res.end();
      return;
    }
    res.writeHead(405); res.end();
  });
  await new Promise((r) => fakeR2.listen(0, '127.0.0.1', r));
  const r2Port = fakeR2.address().port;
  const r2Endpoint = `http://127.0.0.1:${r2Port}`;
  mock.env.R2_S3_ENDPOINT = r2Endpoint;

  // —— 假 Functions 服务：把真实 handler 挂到 HTTP 上 ——
  const handlers = {
    '/api/upload-init': uploadInit,
    '/api/upload-complete': uploadComplete,
    '/api/cleanup': cleanupApi,
    '/api/stats': statsApi,
  };
  const fnServer = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const bodyBuf = await readBody(req);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k] = v;
    const request = new Request(`http://127.0.0.1${req.url}`, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : bodyBuf,
    });
    let mod = handlers[u.pathname];
    let params = {};
    if (!mod) {
      const dm = u.pathname.match(/^\/d\/([0-9a-f]{32})$/);
      if (dm) { mod = downloadRoute; params = { id: dm[1] }; }
    }
    if (!mod) { res.writeHead(404); res.end('no route'); return; }
    try {
      const out = await mod.onRequest({ request, env: mock.env, params, waitUntil: mock.waitUntil });
      const text = await out.text();
      const h = {};
      out.headers.forEach((v, k) => { h[k] = v; });
      res.writeHead(out.status, h);
      res.end(text);
      await mock.drainWaitUntil();
    } catch (e) {
      res.writeHead(500);
      res.end('handler error: ' + e.message);
    }
  });
  await new Promise((r) => fnServer.listen(0, '127.0.0.1', r));
  const fnPort = fnServer.address().port;
  const base = `http://127.0.0.1:${fnPort}`;

  async function uploadFlow({ name, mime, sizeBytes, hours, buf }) {
    const initRes = await fetch(`${base}/api/upload-init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '10.0.0.1' },
      body: JSON.stringify({ name, mime, size: sizeBytes, expires_hours: hours }),
    });
    const initJson = await initRes.json();
    assert.strictEqual(initRes.status, 200, 'init 应 200：' + JSON.stringify(initJson));
    const d = initJson.data;
    assert.ok(d.upload_url.startsWith(r2Endpoint + '/'), '上传地址应指向 R2（本测试里是假 R2），不是经过 Function');
    // 浏览器直 PUT 到 R2（绕过 Functions 服务）
    const putRes = await fetch(d.upload_url, { method: 'PUT', headers: { 'Content-Type': mime }, body: buf });
    assert.strictEqual(putRes.status, 200, 'PUT 到 R2 应 200');
    const compRes = await fetch(`${base}/api/upload-complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: d.id }),
    });
    const compJson = await compRes.json();
    assert.strictEqual(compRes.status, 200, 'complete 应 200：' + JSON.stringify(compJson));
    return { id: d.id, downloadUrl: compJson.data.download_url, uploadUrl: d.upload_url };
  }

  async function downloadAndVerify(downloadUrl, expectedBuf, expectedName) {
    const r1 = await fetch(downloadUrl, { redirect: 'manual' });
    assert.strictEqual(r1.status, 302, '下载链接应 302 跳转');
    const loc = r1.headers.get('location');
    assert.ok(loc && loc.startsWith(r2Endpoint + '/'), '应跳转到 R2 预签名 GET');
    const r2 = await fetch(loc);
    assert.strictEqual(r2.status, 200, '预签名 GET 应 200');
    const disp = r2.headers.get('content-disposition') || '';
    assert.ok(disp.includes('attachment'), '应带 attachment');
    assert.ok(disp.includes('UTF-8'), '应带原文件名（RFC 5987）');
    const got = Buffer.from(await r2.arrayBuffer());
    assert.strictEqual(sha256(got), sha256(expectedBuf), '下载字节应与上传字节一致');
    return disp;
  }

  console.log('— 端到端：小文件 5MB —');
  const small = randomBytes(5 * 1024 * 1024);
  await test('5MB 中文名文件：init → 直 PUT 到 R2 → complete → 下载字节一致', async () => {
    const { downloadUrl } = await uploadFlow({ name: '测试报告（终版）.zip', mime: 'application/zip', sizeBytes: small.length, hours: 72, buf: small });
    const disp = await downloadAndVerify(`${base}${new URL(downloadUrl).pathname}`, small);
    assert.ok(disp.includes('%E6%B5%8B%E8%AF%95'), 'Content-Disposition 应含中文文件名的百分号编码');
  });

  console.log('— 端到端：大文件 150MB（>100MB，验证直传绕过 Worker）—');
  const big = randomBytes(150 * 1024 * 1024);
  await test('150MB 文件：init → 直 PUT 到 R2 → complete → 下载字节一致', async () => {
    const before = putLog.length;
    const { downloadUrl, uploadUrl } = await uploadFlow({ name: 'large-video.mp4', mime: 'video/mp4', sizeBytes: big.length, hours: 168, buf: big });
    assert.strictEqual(putLog.length, before + 1, '假 R2 应收到一次 PUT');
    assert.strictEqual(putLog[putLog.length - 1].size, big.length, '假 R2 收到的 PUT 应是完整 150MB');
    assert.strictEqual(putLog[putLog.length - 1].contentType, 'video/mp4', 'PUT 应带签名的 Content-Type');
    await downloadAndVerify(`${base}${new URL(downloadUrl).pathname}`, big);
  });

  console.log('— 端到端：过期与清理 —');
  await test('过期链接打开是 404 中文页，且对象被懒清理', async () => {
    const initRes = await fetch(`${base}/api/upload-init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '10.0.0.2' },
      body: JSON.stringify({ name: 'a.txt', mime: 'text/plain', size: 10, expires_hours: 24 }),
    });
    const d = (await initRes.json()).data;
    await fetch(d.upload_url, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: Buffer.alloc(10, 65) });
    await fetch(`${base}/api/upload-complete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: d.id }) });
    // 把过期时间改到过去（模拟过期）
    mock.env.DB.prepare('UPDATE files SET expires_at = ? WHERE id = ?').bind(Math.floor(Date.now() / 1000) - 10, d.id).run();
    const r = await fetch(`${base}/d/${d.id}`);
    assert.strictEqual(r.status, 404);
    const text = await r.text();
    assert.ok(text.includes('过期'), '应提示已过期');
    const row = mock.env.DB.prepare('SELECT r2_key FROM files WHERE id = ?').bind(d.id).first();
    assert.strictEqual(row, null, '过期记录应被懒清理删掉');
  });
  await test('清理接口：删过期文件并返回数量', async () => {
    const r = await fetch(`${base}/api/cleanup`, { method: 'POST', headers: { 'X-Task-Secret': 'test-task-secret' } });
    const j = await r.json();
    assert.strictEqual(r.status, 200);
    assert.ok(typeof j.data.deleted === 'number');
  });
  await test('统计接口：返回已用容量', async () => {
    const r = await fetch(`${base}/api/stats`);
    const j = await r.json();
    assert.strictEqual(r.status, 200);
    assert.ok(j.data.used_bytes >= 150 * 1024 * 1024, '已用应至少含 150MB 文件');
    assert.strictEqual(j.data.total_cap_bytes, 10 * 1024 * 1024 * 1024);
  });

  fakeR2.close();
  fnServer.close();

  console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
  if (fail) {
    console.log('失败的用例：' + failures.join('；'));
    process.exit(1);
  }
  console.log('全部通过 ✓');
}

main().catch((e) => { console.error(e); process.exit(1); });
