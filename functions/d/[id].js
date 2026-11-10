// d/[id].js — 下载入口：/d/<32 位链接 ID>
// 查元数据 → 未过期且已就绪 → 302 跳转到 R2 预签名 GET（1 小时有效，下载文件名是原文件名）
// 浏览器直接从 R2 下载，文件字节不经过 Worker。
// 过期/不存在/未传完时返回中文提示页；访问到已过期链接时顺手删掉 R2 对象与记录（懒清理）。

import { nowSec, esc } from '../_lib/http.js';
import { first, run } from '../_lib/db.js';
import { presignGet } from '../_lib/r2sign.js';

function gonePage(msg) {
  const safe = esc(msg);
  return new Response(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>文件已失效 - YM 传文件</title><style>body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;background:#0b1220;color:#dbe6f5;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;text-align:center}h1{font-size:20px}p{color:#8498b3;font-size:14px;line-height:1.8}a{color:#2ea6ff}</style></head><body><div><h1>😕 ${safe}</h1><p>链接不存在、还没传完，或者已经过期被删除了。<br><a href="/">回首页传一个新文件</a></p></div></body></html>`, {
    status: 404,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function onRequest(context) {
  const { request, env, params, waitUntil } = context;
  const id = String(params.id || '');
  if (!/^[0-9a-f]{32}$/.test(id)) return gonePage('这个下载链接不对');
  const now = nowSec();
  const row = await first(env, 'SELECT * FROM files WHERE id = ?', id);
  if (!row) return gonePage('这个下载链接不存在');
  if (row.status === 'pending') return gonePage('文件还在上传中，请等上传完成后再打开');
  if (row.status !== 'ready' || row.expires_at <= now) {
    // 懒清理：过期了顺手删掉 R2 对象与记录（不阻塞响应）
    waitUntil((async () => {
      try { await env.FILES.delete(row.r2_key); } catch { /* 忽略 */ }
      try { await run(env, 'DELETE FROM files WHERE id = ?', id); } catch { /* 忽略 */ }
    })());
    return gonePage('这个文件已经过期被删除了');
  }
  if (row.max_downloads !== null && row.downloads >= row.max_downloads) {
    // 下载次数已用完：同样顺手清理
    waitUntil((async () => {
      try { await env.FILES.delete(row.r2_key); } catch { /* 忽略 */ }
      try { await run(env, 'DELETE FROM files WHERE id = ?', id); } catch { /* 忽略 */ }
    })());
    return gonePage('这个链接的下载次数已用完');
  }

  let signed;
  try {
    signed = await presignGet(env, row.r2_key, { contentType: row.mime, filename: row.orig_name, expiresSec: 3600 });
  } catch {
    return new Response('下载地址签发失败，请稍后再试', { status: 500 });
  }
  // 下载计数（不阻塞跳转）
  waitUntil(run(env, 'UPDATE files SET downloads = downloads + 1 WHERE id = ?', id).catch(() => {}));
  return Response.redirect(signed.url, 302);
}
