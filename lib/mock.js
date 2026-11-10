// Имитация Vibe API для локальной разработки и тестов (MOCK=1).
// Данные выдуманные и детерминированные; в production режим не включается.

import { VibeError } from './vibe.js';

const CATEGORIES = [
  { id: 0, name: 'Продажи', sort: 100 },
  { id: 3, name: 'Корпоративные клиенты', sort: 200 },
];

const STAGES = {
  DEAL_STAGE: [
    ['NEW', 'Новая', '#39A8EF', null], ['PREPARATION', 'Подготовка КП', '#2FC6F6', null],
    ['PREPAYMENT_INVOICE', 'Счёт на предоплату', '#55D0E0', null], ['EXECUTING', 'В работе', '#47E4C2', null],
    ['FINAL_INVOICE', 'Финальный счёт', '#FFA900', null], ['WON', 'Сделка успешна', '#7BD500', 'S'],
    ['LOSE', 'Сделка провалена', '#FF5752', 'F'],
  ],
  DEAL_STAGE_3: [
    ['C3:NEW', 'Заявка', '#39A8EF', null], ['C3:NEGOTIATION', 'Переговоры', '#2FC6F6', null],
    ['C3:CONTRACT', 'Договор', '#FFA900', null], ['C3:WON', 'Контракт подписан', '#7BD500', 'S'],
    ['C3:LOSE', 'Отказ', '#FF5752', 'F'],
  ],
};

const USERS = { 1: ['Анна', 'Смирнова'], 5: ['Игорь', 'Ковалёв'], 7: ['Мария', 'Лебедева'], 9: ['Дмитрий', 'Орлов'] };
const TITLES = ['Поставка оборудования', 'Годовое обслуживание', 'Внедрение CRM', 'Партия расходников', 'Аудит склада',
  'Лицензии на 50 мест', 'Монтаж вентиляции', 'Обучение персонала', 'Пилотный проект', 'Расширение тарифа'];

// Псевдослучайный, но повторяемый генератор.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

function makeDeals(today = new Date()) {
  const rand = rng(42);
  const deals = [];
  let id = 100;
  for (const [cat, entity, n] of [[0, 'DEAL_STAGE', 140], [3, 'DEAL_STAGE_3', 45]]) {
    const st = STAGES[entity];
    for (let i = 0; i < n; i++) {
      const daysAgo = Math.floor(rand() * 420);
      const created = new Date(today.getTime() - daysAgo * 86400_000 - Math.floor(rand() * 86400_000));
      const stage = st[Math.min(st.length - 1, Math.floor(rand() ** 0.8 * st.length))];
      const userIds = Object.keys(USERS);
      deals.push({
        id: id++,
        title: `${TITLES[Math.floor(rand() * TITLES.length)]} — ${['ООО «Север»', 'ИП Петров', 'АО «Вектор»', 'ООО «Ромашка»', 'ЗАО «Полюс»'][Math.floor(rand() * 5)]}`,
        amount: Math.round((5 + rand() * 495) * 1000),
        currency: 'RUB',
        categoryId: cat,
        stageId: stage[0],
        assignedById: Number(userIds[Math.floor(rand() * userIds.length)]),
        createdAt: created.toISOString().replace(/\.\d{3}Z$/, '+00:00'),
      });
    }
  }
  return deals;
}

function matches(deal, filter = {}) {
  if (filter.categoryId != null && deal.categoryId !== filter.categoryId) return false;
  if (filter.assignedById != null && deal.assignedById !== filter.assignedById) return false;
  const c = filter.createdAt;
  if (c?.$gte && deal.createdAt.slice(0, 19) < c.$gte) return false;
  if (c?.$lte && deal.createdAt.slice(0, 19) > c.$lte) return false;
  return true;
}

