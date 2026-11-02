import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVibeClient, describeError, VibeError } from '../lib/vibe.js';

function fakeFetch(responses) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, opts });
    const r = responses.shift();
    if (r instanceof Error) throw r;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: new Map(Object.entries(r.headers || {})),
      json: async () => r.body,
    };
  };
  return { impl, calls };
}

const noSleep = { delays: [], fn(ms) { this.delays.push(ms); return Promise.resolve(); } };

test('заголовки: ключ приложения и токен сессии пользователя', async () => {
  const f = fakeFetch([{ status: 200, body: { success: true, data: {} } }]);
  const c = createVibeClient({ appKey: 'vibe_app_test', sessionToken: 'vibe_session_x', fetchImpl: f.impl });
  await c.me();
  assert.equal(f.calls[0].opts.headers['X-Api-Key'], 'vibe_app_test');
  assert.equal(f.calls[0].opts.headers.Authorization, 'Bearer vibe_session_x');
  assert.match(f.calls[0].url, /\/v1\/me$/);
});

test('429: экспоненциальная пауза 1с → 2с → 4с, затем успех', async () => {
  const s = { ...noSleep, delays: [] };
  const f = fakeFetch([
    { status: 429, body: { success: false, error: { code: 'RATE_LIMITED' } } },
    { status: 429, body: { success: false, error: { code: 'RATE_LIMITED' } } },
    { status: 429, body: { success: false, error: { code: 'RATE_LIMITED' } } },
    { status: 200, body: { success: true, data: 1 } },
  ]);
  const c = createVibeClient({ appKey: 'k', sessionToken: 't', fetchImpl: f.impl, sleepImpl: s.fn.bind(s) });
  const r = await c.aggregateDeals({});
  assert.equal(r.data, 1);
  assert.deepEqual(s.delays, [1000, 2000, 4000]);
});

test('429: уважает Retry-After', async () => {
  const s = { ...noSleep, delays: [] };
  const f = fakeFetch([
    { status: 429, headers: { 'retry-after': '3' }, body: { success: false, error: { code: 'RATE_LIMITED' } } },
    { status: 200, body: { success: true } },
  ]);
  const c = createVibeClient({ appKey: 'k', sessionToken: 't', fetchImpl: f.impl, sleepImpl: s.fn.bind(s) });
  await c.me();
  assert.deepEqual(s.delays, [3000]);
});

test('429 четыре раза подряд — ошибка RATE_LIMITED', async () => {
  const s = { ...noSleep, delays: [] };
  const busy = { status: 429, body: { success: false, error: { code: 'RATE_LIMITED' } } };
  const f = fakeFetch([busy, busy, busy, busy]);
  const c = createVibeClient({ appKey: 'k', sessionToken: 't', fetchImpl: f.impl, sleepImpl: s.fn.bind(s) });
  await assert.rejects(c.me(), { code: 'RATE_LIMITED', status: 429 });
});

test('502 BITRIX_UNAVAILABLE: одна повторная попытка', async () => {
  const s = { ...noSleep, delays: [] };
  const down = { status: 502, body: { success: false, error: { code: 'BITRIX_UNAVAILABLE' } } };
  const f = fakeFetch([down, down]);
  const c = createVibeClient({ appKey: 'k', sessionToken: 't', fetchImpl: f.impl, sleepImpl: s.fn.bind(s) });
  await assert.rejects(c.me(), { code: 'BITRIX_UNAVAILABLE' });
  assert.equal(f.calls.length, 2);
});

test('403 и 401 не повторяются', async () => {
  for (const [status, code] of [[403, 'BITRIX_ACCESS_DENIED'], [401, 'KEY_EXPIRED']]) {
    const f = fakeFetch([{ status, body: { success: false, error: { code } } }]);
    const c = createVibeClient({ appKey: 'k', sessionToken: 't', fetchImpl: f.impl, sleepImpl: async () => {} });
    await assert.rejects(c.me(), { code, status });
    assert.equal(f.calls.length, 1);
  }
});

test('сетевой сбой: одна повторная попытка, затем UPSTREAM_TIMEOUT', async () => {
  const f = fakeFetch([new TypeError('fetch failed'), new TypeError('fetch failed')]);
  const c = createVibeClient({ appKey: 'k', sessionToken: 't', fetchImpl: f.impl, sleepImpl: async () => {} });
  await assert.rejects(c.me(), { code: 'UPSTREAM_TIMEOUT' });
});

test('понятные сообщения для ожидаемых кодов', () => {
  const cases = {
    RATE_LIMITED: 429, BITRIX_UNAVAILABLE: 502, BITRIX_ACCESS_DENIED: 403, KEY_EXPIRED: 503,
    INVALID_SESSION: 401, NO_SESSION: 401, SCOPE_DENIED: 403, CONFIG_MISSING: 503,
  };
  for (const [code, status] of Object.entries(cases)) {
    const d = describeError(new VibeError(500, code));
    assert.equal(d.status, status, code);
    assert.ok(d.message && !/Error|stack/i.test(d.message), code);
  }
  const unknown = describeError(new VibeError(500, 'WEIRD'));
  assert.equal(unknown.status, 502);
  const generic = describeError(Object.assign(new Error('boom'), { code: 'ENOENT' }));
  assert.deepEqual([generic.status, generic.code], [500, 'INTERNAL']);
});

test('незнакомый код — сообщение по HTTP-статусу', () => {
  assert.equal(describeError(new VibeError(401, 'UNAUTHORIZED')).message, describeError(new VibeError(401, 'INVALID_SESSION')).message);
  assert.equal(describeError(new VibeError(403, 'FORBIDDEN_X')).status, 403);
  assert.equal(describeError(new VibeError(429, 'TOO_MANY_REQUESTS')).message, describeError(new VibeError(429, 'RATE_LIMITED')).message);
});
