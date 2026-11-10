// frontend.mjs — 前端冒烟测试：用最小 DOM 替身跑 preview.html 里的真实脚本，
// 模拟她在手机上的操作：选文件 → 点上传 → 看进度 → 出链接 → 复制 → 再传一个。
// 同时校验 index.html / preview.html 的脚本无语法错误。
// 用法：node scripts/frontend.mjs；任一失败即 exit 1。
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

function extractScript(html) {
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, '应含 <script>');
  return m[1];
}

let pass = 0, fail = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; failures.push(name); console.log(`  ✗ ${name}\n    ${String(e.message || e).split('\n')[0]}`); }
}

// —— DOM 替身 ——
function makeEl(id) {
  const el = {
    id,
    style: {},
    textContent: '',
    innerHTML: '',
    value: '',
    disabled: false,
    files: [],
    __handlers: {},
    classList: { _set: new Set(), add(c) { this._set.add(c); }, remove(c) { this._set.delete(c); }, toggle(c, f) { f ? this._set.add(c) : this._set.delete(c); }, contains(c) { return this._set.has(c); } },
    addEventListener(ev, fn) { (this.__handlers[ev] = this.__handlers[ev] || []).push(fn); },
    trigger(ev, arg) { (this.__handlers[ev] || []).forEach((fn) => fn(arg || {})); },
    click() { this.trigger('click', { target: this }); },
    select() { this.__selected = true; },
    focus() {},
    getAttribute(k) { return this.__attrs ? this.__attrs[k] : null; },
    closest() { return this; },
    querySelectorAll() { return []; },
  };
  return el;
}

