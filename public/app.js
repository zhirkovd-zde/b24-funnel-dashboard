// Фронтенд дашборда. Ходит только к своему серверу (/api/*); токенов и
// ключей здесь нет и быть не должно. Весь текст из данных выводится через
// textContent — никакой вставки HTML.

const $ = (id) => document.getElementById(id);
const STORE_KEY = 'funnel-dashboard:v1';

const state = {
  currency: 'RUB',
  portal: null,
  bar: 'count',
  data: null,
  seq: 0,
  ctrl: null,
};

// ---------- даты ----------
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function presetRange(preset, today = new Date()) {
  const y = today.getFullYear();
  const m = today.getMonth();
  switch (preset) {
    case 'month': return { from: iso(new Date(y, m, 1)), to: iso(today) };
    case 'prev-month': return { from: iso(new Date(y, m - 1, 1)), to: iso(new Date(y, m, 0)) };
    case '30d': return { from: iso(new Date(y, m, today.getDate() - 29)), to: iso(today) };
    case 'quarter': return { from: iso(new Date(y, Math.floor(m / 3) * 3, 1)), to: iso(today) };
    case 'year': return { from: iso(new Date(y, 0, 1)), to: iso(today) };
    case 'all': return { from: '', to: '' };
    default: return null;
  }
}

