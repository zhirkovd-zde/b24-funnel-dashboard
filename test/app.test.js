import { test } from 'node:test';
import assert from 'node:assert/strict';
import { presetRange } from '../public/app.js';

test('быстрые периоды считаются от сегодняшней даты', () => {
  const today = new Date(2026, 10, 2); // 2 ноября 2026
  assert.deepEqual(presetRange('month', today), { from: '2026-11-01', to: '2026-11-02' });
  assert.deepEqual(presetRange('prev-month', today), { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(presetRange('30d', today), { from: '2026-10-04', to: '2026-11-02' });
  assert.deepEqual(presetRange('quarter', today), { from: '2026-10-01', to: '2026-11-02' });
  assert.deepEqual(presetRange('year', today), { from: '2026-01-01', to: '2026-11-02' });
  assert.deepEqual(presetRange('all', today), { from: '', to: '' });
  assert.equal(presetRange('custom', today), null);
});

test('прошлый месяц в январе — декабрь прошлого года', () => {
  assert.deepEqual(presetRange('prev-month', new Date(2026, 0, 15)), { from: '2025-12-01', to: '2025-12-31' });
});
