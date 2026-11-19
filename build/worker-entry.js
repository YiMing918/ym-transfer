// build/worker-entry.js — 「_worker.js 高级模式包」的构建入口（本文件不要直接部署）
//
// 为什么需要它：Cloudflare 控制台的「上传资产 / 拖拽」部署**不会编译 functions/
// 文件夹**（官方文档明示），把普通部署包直传上去会得到一个页面能开、但上传/
// 下载接口全部坏死的站。官方确认根目录的单个 `_worker.js` 在拖拽上传下受
// 支持，所以打包时用 esbuild 把 functions/ 的原处理函数合成一个 _worker.js，
// 原函数源码一字不改，逻辑还是同一套。
//
// 构建命令（release-pack 工作流里执行，本地复现也是这一条）：
//   esbuild build/worker-entry.js --bundle --format=esm \
//     --platform=neutral --target=es2022 --outfile=_worker.js
// 打包时还要把 public/ 里的静态文件摊平到包根目录（原部署的资产根就是
// public/），与 _worker.js 同放。
//
// 路由语义与 functions 文件路由对齐：5 个 /api/* 文件与 /d/[id] 都导出通用
// onRequest（方法在函数内部分发），入口按精确路径分发、不限方法；/d/<id>
// 用正则捕获 id 并按原样塞进 context.params（原 handler 从 params.id 取，
// 还要用到 waitUntil，原样透传）。路径匹配前去掉一个尾斜杠（与原版文件
// 路由的尾斜杠等价口径一致）。其余路径走 env.ASSETS.fetch 原样返回——
// 本仓原版没有单页回退，未知路径就是平台 404，不要画蛇添足。

import { onRequest as cleanup } from '../functions/api/cleanup.js';
import { onRequest as del } from '../functions/api/delete.js';
import { onRequest as stats } from '../functions/api/stats.js';
import { onRequest as uploadComplete } from '../functions/api/upload-complete.js';
import { onRequest as uploadInit } from '../functions/api/upload-init.js';
import { onRequest as download } from '../functions/d/[id].js';

const ROUTES = {
  '/api/cleanup': cleanup,
  '/api/delete': del,
  '/api/stats': stats,
  '/api/upload-complete': uploadComplete,
  '/api/upload-init': uploadInit,
};
const D_RE = /^\/d\/([^/]+)$/;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    let path = url.pathname;
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    const base = {
      request,
      env,
      waitUntil: ctx.waitUntil.bind(ctx),
      next: () => env.ASSETS.fetch(request),
    };
    const handler = ROUTES[path];
    if (handler) return handler({ ...base, params: {} });
    const m = path.match(D_RE);
    if (m) {
      let id = m[1];
      try { id = decodeURIComponent(id); } catch { /* 保持原样 */ }
      return download({ ...base, params: { id } });
    }
    // 静态文件只有首页一个（public/ 里就一个 index.html）。原版静态层口径：
    // GET/HEAD 找不到文件时回落首页（无 404.html 时的平台单页回退）、其它
    // 方法回 405。高级模式下 ASSETS.fetch 对 GET/HEAD 的回落与原版一致，
    // 原样用它；非 GET/HEAD 它会错误地回落首页，故在这里按原版口径回 405
    // （带平台默认的 Referrer-Policy 头）。
    if (request.method === 'GET' || request.method === 'HEAD') {
      // 静态响应补基础安全头：高级模式下 public/_headers 不一定生效，
      // 在这里给资产响应统一加上，与函数层 http.js 的口径一致。
      const res = await env.ASSETS.fetch(request);
      const headers = new Headers(res.headers);
      headers.set('X-Content-Type-Options', 'nosniff');
      headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
      headers.set('X-Frame-Options', 'DENY');
      headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    }
    return new Response(null, {
      status: 405,
      headers: { 'Referrer-Policy': 'strict-origin-when-cross-origin' },
    });
  },
};
