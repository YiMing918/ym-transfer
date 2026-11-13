// consts.js — 全站共享常量：容量与时限只在这里定义一处
// 此前 MAX_FILE_BYTES / TOTAL_CAP_BYTES 在 upload-init 与 stats 各写一份、
// PENDING_TTL 在 upload-init / cleanup / stats 三处各写一个字面量，
// 改一处漏一处就会口径打架（v1.0 时 pending 时限与上传地址有效期
// 打架就是这么来的）。前端 public/index.html 里有同名数字，属静态页
// 无法 import，改这里时记得同步前端那份（数值保持一致即可）。

export const MAX_FILE_BYTES = 5 * 1024 * 1024 * 1024;   // 单文件上限 5 GiB
export const TOTAL_CAP_BYTES = 10 * 1024 * 1024 * 1024; // 站内总容量上限 10 GiB（免费 R2 上限）
export const UPLOAD_URL_TTL_SEC = 6 * 3600;             // 上传地址有效 6 小时，覆盖慢速大文件上传
// pending 保留必须 >= 上传地址有效期 + 缓冲：慢速大文件传满 6 小时才
// complete 时记录不能已被清（v1.0 是 1 小时，5GB 慢传必被中途清记录，
// 传完的对象成无记录孤儿、还不计入容量统计）
export const PENDING_TTL_SEC = UPLOAD_URL_TTL_SEC + 600;
export const PRESIGN_GET_TTL_SEC = 3600;                // 下载直链有效 1 小时（且不超过分享剩余有效期）
