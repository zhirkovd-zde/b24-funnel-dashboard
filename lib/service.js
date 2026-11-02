// Сборка данных дашборда: какие вызовы Vibe API делать и как их объединять.
// На одну загрузку дашборда — 2–3 запроса: агрегация по стадиям, пакетный
// вызов (последние сделки + справочники при промахе кэша) и, если нужно,
// пакет с именами ответственных.

import { createHash } from 'node:crypto';
import { TtlCache } from './cache.js';
import { VibeError } from './vibe.js';
import {
  InputError, buildDealFilter, buildSummary, isNumericId, normalizeCategories,
  normalizeDeals, normalizeStages, safePortalHost, stageEntityId, userDisplayName,
} from './dashboard.js';

const DEAL_SELECT = ['id', 'title', 'amount', 'currency', 'stageId', 'assignedById', 'createdAt'];

export function createService({ now } = {}) {
  const ctxCache = new TtlCache({ ttlMs: 10 * 60_000, now });       // контекст сессии по хэшу токена
  const dictCache = new TtlCache({ ttlMs: 5 * 60_000, now });       // воронки и стадии портала
  const currencyCache = new TtlCache({ ttlMs: 60 * 60_000, now });  // базовая валюта портала
  const userCache = new TtlCache({ ttlMs: 10 * 60_000, maxEntries: 5000, now }); // имена сотрудников

  // Кто пользователь и на каком портале — только из ответа /v1/me
  // по токену сессии, а не из параметров браузера.
  async function context(client, sessionToken) {
    const key = createHash('sha256').update(sessionToken).digest('hex');
    return ctxCache.getOrLoad(key, async () => {
      const me = (await client.me())?.data ?? {};
      const userId = me.currentUser?.bitrixUserId;
      if (!isNumericId(String(userId ?? ''))) throw new VibeError(401, 'INVALID_SESSION', 'No current user in session');
      // Портал — ключ кэша справочников: без него сессию не принимаем,
      // иначе данные разных порталов смешались бы под одним ключом.
      const portal = safePortalHost(me.portal);
      if (!portal) throw new VibeError(401, 'INVALID_SESSION', 'No portal in session');
      return {
        userId: String(userId),
        portal,
        scopes: Array.isArray(me.scopes) ? me.scopes : [],
      };
    });
  }

  async function currency(client, portal) {
    return currencyCache.getOrLoad(portal, async () => {
      try {
        const r = await client.baseCurrency();
        const code = typeof r?.data === 'string' ? r.data : (r?.data?.currency ?? r?.data?.code);
        return typeof code === 'string' && /^[A-Z]{3}$/.test(code) ? code : 'RUB';
      } catch {
        return 'RUB';
      }
    });
  }

  async function categories(client, portal) {
    return dictCache.getOrLoad(`cats:${portal}`, async () => {
      const r = await client.batch([{ id: 'cats', entity: 'deal-categories', action: 'list', params: { limit: 50 } }]);
      throwIfFailed(r, 'cats');
      return normalizeCategories(r.data.results.cats);
    });
  }

  // Пустой справочник не кэшируем: это скорее сбой, чем воронка без стадий.
  async function stages(client, portal, categoryId, prefetched) {
    const key = `stages:${portal}:${categoryId}`;
    if (prefetched?.length) { dictCache.set(key, prefetched); return prefetched; }
    const hit = dictCache.get(key);
    if (hit) return hit;
    const r = await client.batch([stagesCall(categoryId)]);
    throwIfFailed(r, 'stages');
    const list = normalizeStages(r.data.results.stages);
    if (list.length) dictCache.set(key, list);
    return list;
  }

  async function userNames(client, portal, ids) {
    const names = new Map();
    const missing = [];
    for (const id of ids) {
      const hit = userCache.get(`${portal}:${id}`);
      if (hit !== undefined) names.set(id, hit); else missing.push(id);
    }
    if (missing.length) {
      try {
        const r = await client.batch(missing.slice(0, 50).map((id) => ({ id: `u${id}`, entity: 'users', action: 'get', entityId: Number(id) })));
        for (const id of missing) {
          const name = userDisplayName(r?.data?.results?.[`u${id}`]);
          if (name) { names.set(id, name); userCache.set(`${portal}:${id}`, name); }
        }
      } catch {
        // Нет права user или сбой — покажем «Сотрудник #ID», дашборд не роняем.
      }
    }
    return names;
  }

  async function bootstrap(client, sessionToken) {
    const ctx = await context(client, sessionToken);
    const [cats, cur] = await Promise.all([categories(client, ctx.portal), currency(client, ctx.portal)]);
    return { portal: ctx.portal, categories: cats, currency: cur };
  }

  async function dashboard(client, sessionToken, query) {
    const ctx = await context(client, sessionToken);
    const cats = await categories(client, ctx.portal);
    if (!cats.some((c) => c.id === query.categoryId)) throw new InputError('Такой воронки нет');

    const filter = buildDealFilter(query, ctx.userId);
    const stagesKey = `stages:${ctx.portal}:${query.categoryId}`;
    const needStages = dictCache.get(stagesKey) === undefined;

    const calls = [{
      id: 'recent', entity: 'deals', action: 'list',
      params: { filter, select: DEAL_SELECT, sort: '-createdAt,-id', limit: query.limit, withTotal: false },
    }];
    if (needStages) calls.push(stagesCall(query.categoryId));

    const [agg, batch, cur] = await Promise.all([
      aggregateByStage(client, filter),
      client.batch(calls),
      currency(client, ctx.portal),
    ]);
    throwIfFailed(batch, 'recent');

    const prefetched = needStages && batch.data.errors?.stages == null ? normalizeStages(batch.data.results.stages) : null;
    let stageList;
    try {
      stageList = await stages(client, ctx.portal, query.categoryId, prefetched);
    } catch {
      stageList = [];
    }
    if (!stageList.length) {
      agg.warnings.push({ code: 'NO_STAGES', message: 'Не удалось получить список стадий воронки — стадии показаны по кодам. Обновите страницу позже.' });
    }

    const summary = buildSummary(stageList, agg.data, { sumsAvailable: agg.sumsAvailable });
    const rawDeals = Array.isArray(batch.data.results.recent) ? batch.data.results.recent : [];
    const ids = [...new Set(rawDeals.map((d) => d.assignedById).filter((v) => v != null).map(String).filter(isNumericId))];
    const names = await userNames(client, ctx.portal, ids);

    return {
      categoryId: query.categoryId,
      period: { from: query.from, to: query.to },
      mine: query.mine,
      currency: cur,
      portal: ctx.portal,
      ...summary,
      recent: normalizeDeals(rawDeals, stageList, names),
      warnings: agg.warnings,
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
  if (err) throw new VibeError(err.status || 502, err.code || 'BATCH_CALL_FAILED', err.message);
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
