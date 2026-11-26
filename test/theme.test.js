/**
 * 主题取值与镜像。
 */
'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { THEME_MIRROR, normalizeTheme, applyTheme } from '../ui/shared/theme.js';

// ui/theme-init.js 是页面 <head> 里的普通同步脚本（不是模块）：放进一个假的页面环境里跑
const THEME_INIT = readFileSync(new URL('../ui/theme-init.js', import.meta.url), 'utf8');
const boot = (mirror, { brokenStore = false, live = false } = {}) => {
  const document = { documentElement: { dataset: {} } };
  const window = {};
  const localStorage = brokenStore
    ? { getItem: () => { throw new Error('denied'); } }
    : { getItem: () => mirror };
  vm.runInNewContext(THEME_INIT, { document, localStorage, window });
  return { document, window, setMirror: (v) => { if (live) mirror = v; } };
};

const fakeRoot = () => ({ dataset: {} });
const fakeStore = () => {
  const map = new Map();
  return { setItem: (k, v) => map.set(k, String(v)), getItem: (k) => map.get(k) ?? null };
};

test('主题：只有写着 light 才是亮色，其余一律深色', () => {
  assert.equal(normalizeTheme('light'), 'light');
  assert.equal(normalizeTheme('dark'), 'dark');
  assert.equal(normalizeTheme(undefined), 'dark'); // 没存过
  assert.equal(normalizeTheme(null), 'dark');
  assert.equal(normalizeTheme(''), 'dark');
  assert.equal(normalizeTheme('Light'), 'dark'); // 大小写不对也算写坏了
});

test('主题：写上去的同时更新镜像，换成深色时把上次的亮色镜像盖掉', () => {
  const root = fakeRoot();
  const store = fakeStore();
  assert.equal(applyTheme(root, store, 'light'), 'light');
  assert.equal(root.dataset.mode, 'light');
  assert.equal(store.getItem(THEME_MIRROR), 'light');
  assert.equal(applyTheme(root, store, 'dark'), 'dark');
  assert.equal(root.dataset.mode, 'dark');
  assert.equal(store.getItem(THEME_MIRROR), 'dark');
});

test('主题：镜像存不进去也不影响这次显示', () => {
  const root = fakeRoot();
  const store = { setItem: () => { throw new Error('quota'); } };
  assert.equal(applyTheme(root, store, 'light'), 'light');
  assert.equal(root.dataset.mode, 'light');
});

test('页面开头：照着镜像把主题摆好；没有镜像、写坏了、读不了存储，都按深色画', () => {
  assert.equal(boot('light').document.documentElement.dataset.mode, 'light');
  assert.equal(boot('dark').document.documentElement.dataset.mode, 'dark');
  assert.equal(boot(null).document.documentElement.dataset.mode, 'dark');
  assert.equal(boot('Light').document.documentElement.dataset.mode, 'dark');
  assert.equal(boot(null, { brokenStore: true }).document.documentElement.dataset.mode, 'dark');
});

test('浮层窗口：弹出之前重新照镜像对一次（它常驻内存，期间主界面可能换过主题）', () => {
  const page = boot('dark', { live: true });
  assert.equal(page.document.documentElement.dataset.mode, 'dark');
  page.setMirror('light');
  page.window.applyMirroredTheme();
  assert.equal(page.document.documentElement.dataset.mode, 'light');
});
