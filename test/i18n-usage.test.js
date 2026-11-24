/**
 * 文案键使用审计。
 * 界面上引用的每个键都必须在字典里（否则会原样显示键名，比如把 "keyLeft" 显示给用户）；
 * 字典里也不该留没人引用的键。
 */

'use strict';

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { messages } from '../ui/shared/i18n.js';

const UI = new URL('../ui/', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, UI), 'utf8');
const FILES = [
  'index.html',
  'popover.html',
  'app.js',
  'popover.js',
  'shared/protocol.js',
  ...readdirSync(new URL('bridge/', UI)).filter((f) => f.endsWith('.js')).map((f) => `bridge/${f}`),
];
const SOURCES = FILES.map((file) => ({ file, src: read(file) }));

test('i18n：界面引用的键都在字典里', () => {
  const missing = [];
  // t('key') / data-i18n="key" / data-i18n-title="key" / 表驱动用的 key: 'xxx'、descKey: 'xxx'
  const patterns = [
    /\bt\(\s*'([A-Za-z0-9_]+)'/g,
    /data-i18n(?:-title)?="([A-Za-z0-9_]+)"/g,
    /\b(?:labelKey|descKey|key):\s*'([A-Za-z0-9_]+)'/g,
  ];
  for (const { file, src } of SOURCES) {
    for (const re of patterns) {
      for (const m of src.matchAll(re)) {
        if (!(m[1] in messages.zh)) missing.push(`${m[1]}（${file}）`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

test('i18n：字典里没有没人引用的键', () => {
  const all = SOURCES.map((s) => s.src).join('\n');
  const dead = Object.keys(messages.zh).filter((k) => !all.includes(`'${k}'`) && !all.includes(`"${k}"`));
  assert.deepEqual(dead, []);
});
