/**
 * 读数屏里的鼠标线稿：按型号一张。数据和摆放规则在 ui/shared/mouse-art.js。
 */
'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import { MOUSE_ART, mouseArtFor, artLayout } from '../ui/shared/mouse-art.js';
import { MODEL_TABLE, parseModelInfo } from '../ui/shared/protocol.js';

test('线稿：型号表里的每个型号代码都有一张，没有多余的', () => {
  assert.deepEqual(Object.keys(MOUSE_ART).map(Number).sort((a, b) => a - b), Object.keys(MODEL_TABLE).map(Number).sort((a, b) => a - b));
});

test('线稿：每条路径都是一条闭合的轮廓，只含路径数据该有的字符', () => {
  const ok = /^[MCLZmclz0-9.,\s-]+$/; // 只用了移线 / 三次曲线 / 直线；没有 H V A T 这种会被原样画出来、却可能把轮廓画歪的命令
  for (const [code, art] of Object.entries(MOUSE_ART)) {
    assert.match(art.d, ok, `型号 ${code}`);
    assert.match(art.d, /^M /, `型号 ${code} 要从移线开始`);
    assert.match(art.d, /Z$/, `型号 ${code} 要闭合`);
    assert.equal((art.d.match(/M/g) || []).length, 1, `型号 ${code} 只有一条轮廓`);
  }
});

test('线稿：画布是四个正数，轮廓在画布里，影子不超出画布', () => {
  for (const [code, art] of Object.entries(MOUSE_ART)) {
    const [x, y, w, h] = art.box;
    const [, , vw, vh] = art.viewBox.split(' ').map(Number);
    assert.ok(vw > 0 && vh > 0, `型号 ${code} 的画布`);
    assert.ok(x >= 0 && y >= 0 && x + w <= vw && y + h <= vh, `型号 ${code} 的轮廓在画布里`);
    const { led, shadow } = artLayout(art);
    assert.ok(x <= led.cx - led.r && led.cx + led.r <= x + w && y <= led.cy - led.r && led.cy + led.r <= y + h, `型号 ${code} 的小灯落在机身里`);
    assert.ok(shadow.cy - shadow.ry > y + h, `型号 ${code} 的影子在轮廓下面`);
    assert.ok(shadow.cy + shadow.ry <= vh, `型号 ${code} 的影子不超出画布`);
  }
});

test('线稿：G23 V2 的两个型号代码共用一张，G23 和 G23 V2 也是同一条路径；G24 和 G24 Pro 是同一个代码', () => {
  assert.equal(mouseArtFor(14), mouseArtFor(8));
  assert.equal(mouseArtFor(2), mouseArtFor(8)); // 提供过来的 G23 和 G23 V2 是同一个文件内容（外轮廓本来一致）
  const pro = parseModelInfo([0x8f, 1, 3, 2, 0, 241, 0, 0], true);
  const plain = parseModelInfo([0x8f, 1, 3, 0, 240, 0, 0, 0], false);
  assert.equal(pro.name, 'G24 Pro');
  assert.equal(plain.name, 'G24');
  assert.equal(mouseArtFor(pro.modelCode), mouseArtFor(plain.modelCode));
});

test('线稿：型号表里没有的代码没有线稿', () => {
  assert.equal(mouseArtFor(99), null);
  assert.equal(mouseArtFor(undefined), null);
});