// deny — разделы, закрытые этому пользователю правами портала
//   ('users', 'statuses', 'deal-categories'): подвызов отвечает 403.
// flaky — сколько первых подвызовов раздела упадут временной ошибкой 429,
//   например { deals: 2 }.
// Сценарий 'nostages' — справочник стадий недоступен (для npm run dev).
export function createMockClient({ scenario = 'normal', userId = '1', deny = [], flaky = {} } = {}) {
  const deals = scenario === 'empty' ? [] : makeDeals();
  const denied = new Set(scenario === 'nostages' ? [...deny, 'statuses'] : deny);
  const flakyLeft = { ...flaky };
  const ok = (data, meta) => ({ success: true, data, ...(meta ? { meta } : {}) });
  const fail = () => { throw new VibeError(502, 'BITRIX_UNAVAILABLE', 'mock outage'); };

  return {
    async me() {
      return ok({ type: 'oauth_app', portal: 'demo.bitrix24.ru', scopes: ['crm', 'user', 'placement'], currentUser: { bitrixUserId: userId } });
    },
    async baseCurrency() { return ok('RUB'); },
    async aggregateDeals({ filter, aggregate }) {
      if (scenario === 'error') fail();
      if (scenario === 'huge' && aggregate?.[0]?.function === 'sum') {
        throw new VibeError(422, 'AGGREGATION_LIMIT_EXCEEDED', 'mock: too many');
      }
      const groups = new Map();
      const rows = deals.filter((d) => matches(d, filter));
      for (const d of rows) {
        const g = groups.get(d.stageId) ?? { stageId: d.stageId, count: 0, aggregates: { amount: { sum: 0 } } };
        g.count++; g.aggregates.amount.sum += d.amount;
        groups.set(d.stageId, g);
      }
      const truncated = scenario === 'partial';
      return ok({ count: rows.length, groups: [...groups.values()], meta: { totalRecords: rows.length, recordsProcessed: truncated ? Math.floor(rows.length / 2) : rows.length, truncated } });
    },
    async batch(calls) {
      const results = {}; const errors = {};
      for (const c of calls) {
        if (denied.has(c.entity)) { errors[c.id] = { code: 'BITRIX_ACCESS_DENIED', status: 403, message: 'mock: access denied' }; continue; }
        if (flakyLeft[c.entity] > 0) {
          flakyLeft[c.entity]--;
          errors[c.id] = { code: 'RATE_LIMITED', status: 429, message: 'mock: busy' };
          continue;
        }
        if (c.entity === 'deals' && c.action === 'list') {
          if (scenario === 'error') { errors[c.id] = { code: 'BITRIX_UNAVAILABLE', message: 'mock outage' }; continue; }
          results[c.id] = deals.filter((d) => matches(d, c.params.filter))
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id).slice(0, c.params.limit)
            .map(({ categoryId, ...rest }) => rest);
        } else if (c.entity === 'deal-categories') {
          results[c.id] = CATEGORIES;
        } else if (c.entity === 'statuses') {
          const entity = c.params.filter.entityId;
          results[c.id] = (STAGES[entity] ?? []).map(([statusId, name, color, sem], i) => ({
            id: i + 1, entityId: entity, statusId, name, sort: (i + 1) * 10, color, semantics: sem,
            extra: { SEMANTICS: sem === 'S' ? 'success' : sem === 'F' ? 'failure' : 'process', COLOR: color },
          }));
        } else if (c.entity === 'users' && c.action === 'get') {
          const u = USERS[c.entityId];
          if (u) results[c.id] = [{ ID: String(c.entityId), NAME: u[0], LAST_NAME: u[1] }];
          else errors[c.id] = { code: 'NOT_FOUND', message: 'no user' };
        } else {
          errors[c.id] = { code: 'ROUTE_NOT_FOUND', message: 'mock: unsupported call' };
        }
      }
      return ok({ results, errors, summary: { total: calls.length, succeeded: Object.keys(results).length, failed: Object.keys(errors).length } });
    },
  };
}
