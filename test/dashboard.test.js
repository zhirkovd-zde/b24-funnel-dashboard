import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDealFilter, buildSummary, normalizeCategories, normalizeDeals, normalizeStages,
  parseDashboardQuery, safePortalHost, stageEntityId, stageKind, userDisplayName,
} from '../lib/dashboard.js';

const q = (s) => parseDashboardQuery(new URLSearchParams(s));

test('параметры: значения по умолчанию', () => {
  assert.deepEqual(q(''), { categoryId: 0, from: null, to: null, mine: false, limit: 20 });
});

test('параметры: корректный период', () => {
  assert.deepEqual(q('categoryId=3&from=2026-01-01&to=2026-03-31&mine=1&limit=10'),
    { categoryId: 3, from: '2026-01-01', to: '2026-03-31', mine: true, limit: 10 });
});

test('параметры: мусор и невозможные даты отвергаются', () => {
  for (const bad of ['categoryId=-1', 'categoryId=abc', 'from=2026-02-30', 'from=26-01-01', 'to=2026-13-01',
    'from=2026-05-01&to=2026-04-01', 'mine=yes', 'limit=500', 'from=1999-12-31', "categoryId=1;DROP"]) {
    assert.throws(() => q(bad), { code: 'INVALID_INPUT' }, bad);
  }
});

test('фильтр: период, воронка, «только мои»', () => {
  assert.deepEqual(buildDealFilter({ categoryId: 0, from: '2026-01-01', to: '2026-01-31', mine: false }, '1'),
    { categoryId: 0, createdAt: { $gte: '2026-01-01T00:00:00', $lte: '2026-01-31T23:59:59' } });
  assert.deepEqual(buildDealFilter({ categoryId: 2, from: null, to: null, mine: true }, '42'),
    { categoryId: 2, assignedById: 42 });
  assert.deepEqual(buildDealFilter({ categoryId: 0, from: '2026-01-01', to: null, mine: false }, '1'),
    { categoryId: 0, createdAt: { $gte: '2026-01-01T00:00:00' } });
});

test('фильтр «только мои» без числового ID пользователя — ошибка, а не чужие данные', () => {
  assert.throws(() => buildDealFilter({ categoryId: 0, mine: true }, 'net_5'), { code: 'INVALID_INPUT' });
});

test('справочник стадий по воронке', () => {
  assert.equal(stageEntityId(0), 'DEAL_STAGE');
  assert.equal(stageEntityId(7), 'DEAL_STAGE_7');
});

test('смысл стадии из обоих форматов Битрикс24', () => {
  assert.equal(stageKind({ semantics: 'S' }), 'won');
  assert.equal(stageKind({ semantics: null, extra: { SEMANTICS: 'failure' } }), 'lost');
  assert.equal(stageKind({ semantics: null, extra: { SEMANTICS: 'process' } }), 'open');
  assert.equal(stageKind({}), 'open');
});

const STATUSES = [
  { statusId: 'WON', name: 'Успех', sort: 60, semantics: 'S', color: '#7BD500' },
  { statusId: 'NEW', name: 'Новая', sort: 10, color: '#39A8EF' },
  { statusId: 'WORK', name: 'В работе', sort: 20, color: 'red; background:url(x)' },
  { statusId: 'LOSE', name: 'Провал', sort: 70, extra: { SEMANTICS: 'failure' } },
];

test('стадии сортируются, цвет без инъекций CSS', () => {
  const s = normalizeStages(STATUSES);
  assert.deepEqual(s.map((x) => x.stageId), ['NEW', 'WORK', 'WON', 'LOSE']);
  assert.equal(s[1].color, null);
  assert.equal(s[0].color, '#39A8EF');
});

test('сводка: стадии, показатели, средний чек, конверсия', () => {
  const stages = normalizeStages(STATUSES);
  const agg = { groups: [
    { stageId: 'NEW', count: 4, aggregates: { amount: { sum: 1000 } } },
    { stageId: 'WORK', count: 2, aggregates: { amount: { sum: '500.5' } } },
    { stageId: 'WON', count: 3, aggregates: { amount: { sum: 900 } } },
    { stageId: 'LOSE', count: 1, aggregates: { amount: { sum: 100 } } },
  ] };
  const { stages: rows, kpi } = buildSummary(stages, agg);
  assert.equal(rows.length, 4);
  assert.deepEqual(kpi, {
    totalCount: 10, totalSum: 2500.5, openCount: 6, openSum: 1500.5, wonCount: 3, wonSum: 900,
    lostCount: 1, avgCheck: 300, conversion: 75, unknownCount: 0, classified: true,
  });
});

test('стадии в полях Битрикс24 (STATUS_ID, NAME, SORT)', () => {
  const s = normalizeStages([{ STATUS_ID: 'WON', NAME: 'Успех', SORT: '20', SEMANTICS: 'S' }, { STATUS_ID: 'NEW', NAME: 'Новая', SORT: '10' }]);
  assert.deepEqual(s.map((x) => [x.stageId, x.name, x.kind]), [['NEW', 'Новая', 'open'], ['WON', 'Успех', 'won']]);
});

