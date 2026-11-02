#!/usr/bin/env node
// Воспроизводимый деплой дашборда на сервер Black Hole платформы Вайбкод.
//
// Ключ берётся ТОЛЬКО из окружения и никогда не печатается:
//   VIBE_API_KEY  — личный ключ vibe_api_ для инфраструктуры (скоупы vibe:infra, placement)
//   VIBE_APP_KEY  — ключ авторизации приложения vibe_app_ (скоупы crm, user, placement);
//                   уходит в окружение сервера, по нему же определяется id приложения
//   SERVER_ID     — необязательно: id существующего сервера вместо поиска по имени
// Задать оба ключа скрытым вводом в текущей вкладке PowerShell: . .\deploy\set-keys.ps1
//
// Команды:
//   node deploy/deploy.mjs check    — что видит платформа по ключам (тип, скоупы, возможности)
//   node deploy/deploy.mjs deploy   — найти или создать сервер, выложить код, задать appUrl приложению
//   node deploy/deploy.mjs publish  — опубликовать приложение для сотрудников портала
//   node deploy/deploy.mjs status   — состояние сервера и последние строки журнала

import { request as httpsRequest } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'https://vibecode.bitrix24.tech/v1';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_NAME = 'b24-funnel-dashboard';
const APP_FILES = ['server.js', 'package.json', 'lib', 'public'];
const DISPLAY_NAME = 'Воронка продаж';
const DESCRIPTION = 'Дашборд по сделкам CRM: сводка по стадиям, открытые и выигранные сделки, средний чек, последние сделки, фильтр по периоду. Данные — с правами текущего сотрудника.';

const API_KEY = process.env.VIBE_API_KEY || '';
const APP_KEY = process.env.VIBE_APP_KEY || '';

