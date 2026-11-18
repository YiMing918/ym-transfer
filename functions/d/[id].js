// d/[id].js — 下载入口：/d/<32 位链接 ID>
// 查元数据 → 未过期且已就绪 → 302 跳转到 R2 预签名 GET（最长 1 小时、且不超过
// 分享剩余有效期，下载文件名是原文件名）。注意口径：次数限制的是「经本入口
// 领取直链的次数」；直链在有效期内可重复下载，这是预签名直链的固有形态。
// 浏览器直接从 R2 下载，文件字节不经过 Worker。
// 过期/不存在/未传完时返回中文提示页；访问到已过期链接时顺手删掉 R2 对象与记录（懒清理）。

import { nowSec, esc } from '../_lib/http.js';
import { first, run } from '../_lib/db.js';
import { presignGet } from '../_lib/r2sign.js';
import { PRESIGN_GET_TTL_SEC } from '../_lib/consts.js';

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
    // 懒清理：过期了顺手删（不阻塞响应）。对象删失败时记录必须留下，
    // 否则对象成无主孤儿——留着记录，定时清理会重试（与 cron 同语义）
    waitUntil((async () => {
      try { await env.FILES.delete(row.r2_key); }
      catch { return; }
      try { await run(env, 'DELETE FROM files WHERE id = ?', id); } catch { /* 下次再清 */ }
    })());
    return gonePage('这个文件已经过期被删除了');
  }
  if (row.max_downloads !== null && row.downloads >= row.max_downloads) {
    // 次数已用完：不立即删——已领到直链的人可能还在下载，当场删对象会
    // 把他们的下载掐断。改为把有效期收紧到「已签发直链的最长寿命」，
    // 到点后由过期清理（懒清理 + 定时清理）统一删除
    const cap = Math.min(row.expires_at, now + PRESIGN_GET_TTL_SEC);
    if (cap < row.expires_at) {
      waitUntil(run(env, 'UPDATE files SET expires_at = ? WHERE id = ?', cap, id).catch(() => {}));
    }
    return gonePage('这个链接的下载次数已用完');
  }

  let signed;
  try {
    // 直链有效期不超过分享的剩余有效期（此前固定 1 小时，文件只剩
    // 5 分钟到期时直链还能再活 55 分钟）
    const ttl = Math.max(1, Math.min(PRESIGN_GET_TTL_SEC, row.expires_at - now));
    signed = await presignGet(env, row.r2_key, { contentType: row.mime, filename: row.orig_name, expiresSec: ttl });
  } catch {
    return new Response('下载地址签发失败，请稍后再试', { status: 500 });
  }
  // 计次口径（C-1/C-35 修复）：只有 HEAD 探测不计次；其余任何 UA 的 GET
  // 都必须先原子占位计数再发链——此前带 bot/preview/scanner 等字样的 UA
  // 免计数却照发直链，限次链接换个 UA 就能无限下，限次形同虚设。聊天
  // 软件的预览抓取从此与普通 GET 同等对待（计数后发链），不再免计数。
  // 不限次文件不再逐次写计数：每次打开都写一笔 D1 纯属浪费写额度，
  // downloads 对不限次文件没有展示/统计用途（见 C-35）。
  if (row.max_downloads !== null && request.method !== 'HEAD') {
    // 有次数上限：先原子占位（条件更新），抢到才放行，并发打开也不会超发。
    // 计数失败（数据库异常/结果读不到）时关门返回 503，不再 fail-open
    // 放行——否则计数形同虚设（v1.0 的回落逻辑会无条件 +1 后照样发链）
    let changed = null;
    try {
      const res = await run(env, 'UPDATE files SET downloads = downloads + 1 WHERE id = ? AND downloads < ?', id, row.max_downloads);
      changed = res && res.meta ? res.meta.changes : null;
    } catch { changed = null; }
    if (changed === 0) return gonePage('这个链接的下载次数已用完');
    if (changed === null) {
      return new Response('服务暂时不可用（计数失败），请稍后再试', { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
  }
  return Response.redirect(signed.url, 302);
}
