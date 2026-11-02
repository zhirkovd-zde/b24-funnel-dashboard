// Чистая логика дашборда: проверка параметров, фильтры, сводка по стадиям.
// Без сети и без состояния — всё покрыто тестами в test/dashboard.test.js.

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;
export const RECENT_LIMITS = [10, 20];

export class InputError extends Error {
  constructor(message) {
    super(message);
    this.code = 'INVALID_INPUT';
  }
}

// «2026-02-30» отвергается: дата должна существовать в календаре.
export function parseDate(value, name) {
  const m = DATE_RE.exec(value);
  if (!m) throw new InputError(`Параметр ${name}: нужна дата в формате ГГГГ-ММ-ДД`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (y < MIN_YEAR || y > MAX_YEAR || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    throw new InputError(`Параметр ${name}: такой даты нет`);
  }
  return value;
}

// Разбор query-параметров запроса /api/dashboard. Всё, что пришло из браузера,
// проверяется здесь, до обращения к API.
export function parseDashboardQuery(params) {
  const rawCategory = params.get('categoryId') ?? '0';
  if (!/^\d{1,9}$/.test(rawCategory)) throw new InputError('Параметр categoryId: нужен номер воронки');
  const categoryId = Number(rawCategory);

  const rawFrom = params.get('from') || '';
  const rawTo = params.get('to') || '';
  const from = rawFrom ? parseDate(rawFrom, 'from') : null;
  const to = rawTo ? parseDate(rawTo, 'to') : null;
  if (from && to && from > to) throw new InputError('Начало периода позже его конца');

  const rawMine = params.get('mine') ?? '0';
  if (rawMine !== '0' && rawMine !== '1') throw new InputError('Параметр mine: 0 или 1');

  const rawLimit = params.get('limit') ?? '20';
  const limit = Number(rawLimit);
  if (!RECENT_LIMITS.includes(limit)) throw new InputError(`Параметр limit: одно из ${RECENT_LIMITS.join(', ')}`);

  return { categoryId, from, to, mine: rawMine === '1', limit };
}

// Фильтр сделок для Vibe API. Даты без смещения — Битрикс24 трактует их
// в часовом поясе пользователя, от чьего имени идёт запрос.
export function buildDealFilter({ categoryId, from, to, mine }, userId) {
  const filter = { categoryId };
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = `${from}T00:00:00`;
    if (to) filter.createdAt.$lte = `${to}T23:59:59`;
  }
  if (mine) {
    if (!isNumericId(userId)) throw new InputError('Не удалось определить текущего пользователя для фильтра «Только мои»');
    filter.assignedById = Number(userId);
  }
  return filter;
}

export function isNumericId(v) {
  return typeof v === 'string' ? /^\d+$/.test(v) : Number.isInteger(v) && v >= 0;
}

export function stageEntityId(categoryId) {
  return categoryId === 0 ? 'DEAL_STAGE' : `DEAL_STAGE_${categoryId}`;
}

// Смысл стадии: в Битрикс24 он лежит то в `semantics` ('S'/'F'), то в
// extra.SEMANTICS ('success'/'failure'/'process'). Пустое значение — «в работе».
export function stageKind(status) {
  const raw = String(status?.semantics ?? status?.extra?.SEMANTICS ?? '').toLowerCase();
  if (raw === 's' || raw === 'success') return 'won';
  if (raw === 'f' || raw === 'failure' || raw === 'apology') return 'lost';
  return 'open';
}

export function normalizeStages(statuses) {
  return (Array.isArray(statuses) ? statuses : [])
    .filter((s) => s && typeof s.statusId === 'string')
    .map((s) => ({
      stageId: s.statusId,
      name: String(s.name ?? s.statusId),
      color: safeColor(s.color ?? s.extra?.COLOR),
      sort: Number(s.sort) || 0,
      kind: stageKind(s),
    }))
    .sort((a, b) => a.sort - b.sort);
}

function safeColor(c) {
  return typeof c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : null;
}

