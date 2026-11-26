/**
 * 应用图标的小尺寸帧。零依赖，Node 18+。
 *
 * 应用图标和托盘图标是同一个构成：一个只描边的圆角方框，里面一只单色鼠标、一枚绿灯。
 * 应用图标多一块底板（要放在浅色、深色各种背景上），框和鼠标画成白的；托盘图标不带底板、墨色跟随主题，
 * 在 src-tauri/src/tray.rs 里现画。
 *
 * 以前小尺寸另有一套「越小越粗」的比例（24 像素下鼠标宽到画面的 74%）：那时图标的外轮廓靠鼠标自己撑，
 * 鼠标一细就显小。2026-11-26 用户看了安装包的图标，说「还是胖胖的鼠标图标」。现在外轮廓由框撑着，
 * 鼠标在哪个尺寸都保持托盘图标里的细长比例，不用再加粗。
 *
 * 比例记在 MASTER 里，就是大图（design/icon/IncottFramedMouse，画布 1024）里的像素数，小尺寸帧照着缩。
 * 只有线宽不是等比缩放的：16 像素下线要 1 像素才看得见，图越大在比例上越细——
 * 16 像素下 1 像素，64 像素下 3 像素，256 像素（大图缩出来的）是 8 像素。
 *
 * icon.ico 里 16 / 24 / 32 / 48 / 64 五帧是这里画的；256 那一帧是大图缩出来的（npx tauri icon）。
 *
 *   node design/icon/small-frames.mjs                 # 把小尺寸帧写回 src-tauri/icons/icon.ico
 *   node design/icon/small-frames.mjs --check         # 只核对，不一致时退出码 1（npm test 也跑）
 *   node design/icon/small-frames.mjs --sheet 图.png   # 放大预览 ico 里的各帧（浅色、深色底各一份）
 *
 * 跑过 `npx tauri icon` 之后要再跑一遍本脚本：那一步会用大图重写全部帧。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import zlib from 'node:zlib';

export const ICO = new URL('../../src-tauri/icons/icon.ico', import.meta.url);

/**
 * 大图里的像素数（画布 1024，中心在 512）。鼠标各部分到中心的距离都从中心量起。
 * test/icon.test.js 拿 design/icon/IncottFramedMouse/incottframedmouse.svg 逐项核对这里的数
 */
export const MASTER = {
  frame: 758, // 方框外沿的边长
  frameRadius: 170, // 方框圆角
  stroke: 32, // 大图里的线宽（缩到 256 像素那一帧是 8 像素）
  mouseW: 394,
  mouseH: 522,
  notchW: 47, // 分键线的宽
  notchTop: 37.9, // 分键线顶端离鼠标顶边
  notchEnd: 0.4, // 分键线通到鼠标高度的多少
  lampR: 56.9,
  lampCy: 110.5, // 灯心在中心下方
  tileRadius: 224, // 圆角预览图（.preview.svg 的 clipPath）的半径；.ico 里的帧用它
};
/** 鼠标的顶部圆拱、底部收圆各是半宽的多少（tray.rs 里也是这两个数） */
const DOME = 0.78;
const BOTTOM_DOME = 0.42;

/** 由本脚本画的那几帧 */
export const SMALL_SIZES = [16, 24, 32, 48, 64];

/** 这一帧及以下：底板更黑、线条纯白——细线被抗锯齿冲淡以后还得站得住 */
const PURE_WHITE_BELOW = 24;

/** 指示灯的颜色（界面的 --success） */
export const LAMP_GREEN = [0x46, 0xc9, 0x8c];

/** 方框的线宽（像素）：16 像素下 1，64 像素下 3；再往上由大图缩放接手（128 像素下 4，256 下 8） */
export function strokeFor(size) {
  return Math.max(1, Math.round(0.0948 * size ** 0.8));
}

/** 边长 size 的一帧里各部分落在哪（像素，到中心的距离；inset 是方框外沿离画布边的距离） */
export function layoutFor(size) {
  const u = size / 1024;
  const frame = MASTER.frame * u;
  return {
    size,
    u,
    inset: Math.round((size - frame) / 2), // 取整：方框的直边落在像素边界上，线才是实的
    stroke: strokeFor(size),
    frameRadius: MASTER.frameRadius * u,
    tileRadius: MASTER.tileRadius * u,
  };
}