test('сводка: пустые данные — нули, без деления на ноль', () => {
  const { stages: rows, kpi } = buildSummary(normalizeStages(STATUSES), { groups: [] });
  assert.ok(rows.every((r) => r.count === 0 && r.sum === 0));
  assert.equal(kpi.avgCheck, null);
  assert.equal(kpi.conversion, null);
  assert.equal(kpi.totalCount, 0);
  const none = buildSummary([], undefined);
  assert.deepEqual(none.stages, []);
});

test('сводка: стадия вне справочника — строка по коду, показатели недоступны, а не ноль', () => {
  const { stages: rows, kpi } = buildSummary(normalizeStages(STATUSES), { groups: [
    { stageId: 'NEW', count: 3, aggregates: { amount: { sum: 30 } } },
    { stageId: 'WON', count: 2, aggregates: { amount: { sum: 20 } } },
    { stageId: 'OLD', count: 5, aggregates: { amount: { sum: 50 } } },
  ] });
  assert.equal(rows.find((r) => r.stageId === 'OLD').kind, 'unknown');
  assert.equal(kpi.classified, false);
  assert.equal(kpi.unknownCount, 5);
  for (const k of ['openCount', 'openSum', 'wonCount', 'wonSum', 'lostCount', 'avgCheck', 'conversion']) assert.equal(kpi[k], null, k);
  assert.equal(kpi.totalCount, 10, 'общее количество известно и показывается');
  assert.equal(kpi.totalSum, 100);
});

test('сводка: справочник стадий пуст, сделки есть — показатели недоступны', () => {
  const { stages: rows, kpi } = buildSummary([], { groups: [{ stageId: 'NEW', count: 4, aggregates: { amount: { sum: 40 } } }] });
  assert.equal(rows.length, 1);
  assert.equal(kpi.classified, false);
  assert.equal(kpi.openCount, null);
  assert.equal(kpi.wonCount, null);
});

test('сводка: стадия вне справочника без сделок не мешает расчёту', () => {
  const { kpi } = buildSummary(normalizeStages(STATUSES), { groups: [{ stageId: 'NEW', count: 1, aggregates: { amount: { sum: 10 } } }] });
  assert.equal(kpi.classified, true);
  assert.equal(kpi.openCount, 1);
});

test('сводка без сумм (выборка больше лимита платформы)', () => {
  const { stages: rows, kpi } = buildSummary(normalizeStages(STATUSES), { groups: [{ stageId: 'WON', count: 7 }] }, { sumsAvailable: false });
  assert.equal(rows.find((r) => r.stageId === 'WON').sum, null);
  assert.equal(kpi.wonCount, 7);
  assert.equal(kpi.wonSum, null);
  assert.equal(kpi.avgCheck, null);
  assert.equal(kpi.openSum, null);
});

test('имя сотрудника из обоих форматов ответа', () => {
  assert.equal(userDisplayName([{ NAME: 'Мария', LAST_NAME: 'Иванова' }]), 'Мария Иванова');
  assert.equal(userDisplayName({ name: 'Иван', lastName: null }), 'Иван');
  assert.equal(userDisplayName([]), null);
  assert.equal(userDisplayName(null), null);
});

test('последние сделки: имена, стадии, пустое название', () => {
  const stages = normalizeStages(STATUSES);
  const out = normalizeDeals([
    { id: 5, title: '  ', amount: '1500', currency: 'RUB', stageId: 'NEW', assignedById: 3, createdAt: '2026-10-01T10:00:00+03:00' },
    { id: 6, title: 'Б', amount: null, currency: 'bad', stageId: 'GONE', assignedById: null },
  ], stages, new Map([['3', 'Пётр Петров']]));
  assert.equal(out[0].title, 'Сделка #5');
  assert.equal(out[0].amount, 1500);
  assert.equal(out[0].stageName, 'Новая');
  assert.equal(out[0].assignedName, 'Пётр Петров');
  assert.equal(out[1].currency, null);
  assert.equal(out[1].stageName, 'GONE');
  assert.equal(out[1].assignedName, '—');
});

test('воронки: основная добавляется, если её нет в списке', () => {
  assert.deepEqual(normalizeCategories([{ id: 3, name: 'B2B', sort: 200 }]), [{ id: 0, name: 'Общая' }, { id: 3, name: 'B2B' }]);
  assert.deepEqual(normalizeCategories(null), [{ id: 0, name: 'Общая' }]);
});

test('домен портала: только имя хоста', () => {
  assert.equal(safePortalHost('company.bitrix24.ru'), 'company.bitrix24.ru');
  assert.equal(safePortalHost('https://Company.Bitrix24.ru/path'), 'company.bitrix24.ru');
  assert.equal(safePortalHost('evil.com"><script>'), null);
  assert.equal(safePortalHost(undefined), null);
});
