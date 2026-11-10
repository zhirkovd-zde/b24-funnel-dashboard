// Сборка данных дашборда: какие вызовы Vibe API делать и как их объединять.
// На одну загрузку дашборда — 2–3 запроса: агрегация по стадиям, пакетный
// вызов (последние сделки + справочники при промахе кэша) и, если нужно,
// пакет с именами ответственных.
//
// Всё, что видно в зависимости от прав (воронки, стадии, имена сотрудников),
// кэшируется отдельно для каждого пользователя портала: ответ, полученный с
// правами одного сотрудника, никогда не отдаётся другому.

import { createHash } from 'node:crypto';
import { TtlCache } from './cache.js';
import { VibeError } from './vibe.js';
import {
  InputError, buildDealFilter, buildSummary, isNumericId, normalizeCategories,
  normalizeDeals, normalizeStages, safePortalHost, stageEntityId, userDisplayName,
} from './dashboard.js';

const DEAL_SELECT = ['id', 'title', 'amount', 'currency', 'stageId', 'assignedById', 'createdAt'];

// Временные ошибки подвызова batch — повторяются с паузой 1с → 2с → 4с.
const TRANSIENT_CODES = new Set([
  'RATE_LIMITED', 'QUERY_LIMIT_EXCEEDED', 'BITRIX_UNAVAILABLE', 'OPERATION_TIME_LIMIT',
  'UPSTREAM_TIMEOUT', 'TIMEOUT', 'INTERNAL_ERROR',
]);
const BATCH_RETRY_DELAYS_MS = [1000, 2000, 4000];

