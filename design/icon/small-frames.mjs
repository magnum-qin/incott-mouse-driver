/**
 * 应用图标的小尺寸帧 + 托盘图标的离线预览。零依赖，Node 18+。
 *
 * 图标挨着一排别的应用图标时（任务栏、托盘），分量来自反差和占比。把 1024 的大图直接缩到二十来个像素，
 * 鼠标只剩细细一条，看着比旁边的小一圈。所以小尺寸单独画，并且越小越粗：
 *
 *   BOLD       二十来个像素以下的比例：底板更黑，鼠标更宽、纯白
 *   REGULAR    大图的比例：修长
 *   BOLD_SHARE 各个边长下取多少 BOLD，节点之间线性过渡
 *
 * icon.ico 里 16 / 24 / 32 / 48 四帧是这里画的；64 / 256 两帧仍然是大图缩出来的（npx tauri icon）。
 * 托盘图标（src-tauri/src/tray.rs 的 tray_icon）用的是同一套东西，只换灯的颜色——所以托盘图标
 * 在任何缩放下都等于应用图标同尺寸的那一帧。两边的参数由 test/icon.test.js 核对，改一边要同步另一边。
 *
 *   node design/icon/small-frames.mjs                 # 把小尺寸帧写回 src-tauri/icons/icon.ico
 *   node design/icon/small-frames.mjs --check         # 只核对，不一致时退出码 1（npm test 也跑）
 *   node design/icon/small-frames.mjs --sheet 图.png   # 放大 6 倍的预览：托盘四种灯色 + ico 里的各帧
 *
 * 跑过 `npx tauri icon` 之后要再跑一遍本脚本：那一步会用大图重写全部帧。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import zlib from 'node:zlib';

export const ICO = new URL('../../src-tauri/icons/icon.ico', import.meta.url);

/** 一只鼠标的各部分在画布里的比例，单位是画布边长。字段名同 tray.rs 的 Shape */
export const BOLD = {
  rx: 0.37, // 鼠标半宽
  top: 0.35, // 顶边到中心
  bottom: 0.35, // 底边到中心
  dome: 0.27, // 顶部圆拱的高
  bottom_dome: 0.19, // 底部收圆的高
  groove_hw: 0.05, // 分键槽半宽
  groove_end: -0.1, // 分键槽底端到中心
  lamp_r: 0.12, // 指示灯半径
  lamp_cy: 0.1, // 指示灯中心
  radius: 0.22, // 底板圆角
  tile: [0x11, 0x11, 0x13],
  body: [0xff, 0xff, 0xff],
};

/** 量自 design/icon/IncottLitMouse/incottlitmouse.svg */
export const REGULAR = {
  rx: 0.215,
  top: 0.354,
  bottom: 0.355,
  dome: 0.244,
  bottom_dome: 0.172,
  groove_hw: 0.033,
  groove_end: -0.113,
  lamp_r: 0.043,
  lamp_cy: 0.107,
  radius: 0.22,
  tile: [0x23, 0x23, 0x27],
  body: [0xed, 0xed, 0xee],
};

/** [边长, 取多少 BOLD]，节点之间线性过渡 */
export const BOLD_SHARE = [
  [24, 1],
  [32, 0.55],
  [48, 0.4],
  [64, 0],
];

/** 由本脚本画的那几帧 */
export const SMALL_SIZES = [16, 24, 32, 48];

/** 灯的颜色，含义同主界面 */
export const LAMP = {
  off: [0x3a, 0x3a, 0x40],
  green: [0x46, 0xc9, 0x8c],
  yellow: [0xf0, 0xb3, 0x4c],
  red: [0xf0, 0x58, 0x5d],
};

export function boldShare(size) {
  let [x0, y0] = BOLD_SHARE[0];
  if (size <= x0) return y0;
  for (const [x1, y1] of BOLD_SHARE.slice(1)) {
    if (size <= x1) return y0 + ((y1 - y0) * (size - x0)) / (x1 - x0);
    [x0, y0] = [x1, y1];
  }
  return y0;
}

export function blend(t) {
  const mix = (a, b) => a * t + b * (1 - t);
  const out = {};
  for (const key of Object.keys(BOLD)) {
    out[key] = Array.isArray(BOLD[key])
      ? BOLD[key].map((v, i) => Math.round(mix(v, REGULAR[key][i])))
      : mix(BOLD[key], REGULAR[key]);
  }
  return out;
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

/**
 * 画 size × size 的图标，返回 RGBA。
 * 自下而上合成：底板 → 鼠标 → 分键槽（底色）→ 指示灯。槽和灯不重叠。
 * 窄于 1.5px 的细节在小尺寸下会被抗锯齿抹掉，给了下限
 */
export function paint(shape, lamp, size) {
  const s = size;
  const half = s / 2;
  // 鼠标：顶部圆拱，中间直边，底部收圆
  const rx = shape.rx * s;
  const top = -shape.top * s;
  const dome = shape.dome * s;
  const bottomDome = shape.bottom_dome * s;
  const domeCy = top + dome;
  const bottomCy = shape.bottom * s - bottomDome;
  // 分键槽：从顶边通下来
  const grooveHw = Math.max(shape.groove_hw * s, 0.75);
  const grooveTop = top - 1;
  const grooveEnd = shape.groove_end * s;
  // 指示灯
  const lampR = Math.max(shape.lamp_r * s, 1.6);
  const lampCy = shape.lamp_cy * s;
  const radius = shape.radius * s;

  const rgba = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5 - half;
      const py = y + 0.5 - half;
      const tile = coverage(sdRoundBox(px, py, half, half, radius));
      if (tile <= 0) continue;
      const body = coverage(
        Math.min(
          sdEllipse(px, py - domeCy, rx, dome),
          sdEllipse(px, py - bottomCy, rx, bottomDome),
          sdRoundBox(px, py - (domeCy + bottomCy) / 2, rx, (bottomCy - domeCy) / 2, 0),
        ),
      );
      const groove =
        coverage(
          sdRoundBox(px, py - (grooveTop + grooveEnd) / 2, grooveHw, (grooveEnd - grooveTop) / 2, grooveHw),
        ) * body;
      const lit = coverage(Math.hypot(px, py - lampCy) - lampR) * body;
      const plain = body - groove - lit;
      const i = (y * size + x) * 4;
      for (let k = 0; k < 3; k++) {
        rgba[i + k] = Math.round(
          shape.tile[k] * (1 - body) + shape.body[k] * plain + shape.tile[k] * groove + lamp[k] * lit,
        );
      }
      rgba[i + 3] = Math.round(tile * 255);
    }
  }
  return rgba;
}

/** 应用图标在边长 size 时的那一帧（绿码灯） */
export function frameFor(size) {
  return paint(blend(boldShare(size)), LAMP.green, size);
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
/** 放大 6 倍的预览图（PNG）：托盘图标在四种灯色下的 16 / 20 / 24 / 32，和 ico 里现有的各帧；浅色、深色底各一份 */
export function sheet(buf) {
  const Z = 6;
  const cell = 60;
  const pad = 12;
  const rows = [
    ...[16, 20, 24, 32].map((size) =>
      Object.values(LAMP).map((lamp) => ({ rgba: paint(blend(boldShare(size)), lamp, size), w: size, h: size, zoom: Z })),
    ),
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
    console.log(`预览图：${argv[sheetAt + 1]}（上：托盘图标 16 / 20 / 24 / 32 × 灯灭 / 绿 / 黄 / 红；下：ico 里的各帧）`);
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
