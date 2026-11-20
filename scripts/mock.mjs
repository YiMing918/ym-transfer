// mock.mjs — 本地测试用的 mock 环境（smoke.mjs 与 e2e.mjs 共用）
// D1 用 Node 内置 node:sqlite 真跑 SQL（D1 本身就是 SQLite，行为最接近）；
// R2 用内存 Map；waitUntil 收集起来由测试统一等。
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
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
      if (!o) return null;
      // 真 R2 里单次 PUT 对象的 etag 就是内容 MD5（带引号的十六进制），
      // 照真形态给：只给假字符串的话，「按 etag 存指纹」这类代码在本地
      // 永远测不出真效果（v1.1.8 起 complete 会读它）。没 body 的老数据
      // 才回落到原来的占位 etag。
      const etag = o.body ? '"' + createHash('md5').update(o.body).digest('hex') + '"' : '"mock-etag"';
      return { key, size: o.size, etag };
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

// —— 假 S3 CopyObject（供 upload-complete 的转正复制走 fetch 时用）——
// 生产代码用 S3 API 做 CopyObject（R2 绑定没有 copy 操作），本地测试里
// R2_S3_ENDPOINT 指向假域名、真 fetch 出不去，故按「最近一次
// createMockEnv 的端点主机名 + 共享 store」拦截 global fetch：只认带
// x-amz-copy-source 头的 PUT（即 CopyObject），其余请求一律放行真 fetch。
// e2e 里端点会被改成 127.0.0.1 的假 R2 服务，主机名对不上、自动放行到
// 真服务（假 R2 服务自己实现 COPY），两边口径一致。
let activeMockS3 = null;
let fetchWrapped = false;
function ensureMockS3Fetch() {
  if (fetchWrapped) return;
  fetchWrapped = true;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    try {
      const url = new URL(typeof input === 'string' ? input : input.url);
      const method = String(init.method || (typeof input !== 'string' ? input.method : '') || 'GET').toUpperCase();
      const headers = new Headers(init.headers || (typeof input !== 'string' ? input.headers : undefined));
      const copySource = headers.get('x-amz-copy-source');
      if (activeMockS3 && url.host === activeMockS3.host && method === 'PUT' && copySource) {
        const dstKey = decodeURIComponent(url.pathname.replace(/^\/[^/]+\//, ''));
        const srcKey = decodeURIComponent(copySource.replace(/^\/[^/]+\//, ''));
        const obj = activeMockS3.store.get(srcKey);
        if (!obj) return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
        activeMockS3.store.set(dstKey, { size: obj.size, body: obj.body });
        return new Response('<CopyObjectResult></CopyObjectResult>', { status: 200, headers: { 'Content-Type': 'application/xml' } });
      }
    } catch { /* 解析不了就放行真 fetch */ }
    return realFetch(input, init);
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
  // 登记本 env 为当前假 S3 的数据源（CopyObject 拦截按端点主机名认它）
  try { activeMockS3 = { host: new URL(env.R2_S3_ENDPOINT).host, store }; } catch { activeMockS3 = null; }
  ensureMockS3Fetch();
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
