// 极简 PNG 编码器：IHDR + IDAT(deflate) + IEND + CRC32
// 零第三方依赖；供「译文」渲染器按像素回调生成图像。
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'latin1');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** HSL(hue 0-360, s 0-1, l 0-1) → [r,g,b] 0-255 */
export function hslToRgb(hue, s = 0.55, l = 0.62) {
  const h = (((hue % 360) + 360) % 360) / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const conv = (t) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return [
    Math.round(conv(h + 1 / 3) * 255),
    Math.round(conv(h) * 255),
    Math.round(conv(h - 1 / 3) * 255),
  ];
}

/**
 * 按像素回调编码为 PNG（truecolor RGB，8bit）。
 * @param {number} width
 * @param {number} height
 * @param {(x:number, y:number, put:(r:number,g:number,b:number)=>void) => void} shade
 * @returns {Buffer}
 */
export function encodePng(width, height, shade) {
  const w = Math.max(1, Math.min(4096, Math.floor(width) || 400));
  const h = Math.max(1, Math.min(4096, Math.floor(height) || 600));
  const rowBytes = w * 3 + 1; // 每行 1 字节 filter + RGB
  const raw = Buffer.alloc(rowBytes * h);

  for (let y = 0; y < h; y++) {
    const off = y * rowBytes;
    raw[off] = 0; // filter type 0 (None)
    for (let x = 0; x < w; x++) {
      const p = off + 1 + x * 3;
      shade(x, y, (r, g, b) => {
        raw[p] = r & 0xff;
        raw[p + 1] = g & 0xff;
        raw[p + 2] = b & 0xff;
      });
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const idat = zlib.deflateSync(raw, { level: 6 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 按 seq 决定色相，保证相邻序号的标识色差异明显 */
export function hueForSeq(seq) {
  return (seq * 47) % 360;
}
