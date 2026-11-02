// Клиент Vibe API от лица текущего пользователя (BFF): ключ приложения
// живёт только в окружении сервера, токен сессии приходит от Gateway в
// X-Vibe-Authorization. Ни то ни другое не уходит в браузер и не пишется в лог.

const DEFAULT_BASE = 'https://vibecode.bitrix24.tech/v1';
const RETRY_DELAYS_MS = [1000, 2000, 4000];
const REQUEST_TIMEOUT_MS = 25000;

export class VibeError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message || code);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function retryDelay(attempt, res) {
  const ra = Number(res?.headers?.get?.('retry-after'));
  if (Number.isFinite(ra) && ra > 0) return Math.min(ra * 1000, 10000);
  return RETRY_DELAYS_MS[attempt] ?? 4000;
}

export function createVibeClient({ appKey, sessionToken, baseUrl = DEFAULT_BASE, fetchImpl = fetch, sleepImpl = sleep }) {
  async function request(method, path, body) {
    const headers = { 'X-Api-Key': appKey, Accept: 'application/json' };
    if (sessionToken) headers.Authorization = `Bearer ${sessionToken}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetchImpl(`${baseUrl}${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: 'error', // ключ не должен уйти по перенаправлению на чужой адрес
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (e) {
        // Сеть или таймаут: одна повторная попытка, потом честная ошибка.
        if (attempt < 1) { await sleepImpl(RETRY_DELAYS_MS[0]); continue; }
        throw new VibeError(504, 'UPSTREAM_TIMEOUT', 'Платформа Вайбкод не ответила вовремя');
      }

      let json = null;
      try { json = await res.json(); } catch { /* тело не JSON */ }

      if (res.ok && json?.success !== false) return json;

      const code = json?.error?.code || `HTTP_${res.status}`;
      // 429 — экспоненциальная пауза 1с → 2с → 4с (или Retry-After).
      if (res.status === 429 && attempt < RETRY_DELAYS_MS.length) {
        await sleepImpl(retryDelay(attempt, res));
        continue;
      }
      // Портал Битрикс24 недоступен — одна повторная попытка.
      if ((res.status === 502 || res.status === 503) && attempt < 1) {
        await sleepImpl(retryDelay(attempt, res));
        continue;
      }
      throw new VibeError(res.status, code, json?.error?.message, { details: json?.error?.details, data: json?.data });
    }
  }

  return {
    me: () => request('GET', '/me'),
    aggregateDeals: (body) => request('POST', '/deals/aggregate', body),
    batch: (calls) => request('POST', '/batch', { calls }),
    baseCurrency: () => request('GET', '/currencies/base'),
  };
}

// Понятное сообщение для пользователя вместо технической трассы.
export function describeError(err) {
  const code = err?.code || 'UNKNOWN';
  const status = err?.status || 500;
  const table = {
    NO_SESSION: [401, 'Откройте приложение из Битрикс24 — пункт «Воронка продаж» в левом меню.'],
    TOKEN_MISSING: [401, 'Откройте приложение из Битрикс24 — пункт «Воронка продаж» в левом меню.'],
    INVALID_SESSION: [401, 'Сессия истекла. Обновите страницу или откройте приложение заново из меню Битрикс24.'],
    SESSION_EXPIRED: [401, 'Сессия истекла. Обновите страницу или откройте приложение заново из меню Битрикс24.'],
    KEY_EXPIRED: [503, 'Срок действия ключа приложения истёк. Сообщите администратору портала.'],
    KEY_INACTIVE: [503, 'Ключ приложения отозван. Сообщите администратору портала.'],
    INVALID_API_KEY: [503, 'Ключ приложения не распознан. Сообщите администратору портала.'],
    SESSION_APP_MISMATCH: [503, 'Приложение настроено с ключом другого приложения. Сообщите администратору портала.'],
    CONFIG_MISSING: [503, 'Приложение не настроено: не задан ключ приложения. Сообщите администратору портала.'],
    SCOPE_DENIED: [403, 'У приложения нет права на CRM. Сообщите администратору портала.'],
    BITRIX_ACCESS_DENIED: [403, 'У вас нет доступа к сделкам этой воронки. Обратитесь к администратору CRM.'],
    ACCESS_DENIED: [403, 'У вас нет доступа к сделкам этой воронки. Обратитесь к администратору CRM.'],
    RATE_LIMITED: [429, 'Портал сейчас перегружен запросами. Повторите через минуту.'],
    BITRIX_UNAVAILABLE: [502, 'Битрикс24 временно не отвечает. Повторите чуть позже.'],
    UPSTREAM_TIMEOUT: [504, 'Платформа не ответила вовремя. Повторите чуть позже.'],
    AGGREGATION_LIMIT_EXCEEDED: [422, 'Слишком много сделок для расчёта сумм. Сузьте период.'],
    INVALID_INPUT: [400, err?.message || 'Неверные параметры фильтра.'],
  };
  if (table[code]) return { status: table[code][0], code, message: table[code][1] };
  // Ошибка не от Vibe API (сбой самого сервера) — наружу без внутренних кодов Node.
  if (!(err instanceof VibeError)) return { status: 500, code: 'INTERNAL', message: 'Внутренняя ошибка приложения. Повторите чуть позже.' };
  if (code === 'BITRIX_ERROR' && /FEATURE_NOT_AVAILABLE/.test(String(err?.message))) {
    return { status: 422, code, message: 'Тариф портала не поддерживает эту функцию.' };
  }
  // Незнакомый код — сообщение по HTTP-статусу.
  if (status === 401) return { status: 401, code, message: table.INVALID_SESSION[1] };
  if (status === 403) return { status: 403, code, message: table.BITRIX_ACCESS_DENIED[1] };
  if (status === 429) return { status: 429, code, message: table.RATE_LIMITED[1] };
  if (status >= 500) return { status: 502, code, message: 'Не удалось получить данные из Битрикс24. Повторите чуть позже.' };
  return { status: status >= 400 && status < 500 ? status : 500, code, message: `Не удалось получить данные (код ${code}).` };
}