function runPage(html, { protocol = 'file:', search = '' } = {}) {
  const script = extractScript(html);
  const ids = ['previewBanner', 'dropZone', 'fileInput', 'fileInfo', 'fileName', 'fileMeta', 'expiryBox', 'expirySeg', 'dlBox', 'dlSeg', 'uploadBtn', 'progressBox', 'progText', 'progPct', 'progBar', 'progSpeed', 'progEta', 'resultBox', 'linkInput', 'copyBtn', 'resultMeta', 'againBtn', 'errorBox', 'usedText', 'usedBar'];
  const els = {};
  for (const id of ids) els[id] = makeEl(id);
  // 有效期六个按钮（小时/天统一按小时算，默认 1 天 = 24 小时）
  const segBtns = [1, 6, 12, 24, 72, 168].map((h) => {
    const b = makeEl('seg-' + h);
    b.__attrs = { 'data-hours': String(h) };
    if (h === 24) b.classList.add('on');
    return b;
  });
  els.expirySeg.querySelectorAll = () => segBtns;
  // 下载次数四个按钮（默认不限）
  const dlBtns = ['', 1, 5, 10].map((c) => {
    const b = makeEl('dl-' + (c === '' ? 'unlimited' : c));
    b.__attrs = { 'data-count': String(c) };
    if (c === '') b.classList.add('on');
    return b;
  });
  els.dlSeg.querySelectorAll = () => dlBtns;
  let execCopyCalled = false;
  const sandbox = {
    document: {
      getElementById: (id) => els[id] || null,
      execCommand: (cmd) => { if (cmd === 'copy') execCopyCalled = true; return true; },
    },
    location: { search, protocol, origin: 'https://ym-transfer.pages.dev' },
    navigator: {},
    fetch: () => { throw new Error('预览模式不应调 fetch'); },
    XMLHttpRequest: function () { throw new Error('预览模式不应 new XMLHttpRequest'); },
    setTimeout, setInterval, clearInterval, clearTimeout,
    URLSearchParams,
    console,
  };
  sandbox.window = sandbox;
  const fn = new Function(...Object.keys(sandbox), script);
  fn(...Object.values(sandbox));
  return { els, segBtns, dlBtns, isExecCopyCalled: () => execCopyCalled };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('— 脚本语法 —');
await test('index.html 与 preview.html 的脚本无语法错误', async () => {
  for (const f of ['public/index.html', 'preview.html']) {
    const html = readFileSync(join(root, f), 'utf8');
    const script = extractScript(html);
    const tmp = join(here, '.tmp-check.js');
    const { writeFileSync, unlinkSync } = await import('node:fs');
    writeFileSync(tmp, script);
    execSync(`node --check ${tmp}`, { stdio: 'pipe' });
    unlinkSync(tmp);
  }
});

console.log('— 预览流程（模拟她在手机上的操作）—');
await test('打开预览：横幅显示，站内已用显示模拟值', async () => {
  const html = readFileSync(join(root, 'preview.html'), 'utf8');
  const { els } = runPage(html);
  assert.strictEqual(els.previewBanner.style.display, 'block', '预览横幅应显示');
  assert.strictEqual(els.usedText.textContent, '2.3 GB');
});
await test('选文件：显示文件名与大小，上传按钮可用', async () => {
  const html = readFileSync(join(root, 'preview.html'), 'utf8');
  const { els } = runPage(html);
  const fake = { name: '我的文件.zip', size: 10 * 1024 * 1024, type: 'application/zip' };
  els.fileInput.files = [fake];
  els.fileInput.trigger('change');
  assert.strictEqual(els.fileInfo.style.display, 'block');
  assert.strictEqual(els.fileName.textContent, '我的文件.zip');
  assert.ok(els.fileMeta.textContent.includes('10.0 MB'), '应显示 10.0 MB');
  assert.strictEqual(els.expiryBox.style.display, 'block');
  assert.strictEqual(els.dlBox.style.display, 'block', '下载次数选项应显示');
  assert.strictEqual(els.uploadBtn.disabled, false);
});
await test('超 5GB 文件：立即报错，不让上传', async () => {
  const html = readFileSync(join(root, 'preview.html'), 'utf8');
  const { els } = runPage(html);
  els.fileInput.files = [{ name: 'big.iso', size: 6 * 1024 * 1024 * 1024, type: 'application/octet-stream' }];
  els.fileInput.trigger('change');
  assert.strictEqual(els.errorBox.style.display, 'block');
  assert.ok(els.errorBox.textContent.includes('5 GB'), '应提示 5GB 上限');
  assert.strictEqual(els.uploadBtn.disabled, true);
});
await test('点上传：模拟进度走完，出下载链接；复制、再传一个都正常', async () => {
  const html = readFileSync(join(root, 'preview.html'), 'utf8');
  const { els, isExecCopyCalled } = runPage(html);
  const fake = { name: '报告.pdf', size: 10 * 1024 * 1024, type: 'application/pdf' };
  els.fileInput.files = [fake];
  els.fileInput.trigger('change');
  els.uploadBtn.trigger('click');
  assert.strictEqual(els.progressBox.style.display, 'block', '应显示进度条');
  // 等模拟上传跑完（每 120ms 一格，10MB 约 6 格）
  const deadline = Date.now() + 5000;
  while (els.resultBox.style.display !== 'block' && Date.now() < deadline) await sleep(200);
  assert.strictEqual(els.resultBox.style.display, 'block', '应出结果区');
  assert.ok(els.linkInput.value.includes('/d/'), '链接应含 /d/ 路径');
  assert.ok(els.linkInput.value.includes('ym-transfer.pages.dev'), '链接应是本站域名');
  assert.ok(els.resultMeta.innerHTML.includes('报告.pdf'), '结果区应显示文件名');
  assert.ok(els.resultMeta.innerHTML.includes('到期自动删除'), '结果区应提示到期删除');
  els.copyBtn.trigger('click');
  assert.ok(isExecCopyCalled(), '复制应走 fallback（无 clipboard 时）');
  els.againBtn.trigger('click');
  assert.strictEqual(els.resultBox.style.display, 'none', '再传一个应隐藏结果');
  assert.strictEqual(els.uploadBtn.disabled, true, '再传一个后上传按钮应禁用');
});
await test('有效期切换：默认 1 天；点 7 天，按钮高亮跟着变', async () => {
  const html = readFileSync(join(root, 'preview.html'), 'utf8');
  const { els, segBtns } = runPage(html);
  assert.ok(segBtns.find((b) => b.__attrs['data-hours'] === '24').classList.contains('on'), '默认应是 1 天高亮');
  const btn168 = segBtns.find((b) => b.__attrs['data-hours'] === '168');
  els.expirySeg.trigger('click', { target: btn168 });
  assert.ok(btn168.classList.contains('on'), '7 天按钮应高亮');
  assert.ok(!segBtns.find((b) => b.__attrs['data-hours'] === '24').classList.contains('on'), '1 天按钮应取消高亮');
});
await test('有效期切换：点 6 小时，高亮跟着变', async () => {
  const html = readFileSync(join(root, 'preview.html'), 'utf8');
  const { els, segBtns } = runPage(html);
  const btn6 = segBtns.find((b) => b.__attrs['data-hours'] === '6');
  els.expirySeg.trigger('click', { target: btn6 });
  assert.ok(btn6.classList.contains('on'), '6 小时按钮应高亮');
  assert.ok(!segBtns.find((b) => b.__attrs['data-hours'] === '24').classList.contains('on'), '1 天按钮应取消高亮');
});
await test('下载次数切换：默认不限；点 5 次，按钮高亮跟着变', async () => {
  const html = readFileSync(join(root, 'preview.html'), 'utf8');
  const { els, dlBtns } = runPage(html);
  const unlimited = dlBtns.find((b) => b.__attrs['data-count'] === '');
  assert.ok(unlimited.classList.contains('on'), '默认应是“不限”高亮');
  const btn5 = dlBtns.find((b) => b.__attrs['data-count'] === '5');
  els.dlSeg.trigger('click', { target: btn5 });
  assert.ok(btn5.classList.contains('on'), '5 次按钮应高亮');
  assert.ok(!unlimited.classList.contains('on'), '“不限”按钮应取消高亮');
});

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
if (fail) {
  console.log('失败的用例：' + failures.join('；'));
  process.exit(1);
}
console.log('全部通过 ✓');