function toNumber(v) {
  const n = typeof v === 'number' ? v : Number.parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

// Сводит ответ агрегации (группы по stageId) со справочником стадий.
// Стадии без сделок показываются с нулями; группы по удалённой стадии —
// отдельной строкой, в показатели «открытые/выигранные» не входят.
// sumsAvailable=false — суммы не посчитаны (выборка больше лимита платформы).
export function buildSummary(stages, aggregate, { sumsAvailable = true } = {}) {
  const groups = Array.isArray(aggregate?.groups) ? aggregate.groups : [];
  const byStage = new Map();
  for (const g of groups) {
    if (!g || g.stageId == null) continue;
    byStage.set(String(g.stageId), {
      count: toNumber(g.count),
      sum: sumsAvailable ? toNumber(g.aggregates?.amount?.sum) : null,
    });
  }

  const rows = stages.map((s) => {
    const g = byStage.get(s.stageId);
    byStage.delete(s.stageId);
    return { ...s, count: g?.count ?? 0, sum: sumsAvailable ? (g?.sum ?? 0) : null };
  });
  for (const [stageId, g] of byStage) {
    rows.push({ stageId, name: `Стадия ${stageId} (нет в справочнике)`, color: null, sort: Infinity, kind: 'unknown', ...g });
  }

  const kpi = { totalCount: 0, totalSum: 0, openCount: 0, openSum: 0, wonCount: 0, wonSum: 0, lostCount: 0 };
  for (const r of rows) {
    kpi.totalCount += r.count;
    kpi.totalSum += r.sum ?? 0;
    if (r.kind === 'open') { kpi.openCount += r.count; kpi.openSum += r.sum ?? 0; }
    if (r.kind === 'won') { kpi.wonCount += r.count; kpi.wonSum += r.sum ?? 0; }
    if (r.kind === 'lost') kpi.lostCount += r.count;
  }
  if (!sumsAvailable) { kpi.totalSum = null; kpi.openSum = null; kpi.wonSum = null; }
  kpi.avgCheck = sumsAvailable && kpi.wonCount > 0 ? round2(kpi.wonSum / kpi.wonCount) : null;
  kpi.conversion = kpi.totalCount > 0 ? round2((kpi.wonCount / kpi.totalCount) * 100) : null;
  kpi.totalSum = kpi.totalSum === null ? null : round2(kpi.totalSum);
  kpi.openSum = kpi.openSum === null ? null : round2(kpi.openSum);
  kpi.wonSum = kpi.wonSum === null ? null : round2(kpi.wonSum);

  return { stages: rows.map((r) => ({ ...r, sort: undefined })), kpi };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Пользователь из batch `users.get` приходит то в camelCase, то в полях
// Битрикс24 (NAME, LAST_NAME) — принимаем оба вида.
export function userDisplayName(u) {
  const rec = Array.isArray(u) ? u[0] : u;
  if (!rec || typeof rec !== 'object') return null;
  const first = rec.name ?? rec.NAME ?? '';
  const last = rec.lastName ?? rec.LAST_NAME ?? '';
  const full = `${first} ${last}`.trim();
  return full || null;
}

export function normalizeDeals(deals, stages, userNames) {
  const stageMap = new Map(stages.map((s) => [s.stageId, s]));
  return (Array.isArray(deals) ? deals : []).map((d) => {
    const st = stageMap.get(d.stageId);
    const uid = d.assignedById == null ? null : String(d.assignedById);
    return {
      id: Number(d.id),
      title: String(d.title ?? '').trim() || `Сделка #${d.id}`,
      amount: toNumber(d.amount),
      currency: typeof d.currency === 'string' && /^[A-Z]{3}$/.test(d.currency) ? d.currency : null,
      stageId: d.stageId ?? null,
      stageName: st?.name ?? (d.stageId ? String(d.stageId) : '—'),
      stageColor: st?.color ?? null,
      stageKind: st?.kind ?? 'unknown',
      assignedById: uid,
      assignedName: uid ? (userNames.get(uid) ?? `Сотрудник #${uid}`) : '—',
      createdAt: typeof d.createdAt === 'string' ? d.createdAt : null,
    };
  });
}

export function normalizeCategories(list) {
  const cats = (Array.isArray(list) ? list : [])
    .filter((c) => c && isNumericId(String(c.id)))
    .map((c) => ({ id: Number(c.id), name: String(c.name ?? `Воронка ${c.id}`), sort: Number(c.sort) || 0 }));
  if (!cats.some((c) => c.id === 0)) cats.unshift({ id: 0, name: 'Общая', sort: -1 });
  return cats.sort((a, b) => a.sort - b.sort || a.id - b.id).map(({ id, name }) => ({ id, name }));
}

// Домен портала из /v1/me — только имя хоста, чтобы ссылка на сделку
// не могла увести пользователя на посторонний адрес.
export function safePortalHost(portal) {
  if (typeof portal !== 'string') return null;
  const host = portal.replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) ? host : null;
}
