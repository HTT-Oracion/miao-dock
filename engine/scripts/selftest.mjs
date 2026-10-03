// mangatranslator-mock 自测 —— 覆盖 dev-plan.md §3 M2 的出口条件
//
// 运行：node engine/scripts/selftest.mjs
// 覆盖：① 渲染确定性与尺寸一致 ② 顶部色带 == (seq*47)%360（可像素级校验）
//       ③ /ready 就绪延迟 ④ /translate 正常与失败注入 ⑤ 非图片输入拒绝 ⑥ 端口自动探测
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import zlib from 'node:zlib';
import path from 'node:path';

import { encodePng, hslToRgb, hueForSeq } from '../src/png.mjs';
import { renderTranslatedPage } from '../src/render.mjs';

const ENTRY = path.resolve(import.meta.dirname, '..', 'src', 'server.mjs');

let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); } else {
    failed++; failures.push(name); console.log(`  ✗ ${name}${extra !== undefined ? `  → ${JSON.stringify(extra)}` : ''}`);
  }
}
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// ------------------------------------------------------------------ PNG 解码（只解析自己生成的格式，供像素断言）

function decodePng(buf) {
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG 魔数');
  let off = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.equal(data[8], 8, 'bit depth 8');
      assert.equal(data[9], 2, 'truecolor RGB');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 3 + 1;
  return {
    width,
    height,
    pixel: (x, y) => {
      const p = y * stride + 1 + x * 3;
      return [raw[p], raw[p + 1], raw[p + 2]];
    },
  };
}

// ------------------------------------------------------------------ 进程

