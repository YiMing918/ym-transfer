// mock.mjs — 本地测试用的 mock 环境（smoke.mjs 与 e2e.mjs 共用）
// D1 用 Node 内置 node:sqlite 真跑 SQL（D1 本身就是 SQLite，行为最接近）；
// R2 用内存 Map；waitUntil 收集起来由测试统一等。
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// 按文件名顺序应用全部迁移（0001、0002……），与部署时的迁移顺序一致
export const SCHEMA_SQL = readdirSync(join(here, '..', 'schema'))
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(join(here, '..', 'schema', f), 'utf8'))
  .join('\n');

export function createMockD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA_SQL);
  return {
    _db: db,
    prepare(sql) {
      const stmt = db.prepare(sql);
      let params = [];
      const bound = {
        bind(...p) { params = p; return bound; },
        // 返回形状必须与真 D1 一致（{ success, meta: { changes } }）：
        // 此前直接透传 node:sqlite 的 { changes }，生产代码读 res.meta.changes
        // 在测试里永远是 undefined → 原子计数分支本地测不到、上线才暴露
        run() {
          const r = stmt.run(...params);
          return { success: true, meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } };
        },
        first() { return stmt.get(...params) ?? null; },
        all() { return { results: stmt.all(...params) }; },
      };
      return bound;
    },
    batch(prepared) {
      const out = [];
      for (const p of prepared) out.push(p.run());
      return out;
    },
  };
}

// store: Map<key, {size, body:Buffer}>，由调用方传入（e2e 里与 fake R2 HTTP 服务共用同一份）
export function createMockR2(store = new Map()) {
  return {
    _store: store,
    async head(key) {
      const o = store.get(key);
      return o ? { key, size: o.size, etag: '"mock-etag"' } : null;
    },
    async put(key, value) {
      const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
      store.set(key, { size: buf.length, body: buf });
      return { key, size: buf.length };
    },
    async delete(key) { store.delete(key); },
    async get(key) {
      const o = store.get(key);
      return o ? { body: o.body, size: o.size } : null;
    },
  };
}

export function createMockEnv(overrides = {}) {
  const store = overrides._store || new Map();
  const pending = [];
  const env = {
    DB: createMockD1(),
    FILES: createMockR2(store),
    R2_S3_ENDPOINT: 'https://00000000000000000000000000000000.r2.cloudflarestorage.com',
    R2_S3_BUCKET: 'ym-transfer-files',
    R2_ACCESS_KEY_ID: 'test-access-key-id',
    R2_SECRET_ACCESS_KEY: 'test-secret-access-key-0123456789abcdef',
    TASK_SECRET: 'test-task-secret',
    IP_SALT: 'test-salt',
    ...overrides.env,
  };
  delete env._store;
  return {
    env,
    store,
    waitUntil(p) { pending.push(Promise.resolve(p)); },
    async drainWaitUntil() {
      const all = pending.splice(0, pending.length);
      await Promise.allSettled(all);
    },
  };
}

// 用真实 Request/Response 调一个 handler，返回 {res, json}（json 为解析后的 body，解析失败为 null）
export async function callHandler(handlerModule, { method = 'GET', url = 'http://localhost/', headers = {}, body = null, params = {}, env, waitUntil }) {
  const init = { method, headers };
  if (body !== null) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  const request = new Request(url, init);
  const res = await handlerModule.onRequest({ request, env, params, waitUntil: waitUntil || (() => {}) });
  let json = null;
  const text = await res.text();
  try { json = JSON.parse(text); } catch { /* 非 JSON 响应（如下载页） */ }
  return { res, json, text };
}
