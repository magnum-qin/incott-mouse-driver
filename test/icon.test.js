/**
 * 图标一致性审计。
 * 应用图标和托盘图标是同一个构成：空心方框 + 细鼠标 + 绿灯，应用图标多一块底板。
 * 这里核对两件事：小尺寸帧的比例和颜色确实是大图（design/icon/IncottFramedMouse）里的；
 * .ico 里的小尺寸帧确实出自脚本（design/icon/small-frames.mjs）。
 * （托盘图标在 src-tauri/src/tray.rs 里现画，那里有自己的单元测试。）
 */

'use strict';

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  MASTER, LAMP_GREEN, ICO, SMALL_SIZES, staleFrames, frameFor, layoutFor,
} from '../design/icon/small-frames.mjs';

const ROOT = new URL('../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, ROOT), 'utf8');
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)); // 「#」后面每两位一色
const TILE = [0x23, 0x23, 0x27];
const BODY = [0xed, 0xed, 0xee];

test('图标：小尺寸帧的比例和颜色就是大图里的', () => {
  const svg = read('design/icon/IncottFramedMouse/incottframedmouse.svg');
  const centre = 512; // 画布 1024 的中心
  const near = (actual, expected, what) =>
    assert.ok(Math.abs(actual - expected) < 0.15, `${what}：大图里是 ${actual}，脚本里记的是 ${expected}`);

  const rects = [...svg.matchAll(/<rect ([^>]+)\/>/g)].map((m) =>
    Object.fromEntries([...m[1].matchAll(/([\w-]+)="([^"]+)"/g)].map((a) => [a[1], a[2]])));
  assert.equal(rects.length, 4, '大图里应该有四块矩形：底板、方框、方框的内芯（挖空）、分键线');
  const [background, frame, inner, notch] = rects;
  near((centre - Number(frame.x)) * 2, MASTER.frame, '方框外沿边长');
  near(Number(frame.rx), MASTER.frameRadius, '方框圆角');
  near(Number(inner.x) - Number(frame.x), MASTER.stroke, '方框线宽');
  near(Number(notch.width), MASTER.notchW, '分键线宽');

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
  const rx = (rightTop[0] - leftTop[0]) / 2;
  near(rx * 2, MASTER.mouseW, '鼠标宽');
  near(centre - top[1], MASTER.mouseH / 2, '顶边');
  near(bottom[1] - centre, MASTER.mouseH / 2, '底边');
  near(rightTop[1] - top[1], 0.78 * rx, '顶部圆拱');
  near(bottom[1] - rightBottom[1], 0.42 * rx, '底部收圆');
  near(Number(notch.y) - top[1], MASTER.notchTop, '分键线离顶边');
  near((Number(notch.y) + Number(notch.height) - top[1]) / MASTER.mouseH, MASTER.notchEnd, '分键线通到多高');

  const circle = svg.match(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)" fill="#([\da-f]{6})"/i);
  near(Number(circle[3]), MASTER.lampR, '指示灯半径');
  near(Number(circle[2]) - centre, MASTER.lampCy, '指示灯位置');
  const preview = read('design/icon/IncottFramedMouse/incottframedmouse.preview.svg');
  near(Number(preview.match(/<rect width="1024" height="1024" rx="(\d+)"/)[1]), MASTER.tileRadius, '底板圆角');

  assert.deepEqual(rgb(background.fill), TILE, '底板颜色');
  assert.deepEqual(rgb(frame.fill), BODY, '方框颜色');
  assert.deepEqual(rgb(`#${paths[0][2]}`), BODY, '鼠标颜色');
  assert.deepEqual(rgb(`#${circle[4]}`), LAMP_GREEN, '指示灯颜色');
});

test('图标：小尺寸帧里框是整像素宽的空心线，鼠标保持细长，灯是绿的', () => {
  for (const size of SMALL_SIZES) {
    const g = layoutFor(size);
    assert.ok(Number.isInteger(g.inset) && g.inset >= 1, `${size} 像素：方框外沿要落在像素边界上`);
    assert.ok(Number.isInteger(g.stroke) && g.stroke >= 1, `${size} 像素：线宽要是整像素`);
    const rgba = frameFor(size);
    const px = (x, y) => [...rgba.slice((y * size + x) * 4, (y * size + x) * 4 + 4)];
    const opaque = (x, y, what) => {
      const p = px(x, y);
      assert.equal(p[3], 255, `${size} 像素：${what}应该不透明`);
      return p.slice(0, 3);
    };
    const body = size <= 24 ? [255, 255, 255] : BODY;
    const tile = size <= 24 ? [0x11, 0x11, 0x13] : TILE;
    // 方框上边的中点：实心白；框内左侧、鼠标外边：底色（框是空心的）
    assert.deepEqual(opaque(size / 2, g.inset, '方框的线'), body, `${size} 像素：方框的线`);
    assert.deepEqual(opaque(g.inset + g.stroke, size / 2, '方框内侧'), tile, `${size} 像素：方框里面应该是空的`);
    // 鼠标：宽高比和大图一样，不到方框的一半宽
    const ratio = MASTER.mouseW / MASTER.mouseH;
    assert.ok(Math.abs(ratio - 0.755) < 0.01, `鼠标的宽高比是 ${ratio.toFixed(3)}`);
    assert.ok(MASTER.mouseW / MASTER.frame < 0.53, '鼠标不到方框的一半宽');
    // 灯心所在的那颗像素：24 像素及以上是纯绿；16 像素下灯不到 2 像素，只要求明显偏绿
    const lamp = px(size / 2, Math.floor(size / 2 + MASTER.lampCy * (size / 1024)));
    if (size >= 24) assert.deepEqual(lamp.slice(0, 3), LAMP_GREEN, `${size} 像素：指示灯`);
    else assert.ok(lamp[1] > lamp[0] + 60 && lamp[1] > lamp[2] + 20, `16 像素：指示灯应该偏绿，实际 ${lamp}`);
  }
});

test('图标：icon.ico 的小尺寸帧出自 small-frames.mjs（跑过 npx tauri icon 之后要再跑一遍它）', () => {
  assert.deepEqual(staleFrames(readFileSync(ICO)), []);
});
