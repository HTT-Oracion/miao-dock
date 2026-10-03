#!/usr/bin/env node
/**
 * 生成 `app/src-tauri/testdata/probe.png` —— 自检里「关窗后提交一张图」用的样张。
 *
 * B1 的判据不只是「窗口隐藏了」，还有「**此时用插件/curl 提交任务仍成功执行**」。
 * 要真的走一遍提交，就得有一张**真的** PNG —— 服务端有魔数嗅探（契约 §8.2），
 * 塞一段假字节会被 INVALID_IMAGE 挡下，那样测出来的只是「校验还在」，不是「还能干活」。
 *
 * 复用引擎自己的编码器，保证产出的就是引擎认得的那种 PNG（不引第三方依赖）。
 * 尺寸取 40×60：够小（几百字节，可随源码提交），又够大，让引擎的译文渲染
 * （顶部 4px 标识色带 + 文本行 + 对话框）有正常发挥的余地。
 *
 * 用法：node scripts/make-probe-png.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

import { encodePng } from '../engine/src/png.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'app', 'src-tauri', 'testdata', 'probe.png');

const W = 40;
const H = 60;
// 做个可辨认的斜向渐变：给引擎一个「像图」的输入，而不是一整块纯色
const png = encodePng(W, H, (x, y, put) => {
  put((x * 6) % 256, (y * 4) % 256, 128);
});

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, png);
console.log(`${path.relative(ROOT, OUT)}  ${W}×${H}  ${png.length} 字节`);