function fail(msg) { console.error(`✖ ${msg}`); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// HTTPS без встроенных таймаутов fetch: выкладка держит соединение до конца
// всех шагов, а это может быть дольше пяти минут.
function call(method, path, { key = API_KEY, body, timeoutMs = 60_000 } = {}) {
  if (!key) fail('Не задан ключ в окружении (VIBE_API_KEY / VIBE_APP_KEY).');
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
  return new Promise((resolve, reject) => {
    const req = httpsRequest(`${BASE}${path}`, {
      method,
      headers: {
        'X-Api-Key': key,
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': payload.length } : {}),
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* не JSON */ }
        resolve({ status: res.statusCode, json, headers: res.headers });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`таймаут ${timeoutMs} мс`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function must(method, path, opts) {
  for (let attempt = 0; ; attempt++) {
    const r = await call(method, path, opts);
    if (r.status === 429 && attempt < 3) { await sleep((Number(r.headers['retry-after']) || 2 ** attempt) * 1000); continue; }
    if (r.status >= 200 && r.status < 300 && r.json?.success !== false) return r.json;
    const e = r.json?.error ?? {};
    fail(`${method} ${path} → ${r.status} ${e.code ?? ''} ${e.message ?? ''}${e.hint ? `\n  подсказка: ${JSON.stringify(e.hint)}` : ''}`);
  }
}

function describeMe(label, me) {
  const d = me?.data ?? {};
  console.log(`\n${label}`);
  console.log(`  тип ключа:  ${d.type ?? '?'}${d.readOnly || d.mode === 'READONLY' ? ' (только чтение)' : ''}`);
  console.log(`  портал:     ${d.portal ?? '?'}`);
  console.log(`  скоупы:     ${(d.scopes ?? []).join(', ') || '—'}`);
  if (d.app) console.log(`  приложение: ${d.app.title ?? ''} (${d.app.id ?? ''})`);
  const sc = d.capabilities?.servers?.create;
  if (sc) console.log(`  создание серверов: ${sc.available ? 'да' : 'нет'}${sc.reason ? ` (${sc.reason})` : ''}${sc.userMessage ? ` — ${sc.userMessage}` : ''}`);
  const reuse = d.deployment?.standalone?.reuseTarget;
  if (reuse) console.log(`  платформа предлагает сервер: ${reuse.serverId}`);
  const bp = d.placements?.bindPrerequisite;
  if (bp) console.log(`  условие встройки: ${JSON.stringify(bp)}`);
  if (d.infra?.limits) console.log(`  серверов: ${d.infra.limits.used}/${d.infra.limits.max}`);
}

async function check() {
  if (API_KEY) describeMe('Ключ инфраструктуры (VIBE_API_KEY)', await must('GET', '/me'));
  if (APP_KEY) describeMe('Ключ приложения (VIBE_APP_KEY)', await must('GET', '/me', { key: APP_KEY }));
  if (!API_KEY && !APP_KEY) fail('Нет ни VIBE_API_KEY, ни VIBE_APP_KEY в окружении.');
}

async function findOrCreateServer() {
  if (process.env.SERVER_ID) return (await must('GET', `/infra/servers/${encodeURIComponent(process.env.SERVER_ID)}`)).data;

  const list = (await must('GET', '/infra/servers')).data ?? [];
  const existing = (Array.isArray(list) ? list : list.items ?? []).find((s) => s.name === SERVER_NAME && s.status !== 'deleted');
  if (existing) { console.log(`Сервер найден: ${existing.id} (${existing.status})`); return existing; }

  const me = (await must('GET', '/me')).data ?? {};
  const reuse = me.deployment?.standalone?.reuseTarget?.serverId;
  if (reuse) { console.log(`Платформа предлагает существующий сервер ${reuse}`); return (await must('GET', `/infra/servers/${reuse}`)).data; }
  const cap = me.capabilities?.servers?.create;
  if (cap && !cap.available) fail(`Платформа не даёт создать сервер: ${cap.reason ?? ''} ${cap.userMessage ?? ''}`);

  const provider = 'bitrix-cloud';
  const plans = (await must('GET', `/infra/providers/${provider}/plans`)).data ?? [];
  const regions = (await must('GET', `/infra/providers/${provider}/regions`)).data ?? [];
  const images = (await must('GET', `/infra/providers/${provider}/images`)).data ?? [];
  const plan = plans.find((p) => p.id === 'bc-small') ?? plans[0];
  const region = regions.find((r) => r.id === 'ru-central1-b') ?? regions[0];
  const image = images.find((i) => /24\.04/.test(`${i.name ?? ''} ${i.id ?? ''}`)) ?? images[0];
  if (!plan || !region || !image) fail('Не удалось выбрать тариф, регион или образ сервера.');

  console.log(`Создаю сервер ${SERVER_NAME}: ${plan.id}, ${region.id}, образ ${image.id}`);
  const created = (await must('POST', '/infra/servers', {
    body: { provider, name: SERVER_NAME, plan: plan.id, region: region.id, image: image.id },
  })).data;
  return created;
}

async function waitReady(server) {
  if (server.kind === 'GALAXY_APP') return server;
  let s = server;
  for (let i = 0; i < 60 && !(s.status === 'running' && s.blackholeStatus === 'CONNECTED'); i++) {
    if (s.status === 'sleeping') break; // деплой разбудит сам
    if (s.status === 'error') fail(`Сервер в статусе error: ${s.id}`);
    console.log(`  жду готовности: status=${s.status}, туннель=${s.blackholeStatus}`);
    await sleep(10_000);
    s = (await must('GET', `/infra/servers/${s.id}`)).data;
  }
  return s;
}

function packSource() {
  const dir = mkdtempSync(join(tmpdir(), 'funnel-'));
  const archive = join(dir, 'app.tar.gz');
  try {
    // Только код приложения: без тестов, скриптов деплоя и служебных файлов.
    execFileSync('tar', ['-czf', archive.replace(/\\/g, '/'), '--force-local', '-C', ROOT.replace(/\\/g, '/'), ...APP_FILES], { stdio: 'pipe' });
  } catch {
    execFileSync('tar', ['-czf', archive, '-C', ROOT, ...APP_FILES], { stdio: 'pipe' });
  }
  const buf = readFileSync(archive);
  rmSync(dir, { recursive: true, force: true });
  return buf;
}

async function deploy() {
  const server = await waitReady(await findOrCreateServer());
  const archive = packSource();
  console.log(`Выкладываю ${Math.round(archive.length / 1024)} КБ на сервер ${server.id}…`);
  const r = await call('POST', `/infra/servers/${server.id}/deploy`, {
    timeoutMs: 15 * 60_000,
    body: {
      source: { content: archive.toString('base64') },
      runtime: 'node24',
      start: 'node server.js',
      port: 3000,
      // Ключ приложения уходит в окружение сервера (файл .env с правами 600),
      // в коде и в архиве его нет. Альтернатива — секрет в карточке приложения.
      env: { NODE_ENV: 'production', ...(APP_KEY ? { VIBE_APP_KEY: APP_KEY } : {}) },
      healthPath: '/health',
      displayName: DISPLAY_NAME,
      description: DESCRIPTION,
      changelog: process.env.CHANGELOG || 'Обновление дашборда',
      ...(process.env.BASE_VERSION ? { baseVersionId: process.env.BASE_VERSION } : {}),
    },
  });
  const d = r.json?.data ?? {};
  for (const s of d.steps ?? []) console.log(`  ${s.status === 'ok' ? '✓' : s.status === 'warning' ? '!' : '✖'} ${s.step ?? s.name}${s.status !== 'ok' && s.stdout ? ` — ${String(s.stdout).slice(-300)}` : ''}`);
  for (const w of d.warnings ?? r.json?.warnings ?? []) console.log(`  предупреждение: ${typeof w === 'string' ? w : (w.message ?? JSON.stringify(w))}`);
  if (r.status >= 300 || r.json?.success === false) {
    const e = r.json?.error ?? {};
    fail(`Деплой не прошёл: ${r.status} ${e.code ?? ''} ${e.message ?? ''}${e.step ? ` (шаг ${e.step})` : ''}`);
  }
  if (d.source) console.log(`Исходники: ${d.source.autoSaved ? `сохранена версия ${d.source.savedVersionId}` : `не сохранены (${d.source.skippedReason ?? '—'})`}`);
  const appUrl = d.appUrl ?? server.appUrl;
  console.log(`\nГотово. Адрес приложения: ${appUrl ?? '(см. кабинет)'}\nСервер: ${server.id}`);

  // Привязать OAuth-приложение к адресу сервера — тогда пункт меню
  // в Битрикс24 открывает именно этот дашборд.
  if (APP_KEY && appUrl) {
    const appId = await appIdFromKey();
    await must('PATCH', `/apps/${encodeURIComponent(appId)}`, { body: { appUrl } });
    console.log(`Адрес задан OAuth-приложению ${appId}.`);
  }
}

async function appIdFromKey() {
  if (process.env.APP_ID) return process.env.APP_ID;
  const me = (await must('GET', '/me', { key: APP_KEY })).data ?? {};
  if (!me.app?.id) fail('По ключу приложения не удалось узнать id приложения (data.app.id).');
  return me.app.id;
}

async function publish() {
  const appId = await appIdFromKey();
  const placements = (process.env.PLACEMENTS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const r = await must('POST', `/apps/${encodeURIComponent(appId)}/publish`, {
    body: { catalogTitle: DISPLAY_NAME, catalogDescription: DESCRIPTION, ...(placements.length ? { placements } : {}) },
  });
  console.log(`Опубликовано: ${r.data?.catalogStatus ?? '?'}; места: ${(r.data?.placements ?? []).join(', ') || 'пункт левого меню по умолчанию'}`);
}

async function status() {
  const list = (await must('GET', '/infra/servers')).data ?? [];
  const s = (Array.isArray(list) ? list : list.items ?? []).find((x) => x.name === SERVER_NAME);
  if (!s) fail(`Сервер ${SERVER_NAME} не найден.`);
  console.log(`Сервер ${s.id}: status=${s.status}, туннель=${s.blackholeStatus}, адрес=${s.appUrl ?? s.subdomain ?? '?'}`);
  const logs = await call('GET', `/infra/servers/${s.id}/logs?lines=30`);
  const lines = logs.json?.data?.lines ?? logs.json?.data?.logs ?? logs.json?.data;
  console.log(Array.isArray(lines) ? lines.join('\n') : String(lines ?? '').slice(-4000));
}

const cmd = process.argv[2];
const commands = { check, deploy, publish, status };
if (!commands[cmd]) fail(`Команда: ${Object.keys(commands).join(' | ')}`);
await commands[cmd]();