// ---------- форматирование ----------
function money(v, currency = state.currency) {
  if (v == null) return '—';
  try {
    return new Intl.NumberFormat('ru-RU', { style: 'currency', currency, maximumFractionDigits: 0 }).format(v);
  } catch {
    return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(v)} ${currency}`;
  }
}
const int = (v) => (v == null ? '—' : new Intl.NumberFormat('ru-RU').format(v));
function plural(n, one, few, many) {
  const a = Math.abs(n) % 100; const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}
const deals = (n) => `${int(n)} ${plural(n, 'сделка', 'сделки', 'сделок')}`;
function dateRu(s) {
  if (!s) return '—';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
function periodText(p) {
  if (!p?.from && !p?.to) return 'за всё время';
  const f = (s) => s.split('-').reverse().join('.');
  if (p.from && p.to) return `с ${f(p.from)} по ${f(p.to)}`;
  return p.from ? `с ${f(p.from)}` : `по ${f(p.to)}`;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// ---------- хранение выбора (только удобство, без данных) ----------
function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; }
}
function savePrefs() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      categoryId: $('category').value, preset: $('preset').value, from: $('from').value, to: $('to').value,
      mine: $('mine').checked, limit: $('limit').value, bar: state.bar,
    }));
  } catch { /* приватный режим — не страшно */ }
}

// ---------- сеть ----------
async function api(path, signal) {
  let res;
  try {
    res = await fetch(path, { headers: { Accept: 'application/json' }, signal });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw Object.assign(new Error('Нет связи с сервером приложения. Проверьте интернет и повторите.'), { code: 'NETWORK' });
  }
  let body = null;
  try { body = await res.json(); } catch { /* не JSON */ }
  if (!res.ok) {
    const msg = body?.error?.message || `Сервер ответил ошибкой ${res.status}`;
    throw Object.assign(new Error(msg), { code: body?.error?.code, status: res.status, requestId: body?.error?.requestId });
  }
  return body;
}

// ---------- отрисовка ----------
function showNotice(kind, text, onRetry = null) {
  const n = $('notice');
  n.replaceChildren();
  n.hidden = !text;
  if (!text) return;
  n.className = `notice notice--${kind}`;
  n.append(el('span', null, text));
  if (onRetry) {
    const b = el('button', 'btn btn--small', 'Повторить');
    b.type = 'button';
    b.addEventListener('click', onRetry, { once: true });
    n.append(b);
  }
}

function setLoading(on) {
  document.body.classList.toggle('is-loading', on);
  $('refresh').disabled = on;
}

function renderKpis(d) {
  const k = d.kpi;
  $('kpi-open-sum').textContent = money(k.openSum);
  $('kpi-open-count').textContent = `${deals(k.openCount)} в работе`;
  $('kpi-won-count').textContent = int(k.wonCount);
  $('kpi-won-sum').textContent = k.wonSum == null ? 'сумма недоступна' : `на ${money(k.wonSum)}`;
  $('kpi-avg').textContent = k.avgCheck == null ? '—' : money(k.avgCheck);
  $('kpi-conv').textContent = k.conversion == null ? '—' : `${k.conversion.toLocaleString('ru-RU')} %`;
  $('kpi-total').textContent = `закрыто ${int(k.wonCount + k.lostCount)} из ${deals(k.totalCount)} ${periodText(d.period)}`;
}

// После ошибки не оставляем на экране цифры от прежних фильтров.
function clearView() {
  state.data = null;
  for (const id of ['kpi-open-sum', 'kpi-won-count', 'kpi-avg', 'kpi-conv']) $(id).textContent = '—';
  for (const id of ['kpi-open-count', 'kpi-won-sum', 'kpi-total']) $(id).textContent = '';
  $('funnel').replaceChildren(el('p', 'empty', 'Нет данных.'));
  const tr = el('tr');
  const td = el('td', 'empty', 'Нет данных.');
  td.colSpan = 5;
  tr.append(td);
  $('recent').replaceChildren(tr);
  $('foot').textContent = '';
}

const canRetry = (e) => e.code !== 'NO_SESSION' && e.status !== 401;

function stageRow(s, max) {
  const row = el('div', `stage stage--${s.kind}`);
  const name = el('div', 'stage__name');
  const dot = el('span', 'dot');
  if (s.color) dot.style.background = s.color;
  name.append(dot, el('span', null, s.name));
  const track = el('div', 'stage__track');
  const bar = el('div', 'stage__bar');
  const v = state.bar === 'sum' ? (s.sum ?? 0) : s.count;
  bar.style.width = `${max > 0 ? Math.max(v > 0 ? 2 : 0, (v / max) * 100) : 0}%`;
  if (s.color) bar.style.background = s.color;
  track.append(bar);
  row.append(name, track, el('div', 'stage__count num', int(s.count)), el('div', 'stage__sum num', money(s.sum)));
  row.title = `${s.name}: ${deals(s.count)}, ${money(s.sum)}`;
  return row;
}

function renderFunnel(d) {
  const box = $('funnel');
  box.replaceChildren();
  if (!d.stages.length) {
    box.append(el('p', 'empty', 'В этой воронке нет стадий или нет доступа к их списку.'));
    return;
  }
  const max = Math.max(0, ...d.stages.map((s) => (state.bar === 'sum' ? (s.sum ?? 0) : s.count)));
  const head = el('div', 'stage stage--head');
  head.append(el('div', null, 'Стадия'), el('div'), el('div', 'num', 'Сделок'), el('div', 'num', 'Сумма'));
  box.append(head);
  const groups = [
    [null, d.stages.filter((s) => s.kind === 'open')],
    ['Завершённые', d.stages.filter((s) => s.kind === 'won' || s.kind === 'lost')],
    ['Вне справочника стадий', d.stages.filter((s) => s.kind === 'unknown')],
  ];
  for (const [title, list] of groups) {
    if (!list.length) continue;
    if (title) box.append(el('div', 'stage__sep', title));
    list.forEach((s) => box.append(stageRow(s, max)));
  }
  if (d.kpi.totalCount === 0) box.append(el('p', 'empty', `Сделок ${periodText(d.period)} нет — попробуйте другой период или воронку.`));
}

function renderRecent(d) {
  const body = $('recent');
  body.replaceChildren();
  if (!d.recent.length) {
    const tr = el('tr');
    const td = el('td', 'empty', 'Сделок за выбранный период нет.');
    td.colSpan = 5;
    tr.append(td);
    body.append(tr);
    return;
  }
  for (const r of d.recent) {
    const tr = el('tr');
    const tdTitle = el('td', 'cell-title');
    if (state.portal && Number.isInteger(r.id)) {
      const a = el('a', null, r.title);
      a.href = `https://${state.portal}/crm/deal/details/${r.id}/`;
      a.target = '_top';
      a.rel = 'noopener';
      tdTitle.append(a);
    } else {
      tdTitle.textContent = r.title;
    }
    const stage = el('span', `chip chip--${r.stageKind}`, r.stageName);
    if (r.stageColor) stage.style.setProperty('--chip', r.stageColor);
    const tdStage = el('td');
    tdStage.append(stage);
    tr.append(tdTitle, el('td', 'num', money(r.amount, r.currency || state.currency)), tdStage, el('td', null, r.assignedName), el('td', 'nowrap', dateRu(r.createdAt)));
    body.append(tr);
  }
}

function render(d) {
  state.data = d;
  state.currency = d.currency || state.currency;
  if (d.portal) state.portal = d.portal;
  renderKpis(d);
  renderFunnel(d);
  renderRecent(d);
  const warn = (d.warnings || []).map((w) => w.message).join(' ');
  showNotice('warn', warn);
  $('foot').textContent = `Данные Битрикс24 на ${new Date(d.generatedAt).toLocaleString('ru-RU')}. Итоги складываются без пересчёта курсов валют.`;
}

