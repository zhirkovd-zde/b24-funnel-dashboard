// Дашборд воронки продаж для Битрикс24 на платформе Вайбкод.
// Сервер — BFF: отдаёт статику и два JSON-метода, к Vibe API ходит сам
// от лица пользователя, открывшего приложение (токен сессии от Gateway).

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createVibeClient, describeError, VibeError } from './lib/vibe.js';
import { createService } from './lib/service.js';
import { createMockClient } from './lib/mock.js';
import { parseDashboardQuery } from './lib/dashboard.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const APP_KEY = process.env.VIBE_APP_KEY || '';
const API_BASE = process.env.VIBE_API_BASE || 'https://vibecode.bitrix24.tech/v1';
// Имитация данных — только для локальной разработки, в production выключена всегда.
const MOCK = process.env.MOCK === '1' && process.env.NODE_ENV !== 'production';
if (MOCK && APP_KEY) {
  console.error('MOCK=1 вместе с VIBE_APP_KEY — отказ запуска: имитация не должна работать рядом с настоящим ключом.');
  process.exit(1);
}

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/static/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/static/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/static/icon.svg': ['icon.svg', 'image/svg+xml'],
  '/favicon.ico': ['icon.svg', 'image/svg+xml'],
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; object-src 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

const service = createService();

function sessionToken(req) {
  const raw = req.headers['x-vibe-authorization'];
  const m = typeof raw === 'string' ? /^Bearer\s+(\S+)$/.exec(raw) : null;
  if (m) return m[1];
  return MOCK ? 'mock-session' : null;
}

function userName(req) {
  const enc = req.headers['x-vibe-user-name-encoded'];
  if (typeof enc === 'string') {
    try { return decodeURIComponent(enc).slice(0, 200); } catch { /* битая кодировка */ }
  }
  return MOCK ? 'Анна Смирнова' : null;
}

function clientFor(token) {
  if (MOCK) return createMockClient({ scenario: process.env.MOCK_SCENARIO || 'normal' });
  if (!APP_KEY) throw new VibeError(503, 'CONFIG_MISSING', 'VIBE_APP_KEY is not set');
  return createVibeClient({ appKey: APP_KEY, sessionToken: token, baseUrl: API_BASE });
}

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  const payload = isJson ? JSON.stringify(body) : body;
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function sendError(res, err, requestId) {
  const d = describeError(err);
  res.errorCode = d.code;
  send(res, d.status, { error: { code: d.code, message: d.message, requestId } });
}

async function handleApi(req, res, url, requestId) {
  const token = sessionToken(req);
  if (!token) throw new VibeError(401, 'NO_SESSION', 'No X-Vibe-Authorization');
  const client = clientFor(token);

  if (url.pathname === '/api/bootstrap') {
    const data = await service.bootstrap(client, token);
    return send(res, 200, { ...data, user: { name: userName(req) } });
  }
  if (url.pathname === '/api/dashboard') {
    const query = parseDashboardQuery(url.searchParams);
    const data = await service.dashboard(client, token, query);
    return send(res, 200, data);
  }
  return send(res, 404, { error: { code: 'NOT_FOUND', message: 'Нет такого метода', requestId } });
}

async function handleStatic(res, pathname) {
  const entry = STATIC[pathname];
  if (!entry) return send(res, 404, 'Not found');
  const body = await readFile(join(ROOT, 'public', entry[0]));
  send(res, 200, body, { 'Content-Type': entry[1], 'Cache-Control': 'no-cache' });
}

// В журнал — только служебное: метод, путь, статус, код ошибки, время.
// Ни параметров фильтра, ни имён, ни данных сделок.
function log(req, res, pathname, started, requestId) {
  const line = { t: new Date().toISOString(), req: requestId, m: req.method, p: pathname, s: res.statusCode, ms: Date.now() - started };
  if (res.errorCode) line.code = res.errorCode;
  console.log(JSON.stringify(line));
}

const server = createServer(async (req, res) => {
  const started = Date.now();
  const requestId = String(req.headers['x-vibe-request-id'] || '').slice(0, 40) || null;
  let pathname = '/';
  res.on('finish', () => log(req, res, pathname, started, requestId));
  try {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return send(res, 400, 'Bad request'); }
    pathname = url.pathname;
    if (pathname === '/health') return send(res, 200, 'ok');
    if (pathname.startsWith('/api/')) {
      if (req.method !== 'GET') return send(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Только GET' } }, { Allow: 'GET' });
      return await handleApi(req, res, url, requestId);
    }
    // Битрикс24 может открыть встройку POST-запросом — отдаём ту же страницу.
    if (!['GET', 'HEAD', 'POST'].includes(req.method)) return send(res, 405, 'Method not allowed', { Allow: 'GET, HEAD, POST' });
    return await handleStatic(res, pathname);
  } catch (err) {
    if (!(err instanceof VibeError) && err?.code !== 'INVALID_INPUT') {
      console.error(JSON.stringify({ t: new Date().toISOString(), req: requestId, p: pathname, error: err?.name, msg: String(err?.message).slice(0, 200) }));
    }
    if (!res.headersSent) sendError(res, err, requestId);
  }
});

server.listen(PORT, () => {
  console.log(JSON.stringify({ t: new Date().toISOString(), msg: 'listening', port: PORT, mock: MOCK, appKeySet: Boolean(APP_KEY) }));
});
