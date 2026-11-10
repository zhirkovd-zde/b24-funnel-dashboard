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

// ---------- S1: кэш не переносит ответы между пользователями ----------

test('S1: имена, полученные пользователем A, не попадают к B без права на сотрудников', async () => {
  const svc = createService();
  const a = createMockClient({ userId: '1' });
  const b = createMockClient({ userId: '2', deny: ['users'] });
  const dA = await svc.dashboard(a, 'tokA', query());
  assert.ok(dA.recent.every((r) => !r.assignedName.startsWith('Сотрудник #')), 'A видит имена');

  const dB = await svc.dashboard(b, 'tokB', query());
  assert.ok(dB.recent.length > 0);
  assert.ok(dB.recent.every((r) => r.assignedName.startsWith('Сотрудник #')), 'B после прогрева A — без имён');

  const fresh = await createService().dashboard(createMockClient({ userId: '2', deny: ['users'] }), 'tokB', query());
  assert.deepEqual(dB.recent.map((r) => r.assignedName), fresh.recent.map((r) => r.assignedName), 'результат B не зависит от того, кто открыл раньше');
});

test('S1: воронки, полученные A, не отдаются B без доступа к воронкам', async () => {
  const svc = createService();
  await svc.bootstrap(createMockClient({ userId: '1' }), 'tokA');
  const b = createMockClient({ userId: '2', deny: ['deal-categories'] });
  await assert.rejects(svc.bootstrap(b, 'tokB'), { code: 'BITRIX_ACCESS_DENIED' });
  await assert.rejects(svc.dashboard(b, 'tokB', query()), { code: 'BITRIX_ACCESS_DENIED' });
});

test('S1: стадии, полученные A, не отдаются B без доступа к стадиям', async () => {
  const svc = createService();
  const dA = await svc.dashboard(createMockClient({ userId: '1' }), 'tokA', query());
  assert.equal(dA.kpi.classified, true);
  const dB = await svc.dashboard(createMockClient({ userId: '2', deny: ['statuses'] }), 'tokB', query());
  assert.equal(dB.kpi.classified, false, 'B не получает классификацию стадий из кэша A');
  assert.ok(dB.stages.every((s) => s.kind === 'unknown'));
});

test('S1: две сессии одного пользователя делят кэш, разные пользователи — нет', async () => {
  const svc = createService();
  const { client: c1, n: n1 } = counting(createMockClient({ userId: '1' }));
  await svc.dashboard(c1, 'tok1', query());
  const { client: c2, n: n2 } = counting(createMockClient({ userId: '1' }));
  await svc.dashboard(c2, 'tok1-second', query());
  assert.equal(n2.batch, 1, 'тот же пользователь: справочники и имена из кэша');
  const { client: c3, n: n3 } = counting(createMockClient({ userId: '7' }));
  await svc.dashboard(c3, 'tok7', query());
  assert.ok(n3.batch >= 3, 'другой пользователь: справочники и имена запрошены с его правами');
  assert.ok(n1.batch >= 3);
});

// ---------- S2: без классификации стадий — не нули ----------

test('S2: стадии недоступны — показатели открытых и выигранных недоступны, не ноль', async () => {
  const svc = createService();
  const d = await svc.dashboard(createMockClient({ deny: ['statuses'] }), 'tok', query());
  assert.ok(d.kpi.totalCount > 0);
  for (const k of ['openCount', 'openSum', 'wonCount', 'wonSum', 'avgCheck', 'conversion']) assert.equal(d.kpi[k], null, k);
  assert.equal(d.kpi.classified, false);
  assert.ok(d.warnings.some((w) => w.code === 'NO_STAGES' && /недоступны/.test(w.message)));
  assert.equal(d.recent.length, 20, 'последние сделки показываются');
});

test('S2: справочник неполон — показатели недоступны, предупреждение называет число сделок', async () => {
  const svc = createService();
  const base = createMockClient();
  const client = { ...base, batch: async (calls) => {
    const r = await base.batch(calls);
    if (r.data.results.stages) r.data.results.stages = r.data.results.stages.filter((s) => s.statusId !== 'WON');
    return r;
  } };
  const d = await svc.dashboard(client, 'tok', query());
  assert.equal(d.kpi.classified, false);
  assert.equal(d.kpi.wonCount, null);
  const w = d.warnings.find((x) => x.code === 'UNKNOWN_STAGES');
  assert.ok(w && w.message.startsWith(String(d.kpi.unknownCount)));
});