// ---------- фильтры ----------
function currentQuery() {
  const preset = $('preset').value;
  let range = presetRange(preset);
  if (!range) range = { from: $('from').value, to: $('to').value };
  if (range.from && range.to && range.from > range.to) return { error: 'Дата «с» позже даты «по».' };
  const p = new URLSearchParams({
    categoryId: $('category').value || '0',
    mine: $('mine').checked ? '1' : '0',
    limit: $('limit').value,
  });
  if (range.from) p.set('from', range.from);
  if (range.to) p.set('to', range.to);
  return { params: p };
}

async function load() {
  const q = currentQuery();
  const fe = $('filter-error');
  fe.hidden = !q.error;
  fe.textContent = q.error || '';
  if (q.error) return;
  savePrefs();

  state.ctrl?.abort();
  const ctrl = new AbortController();
  state.ctrl = ctrl;
  const seq = ++state.seq;
  setLoading(true);
  try {
    const d = await api(`/api/dashboard?${q.params}`, ctrl.signal);
    if (seq !== state.seq) return;
    render(d);
  } catch (e) {
    if (e.name === 'AbortError' || seq !== state.seq) return;
    clearView();
    showNotice('error', e.message, canRetry(e) ? load : null);
  } finally {
    if (seq === state.seq) setLoading(false);
  }
}

function applyPrefs(prefs, categories) {
  const cat = $('category');
  cat.replaceChildren(...categories.map((c) => { const o = el('option', null, c.name); o.value = String(c.id); return o; }));
  if (prefs.categoryId != null && categories.some((c) => String(c.id) === String(prefs.categoryId))) cat.value = String(prefs.categoryId);
  cat.disabled = categories.length < 2;
  if (prefs.preset && [...$('preset').options].some((o) => o.value === prefs.preset)) $('preset').value = prefs.preset;
  if (prefs.from) $('from').value = prefs.from;
  if (prefs.to) $('to').value = prefs.to;
  $('mine').checked = Boolean(prefs.mine);
  if (prefs.limit === '10' || prefs.limit === '20') $('limit').value = prefs.limit;
  if (prefs.bar === 'sum' || prefs.bar === 'count') setBar(prefs.bar, false);
  $('custom-dates').hidden = $('preset').value !== 'custom';
}

function setBar(kind, rerender = true) {
  state.bar = kind;
  document.querySelectorAll('.seg__btn').forEach((b) => b.classList.toggle('is-active', b.dataset.bar === kind));
  if (rerender && state.data) { renderFunnel(state.data); savePrefs(); }
}

// Высота iframe внутри Битрикс24 — сообщаем родительскому окну.
function autoHeight() {
  if (window.parent === window || typeof ResizeObserver === 'undefined') return;
  let last = 0;
  new ResizeObserver(() => {
    const h = Math.ceil(document.documentElement.scrollHeight);
    if (h !== last) { last = h; window.parent.postMessage({ type: 'vibe:resize', height: h }, '*'); }
  }).observe(document.body);
}

async function init() {
  autoHeight();
  $('preset').addEventListener('change', () => {
    const custom = $('preset').value === 'custom';
    $('custom-dates').hidden = !custom;
    if (custom) {
      if (!$('from').value || !$('to').value) {
        const r = presetRange('month');
        $('from').value ||= r.from;
        $('to').value ||= r.to;
      }
      return;
    }
    load();
  });
  $('filters').addEventListener('submit', (e) => { e.preventDefault(); load(); });
  ['category', 'mine', 'limit'].forEach((id) => $(id).addEventListener('change', load));
  $('refresh').addEventListener('click', load);
  document.querySelectorAll('.seg__btn').forEach((b) => b.addEventListener('click', () => setBar(b.dataset.bar)));

  setLoading(true);
  try {
    const boot = await api('/api/bootstrap');
    state.currency = boot.currency || 'RUB';
    state.portal = boot.portal;
    $('who').textContent = boot.user?.name ? `${boot.user.name} · данные с учётом ваших прав в CRM` : 'Данные с учётом ваших прав в CRM';
    applyPrefs(loadPrefs(), boot.categories || []);
  } catch (e) {
    setLoading(false);
    $('who').textContent = '';
    clearView();
    showNotice('error', e.message, canRetry(e) ? () => location.reload() : null);
    return;
  }
  await load();
}

if (typeof document !== 'undefined') init();
