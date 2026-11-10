// build-preview.mjs — 生成 preview.html（静态预览，给她看界面用）
// 把 public/index.html 复制一份并强制开启预览模式（上传为模拟，不调任何接口）。
// preview.html 不参与部署（Pages 只部署 public/ 目录），只用来在手机上打开看界面。
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'public', 'index.html'), 'utf8');
const needle = "var PREVIEW = new URLSearchParams(location.search).get('preview') === '1' || location.protocol === 'file:';";
if (!src.includes(needle)) {
  console.error('找不到预览开关那行，index.html 可能改过，先检查。');
  process.exit(1);
}
const out = src.replace(needle, 'var PREVIEW = true; // 预览版：强制开启模拟上传');
writeFileSync(join(here, '..', 'preview.html'), out);
console.log('已生成 preview.html（预览版，上传为模拟，不调任何接口）');
