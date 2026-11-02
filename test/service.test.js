import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '../lib/service.js';
import { createMockClient } from '../lib/mock.js';
import { VibeError } from '../lib/vibe.js';

const query = (over = {}) => ({ categoryId: 0, from: null, to: null, mine: false, limit: 20, ...over });

function counting(client) {
  const n = { me: 0, aggregateDeals: 0, batch: 0, baseCurrency: 0 };
  const wrapped = {};
  for (const k of Object.keys(n)) wrapped[k] = (...a) => { n[k]++; return client[k](...a); };
  return { client: wrapped, n };
}

test('полный дашборд по имитации: стадии, показатели, последние сделки', async () => {
  const svc = createService();
  const d = await svc.dashboard(createMockClient(), 'tok', query());
  assert.ok(d.stages.length >= 5);
  assert.equal(d.recent.length, 20);
  assert.ok(d.recent[0].createdAt >= d.recent[19].createdAt, 'сначала новые');
  assert.ok(d.recent.every((r) => r.assignedName && !r.assignedName.startsWith('Сотрудник #')));
  assert.equal(d.kpi.totalCount, d.stages.reduce((s, x) => s + x.count, 0));
  assert.equal(d.currency, 'RUB');
  assert.equal(d.portal, 'demo.bitrix24.ru');
  assert.deepEqual(d.warnings, []);
});

test('справочники кэшируются: повторная загрузка — 2 запроса вместо 3+', async () => {
  const svc = createService();
  const { client, n } = counting(createMockClient());
  await svc.dashboard(client, 'tok', query());
  const first = { ...n };
  await svc.dashboard(client, 'tok', query({ limit: 10 }));
  assert.equal(n.me - first.me, 0, '/v1/me из кэша');
  assert.equal(n.aggregateDeals - first.aggregateDeals, 1);
  assert.equal(n.batch - first.batch, 1, 'только последние сделки, имена и стадии из кэша');
});

test('«Только мои» фильтрует по текущему пользователю из /v1/me', async () => {
  const svc = createService();
  const d = await svc.dashboard(createMockClient({ userId: '5' }), 'tok', query({ mine: true }));
  assert.ok(d.recent.length > 0);
  assert.ok(d.recent.every((r) => r.assignedById === '5'));
});

test('период без сделок — пустое состояние, без ошибок', async () => {
  const svc = createService();
  const d = await svc.dashboard(createMockClient(), 'tok', query({ from: '2001-01-01', to: '2001-12-31' }));
  assert.equal(d.kpi.totalCount, 0);
  assert.equal(d.recent.length, 0);
  assert.equal(d.kpi.avgCheck, null);
});

test('портал без сделок вообще', async () => {
  const svc = createService();
  const d = await svc.dashboard(createMockClient({ scenario: 'empty' }), 'tok', query());
  assert.equal(d.kpi.totalCount, 0);
  assert.ok(d.stages.every((s) => s.count === 0));
});

test('несуществующая воронка — ошибка ввода', async () => {
  const svc = createService();
  await assert.rejects(svc.dashboard(createMockClient(), 'tok', query({ categoryId: 99 })), { code: 'INVALID_INPUT' });
});

test('слишком много сделок для сумм — только количество и предупреждение', async () => {
  const svc = createService();
  const d = await svc.dashboard(createMockClient({ scenario: 'huge' }), 'tok', query());
  assert.equal(d.kpi.wonSum, null);
  assert.ok(d.kpi.totalCount > 0);
  assert.equal(d.warnings[0].code, 'NO_SUMS');
});

test('усечённая агрегация — предупреждение', async () => {
  const svc = createService();
  const d = await svc.dashboard(createMockClient({ scenario: 'partial' }), 'tok', query());
  assert.equal(d.warnings[0].code, 'PARTIAL_SUMS');
});

test('сбой портала доходит до обработчика как VibeError', async () => {
  const svc = createService();
  await assert.rejects(svc.dashboard(createMockClient({ scenario: 'error' }), 'tok', query()), (e) => e instanceof VibeError && e.code === 'BITRIX_UNAVAILABLE');
});

test('сессия без пользователя портала — INVALID_SESSION', async () => {
  const svc = createService();
  const client = { ...createMockClient(), me: async () => ({ success: true, data: { portal: 'x.bitrix24.ru', currentUser: null } }) };
  await assert.rejects(svc.bootstrap(client, 'tok'), { code: 'INVALID_SESSION' });
});

test('пустой справочник стадий не кэшируется и даёт предупреждение', async () => {
  const svc = createService();
  const base = createMockClient();
  let empty = true;
  const client = { ...base, batch: async (calls) => {
    const r = await base.batch(calls);
    if (empty && r.data.results.stages) r.data.results.stages = [];
    return r;
  } };
  const d1 = await svc.dashboard(client, 'tok', query());
  assert.ok(d1.warnings.some((w) => w.code === 'NO_STAGES'));
  empty = false;
  const d2 = await svc.dashboard(client, 'tok', query());
  assert.ok(d2.stages.some((s) => s.name === 'Новая'), 'со второй попытки справочник получен');
});

test('сессия без домена портала — INVALID_SESSION, кэш не общий', async () => {
  const svc = createService();
  const client = { ...createMockClient(), me: async () => ({ success: true, data: { portal: null, currentUser: { bitrixUserId: '1' } } }) };
  await assert.rejects(svc.dashboard(client, 'tok', query()), { code: 'INVALID_SESSION' });
});