// ── 画 ─────────────────────────────────────────────────────
// 有向距离（像素单位，内部为负），只在边缘做 1 像素宽的抗锯齿。同 tray.rs
const sdRoundBox = (x, y, hx, hy, r) => {
  const qx = Math.abs(x) - hx + r;
  const qy = Math.abs(y) - hy + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
const sdEllipse = (x, y, rx, ry) => {
  const k0 = Math.hypot(x / rx, y / ry);
  const k1 = Math.max(Math.hypot(x / (rx * rx), y / (ry * ry)), 1e-6);
  return (k0 * (k0 - 1)) / k1;
};
const coverage = (d) => Math.min(1, Math.max(0, 0.5 - d));
/** 把 src（不透明度 s）叠在 dst（不透明度 d）上，返回合成后的颜色和不透明度 */
const over = (dst, d, src, s) => {
  const a = s + d * (1 - s);
  return [src.map((c, k) => (a > 0 ? (c * s + dst[k] * d * (1 - s)) / a : 0)), a];
};

/**
 * 画 size × size 的图标，返回 RGBA。
 * 自下而上合成：底板 → 方框 → 鼠标 → 分键线（底色）→ 指示灯
 */
export function paint(size) {
  const { u, inset, stroke, frameRadius, tileRadius } = layoutFor(size);
  const half = size / 2;
  const outer = half - inset; // 方框外沿到中心
  const pure = size <= PURE_WHITE_BELOW;
  const tile = pure ? [0x11, 0x11, 0x13] : [0x23, 0x23, 0x27];
  const body = pure ? [0xff, 0xff, 0xff] : [0xed, 0xed, 0xee];
  // 鼠标：顶部圆拱，中间直边，底部收圆
  const rx = (MASTER.mouseW / 2) * u;
  const top = (-MASTER.mouseH / 2) * u;
  const dome = DOME * rx;
  const bottomDome = BOTTOM_DOME * rx;
  const domeCy = top + dome;
  const bottomCy = (MASTER.mouseH / 2) * u - bottomDome;
  // 分键线：离顶边一点，通到 40% 的高度（通到顶的话会和上面的框连成一条线）
  const notchHw = Math.max((MASTER.notchW / 2) * u, 0.3);
  const notchTop = top + MASTER.notchTop * u;
  const notchEnd = top + MASTER.notchEnd * MASTER.mouseH * u;
  // 指示灯
  const lampR = Math.max(MASTER.lampR * u, 0.9);
  const lampCy = MASTER.lampCy * u;

  const rgba = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5 - half;
      const py = y + 0.5 - half;
      const base = coverage(sdRoundBox(px, py, half, half, tileRadius));
      if (base <= 0) continue;
      // 方框 = 落在外沿之内的覆盖率 − 落在内沿之内的覆盖率（次序不能反：反过来是负的，框会整个消失）
      const frame = Math.max(
        coverage(sdRoundBox(px, py, outer, outer, frameRadius)) -
          coverage(sdRoundBox(px, py, outer - stroke, outer - stroke, Math.max(frameRadius - stroke, 0))),
        0,
      );
      const mouse = coverage(
        Math.min(
          sdEllipse(px, py - domeCy, rx, dome),
          sdEllipse(px, py - bottomCy, rx, bottomDome),
          sdRoundBox(px, py - (domeCy + bottomCy) / 2, rx, (bottomCy - domeCy) / 2, 0),
        ),
      );
      const notch =
        coverage(sdRoundBox(px, py - (notchTop + notchEnd) / 2, notchHw, (notchEnd - notchTop) / 2, notchHw)) * mouse;
      const lit = coverage(Math.hypot(px, py - lampCy) - lampR) * mouse;
      let [rgb, a] = over(tile, 1, body, frame);
      [rgb, a] = over(rgb, a, body, mouse * (1 - notch));
      [rgb, a] = over(rgb, a, LAMP_GREEN, lit);
      const i = (y * size + x) * 4;
      for (let k = 0; k < 3; k++) rgba[i + k] = Math.round(rgb[k]);
      rgba[i + 3] = Math.round(a * base * 255);
    }
  }
  return rgba;
}