export function isTransientCallError(err) {
  if (!err) return false;
  const status = Number(err.status);
  return TRANSIENT_CODES.has(err.code) || status === 429 || status === 502 || status === 503 || status === 504;
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createService({ now, sleep = defaultSleep } = {}) {
  const ctxCache = new TtlCache({ ttlMs: 10 * 60_000, now });       // контекст сессии по хэшу токена
  const dictCache = new TtlCache({ ttlMs: 5 * 60_000, now });       // воронки и стадии — по пользователю
  const currencyCache = new TtlCache({ ttlMs: 60 * 60_000, now });  // базовая валюта — по пользователю
  const userCache = new TtlCache({ ttlMs: 10 * 60_000, maxEntries: 5000, now }); // имена — по пользователю

  // Кто пользователь и на каком портале — только из ответа /v1/me
  // по токену сессии, а не из параметров браузера.
  async function context(client, sessionToken) {
    const key = createHash('sha256').update(sessionToken).digest('hex');
    return ctxCache.getOrLoad(key, async () => {
      const me = (await client.me())?.data ?? {};
      const userId = me.currentUser?.bitrixUserId;
      if (!isNumericId(String(userId ?? ''))) throw new VibeError(401, 'INVALID_SESSION', 'No current user in session');
      const portal = safePortalHost(me.portal);
      if (!portal) throw new VibeError(401, 'INVALID_SESSION', 'No portal in session');
      return {
        userId: String(userId),
        portal,
        // Ключ всех кэшей, зависящих от прав: портал + подтверждённый пользователь.
        scope: `${portal}#${userId}`,
        scopes: Array.isArray(me.scopes) ? me.scopes : [],
      };
    });
  }

  // Пакетный вызов с повтором временных ошибок отдельных подвызовов.
  // Повторяются только упавшие по временной причине подвызовы; успешные
  // результаты и окончательные отказы (403 и т. п.) сохраняются как есть.
  // retries — сколько повторов допустимо: для обязательных данных 3
  // (1с → 2с → 4с), для необязательных (имена сотрудников) — 1.
  // Исключение на повторе не теряет уже полученное: оставшиеся подвызовы
  // помечаются ошибкой, накопленные результаты возвращаются.
  async function batch(client, calls, { retries = BATCH_RETRY_DELAYS_MS.length } = {}) {
    const results = {};
    const errors = {};
    let pending = calls;
    for (let attempt = 0; ; attempt++) {
      let r;
      try {
        r = await client.batch(pending);
      } catch (e) {
        if (attempt === 0) throw e;
        for (const c of pending) errors[c.id] = { code: e?.code || 'BATCH_CALL_FAILED', status: e?.status, message: e?.message };
        break;
      }
      const res = r?.data?.results ?? {};
      const err = r?.data?.errors ?? {};
      const retry = [];
      for (const c of pending) {
        if (err[c.id] != null) {
          if (isTransientCallError(err[c.id]) && attempt < retries) retry.push(c);
          else errors[c.id] = err[c.id];
        } else if (c.id in res) {
          results[c.id] = res[c.id];
        }
      }
      if (!retry.length) break;
      await sleep(BATCH_RETRY_DELAYS_MS[attempt]);
      pending = retry;
    }
    return { data: { results, errors } };
  }

  // Запасное значение при сбое не кэшируется — в следующий раз спросим снова.
  async function currency(client, ctx) {
    const hit = currencyCache.get(ctx.scope);
    if (hit) return hit;
    try {
      const r = await client.baseCurrency();
      const code = typeof r?.data === 'string' ? r.data : (r?.data?.currency ?? r?.data?.code);
      if (typeof code === 'string' && /^[A-Z]{3}$/.test(code)) { currencyCache.set(ctx.scope, code); return code; }
    } catch { /* ниже — запасной вариант */ }
    return 'RUB';
  }

  async function categories(client, ctx) {
    return dictCache.getOrLoad(`cats:${ctx.scope}`, async () => {
      const r = await batch(client, [{ id: 'cats', entity: 'deal-categories', action: 'list', params: { limit: 50 } }]);
      throwIfFailed(r, 'cats');
      return normalizeCategories(r.data.results.cats);
    });
  }

  // Пустой справочник не кэшируем: это скорее сбой, чем воронка без стадий.
  async function stages(client, ctx, categoryId, prefetched) {
    const key = `stages:${ctx.scope}:${categoryId}`;
    if (prefetched?.length) { dictCache.set(key, prefetched); return prefetched; }
    const hit = dictCache.get(key);
    if (hit) return hit;
    const r = await batch(client, [stagesCall(categoryId)]);
    throwIfFailed(r, 'stages');
    const list = normalizeStages(r.data.results.stages);
    if (list.length) dictCache.set(key, list);
    return list;
  }

  // Имена ответственных — запросом с правами текущего пользователя; в кэш
  // попадают только имена, которые этот пользователь получил сам.
  async function userNames(client, ctx, ids) {
    const names = new Map();
    const missing = [];
    for (const id of ids) {
      const hit = userCache.get(`${ctx.scope}:${id}`);
      if (hit !== undefined) names.set(id, hit); else missing.push(id);
    }
    if (missing.length) {
      try {
        const r = await batch(client, missing.slice(0, 50).map((id) => ({ id: `u${id}`, entity: 'users', action: 'get', entityId: Number(id) })), { retries: 1 });
        for (const id of missing) {
          const name = userDisplayName(r.data.results[`u${id}`]);
          if (name) { names.set(id, name); userCache.set(`${ctx.scope}:${id}`, name); }
        }
      } catch {
        // Нет права user или сбой — покажем «Сотрудник #ID», дашборд не роняем.
      }
    }
    return names;
  }

  async function bootstrap(client, sessionToken) {
    const ctx = await context(client, sessionToken);
    const [cats, cur] = await Promise.all([categories(client, ctx), currency(client, ctx)]);
    return { portal: ctx.portal, categories: cats, currency: cur };
  }

  async function dashboard(client, sessionToken, query) {
    const ctx = await context(client, sessionToken);
    const cats = await categories(client, ctx);
    if (!cats.some((c) => c.id === query.categoryId)) throw new InputError('Такой воронки нет');

    const filter = buildDealFilter(query, ctx.userId);
    const needStages = dictCache.get(`stages:${ctx.scope}:${query.categoryId}`) === undefined;

    const calls = [{
      id: 'recent', entity: 'deals', action: 'list',
      params: { filter, select: DEAL_SELECT, sort: '-createdAt,-id', limit: query.limit, withTotal: false },
    }];
    if (needStages) calls.push(stagesCall(query.categoryId));

    const [agg, b, cur] = await Promise.all([
      aggregateByStage(client, filter),
      batch(client, calls),
      currency(client, ctx),
    ]);
    throwIfFailed(b, 'recent');

    // Подвызов стадий в основном пакете уже исчерпал свои повторы — второй
    // раз не запрашиваем, сразу показываем дашборд без классификации.
    let stageList;
    if (needStages && b.data.errors.stages != null) {
      stageList = [];
    } else {
      const prefetched = needStages ? normalizeStages(b.data.results.stages) : null;
      try {
        stageList = await stages(client, ctx, query.categoryId, prefetched);
      } catch {
        stageList = [];
      }
    }

    const summary = buildSummary(stageList, agg.data, { sumsAvailable: agg.sumsAvailable });
    const warnings = [...agg.warnings];
    if (!summary.kpi.classified) {
      warnings.push(stageList.length === 0
        ? {
          code: 'NO_STAGES',
          message: 'Список стадий воронки недоступен (нет прав на него или временный сбой): нельзя определить, какие сделки открыты, а какие выиграны. Показатели открытых и выигранных сделок недоступны, стадии показаны по кодам. Обновите страницу позже.',
        }
        : {
          code: 'UNKNOWN_STAGES',
          message: `${summary.kpi.unknownCount} сделок стоят на стадиях, которых нет в справочнике: показатели открытых и выигранных сделок недоступны, чтобы не показать неполные цифры как точные.`,
        });
    }

    const rawDeals = Array.isArray(b.data.results.recent) ? b.data.results.recent : [];
    const ids = [...new Set(rawDeals.map((d) => d.assignedById).filter((v) => v != null).map(String).filter(isNumericId))];
    const names = await userNames(client, ctx, ids);

    return {
      categoryId: query.categoryId,
      period: { from: query.from, to: query.to },
      mine: query.mine,
      currency: cur,
      portal: ctx.portal,
      ...summary,
      recent: normalizeDeals(rawDeals, stageList, names),
      warnings,
      generatedAt: new Date().toISOString(),
    };
  }

  return { bootstrap, dashboard, context };
}

function stagesCall(categoryId) {
  return { id: 'stages', entity: 'statuses', action: 'list', params: { filter: { entityId: stageEntityId(categoryId) }, limit: 200 } };
}

function throwIfFailed(batchResponse, id) {
  const err = batchResponse?.data?.errors?.[id];
  if (err) throw new VibeError(Number(err.status) || 502, err.code || 'BATCH_CALL_FAILED', err.message);
  if (!batchResponse?.data?.results || !(id in batchResponse.data.results)) {
    throw new VibeError(502, 'BATCH_CALL_FAILED', `Пустой ответ пакетного вызова (${id})`);
  }
}

// Количество и сумма по стадиям одним запросом агрегации.
// Если сделок под фильтром больше, чем платформа считает за раз, берём
// только количество (оно точное) и честно сообщаем, что суммы недоступны.
async function aggregateByStage(client, filter) {
  const warnings = [];
  try {
    const r = await client.aggregateDeals({ aggregate: [{ field: 'amount', function: 'sum' }], filter, groupBy: 'stageId' });
    const meta = r?.data?.meta ?? {};
    if (meta.truncated) {
      warnings.push({
        code: 'PARTIAL_SUMS',
        message: `Суммы и количества посчитаны по ${meta.recordsProcessed ?? 'части'} сделкам из ${r.data.count ?? 'всех'} — сузьте период для точных цифр.`,
      });
    }
    return { data: r.data, sumsAvailable: true, warnings };
  } catch (e) {
    if (e?.code !== 'AGGREGATION_LIMIT_EXCEEDED') throw e;
    const r = await client.aggregateDeals({ aggregate: [{ field: '*', function: 'count' }], filter, groupBy: 'stageId' });
    warnings.push({ code: 'NO_SUMS', message: 'Сделок за период слишком много для расчёта сумм — показано только количество. Сузьте период.' });
    if (r?.data?.meta?.truncated) warnings.push({ code: 'PARTIAL_COUNTS', message: 'Количество по стадиям посчитано не полностью — сузьте период.' });
    return { data: r.data, sumsAvailable: false, warnings };
  }
}
