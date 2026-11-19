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
export const PRESIGN_GET_TTL_SEC = 300;                 // 下载直链有效 5 分钟（且不超过分享剩余有效期）；点下载后换出、够开始下载即可，短有效期防直链被转发滥用（Peter 2026-11-19 拍板，原 1 小时）
// pending 占额封顶（配额统一口径，upload-init 与 stats 共用同一份）：
// pending 只是「声明要传」还没传完，空声明若按声明大小全额占容量，刷一批
// pending 就能把全站 10GB 堵死；故已用量里 pending 部分最多计总盘的 1/3，
// ready 全额计。upload-init 的准入判断与 stats 的对外展示都用这个口径，
// 不再各算各的（此前 stats 用无封顶 SUM、init 用封顶口径，两边对不上）。
export const PENDING_CAP_BYTES = Math.floor(TOTAL_CAP_BYTES / 3);