/** 应用图标在边长 size 时的那一帧（绿码灯） */
export function frameFor(size) {
  return paint(size);
}

// ── PNG ────────────────────────────────────────────────────
// 只管 8 位 RGB / RGBA / 调色板、不隔行——ico 里的帧和本脚本的输出都在这个范围内
const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
export function encodePng(rgba, w, h = w) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
export function decodePng(buf) {
  let w = 0;
  let h = 0;
  let type = 0;
  let plte = null;
  let trns = null;
  const idat = [];
  for (let p = 8; p < buf.length; ) {
    const len = buf.readUInt32BE(p);
    const name = buf.toString('latin1', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (name === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0 || ![2, 3, 6].includes(data[9])) {
        throw new Error(`不支持的 PNG：${data[8]} 位、颜色类型 ${data[9]}、隔行 ${data[12]}`);
      }
      type = data[9];
    } else if (name === 'IDAT') idat.push(data);
    else if (name === 'PLTE') plte = data;
    else if (name === 'tRNS') trns = data;
    else if (name === 'IEND') break;
    p += 12 + len;
  }
  const bpp = type === 6 ? 4 : type === 2 ? 3 : 1;
  const stride = w * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const rgba = new Uint8Array(w * h * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      if (filter === 1) line[i] = (line[i] + a) & 255;
      else if (filter === 2) line[i] = (line[i] + b) & 255;
      else if (filter === 3) line[i] = (line[i] + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        line[i] = (line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      } else if (filter !== 0) throw new Error(`不支持的 PNG 行滤波：${filter}`);
    }
    for (let x = 0; x < w; x++) {
      const d = (y * w + x) * 4;
      if (type === 6) line.copy(rgba, d, x * 4, x * 4 + 4);
      else if (type === 2) {
        rgba[d] = line[x * 3];
        rgba[d + 1] = line[x * 3 + 1];
        rgba[d + 2] = line[x * 3 + 2];
        rgba[d + 3] = 255;
      } else {
        rgba[d] = plte[line[x] * 3];
        rgba[d + 1] = plte[line[x] * 3 + 1];
        rgba[d + 2] = plte[line[x] * 3 + 2];
        rgba[d + 3] = trns && line[x] < trns.length ? trns[line[x]] : 255;
      }
    }
    prev = line;
  }
  return { w, h, rgba };
}

// ── ICO ────────────────────────────────────────────────────
// 6 字节文件头 + 每帧 16 字节的目录项（宽、高、位数、字节数、偏移），帧数据跟在后面。
// 帧可以是未压缩的位图，也可以是 PNG；这里只认 PNG（npx tauri icon 产出的和本脚本写回去的都是）
export function readIco(buf) {
  if (buf.readUInt16LE(2) !== 1) throw new Error('不是图标文件（.ico）');
  return Array.from({ length: buf.readUInt16LE(4) }, (_, i) => {
    const e = 6 + i * 16;
    const len = buf.readUInt32LE(e + 8);
    const off = buf.readUInt32LE(e + 12);
    return { w: buf[e] || 256, h: buf[e + 1] || 256, data: buf.subarray(off, off + len) };
  });
}
export function writeIco(frames) {
  const head = Buffer.alloc(6 + frames.length * 16);
  head.writeUInt16LE(1, 2); // 类型：图标
  head.writeUInt16LE(frames.length, 4);
  let off = head.length;
  frames.forEach((f, i) => {
    const e = 6 + i * 16;
    head[e] = f.w === 256 ? 0 : f.w; // 256 记作 0
    head[e + 1] = f.h === 256 ? 0 : f.h;
    head.writeUInt16LE(1, e + 4); // 色彩平面
    head.writeUInt16LE(32, e + 6); // 位深
    head.writeUInt32LE(f.data.length, e + 8);
    head.writeUInt32LE(off, e + 12);
    off += f.data.length;
  });
  return Buffer.concat([head, ...frames.map((f) => f.data)]);
}

/** .ico 里由本脚本负责的那几帧，哪些不是最新画出来的（缺了或像素对不上） */
export function staleFrames(buf) {
  const frames = readIco(buf);
  return SMALL_SIZES.filter((size) => {
    const frame = frames.find((f) => f.w === size && f.h === size);
    return !frame || !Buffer.from(decodePng(frame.data).rgba).equals(Buffer.from(frameFor(size)));
  });
}

