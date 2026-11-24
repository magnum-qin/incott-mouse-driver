/**
 * 图标一致性审计。
 * 托盘图标是 Rust 现画的（src-tauri/src/tray.rs），应用图标的小尺寸帧是脚本现画的
 * （design/icon/small-frames.mjs）。两边必须永远是同一副样子——只差灯的颜色：
 * 参数要一致；.ico 里的帧要确实出自脚本；「修长」的那一端要确实是大图的比例。
 */

'use strict';

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { BOLD, REGULAR, BOLD_SHARE, LAMP, ICO, staleFrames } from '../design/icon/small-frames.mjs';

const ROOT = new URL('../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, ROOT), 'utf8');
const TRAY = read('src-tauri/src/tray.rs');
const hexes = (text) => [...text.matchAll(/0x([\da-f]+)/gi)].map((m) => parseInt(m[1], 16));
const rgb = (hex) => [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** Rust 里 `const NAME: Shape = Shape { 字段: 数字或 [0x.., 0x.., 0x..], … };` 的字段表 */
function rustShape(name) {
  const body = TRAY.match(new RegExp(String.raw`const ${name}: Shape = Shape \{([^}]*)\}`))?.[1];
  const shape = {};
  for (const [, field, value] of body.matchAll(/(\w+):\s*(\[[^\]]*\]|[-\d.]+)/g)) {
    shape[field] = value.startsWith('[') ? hexes(value) : Number(value);
  }
  return shape;
}

test('图标：托盘图标（tray.rs）和脚本里画小尺寸帧用的是同一套参数', () => {
  assert.deepEqual(rustShape('BOLD'), BOLD);
  assert.deepEqual(rustShape('REGULAR'), REGULAR);
  const share = TRAY.match(/const BOLD_SHARE: \[\(u32, f32\); \d\] = \[([^\]]*)\]/)[1];
  assert.deepEqual(
    [...share.matchAll(/\((\d+), ([\d.]+)\)/g)].map((m) => [Number(m[1]), Number(m[2])]),
    BOLD_SHARE,
  );
  assert.deepEqual(hexes(TRAY.match(/const LAMP_OFF: \[u8; 3\] = \[([^\]]*)\]/)[1]), LAMP.off);
  const lampFor = TRAY.slice(TRAY.indexOf('fn lamp_for'), TRAY.indexOf('\n}\n', TRAY.indexOf('fn lamp_for')));
  const [yellow, red, green] = [...lampFor.matchAll(/\[0x[\da-f]+, 0x[\da-f]+, 0x[\da-f]+\]/gi)].map((m) => hexes(m[0]));
  assert.deepEqual([yellow, red, green], [LAMP.yellow, LAMP.red, LAMP.green]);
});

test('图标：「修长」的那一端就是应用图标大图的比例和颜色', () => {
  const svg = read('design/icon/IncottLitMouse/incottlitmouse.svg');
  const unit = 1 / Number(svg.match(/viewBox="0 0 (\d+) \d+"/)[1]); // 画布的一个像素
  const centre = 0.5 / unit;
  const near = (actual, expected, what) =>
    assert.ok(Math.abs(actual - expected) < 0.003, `${what}：大图里是 ${actual.toFixed(4)}，REGULAR 里写的是 ${expected}`);

  // 鼠标轮廓：M / L 的落点和每段 C 的终点，依次是顶、右上、右下、底、左下、左上（最后回到顶）
  const paths = [...svg.matchAll(/<path d="([^"]+)" fill="#([\da-f]{6})"/gi)];
  const points = [];
  const tokens = paths[0][1].match(/[A-Z]|-?[\d.]+/g);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === 'M' || tokens[i] === 'L') points.push([Number(tokens[i + 1]), Number(tokens[i + 2])]);
    else if (tokens[i] === 'C') {
      points.push([Number(tokens[i + 5]), Number(tokens[i + 6])]);
      i += 6;
    }
  }
  const [top, rightTop, rightBottom, bottom, , leftTop] = points;
  near(((rightTop[0] - leftTop[0]) / 2) * unit, REGULAR.rx, '鼠标半宽');
  near((centre - top[1]) * unit, REGULAR.top, '顶边');
  near((bottom[1] - centre) * unit, REGULAR.bottom, '底边');
  near((rightTop[1] - top[1]) * unit, REGULAR.dome, '顶部圆拱');
  near((bottom[1] - rightBottom[1]) * unit, REGULAR.bottom_dome, '底部收圆');

  const groove = paths[1][1].match(/M([\d.]+) [\d.]+ H([\d.]+) V([\d.]+) A([\d.]+) /);
  near(((Number(groove[2]) - Number(groove[1])) / 2) * unit, REGULAR.groove_hw, '分键槽半宽');
  near((Number(groove[3]) + Number(groove[4]) - centre) * unit, REGULAR.groove_end, '分键槽底端');

  const circle = svg.match(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/);
  near(Number(circle[3]) * unit, REGULAR.lamp_r, '指示灯半径');
  near((Number(circle[2]) - centre) * unit, REGULAR.lamp_cy, '指示灯位置');

  const tile = svg.match(/<rect [^>]*fill="#([\da-f]{6})"/i)[1];
  const lamp = svg.match(/<circle [^>]*fill="#([\da-f]{6})"/i)[1];
  assert.deepEqual(rgb(tile), REGULAR.tile, '底板颜色');
  assert.deepEqual(rgb(paths[0][2]), REGULAR.body, '鼠标颜色');
  assert.deepEqual(rgb(lamp), LAMP.green, '指示灯颜色');
});

test('图标：icon.ico 的小尺寸帧出自 small-frames.mjs（跑过 npx tauri icon 之后要再跑一遍它）', () => {
  assert.deepEqual(staleFrames(readFileSync(ICO)), []);
});
