/**
 * 连接跟随与电量。
 * 鼠标插线 / 拔线时连接该怎么换（link.js），有线时的电量抖动怎么压、上一次的电量怎么记（battery.js）。
 */

'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkAction, openOrder, deviceAnswered } from '../ui/shared/link.js';
import { createSteadyBattery, parseBatteryMemory } from '../ui/shared/battery.js';

// 与真机的枚举顺序一致：接收器在前，有线的 Col01 / Col02 在后
const DONGLE = { path: 'dongle', isWireless: true };
const COL01 = { path: 'wired-col01', isWireless: false };
const COL02 = { path: 'wired-col02', isWireless: false };

test('连接跟随：还没连上时，有可以连的接口就连接；一个都没有就不动', () => {
  assert.equal(linkAction(null, [DONGLE]), 'connect');
  assert.equal(linkAction(null, [DONGLE, COL01, COL02]), 'connect');
  assert.equal(linkAction(null, []), 'stay');
});

test('连接跟随：连着接收器时鼠标插上线 → 换到有线', () => {
  assert.equal(linkAction(DONGLE, [DONGLE, COL01, COL02]), 'toWired');
});

test('连接跟随：连着有线时，接收器在不在、掉不掉线都不用动（鼠标还在线上）', () => {
  assert.equal(linkAction(COL02, [DONGLE, COL01, COL02]), 'stay');
  assert.equal(linkAction(COL02, [COL01, COL02]), 'stay');
  assert.equal(linkAction(COL02, [COL02]), 'stay');
});

test('连接跟随：连着的接口不见了 → gone（拔线、接收器被拔、列表为空）', () => {
  assert.equal(linkAction(DONGLE, []), 'gone');
  assert.equal(linkAction(COL02, [DONGLE]), 'gone');
  assert.equal(linkAction(COL01, [DONGLE, COL02]), 'gone');
});

test('打开顺序：枚举靠后的先试，Col02 排在 Col01 前面；可以只挑一部分', () => {
  assert.deepEqual(openOrder([DONGLE, COL01, COL02]).map((d) => d.path), ['wired-col02', 'wired-col01', 'dongle']);
  assert.deepEqual(openOrder([DONGLE, COL01, COL02], (d) => !d.isWireless).map((d) => d.path), ['wired-col02', 'wired-col01']);
  assert.deepEqual(openOrder([]), []);
});

test('读配置：设备应答了没有（鼠标休眠时读回来的是一整份空快照）', () => {
  const empty = { profileIndex: null, levels: null, current: null, slots: [], rate: null, lod: null, buttons: [] };
  assert.equal(deviceAnswered(null), false);
  assert.equal(deviceAnswered(empty), false);
  assert.equal(deviceAnswered({ ...empty, rate: 8000 }), true); // 只读到回报率也算应答了
  assert.equal(deviceAnswered({ ...empty, levels: 6, current: 2, slots: [{ dpi: 400 }] }), true);
});

test('电量防抖：第一个读数直接采纳，之后相差 1 不动、相差 2 才换', () => {
  const steady = createSteadyBattery();
  assert.equal(steady.push(96), 96);
  // 实测的抖动序列：96 / 97 来回跳，同一个值最多连续 5 次
  for (const raw of [97, 97, 97, 96, 96, 97, 96, 97, 97, 97, 97, 97, 96, 96]) {
    assert.equal(steady.push(raw), 96, `读到 ${raw} 时不应改动`);
  }
  assert.equal(steady.push(98), 98); // 差 2：真的在涨
  assert.equal(steady.push(97), 98);
  assert.equal(steady.push(96), 96); // 差 2：真的在掉
});

test('电量防抖：充到 100% 直接采纳，之后 99 / 100 抖动也不会退回', () => {
  const steady = createSteadyBattery();
  assert.equal(steady.push(98), 98);
  assert.equal(steady.push(99), 98); // 只差 1：不动
  assert.equal(steady.push(100), 100); // 满电：直接采纳
  assert.equal(steady.push(99), 100); // 满电后的抖动不动
  assert.equal(steady.push(98), 98); // 真掉下去了（相差 2）才换
});

test('电量防抖：换连接后 reset，下一个读数直接采纳', () => {
  const steady = createSteadyBattery();
  steady.push(97);
  steady.reset();
  assert.equal(steady.push(96), 96);
});

test('上一次的电量：存过的能原样读回来，坏了的、越界的都当作没有', () => {
  assert.deepEqual(parseBatteryMemory('{"level":97,"charging":false,"at":1761500000000}'), { level: 97, charging: false, at: 1761500000000 });
  assert.deepEqual(parseBatteryMemory('{"level":0,"charging":true,"at":1}'), { level: 0, charging: true, at: 1 }); // 0% 是真的快没电了
  const bad = [
    null, undefined, '', 'garbage', 'null', '[]', '"97"',
    '{"level":101,"charging":false,"at":1}', '{"level":-1,"charging":false,"at":1}',
    '{"level":"97","charging":false,"at":1}', '{"level":97.5,"charging":false,"at":1}',
    '{"level":97,"at":1}', '{"level":97,"charging":"no","at":1}', '{"level":97,"charging":false}',
    '{"level":97,"charging":false,"at":"yesterday"}',
  ];
  for (const raw of bad) assert.equal(parseBatteryMemory(raw), null, `${JSON.stringify(raw)} 应该当作没有`);
});
