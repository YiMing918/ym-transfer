// test-upload-complete-expiry.mjs — upload-complete 有效期起算顺序定向测试
// 覆盖 Chief 审计 #1：选 1 小时有效期、上传耗时超过 1 小时（慢传大文件），
// complete 必须能拿到链接（有效期从完成起算）；位移后仍过期的异常行要
// 当场删对象 + 删记录。
// 用法：node scripts/test-upload-complete-expiry.mjs；任一失败即 exit 1。
import assert from 'node:assert';
import { createMockEnv, callHandler } from './mock.mjs';
import * as uploadComplete from '../functions/api/upload-complete.js';

let pass = 0, fail = 0;
async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}\n    ${String(e.message || e).split('\n')[0]}`);
  }
}
const eq = (a, b, msg) => assert.strictEqual(a, b, msg || `期望 ${b}，实际 ${a}`);

const nowSec = () => Math.floor(Date.now() / 1000);
const HEADERS = { 'Content-Type': 'application/json', 'cf-connecting-ip': '1.2.3.4' };

// 直接往 mock D1 塞一行 pending 记录 + 往 mock R2 塞等大对象，模拟
// 「init 在 createdAt 时刻发生、文件到 complete 时刻才传完」的时间线。
async function seedPending(mock, { id, createdAt, expiresAt, size = 1000 }) {
  const r2Key = `f/test/${id}`;
  await mock.env.DB.prepare(
    `INSERT INTO files (id, r2_key, orig_name, mime, size_bytes, status, expires_at, downloads, max_downloads, created_at)
     VALUES (?, ?, '大文件.zip', 'application/zip', ?, 'pending', ?, 0, NULL, ?)`
  ).bind(id, r2Key, size, expiresAt, createdAt).run();
  mock.store.set(r2Key, { size, body: Buffer.alloc(size) });
  return r2Key;
}

async function complete(mock, id) {
  return callHandler(uploadComplete, {
    method: 'POST', url: 'http://localhost/api/upload-complete',
    headers: HEADERS, body: { id }, env: mock.env, waitUntil: mock.waitUntil,
  });
}

await test('选 1 小时有效期、上传耗时 70 分钟：complete 成功拿到链接', async () => {
  const mock = createMockEnv();
  const id = 'a'.repeat(32);
  const createdAt = nowSec() - 70 * 60;          // 70 分钟前 init
  const expiresAt = createdAt + 3600;            // 选的 1 小时有效期（原始口径已过期 10 分钟）
  await seedPending(mock, { id, createdAt, expiresAt });
  const r = await complete(mock, id);
  eq(r.res.status, 200, `期望 200，实际 ${r.res.status}（${JSON.stringify(r.json)}）`);
  assert.ok(r.json && r.json.data && r.json.data.download_url, '应返回 download_url');
  // 有效期从完成起算：新到期时间应 ≈ 现在 + 1 小时
  const drift = Math.abs(r.json.data.expires_at - (nowSec() + 3600));
  assert.ok(drift <= 5, `新 expires_at 应≈完成时刻+1h，偏差 ${drift}s`);
  const row = await mock.env.DB.prepare('SELECT status FROM files WHERE id = ?').bind(id).first();
  eq(row.status, 'ready', '记录应转为 ready');
});

await test('位移后仍过期的异常行：410 且对象与记录当场删除', async () => {
  const mock = createMockEnv();
  const id = 'b'.repeat(32);
  const now = nowSec();
  // expires_at 比 created_at 还早（异常行）：位移后仍 <= now
  const r2Key = await seedPending(mock, { id, createdAt: now - 100, expiresAt: now - 200 });
  const r = await complete(mock, id);
  eq(r.res.status, 410, `期望 410，实际 ${r.res.status}`);
  eq(mock.store.has(r2Key), false, 'R2 对象应被当场删除');
  const row = await mock.env.DB.prepare('SELECT id FROM files WHERE id = ?').bind(id).first();
  eq(row, null, '记录应被当场删除');
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