// ---------- M1: повтор временных ошибок подвызовов batch ----------

test('M1: временная ошибка подвызова повторяется с паузой 1с → 2с', async () => {
  const delays = [];
  const svc = createService({ sleep: async (ms) => { delays.push(ms); } });
  const d = await svc.dashboard(createMockClient({ flaky: { deals: 2 } }), 'tok', query());
  assert.equal(d.recent.length, 20);
  assert.deepEqual(delays, [1000, 2000]);
});

test('M1: временная ошибка не уходит после трёх повторов — честная ошибка', async () => {
  const delays = [];
  const svc = createService({ sleep: async (ms) => { delays.push(ms); } });
  await assert.rejects(svc.dashboard(createMockClient({ flaky: { deals: 9 } }), 'tok', query()), { code: 'RATE_LIMITED' });
  assert.deepEqual(delays, [1000, 2000, 4000]);
});

test('M1: имена сотрудников после временного сбоя тоже получены', async () => {
  const svc = createService({ sleep: async () => {} });
  const d = await svc.dashboard(createMockClient({ flaky: { users: 1 } }), 'tok', query());
  assert.ok(d.recent.every((r) => !r.assignedName.startsWith('Сотрудник #')));
});

test('M1: повторно запрашивается только упавший подвызов, успешные не теряются', async () => {
  const sent = [];
  const base = createMockClient({ flaky: { deals: 1 } });
  const client = { ...base, batch: (calls) => { sent.push(calls.map((c) => c.id)); return base.batch(calls); } };
  const d = await createService({ sleep: async () => {} }).dashboard(client, 'tok', query());
  assert.deepEqual(sent.slice(0, 3), [['cats'], ['recent', 'stages'], ['recent']], 'во втором пакете — только recent');
  assert.equal(d.kpi.classified, true, 'стадии из первого пакета сохранены');
  assert.equal(d.recent.length, 20);
});

test('M1: исключение на повторе не теряет уже полученные подвызовы', async () => {
  const base = createMockClient({ flaky: { users: 1 } });
  let usersCalls = 0;
  const client = { ...base, batch: async (calls) => {
    if (calls[0].entity === 'users' && ++usersCalls === 2) throw new VibeError(502, 'BITRIX_UNAVAILABLE', 'down');
    return base.batch(calls);
  } };
  const d = await createService({ sleep: async () => {} }).dashboard(client, 'tok', query());
  assert.equal(d.recent.length, 20, 'дашборд отдан');
  assert.ok(d.recent.some((r) => !r.assignedName.startsWith('Сотрудник #')), 'имена из первого пакета сохранены');
  assert.ok(d.recent.some((r) => r.assignedName.startsWith('Сотрудник #')), 'упавший на повторе — запасным вариантом');
});

test('M1: стадии, исчерпавшие повторы в основном пакете, второй раз не запрашиваются', async () => {
  const delays = [];
  const { client, n } = counting(createMockClient({ flaky: { statuses: 99 } }));
  const d = await createService({ sleep: async (ms) => { delays.push(ms); } }).dashboard(client, 'tok', query());
  assert.equal(d.kpi.classified, false);
  assert.deepEqual(delays.filter((x) => x).slice(0, 3), [1000, 2000, 4000]);
  assert.equal(delays.length, 3 + 0, 'повторы только в основном пакете; имена — без сбоев');
  assert.equal(n.batch, 1 + 4 + 1, 'cats + основной пакет с 3 повторами + имена');
});

test('M1: имена сотрудников повторяются не больше одного раза', async () => {
  const delays = [];
  await createService({ sleep: async (ms) => { delays.push(ms); } }).dashboard(createMockClient({ flaky: { users: 99 } }), 'tok', query());
  assert.deepEqual(delays, [1000]);
});

test('M1: отказ по правам (403) не повторяется', async () => {
  const delays = [];
  const svc = createService({ sleep: async (ms) => { delays.push(ms); } });
  await svc.dashboard(createMockClient({ deny: ['users'] }), 'tok', query());
  assert.deepEqual(delays, []);
});

test('сессия без домена портала — INVALID_SESSION, кэш не общий', async () => {
  const svc = createService();
  const client = { ...createMockClient(), me: async () => ({ success: true, data: { portal: null, currentUser: { bitrixUserId: '1' } } }) };
  await assert.rejects(svc.dashboard(client, 'tok', query()), { code: 'INVALID_SESSION' });
});