function spawnEngine(env) {
  const child = spawn(process.execPath, [ENTRY], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const state = { child, out: '', err: '', ready: null };
  child.stdout.on('data', (d) => {
    state.out += d.toString();
    const m = /MIAO_ENGINE_READY (\{.*\})/.exec(state.out);
    if (m && !state.ready) { try { state.ready = JSON.parse(m[1]); } catch { /* ignore */ } }
  });
  child.stderr.on('data', (d) => { state.err += d.toString(); });
  return state;
}
const kill = (s) => { if (s && s.child.exitCode === null) s.child.kill('SIGTERM'); };

function req(port, method, pathname, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (body) h['Content-Length'] = body.length;
    const r = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

function listenOccupied(port) {
  return new Promise((resolve) => {
    const s = net.createServer(() => {});
    s.listen(port, '127.0.0.1', () => resolve(s));
    s.on('error', () => resolve(null));
  });
}

// ------------------------------------------------------------------ ① ② 渲染（纯函数，不起进程）

console.log('① 渲染确定性与尺寸');
{
  const a = renderTranslatedPage(120, 180, 7);
  const b = renderTranslatedPage(120, 180, 7);
  check('同一 seq 渲染结果字节级一致（可作回归比对）', a.equals(b));
  const c = renderTranslatedPage(120, 180, 8);
  check('不同 seq 渲染结果不同', !a.equals(c));

  const img = decodePng(a);
  check('输出尺寸与原图一致（120×180）', img.width === 120 && img.height === 180, [img.width, img.height]);

  check('极小尺寸不退化为 0（1×1 可用）', decodePng(renderTranslatedPage(1, 1, 1)).width === 1);
  check('超大尺寸被钳到 4096 以内', decodePng(renderTranslatedPage(9999, 20, 1)).width === 4096);
}

console.log('② 每页标识色 == (seq*47)%360（可像素级校验）');
{
  // 尺寸覆盖小图与**真实页面尺寸**：真实尺寸下外框更宽，曾把色带整条吞掉（回归钉）
  for (const [w, h] of [[64, 96], [700, 1000]]) {
    for (const seq of [1, 5, 37]) {
      const img = decodePng(renderTranslatedPage(w, h, seq));
      const got = img.pixel(Math.floor(w / 2), 3); // 顶部色带
      const want = hslToRgb(hueForSeq(seq), 0.72, 0.68);
      check(`${w}×${h} seq=${seq} 顶部色带颜色与 hueForSeq 一致`, JSON.stringify(got) === JSON.stringify(want), { got, want });
    }
  }
  const img = decodePng(renderTranslatedPage(700, 1000, 3));
  check('色带只占顶部 4px，第 5 行已回到版式区', JSON.stringify(img.pixel(350, 4)) !== JSON.stringify(hslToRgb(hueForSeq(3), 0.72, 0.68)));
}

// ------------------------------------------------------------------ 进程级

let eng = null;
try {
  eng = spawnEngine({ MIAO_ENGINE_PORT: '5003', MIAO_ENGINE_ITEM_MS: '20', MIAO_ENGINE_START_MS: '1200', MIAO_ENGINE_FAIL_SEQ: '5' });
  await sleep(300);

  console.log('③ 就绪延迟（覆盖 Service 的 starting 态）');
  const early = await req(5003, 'GET', '/ready');
  check('预热中 /ready → 503 starting', early.status === 503 && JSON.parse(early.body).status === 'starting', early.status);

  await sleep(1400);
  const ready = await req(5003, 'GET', '/ready');
  const rj = JSON.parse(ready.body);
  check('/ready 就绪 → 200 且 service === "mangatranslator"', ready.status === 200 && rj.service === 'mangatranslator', rj);
  check('引擎标识为 sakura-mock（与契约 §5.2 translator 字段一致）', rj.engine === 'sakura-mock', rj.engine);
  await sleep(100);
  const info = eng.ready;
  check('就绪行 MIAO_ENGINE_READY 携带端口', !!info && info.port === 5003, eng.out.split('\n').filter((l) => l.includes('READY')));

  console.log('④ /translate 正常路径与失败注入');
  const input = encodePng(80, 120, (x, y, put) => put(x % 256, y % 256, 128));
  const ok = await req(5003, 'POST', '/translate', {
    headers: { 'Content-Type': 'image/png', 'X-Miao-Seq': '1', 'X-Miao-From': 'ja', 'X-Miao-To': 'zh' },
    body: input,
  });
  check('/translate 200 + image/png', ok.status === 200 && /image\/png/.test(ok.headers['content-type'] || ''), ok.status);
  check('译文为合法 PNG', ok.body.subarray(0, 8).toString('hex') === '89504e470d0a1a0a');
  check('译文尺寸与原图一致（80×120）', (() => { const d = decodePng(ok.body); return d.width === 80 && d.height === 120; })());

  const bad = await req(5003, 'POST', '/translate', {
    headers: { 'Content-Type': 'image/png', 'X-Miao-Seq': '5' }, body: input,
  });
  const bj = JSON.parse(bad.body);
  check('注入失败 seq → 500 + 错误信封', bad.status === 500 && bj.error?.code === 'ENGINE_INFERENCE_FAILED', bj);

  console.log('⑤ 非图片输入拒绝');
  const garbage = await req(5003, 'POST', '/translate', {
    headers: { 'Content-Type': 'application/octet-stream', 'X-Miao-Seq': '2' }, body: Buffer.from('not an image at all'),
  });
  check('非图片字节 → 400 ENGINE_BAD_INPUT', garbage.status === 400 && JSON.parse(garbage.body).error?.code === 'ENGINE_BAD_INPUT', garbage.status);

  const unknown = await req(5003, 'GET', '/nope');
  check('未知端点 → 404 ENGINE_NOT_FOUND', unknown.status === 404);

  console.log('⑥ 端口自动探测');
  // 用独立端口段（5010 起），避免与正在运行的主引擎（5003）抢端口
  const blocker = await listenOccupied(5010);
  if (blocker) {
    const eng2 = spawnEngine({ MIAO_ENGINE_PORT: '5010', MIAO_ENGINE_ITEM_MS: '20' });
    const until = Date.now() + 8000;
    while (!eng2.ready && Date.now() < until) await sleep(50);
    check('5010 被占 → 自动落到 5011', eng2.ready?.port === 5011, eng2.ready);
    kill(eng2);
    blocker.close();
  } else {
    check('前置：5010 可被占用（端口探测用例）', false);
  }
} catch (err) {
  failed++; failures.push(`运行期异常：${err.message}`);
  console.error(err);
} finally {
  kill(eng);
  await sleep(200);
}

console.log('\n================ 引擎自测 ================');
console.log(`  通过 ${passed} / 失败 ${failed}`);
if (failures.length) { console.log('  失败项：'); for (const f of failures) console.log(`    · ${f}`); }
console.log('=========================================');
process.exit(failed === 0 ? 0 : 1);