/** 把小尺寸帧换成现画的；遇到没有的尺寸就按从小到大插进去 */
export function withSmallFrames(buf) {
  const frames = readIco(buf);
  for (const size of SMALL_SIZES) {
    const frame = { w: size, h: size, data: encodePng(frameFor(size), size) };
    const at = frames.findIndex((f) => f.w === size && f.h === size);
    if (at !== -1) frames[at] = frame;
    else {
      const after = frames.findIndex((f) => f.w > size);
      frames.splice(after === -1 ? frames.length : after, 0, frame);
    }
  }
  return writeIco(frames);
}

// ── 预览图 ─────────────────────────────────────────────────
/** 放大预览图（PNG）：ico 里现有的各帧；浅色、深色底各一份 */
export function sheet(buf) {
  const Z = 6;
  const cell = 60;
  const pad = 12;
  const rows = [
    readIco(buf).map((f) => {
      const img = decodePng(f.data);
      return { rgba: img.rgba, w: f.w, h: f.h, zoom: f.w >= 128 ? 2 : Z };
    }),
  ];
  const rowH = rows.map((r) => Math.max(...r.map((f) => f.h * f.zoom)));
  const W = pad * 2 + Math.max(...rows.map((r) => r.reduce((sum, f) => sum + f.w * f.zoom + pad, pad)));
  const sections = [
    [0xee, 0xee, 0xee],
    [0x20, 0x20, 0x22],
  ];
  const H = (pad * 2 + rowH.reduce((a, b) => a + b + pad, 0)) * sections.length;
  const out = new Uint8Array(W * H * 4);
  sections.forEach((bg, si) => {
    const top = si * (H / sections.length);
    for (let i = top * W * 4; i < (top + H / sections.length) * W * 4; i += 4) {
      out[i] = bg[0];
      out[i + 1] = bg[1];
      out[i + 2] = bg[2];
      out[i + 3] = 255;
    }
    let y = top + pad;
    for (let r = 0; r < rows.length; r++) {
      let x = pad;
      for (const f of rows[r]) {
        for (let dy = 0; dy < f.h * f.zoom; dy++) {
          for (let dx = 0; dx < f.w * f.zoom; dx++) {
            const s = ((dy / f.zoom | 0) * f.w + (dx / f.zoom | 0)) * 4;
            const a = f.rgba[s + 3] / 255;
            const d = ((y + dy) * W + x + dx) * 4;
            for (let k = 0; k < 3; k++) out[d + k] = Math.round(f.rgba[s + k] * a + bg[k] * (1 - a));
            out[d + 3] = 255;
          }
        }
        x += f.w * f.zoom + pad;
      }
      y += rowH[r] + pad;
    }
  });
  return encodePng(out, W, H);
}

// ── 命令行 ─────────────────────────────────────────────────
function main(argv) {
  const sheetAt = argv.indexOf('--sheet');
  if (sheetAt !== -1) {
    writeFileSync(path.resolve(argv[sheetAt + 1]), sheet(readFileSync(ICO)));
    console.log(`预览图：${argv[sheetAt + 1]}（ico 里的各帧；上：浅色底，下：深色底）`);
    return 0;
  }
  const stale = staleFrames(readFileSync(ICO));
  if (argv.includes('--check')) {
    if (stale.length) {
      console.error(`icon.ico 里的 ${stale.join(' / ')} 帧不是 design/icon/small-frames.mjs 画的（跑过 npx tauri icon 之后要再跑一遍它）`);
      return 1;
    }
    console.log(`icon.ico 的 ${SMALL_SIZES.join(' / ')} 帧与 design/icon/small-frames.mjs 一致`);
    return 0;
  }
  writeFileSync(ICO, withSmallFrames(readFileSync(ICO)));
  console.log(stale.length ? `已重画 icon.ico 的 ${stale.join(' / ')} 帧` : `icon.ico 的 ${SMALL_SIZES.join(' / ')} 帧本来就是最新的`);
  return 0;
}

const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
if (process.argv[1] && samePath(fileURLToPath(import.meta.url), path.resolve(process.argv[1]))) {
  process.exitCode = main(process.argv.slice(2));
}
