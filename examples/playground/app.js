// BorealJS Grid playground: bring a CSV or generate data, lay out rows / columns / measures, simulate
// server latency and watch performance. The grid only ever sees a data source; a Web Worker plays the
// server (server-worker.js) and this page adds network latency, jitter and failures around each call.

import { createGrid, createRowSource, createArraySource, createHttpSource, EMPTY_QUERY } from '../../packages/grid-core/dist/index.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const SIGMA = -1;
const nf = new Intl.NumberFormat('en-US');
const fmtInt = (n) => nf.format(Math.round(n));
const fmtMs = (ms) => (ms == null || !Number.isFinite(ms) ? '–' : ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : ms >= 100 ? `${Math.round(ms)} ms` : `${ms.toFixed(1)} ms`);
const fmtBytes = (b) => (b >= 1 << 30 ? `${(b / (1 << 30)).toFixed(2)} GB` : b >= 1 << 20 ? `${(b / (1 << 20)).toFixed(1)} MB` : b >= 1024 ? `${(b / 1024).toFixed(1)} KB` : `${Math.round(b)} B`);
const parseCount = (s) => Number(String(s).replace(/[,_\s]/g, '').replace(/k$/i, '000').replace(/m$/i, '000000'));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ================================================================== state

const DEFAULTS = {
  source: { rows: 200000, dims: 12, measures: 6, years: 5, seed: 42 },
  virtual: { rows: 1_000_000_000, cols: 1_000_000, years: 10 },
  theme: 'auto',
  mode: 'pivot',
  pivot: null, // filled from the dataset (field indexes; SIGMA marks the Σ Values level)
  table: { hidden: [], pinned: 1 },
  server: { latency: 40, jitter: 10, failRate: 0, pageSize: 100, maxCells: 20000 },
  grid: {
    rowHeight: 28, headerHeight: 34, columnWidth: 120, selection: 'multi',
    sortable: true, multiSort: true, filterable: true, resizable: true, reorderable: true, expandable: true,
    copy: true, keyboard: true, notices: true, rowSelection: false, rowNumbers: true, zebra: true,
  },
  format: { style: 'number', decimals: 'auto', conditional: 'none' },
  perfOpen: true,
};
const STORE_KEY = 'borealjs-playground-v1';

function loadState() {
  let saved = null;
  try {
    if (location.hash.length > 1) saved = JSON.parse(decodeURIComponent(escape(atob(location.hash.slice(1)))));
  } catch { /* bad link: ignore */ }
  if (!saved) {
    try { saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null'); } catch { /* storage blocked */ }
  }
  const s = structuredClone(DEFAULTS);
  if (saved && typeof saved === 'object') {
    for (const k of ['source', 'virtual', 'server', 'grid', 'format', 'table']) Object.assign(s[k], saved[k] ?? {});
    for (const k of ['theme', 'mode', 'pivot', 'perfOpen']) if (saved[k] !== undefined) s[k] = saved[k];
  }
  return s;
}
const state = loadState();
let saveTimer = 0;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* storage blocked */ }
  }, 250);
}

let dataset = null; // { rows, fields: [{ index, key, name, kind, cardinality }], bytes, source, buildMs }
let grid = null;
let gridSerial = 0;
let lastPivotInfo = null;
let lastTable = null;
let gridCreatedAt = 0;
let firstDataMs = null;
const samples = {}; // last request / response per call kind, for the "server contract" code view

// ================================================================== worker "server" + simulated network

const worker = new Worker(new URL('./server-worker.js', import.meta.url));
let rpcSeq = 0;
const pending = new Map();
worker.onmessage = (e) => {
  const msg = e.data;
  const p = pending.get(msg.id);
  if (!p) return;
  if (msg.progress) { p.onProgress?.(msg.progress); return; }
  pending.delete(msg.id);
  if (msg.ok) p.resolve(msg);
  else p.reject(Object.assign(new Error(msg.error), { serverMs: msg.serverMs }));
};
worker.onerror = (e) => toast(`Worker error: ${e.message}`);

function workerCall(op, args, { signal, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const id = ++rpcSeq;
    pending.set(id, { resolve, reject, onProgress });
    worker.postMessage({ id, op, args });
    signal?.addEventListener('abort', () => {
      // The server keeps computing (like a real one would); the client just stops waiting.
      if (pending.has(id)) {
        pending.set(id, { resolve() {}, reject() {} });
        worker.postMessage({ op: 'abort', args: { id } }); // lets a long scan on the server stop early
        reject(abortError());
      }
    }, { once: true });
  });
}
const abortError = () => new DOMException('The request was cancelled', 'AbortError');
function sleep(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(abortError()); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const metrics = newMetrics();
function newMetrics() {
  return { requests: 0, ok: 0, aborted: 0, failed: 0, inflight: 0, bytes: 0, cells: 0, rtt: [], srv: [], log: [], longFrames: 0, maxRender: 0, byKind: {} };
}
let logSeq = 0;

/** One data-source call: latency there, the worker's compute, latency back. Recorded for the panel. */
async function net(op, args, { signal, onProgress, kind, detail = '', cells = 0 } = {}) {
  const { latency, jitter, failRate } = state.server;
  const lat = Math.max(0, latency + (jitter ? (Math.random() * 2 - 1) * jitter : 0));
  const entry = { id: ++logSeq, kind, detail, t0: performance.now(), status: 'pending', latency: lat, serverMs: 0, total: 0, bytes: 0, serial: gridSerial };
  metrics.requests++;
  metrics.inflight++;
  metrics.log.push(entry);
  if (metrics.log.length > 400) metrics.log.splice(0, metrics.log.length - 400);
  const k = (metrics.byKind[kind] ??= { n: 0 });
  k.n++;
  schedulePerf();
  try {
    await sleep(lat / 2, signal);
    if (failRate > 0 && Math.random() * 100 < failRate && kind !== 'drill') {
      await sleep(lat / 2, signal);
      throw new Error(`Simulated server error (503) on ${kind}`);
    }
    const res = await workerCall(op, args, { signal, onProgress });
    entry.serverMs = res.serverMs;
    entry.bytes = res.bytes;
    await sleep(lat / 2, signal);
    entry.status = 'ok';
    metrics.ok++;
    metrics.bytes += res.bytes;
    metrics.cells += cells;
    metrics.srv.push(res.serverMs);
    if (metrics.srv.length > 1000) metrics.srv.shift();
    samples[kind] = { args, result: res.result };
    return res.result;
  } catch (err) {
    if (err?.name === 'AbortError') { entry.status = 'aborted'; metrics.aborted++; }
    else { entry.status = 'failed'; entry.error = err.message; metrics.failed++; if (err.serverMs) entry.serverMs = err.serverMs; }
    throw err;
  } finally {
    entry.total = performance.now() - entry.t0;
    if (entry.status === 'ok') { metrics.rtt.push(entry.total); if (metrics.rtt.length > 1000) metrics.rtt.shift(); }
    metrics.inflight--;
    schedulePerf();
  }
}

/** Builds that load the dataset into the server: no latency, progress in the sidebar. */
async function build(op, args) {
  showProgress('Starting…', 0);
  $$('#genForm button, #virtualForm button, #sampleCsv').forEach((b) => { b.disabled = true; });
  try {
    const res = await workerCall(op, args, { onProgress: (p) => showProgress(p.phase, p.total ? p.done / p.total : null) });
    return res.result;
  } finally {
    hideProgress();
    $$('#genForm button, #virtualForm button, #sampleCsv').forEach((b) => { b.disabled = false; });
  }
}

function showProgress(phase, frac) {
  $('#progress').hidden = false;
  $('#progressPhase').textContent = phase;
  $('#progressPct').textContent = frac == null ? '' : `${Math.round(frac * 100)}%`;
  $('#progressBar').style.width = `${frac == null ? 30 : Math.round(frac * 100)}%`;
}
function hideProgress() { $('#progress').hidden = true; }

// ================================================================== dataset loading

async function generateData() {
  const s = state.source;
  s.rows = clamp(Math.round(s.rows) || 1000, 1, 10_000_000);
  if (s.rows * (s.dims + s.measures + 1) > 120_000_000) {
    toast('That is a lot of cells for a browser tab: try fewer rows or columns (rows × columns ≤ 120M).');
    return;
  }
  const t0 = performance.now();
  const info = await build('generate', { rows: s.rows, dims: s.dims, measures: s.measures, years: s.years, seed: s.seed });
  onDataset(info, performance.now() - t0, { keepLayout: true });
}

async function loadCsvText(text, name) {
  const t0 = performance.now();
  try {
    const info = await build('parseCsv', { text, name, header: $('#csvHeader').checked, delimiter: $('#csvDelimiter').value });
    onDataset(info, performance.now() - t0, { keepLayout: false });
    toast(`Loaded ${name}: ${fmtInt(info.rows)} rows, ${info.fields.length} columns`);
  } catch (err) {
    toast(`Could not read ${name}: ${err.message}`);
  }
}

async function loadCsvFile(file) {
  if (!file) return;
  if (file.size > 400 * 1024 * 1024) { toast('Files up to 400 MB work best in a browser tab.'); return; }
  showProgress(`Reading ${file.name}…`, null);
  const text = await file.text();
  await loadCsvText(text, file.name);
}

function sampleCsv() {
  // A small CSV made in the page, to show the CSV path without a file at hand.
  const rnd = mulberry32(7);
  const teams = ['Platform', 'Payments', 'Growth', 'Search', 'Mobile', 'Data', 'Infra', 'Security'];
  const envs = ['prod', 'staging', 'dev'];
  const regions = ['us-east', 'us-west', 'eu-central', 'ap-south', 'sa-east'];
  const services = Array.from({ length: 40 }, (_, i) => `svc-${['auth', 'cart', 'feed', 'img', 'mail', 'pay', 'rank', 'user'][i % 8]}-${Math.floor(i / 8) + 1}`);
  const lines = ['date,team,service,environment,region,"status code",requests,"p95 latency ms",errors,"cost usd"'];
  for (let i = 0; i < 25000; i++) {
    const d = new Date(Date.UTC(2026, 0, 1) + Math.floor(rnd() * 300) * 864e5).toISOString().slice(0, 10);
    const svc = Math.floor(rnd() * services.length);
    const req = Math.round(200 + rnd() * 20000);
    const code = rnd() < 0.92 ? 200 : rnd() < 0.6 ? 404 : 500;
    lines.push([d, teams[svc % 8], services[svc], envs[Math.floor(rnd() ** 2 * 3)], regions[Math.floor(rnd() * 5)], code, req, (40 + rnd() * 400).toFixed(1), code === 500 ? Math.round(req * rnd() * 0.05) : 0, (req * 0.00042 * (1 + rnd())).toFixed(2)].join(','));
  }
  return lines.join('\n');
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function onDataset(info, wallMs, { keepLayout }) {
  const prevSig = dataset ? dataset.fields.map((f) => f.name + f.kind).join('|') : null;
  dataset = info;
  dataset.wallMs = wallMs;
  const sig = info.fields.map((f) => f.name + f.kind).join('|');
  if (!keepLayout || !state.pivot || (prevSig && prevSig !== sig) || !validPivot(state.pivot)) state.pivot = defaultPivot();
  state.table.hidden = state.table.hidden.filter((k) => info.fields.some((f) => f.key === k));
  state.source.type = info.source.type;
  renderDatasetBadge();
  applySourceUi();
  renderFieldList();
  renderZones();
  renderColumnList();
  renderPresets();
  $('#emptyState').hidden = true;
  saveState();
  rebuildGrid();
}

async function loadVirtual() {
  const v = state.virtual;
  v.rows = clamp(Math.round(v.rows) || 1, 1, 1e14);
  v.cols = clamp(Math.round(v.cols) || 1, 1, 1e12);
  v.years = clamp(Math.round(v.years) || 1, 1, 20000);
  try {
    const res = await build('loadVirtual', {});
    dataset = { virtual: true, rows: v.rows, cols: v.cols, years: v.years, fields: [], bytes: 0, source: { type: 'virtual' }, buildMs: res.ms };
  } catch (err) {
    toast(err.message);
    return;
  }
  state.source.type = 'virtual';
  renderDatasetBadge();
  applySourceUi();
  $('#emptyState').hidden = true;
  saveState();
  rebuildGrid();
}

/** Virtual data has no fields to arrange: its layout is fixed, so the field UI gives way to a note. */
function applySourceUi() {
  const virtual = !!dataset?.virtual;
  $('#pivotFieldsUi').hidden = virtual;
  $('#tableFieldsUi').hidden = virtual;
  const note = $('#virtualNote');
  note.hidden = !virtual;
  if (virtual) {
    note.innerHTML = state.mode === 'pivot'
      ? `Virtual pivot: rows <b>Region › Country › City › Product</b> (${fmtInt(dataset.rows)} products), columns <b>Measure › Year › Quarter › Month</b> (68 per year, plus totals). Sort, filter, expand and collapse all work; to arrange your own fields, load real data with Generate or Upload CSV.`
      : `Virtual table: <b>${fmtInt(dataset.rows)}</b> rows × <b>${fmtInt(dataset.cols)}</b> columns. Show or hide column types from the # corner menu. Sort and filter run on the server; multi-column sorts and filters past its limits are refused with a message.`;
  }
}

function renderDatasetBadge() {
  const d = dataset;
  if (d.virtual) {
    $('#datasetBadge').innerHTML = state.mode === 'pivot'
      ? `Virtual · <b>${fmtInt(d.rows)}</b> products × <b>${fmtInt(d.years)}</b> years of columns · computed per cell, 0 B stored`
      : `Virtual · <b>${fmtInt(d.rows)}</b> rows × <b>${fmtInt(d.cols)}</b> columns · computed per cell, 0 B stored`;
    return;
  }
  const dims = d.fields.filter((f) => f.kind === 'dim').length;
  const src = d.source.type === 'csv' ? `CSV <b>${escapeHtml(d.source.name)}</b>` : 'Generated';
  $('#datasetBadge').innerHTML = `${src} · <b>${fmtInt(d.rows)}</b> rows × <b>${d.fields.length}</b> columns (${dims} text, ${d.fields.length - dims} numeric) · ${fmtBytes(d.bytes)} in the server · built in ${fmtMs(d.buildMs)}`;
}

// ================================================================== pivot layout config

const fieldByName = (name) => dataset?.fields.find((f) => f.name === name)?.index;
const isNumField = (i) => dataset.fields[i]?.kind === 'num';

function validPivot(p) {
  const n = dataset.fields.length;
  const ok = (i) => i === SIGMA || (Number.isInteger(i) && i >= 0 && i < n);
  return p && Array.isArray(p.rows) && Array.isArray(p.cols) && Array.isArray(p.values) && p.rows.every(ok) && p.cols.every(ok) && p.values.every((v) => v.field === -1 || ok(v.field));
}

function defaultPivot() {
  if (dataset.source.type === 'generated') {
    const f = fieldByName;
    const rows = [f('Region'), f('Country')].filter((x) => x !== undefined);
    const cols = [SIGMA, f('Year'), f('Quarter')].filter((x) => x !== undefined);
    const values = ['Sales', 'Profit', 'Units'].map((n) => f(n)).filter((x) => x !== undefined).map((field) => ({ field, agg: 'sum' }));
    return { rows, cols: values.length ? cols : cols.filter((c) => c !== SIGMA), values, subtotals: true, grandTotals: true };
  }
  // CSV: the lowest-cardinality text columns as rows / columns, the first numeric columns as values.
  const dims = dataset.fields.filter((f) => f.kind === 'dim').sort((a, b) => a.cardinality - b.cardinality);
  const nums = dataset.fields.filter((f) => f.kind === 'num' && !/(^|\b)(id|code|zip|year)\b/i.test(f.name));
  const rowsDim = dims.find((f) => f.cardinality > 3 && f.cardinality <= 500) ?? dims[0];
  const colDim = dims.find((f) => f !== rowsDim && f.cardinality <= 12);
  // Rates, prices, scores and latencies read better as averages than sums.
  const avgLike = /(latency|rate|ratio|pct|percent|%|price|score|rating|avg|mean|\bms\b|age|temp)/i;
  const values = nums.slice(0, 3).map((f) => ({ field: f.index, agg: avgLike.test(f.name) ? 'avg' : 'sum' }));
  const rows = rowsDim ? [rowsDim.index] : [];
  const cols = values.length ? [SIGMA, ...(colDim ? [colDim.index] : [])] : colDim ? [colDim.index] : [];
  return { rows, cols, values, subtotals: true, grandTotals: true };
}

/** Keeps Σ Values in exactly one axis while there are measures, and nowhere when there are none. */
function normalizePivot() {
  const p = state.pivot;
  const inRows = p.rows.includes(SIGMA), inCols = p.cols.includes(SIGMA);
  if (!p.values.length) { p.rows = p.rows.filter((d) => d !== SIGMA); p.cols = p.cols.filter((d) => d !== SIGMA); return; }
  if (!inRows && !inCols) p.cols.unshift(SIGMA);
  if (inRows && inCols) p.rows = p.rows.filter((d) => d !== SIGMA);
}

function pivotChanged() {
  normalizePivot();
  renderZones();
  renderFieldList();
  saveState();
  rebuildGrid();
}

function measureName(v) {
  if (v.field < 0) return 'Count of rows';
  const agg = { sum: 'Sum', avg: 'Average', min: 'Min', max: 'Max', count: 'Count' }[v.agg];
  return `${agg} of ${dataset.fields[v.field].name}`;
}

function addToZone(zone, field, at) {
  const p = state.pivot;
  if (zone === 'values') {
    const agg = isNumField(field) ? 'sum' : 'count';
    p.values.splice(at ?? p.values.length, 0, { field, agg });
  } else {
    // A field sits in one axis at a time.
    p.rows = p.rows.filter((d) => d !== field);
    p.cols = p.cols.filter((d) => d !== field);
    const list = p[zone];
    list.splice(clamp(at ?? list.length, 0, list.length), 0, field);
  }
  pivotChanged();
}

function renderFieldList() {
  if (!dataset) return;
  const q = $('#fieldSearch').value.trim().toLowerCase();
  const p = state.pivot;
  const used = new Set([...p.rows, ...p.cols, ...p.values.map((v) => v.field)]);
  const ul = $('#fieldList');
  ul.replaceChildren();
  for (const f of dataset.fields) {
    if (q && !f.name.toLowerCase().includes(q)) continue;
    const li = document.createElement('li');
    li.draggable = true;
    li.className = used.has(f.index) ? 'used' : '';
    li.dataset.field = f.index;
    li.innerHTML = `<span class="ftype ${f.kind}" title="${f.kind === 'num' ? 'Number' : 'Text'}">${f.kind === 'num' ? '#' : 'A'}</span>
      <span class="fname" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
      ${f.cardinality ? `<span class="fcard" title="Distinct values">${fmtInt(f.cardinality)}</span>` : ''}
      <span class="fadd">
        <button type="button" data-add="rows" title="Add to Rows" aria-label="Add ${escapeHtml(f.name)} to rows">R</button>
        <button type="button" data-add="cols" title="Add to Columns" aria-label="Add ${escapeHtml(f.name)} to columns">C</button>
        <button type="button" data-add="values" title="Add to Values" aria-label="Add ${escapeHtml(f.name)} to values">V</button>
      </span>`;
    li.addEventListener('dragstart', (e) => startDrag(e, { from: 'list', field: f.index }));
    ul.append(li);
  }
}

function renderZones() {
  if (!dataset) return;
  const p = state.pivot;
  for (const zone of ['rows', 'cols', 'values']) {
    const ul = $(`.zone[data-zone="${zone}"] .zone-list`);
    ul.replaceChildren();
    const items = zone === 'values' ? p.values : p[zone];
    items.forEach((item, i) => {
      const li = document.createElement('li');
      li.className = 'chip';
      li.draggable = true;
      if (zone === 'values') {
        const f = item.field >= 0 ? dataset.fields[item.field] : null;
        const aggs = f?.kind === 'num' ? ['sum', 'avg', 'min', 'max', 'count'] : ['count'];
        li.innerHTML = `<span class="cname" title="${escapeHtml(measureName(item))}">${escapeHtml(f ? f.name : 'Rows')}</span>
          <select aria-label="Aggregation for ${escapeHtml(f ? f.name : 'rows')}">${aggs.map((a) => `<option value="${a}"${a === item.agg ? ' selected' : ''}>${{ sum: 'Sum', avg: 'Avg', min: 'Min', max: 'Max', count: 'Count' }[a]}</option>`).join('')}</select>
          <button type="button" data-act="remove" aria-label="Remove">✕</button>`;
        $('select', li).addEventListener('change', (e) => { item.agg = e.target.value; pivotChanged(); });
      } else if (item === SIGMA) {
        li.classList.add('sigma');
        li.title = 'The measures, as a level. Move it to change where measures appear.';
        li.innerHTML = `<span class="cname">Σ Values</span>
          <button type="button" data-act="up" aria-label="Move up">↑</button><button type="button" data-act="down" aria-label="Move down">↓</button>
          <button type="button" data-act="other" aria-label="Move to the other axis" title="Move to ${zone === 'rows' ? 'Columns' : 'Rows'}">⇄</button>`;
      } else {
        const f = dataset.fields[item];
        li.innerHTML = `<span class="cname" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
          <button type="button" data-act="up" aria-label="Move up">↑</button><button type="button" data-act="down" aria-label="Move down">↓</button>
          <button type="button" data-act="other" aria-label="Move to the other axis" title="Move to ${zone === 'rows' ? 'Columns' : 'Rows'}">⇄</button>
          <button type="button" data-act="remove" aria-label="Remove">✕</button>`;
      }
      li.addEventListener('click', (e) => {
        const act = e.target.closest('button')?.dataset.act;
        if (!act) return;
        const list = zone === 'values' ? p.values : p[zone];
        if (act === 'remove') list.splice(i, 1);
        if (act === 'up' && i > 0) [list[i - 1], list[i]] = [list[i], list[i - 1]];
        if (act === 'down' && i < list.length - 1) [list[i + 1], list[i]] = [list[i], list[i + 1]];
        if (act === 'other') { list.splice(i, 1); p[zone === 'rows' ? 'cols' : 'rows'].push(item); }
        pivotChanged();
      });
      li.addEventListener('dragstart', (e) => startDrag(e, { from: zone, index: i, field: zone === 'values' ? item.field : item, value: zone === 'values' ? item : undefined }));
      li.addEventListener('dragend', () => li.classList.remove('dragging'));
      ul.append(li);
    });
  }
  $('#optSubtotals').checked = p.subtotals;
  $('#optGrand').checked = p.grandTotals;
  // Totals across different measures would add Sales to Units, so levels above Σ Values get none.
  const axis = p.rows.includes(SIGMA) ? p.rows : p.cols.includes(SIGMA) ? p.cols : null;
  let hint = $('#sigmaHint');
  if (!hint) {
    hint = Object.assign(document.createElement('p'), { id: 'sigmaHint', className: 'hint' });
    $('#pivotConfig .checks').after(hint);
  }
  const blocked = axis && axis.indexOf(SIGMA) > 0 && (p.subtotals || p.grandTotals);
  hint.hidden = !blocked;
  hint.textContent = blocked ? `Levels above Σ Values in ${axis === p.rows ? 'Rows' : 'Columns'} get no totals, since those would add different measures together. Move Σ Values up to get them.` : '';
}

// Drag and drop between the field list and zones, with an insertion marker.
let drag = null;
function startDrag(e, info) {
  drag = info;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', String(info.field));
  e.currentTarget.classList.add('dragging');
}
function dropIndex(zoneEl, e) {
  const chips = $$('.chip', zoneEl).filter((c) => !c.classList.contains('dragging'));
  const wide = zoneEl.classList.contains('wide');
  let idx = chips.length;
  for (let i = 0; i < chips.length; i++) {
    const r = chips[i].getBoundingClientRect();
    if (wide ? e.clientX < r.left + r.width / 2 && e.clientY < r.bottom : e.clientY < r.top + r.height / 2) { idx = i; break; }
  }
  return { idx, chips };
}
function clearMarkers() { $$('.drop-marker').forEach((m) => m.remove()); $$('.zone.over').forEach((z) => z.classList.remove('over')); }
for (const zoneEl of $$('.zone')) {
  const zone = zoneEl.dataset.zone;
  zoneEl.addEventListener('dragover', (e) => {
    if (!drag) return;
    if (zone === 'values' && drag.field === SIGMA) return;
    if (zone !== 'values' && drag.from === 'values') return;
    e.preventDefault();
    clearMarkers();
    zoneEl.classList.add('over');
    const { idx, chips } = dropIndex(zoneEl, e);
    const marker = document.createElement('li');
    marker.className = 'drop-marker';
    const list = $('.zone-list', zoneEl);
    if (idx < chips.length) list.insertBefore(marker, chips[idx]); else list.append(marker);
  });
  zoneEl.addEventListener('dragleave', (e) => { if (!zoneEl.contains(e.relatedTarget)) clearMarkers(); });
  zoneEl.addEventListener('drop', (e) => {
    e.preventDefault();
    if (!drag) return;
    let { idx } = dropIndex(zoneEl, e);
    clearMarkers();
    const p = state.pivot;
    const d = drag;
    drag = null;
    if (d.from === zone) {
      const list = zone === 'values' ? p.values : p[zone];
      const [item] = list.splice(d.index, 1);
      if (idx > d.index) idx--;
      list.splice(idx, 0, item);
      pivotChanged();
      return;
    }
    if (d.from === 'rows' || d.from === 'cols') {
      p[d.from].splice(d.index, 1);
      p[zone].splice(idx, 0, d.field);
      pivotChanged();
      return;
    }
    addToZone(zone, d.field, idx);
  });
}
document.addEventListener('dragend', () => { drag = null; clearMarkers(); });
// Dropping a chip outside the zones removes it.
$('#fieldList').addEventListener('dragover', (e) => { if (drag && drag.from !== 'list' && drag.field !== SIGMA) e.preventDefault(); });
$('#fieldList').addEventListener('drop', (e) => {
  e.preventDefault();
  if (!drag || drag.from === 'list') return;
  const list = drag.from === 'values' ? state.pivot.values : state.pivot[drag.from];
  list.splice(drag.index, 1);
  drag = null;
  pivotChanged();
});
$('#fieldList').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-add]');
  if (!btn) return;
  addToZone(btn.dataset.add, Number(btn.closest('li').dataset.field));
});
$('#fieldSearch').addEventListener('input', renderFieldList);
$('#swapAxes').addEventListener('click', () => { const p = state.pivot; [p.rows, p.cols] = [p.cols, p.rows]; pivotChanged(); });
$('#clearLayout').addEventListener('click', () => { Object.assign(state.pivot, { rows: [], cols: [], values: [] }); pivotChanged(); });
$('#optSubtotals').addEventListener('change', (e) => { state.pivot.subtotals = e.target.checked; pivotChanged(); });
$('#optGrand').addEventListener('change', (e) => { state.pivot.grandTotals = e.target.checked; pivotChanged(); });

const PRESETS = [
  { name: 'Sales by region × year', rows: ['Region', 'Country'], cols: [SIGMA, 'Year', 'Quarter'], values: [['Sales', 'sum'], ['Profit', 'sum'], ['Units', 'sum']] },
  { name: 'Product mix by channel', rows: ['Category', 'Product'], cols: [SIGMA, 'Channel'], values: [['Sales', 'sum'], ['Units', 'sum']] },
  { name: 'Monthly trend (measures in rows)', rows: ['Year', SIGMA], cols: ['Month'], values: [['Sales', 'sum'], ['Profit', 'avg'], ['Units', 'sum']] },
  { name: 'Deep drill-down', rows: ['Region', 'Country', 'City', 'Category', 'Product'], cols: [SIGMA, 'Year'], values: [['Sales', 'sum'], ['Discount', 'avg']] },
  { name: 'Very wide: every day as a column', rows: ['Region', 'Country'], cols: [SIGMA, 'Year', 'Order Date'], values: [['Sales', 'sum']] },
  { name: 'Tall: every city × product', rows: ['City', 'Product'], cols: [SIGMA], values: [['Sales', 'sum'], ['Units', 'sum'], ['Profit', 'min'], ['Profit', 'max']] },
  { name: 'Counts only', rows: ['Segment', 'Customer Tier'], cols: ['Ship Mode'], values: [] },
];
function renderPresets() {
  const sel = $('#presetSelect');
  sel.replaceChildren(new Option('Presets…', ''));
  PRESETS.forEach((pr, i) => {
    const names = [...pr.rows, ...pr.cols, ...pr.values.map((v) => v[0])].filter((n) => n !== SIGMA);
    if (names.every((n) => fieldByName(n) !== undefined)) sel.append(new Option(pr.name, String(i)));
  });
  sel.hidden = sel.options.length < 2;
}
$('#presetSelect').addEventListener('change', (e) => {
  const pr = PRESETS[Number(e.target.value)];
  e.target.value = '';
  if (!pr) return;
  const map = (n) => (n === SIGMA ? SIGMA : fieldByName(n));
  Object.assign(state.pivot, { rows: pr.rows.map(map), cols: pr.cols.map(map), values: pr.values.map(([n, agg]) => ({ field: fieldByName(n), agg })) });
  pivotChanged();
});

// ================================================================== table config

function renderColumnList() {
  if (!dataset) return;
  const hidden = new Set(state.table.hidden);
  const ul = $('#columnList');
  ul.replaceChildren();
  for (const f of dataset.fields) {
    const li = document.createElement('li');
    li.innerHTML = `<label><input type="checkbox" ${hidden.has(f.key) ? '' : 'checked'}><span class="ftype ${f.kind}">${f.kind === 'num' ? '#' : 'A'}</span><span class="fname">${escapeHtml(f.name)}</span></label>`;
    $('input', li).addEventListener('change', (e) => {
      const set = new Set(state.table.hidden);
      if (e.target.checked) set.delete(f.key); else set.add(f.key);
      state.table.hidden = [...set];
      saveState();
      rebuildGrid();
    });
    ul.append(li);
  }
}
$('#colsAll').addEventListener('click', () => { state.table.hidden = []; renderColumnList(); saveState(); rebuildGrid(); });
$('#colsNone').addEventListener('click', () => { state.table.hidden = dataset.fields.slice(1).map((f) => f.key); renderColumnList(); saveState(); rebuildGrid(); });
$('#pinnedCount').addEventListener('change', (e) => { state.table.pinned = clamp(Number(e.target.value) || 0, 0, 10); saveState(); rebuildGrid(); });

// ================================================================== formatting

function numberFormatter() {
  const { style, decimals } = state.format;
  const d = decimals === 'auto' ? undefined : Number(decimals);
  const opts = { maximumFractionDigits: d ?? 2, minimumFractionDigits: d ?? 0 };
  if (style === 'compact') return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: d ?? 1, minimumFractionDigits: d ?? 0 });
  if (style === 'currency') return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', ...opts, minimumFractionDigits: d ?? 2, maximumFractionDigits: d ?? 2 });
  if (style === 'plain') return new Intl.NumberFormat('en-US', { ...opts, useGrouping: false });
  return new Intl.NumberFormat('en-US', opts);
}

/** Which measure a pivot cell shows, and whether it is a leaf × leaf cell (heatmaps skip subtotals). */
function pivotCellMeta(ctx) {
  const info = lastPivotInfo;
  if (!info) return null;
  const r = ctx.rowSource, c = ctx.colSource;
  const leaf = info.rowKind[r] === 0 && info.colKind[c] === 0;
  const m = info.sigmaAxis === 'cols' ? info.colM[c] : info.sigmaAxis === 'rows' ? info.rowM[r] : 0;
  return { leaf, range: info.ranges[m] };
}

function pivotHooks() {
  const f = numberFormatter();
  const format = (v) => (v == null ? '' : typeof v === 'number' ? f.format(v) : String(v));
  const cond = state.format.conditional;
  const hooks = { format, cellClass: undefined, renderCell: undefined };
  if (cond === 'negative') hooks.cellClass = (v) => (typeof v === 'number' && v < 0 ? 'neg' : '');
  if (cond === 'heatmap') {
    hooks.cellClass = (v, ctx) => {
      if (typeof v !== 'number') return '';
      const meta = pivotCellMeta(ctx);
      if (!meta?.leaf || !meta.range || !(meta.range.max > meta.range.min)) return v < 0 ? 'neg' : '';
      const t = (v - meta.range.min) / (meta.range.max - meta.range.min);
      return `hm hm${clamp(Math.floor(t * 10), 0, 9)}`;
    };
  }
  if (cond === 'bars') {
    hooks.renderCell = (el, ctx) => {
      const v = ctx.value;
      const meta = typeof v === 'number' ? pivotCellMeta(ctx) : null;
      if (!meta?.leaf || !meta.range) { el.textContent = ctx.text ?? ''; return; }
      const span = Math.max(Math.abs(meta.range.max), Math.abs(meta.range.min)) || 1;
      const w = clamp((Math.abs(v) / span) * 100, 0, 100);
      el.innerHTML = `<span class="bar-cell"><i class="${v < 0 ? 'negbar' : ''}" style="width:${w.toFixed(1)}%"></i><span>${escapeHtml(ctx.text ?? '')}</span></span>`;
    };
  }
  return hooks;
}

// ================================================================== grid

function commonOptions() {
  const g = state.grid;
  return {
    theme: state.theme,
    rowHeight: g.rowHeight,
    headerHeight: g.headerHeight,
    columnWidth: g.columnWidth,
    selection: g.selection,
    sortable: g.sortable,
    multiSort: g.multiSort,
    filterable: g.filterable,
    resizable: g.resizable,
    reorderable: g.reorderable,
    expandable: g.expandable,
    copy: g.copy,
    keyboard: g.keyboard,
    notices: g.notices,
    onSelectionChange: onSelection,
    onCopy: (info) => setEvent(info.ok ? `Copied ${fmtInt(info.cells)} cells in ${fmtMs(info.ms)}` : `Copy failed: ${info.reason ?? ''}`),
    onCellClick: (e) => setEvent(`Click · ${cellName(e)}`),
    onCellDoubleClick: (e) => { setEvent(`Double-click · ${cellName(e)}`); if (state.mode === 'pivot' && !dataset?.virtual) openDrill(e); },
    onCellContextMenu: (e) => { e.event.preventDefault(); openMenu(e); },
    onSortChange: (s) => setEvent(`Sort · ${s.length ? s.map((x) => `${x.key ?? (x.level !== undefined ? `level ${x.level}` : `col ${x.column}`)} ${x.direction}`).join(', ') : 'cleared'}`),
    onFilterChange: (f) => setEvent(`Filter · ${f.length} condition${f.length === 1 ? '' : 's'}`),
    onColumnFilterChange: (f) => setEvent(`Column filter · ${f.length} condition${f.length === 1 ? '' : 's'}`),
    onColumnResize: (r) => setEvent(`Resized ${r.key ?? `column ${r.column}`} to ${Math.round(r.width)} px`),
    onColumnOrderChange: (o) => setEvent(`Column order · ${o.slice(0, 4).join(', ')}${o.length > 4 ? '…' : ''}`),
    onRowSelectionChange: (s) => setEvent(s.all ? `All rows checked${s.except.length ? ` except ${s.except.length}` : ''}` : `${s.ids.length} row${s.ids.length === 1 ? '' : 's'} checked`),
    onViewChange: (v) => {
      if (v.pending) setEvent(`${v.what === 'sort' ? 'Sorting' : 'Filtering'}…${v.progress?.total ? ` ${Math.round((v.progress.done / v.progress.total) * 100)}%` : ''}`);
      else if (v.cancelled) setEvent(`${v.what} cancelled`);
      else if (v.ok === false) setEvent(`${v.what} failed: ${v.reason ?? ''}`);
      else if (v.ok) setEvent(`${v.what === 'sort' ? 'Sorted' : 'Filtered'}${v.rows != null ? ` · ${fmtInt(v.rows)} rows` : ''}`);
      if (!v.pending) renderSummary();
    },
    onError: (err, ctx) => setEvent(`⚠ ${ctx.kind} request failed: ${err.message ?? err}`),
  };
}

function cellName(e) {
  if (state.mode === 'table') return `row ${fmtInt(e.rowIndex + 1)}, ${e.column?.title ?? e.key}: ${e.text ?? ''}`;
  return `row ${fmtInt(e.rowIndex + 1)}, col ${fmtInt(e.colIndex + 1)}: ${e.text ?? ''}`;
}

function pivotCfg() {
  const p = state.pivot;
  return { rows: p.rows, cols: p.cols, values: p.values, subtotals: p.subtotals, grandTotals: p.grandTotals, rowHeight: state.grid.rowHeight, colWidth: state.grid.columnWidth };
}
const plain = (q) => JSON.parse(JSON.stringify(q ?? { sort: [], filter: [], columnFilter: [] }));

function pivotSource(cfg, serial) {
  const live = () => serial === gridSerial;
  return {
    maxRectsPerRequest: 400,
    maxCellsPerRequest: state.server.maxCells,
    async getLayout({ query, signal, onProgress }) {
      const q = plain(query);
      const res = await net('pivotLayout', { cfg, query: q }, { signal, onProgress, kind: 'layout', detail: describeQuery(q) });
      if (live()) { lastPivotInfo = res.info; renderSummary(); }
      return res;
    },
    async getCells({ rects, query, signal }) {
      const cells = rects.reduce((a, r) => a + r.rowCount * r.colCount, 0);
      const res = await net('pivotCells', { cfg, query: plain(query), rects: rects.map((r) => [r.row, r.col, r.rowCount, r.colCount]) },
        { signal, kind: 'cells', detail: `${rects.length} rect${rects.length > 1 ? 's' : ''} · ${fmtInt(cells)} cells`, cells });
      if (live() && firstDataMs == null) firstDataMs = performance.now() - gridCreatedAt;
      return res;
    },
    getLabels({ axis, level, start, count, query, signal }) {
      return net('pivotLabels', { cfg, query: plain(query), axis, level, start, count }, { signal, kind: 'labels', detail: `${axis} L${level} · ${start}+${count}` });
    },
    getFilterValues({ axis, level, search, limit, signal }) {
      return net('pivotValues', { cfg, axis, level, search, limit }, { signal, kind: 'values', detail: `${axis} L${level}${search ? ` "${search}"` : ''}` });
    },
  };
}

function visibleFields() {
  const hidden = new Set(state.table.hidden);
  return dataset.fields.filter((f) => !hidden.has(f.key));
}

function tableColumns() {
  const f = numberFormatter();
  const cond = state.format.conditional;
  return visibleFields().map((fd, i) => {
    const idLike = /(^|\s)(id|code|zip)$|^year$/i.test(fd.name);
    const col = { key: fd.key, title: fd.name, pinned: i < state.table.pinned, width: fd.kind === 'num' ? Math.max(90, state.grid.columnWidth - 10) : Math.max(state.grid.columnWidth, Math.min(220, fd.name.length * 8 + 40)) };
    if (fd.kind === 'num') {
      col.type = 'number';
      col.format = (v) => (v == null ? '' : idLike ? String(v) : f.format(v));
      if (cond !== 'none') col.cellClass = (v) => (typeof v === 'number' && v < 0 ? 'neg' : '');
    } else {
      col.filter = fd.cardinality <= 5000 ? 'values' : 'text';
    }
    return col;
  });
}

function tableSource(serial) {
  const keys = visibleFields().map((f) => f.key);
  return createRowSource({
    pageSize: state.server.pageSize,
    async getRows({ offset, limit, sort, filter, signal }) {
      const q = plain({ sort, filter });
      const res = await net('getRows', { offset, limit, query: q, keys }, { signal, kind: 'rows', detail: `rows ${fmtInt(offset)}–${fmtInt(offset + limit - 1)}`, cells: limit * keys.length });
      if (serial === gridSerial) {
        lastTable = res;
        if (firstDataMs == null) firstDataMs = performance.now() - gridCreatedAt;
        renderSummary();
      }
      return res;
    },
    getFilterValues({ key, search, limit, signal }) {
      return net('tableValues', { key, search, limit }, { signal, kind: 'values', detail: `${key}${search ? ` "${search}"` : ''}` });
    },
    indexOfRow(id, query, signal) {
      return net('indexOfRow', { rowId: id, query: plain({ sort: query.sort, filter: query.filter }) }, { signal, kind: 'index', detail: `row id ${id}` });
    },
  });
}

function virtualSource(serial) {
  const v = state.virtual;
  const live = () => serial === gridSerial;
  // createHttpSource speaks the reference HTTP protocol; this fetch hands each request to the worker,
  // through the same simulated network as every other call.
  const fetchImpl = async (href, init = {}) => {
    const u = new URL(href, location.href);
    const path = u.pathname.split('/').pop();
    const q = u.searchParams;
    const kind = { meta: 'layout', block: 'cells', gather: 'cells', labels: 'labels', values: 'values', progress: 'progress' }[path] ?? path;
    let cells = 0, detail = '';
    if (path === 'block') { cells = Number(q.get('nr')) * Number(q.get('nc')); detail = `1 rect · ${fmtInt(cells)} cells`; }
    else if (path === 'gather') {
      const rects = JSON.parse(init.body ?? '{}').rects ?? [];
      cells = rects.reduce((a, r) => a + r[2] * r[3], 0);
      detail = `${rects.length} rects · ${fmtInt(cells)} cells`;
    } else if (path === 'labels') detail = `${q.get('axis')} L${q.get('level')} · ${fmtInt(Number(q.get('from')))}+${q.get('n')}`;
    else if (path === 'values') detail = `${q.get('axis')} L${q.get('level')}${q.get('q') ? ` "${q.get('q')}"` : ''}`;
    else detail = [q.get('sort') && 'sort', q.get('filter') && 'filter', q.get('colfilter') && 'col filter'].filter(Boolean).join(' · ') || 'no sort / filter';
    const out = await net('virtualApi', { href: u.pathname + u.search, method: init.method ?? 'GET', body: init.body }, { signal: init.signal, kind, detail, cells });
    if (live() && kind === 'cells' && firstDataMs == null) firstDataMs = performance.now() - gridCreatedAt;
    if (live() && kind === 'layout') setTimeout(renderSummary);
    return new Response(JSON.stringify(out.body), { status: out.status, headers: { 'Content-Type': 'application/json' } });
  };
  return createHttpSource({
    baseUrl: '/api',
    params: { mode: state.mode === 'pivot' ? 'pivot' : 'flat', rows: v.rows, cols: v.cols, years: v.years, latency: 0 },
    fetch: fetchImpl,
  });
}

function describeQuery(q) {
  const parts = [];
  if (q.sort?.length) parts.push(`${q.sort.length} sort`);
  if (q.filter?.length) parts.push(`${q.filter.length} filter`);
  if (q.columnFilter?.length) parts.push(`${q.columnFilter.length} col filter`);
  return parts.join(' · ') || 'no sort / filter';
}

let rebuildTimer = 0;
function rebuildGrid() {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(createGridNow, 30);
}

async function createGridNow() {
  if (!dataset) return;
  grid?.destroy();
  grid = null;
  const host = $('#grid');
  host.replaceChildren();
  host.classList.toggle('no-zebra', !state.grid.zebra);
  const serial = ++gridSerial;
  lastPivotInfo = null;
  lastTable = null;
  firstDataMs = null;
  gridCreatedAt = performance.now();
  $('#pivotConfig').hidden = state.mode !== 'pivot';
  $('#tableConfig').hidden = state.mode !== 'table';
  $('#levelBar').replaceChildren();

  applySourceUi();
  if (dataset.virtual) renderDatasetBadge();
  let options;
  if (dataset.virtual) {
    const source = virtualSource(serial);
    if (state.mode === 'pivot') {
      options = { ...commonOptions(), dataSource: source, ariaLabel: 'Virtual pivot table' };
    } else {
      // Read the layout first: it carries the column types the column definitions need.
      let layout;
      try { layout = await source.getLayout({ query: EMPTY_QUERY }); } catch (err) { setEvent(`⚠ ${err.message}`); return; }
      if (serial !== gridSerial) return;
      const meta = layout.meta ?? layout;
      const kinds = meta.columnKinds ?? [];
      const types = meta.columnTypes ?? [];
      const filterOf = (k) => (!k ? false : k.kind === 'values' ? { type: 'values', values: k.values } : k.kind);
      options = {
        ...commonOptions(),
        dataSource: source,
        layout,
        columnCount: meta.cols,
        getColumn: (i) => ({ group: types[i % types.length], filter: filterOf(kinds[i % kinds.length]) }),
        columnChooser: types.length > 0,
        columnGroups: types,
        rowHeader: state.grid.rowNumbers ? undefined : false,
        ariaLabel: 'Virtual table',
      };
    }
  } else if (state.mode === 'pivot') {
    const cfg = pivotCfg();
    const bands = Math.max(2, (cfg.rows.length >= 2 ? cfg.rows.length : 2));
    options = {
      ...commonOptions(),
      ...pivotHooks(),
      dataSource: pivotSource(cfg, serial),
      rowHeaderWidths: Array.from({ length: bands }, (_, i) => (innerWidth < 760 ? (i === bands - 1 ? 116 : 96) : i === bands - 1 ? 170 : 140)),
      ariaLabel: 'Pivot table',
    };
  } else {
    const cols = tableColumns();
    if (!cols.length) { $('#summary').innerHTML = 'Pick at least one column.'; return; }
    options = {
      ...commonOptions(),
      dataSource: tableSource(serial),
      columns: cols,
      getRowId: (row) => row.__id,
      rowSelection: state.grid.rowSelection,
      rowHeader: state.grid.rowNumbers || state.grid.rowSelection ? undefined : false,
      ariaLabel: 'Data table',
    };
  }
  grid = createGrid(host, options);
  grid.ready.then(() => {
    if (serial !== gridSerial) return;
    renderLevelBar();
    renderSummary();
  }).catch((err) => setEvent(`⚠ ${err.message ?? err}`));
}

/** Option changes that the grid applies in place (or rebuilds itself, keeping scroll and query). */
function applyOptions() {
  if (!grid) return;
  const opts = { ...commonOptions() };
  if (dataset?.virtual) { if (state.mode === 'table') opts.rowHeader = state.grid.rowNumbers ? undefined : false; }
  else if (state.mode === 'pivot') Object.assign(opts, pivotHooks());
  else { opts.columns = tableColumns(); opts.rowSelection = state.grid.rowSelection; opts.rowHeader = state.grid.rowNumbers || state.grid.rowSelection ? undefined : false; }
  $('#grid').classList.toggle('no-zebra', !state.grid.zebra);
  grid.setOptions(opts);
}

// ================================================================== view bar

function renderSummary() {
  const el = $('#summary');
  if (!dataset) { el.textContent = ''; return; }
  if (dataset.virtual) {
    el.innerHTML = grid?.rowCount != null ? `<b>${fmtInt(grid.rowCount)}</b> rows × <b>${fmtInt(grid.columnCount)}</b> columns · computed on demand` : 'Loading layout…';
    return;
  }
  if (state.mode === 'pivot') {
    const i = lastPivotInfo;
    if (!i) { el.innerHTML = 'Loading layout…'; return; }
    el.innerHTML = `<b>${fmtInt(i.rowItems)}</b> rows × <b>${fmtInt(i.colItems)}</b> columns · from <b>${fmtInt(i.matched)}</b> of ${fmtInt(dataset.rows)} records`;
  } else {
    const t = lastTable;
    if (!t) { el.innerHTML = 'Loading rows…'; return; }
    el.innerHTML = t.total === t.totalUnfiltered ? `<b>${fmtInt(t.total)}</b> rows` : `<b>${fmtInt(t.total)}</b> of ${fmtInt(t.totalUnfiltered)} rows match`;
  }
}

function renderLevelBar() {
  const bar = $('#levelBar');
  bar.replaceChildren();
  const levels = state.mode === 'pivot' ? grid?.levels : null;
  if (!levels) return;
  for (const axis of ['rows', 'cols']) {
    const list = levels[axis].map((l, i) => ({ ...l, i })).filter((l) => l.collapsible && l.name !== 'All');
    if (!list.length) continue;
    const g = document.createElement('span');
    g.className = 'level-group';
    g.innerHTML = `<span>${axis === 'rows' ? 'Rows' : 'Cols'}</span>`;
    const seg = document.createElement('span');
    seg.className = 'seg';
    for (const l of list) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = l.name;
      b.title = `Collapse ${axis} to ${l.name}`;
      b.onclick = () => grid.showLevel(axis, l.i);
      seg.append(b);
    }
    const all = document.createElement('button');
    all.type = 'button';
    all.textContent = 'All';
    all.title = `Expand every ${axis === 'rows' ? 'row' : 'column'} group`;
    all.onclick = () => grid.expandAll(axis);
    seg.append(all);
    g.append(seg);
    bar.append(g);
  }
}

$('#gotoForm').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!grid) return;
  const r = parseCount(e.target.row.value || '1') - 1;
  const c = parseCount(e.target.col.value || '1') - 1;
  if (!Number.isFinite(r) || r < 0) return;
  grid.scrollToCell(clamp(r, 0, Math.max(0, grid.rowCount - 1)), clamp(Number.isFinite(c) ? c : 0, 0, Math.max(0, grid.columnCount - 1)));
  grid.setSelection({ active: { r: clamp(r, 0, grid.rowCount - 1), c: clamp(c || 0, 0, grid.columnCount - 1) } });
  grid.focus();
});
$('#resetView').addEventListener('click', () => {
  if (!grid) return;
  grid.setOptions({ sort: [], filter: [], columnFilter: [] });
  Promise.all([grid.setSort([]), grid.setFilter([]), grid.setColumnFilter?.([])]).catch(() => {});
});
$('#refreshBtn').addEventListener('click', () => grid?.refresh());

// ================================================================== status bar, events, menus

function setEvent(text) { $('#statusEvent').textContent = text; }

let selTimer = 0;
function onSelection(info) {
  $('#statusSel').innerHTML = `<b>R${fmtInt(info.active.r + 1)}C${fmtInt(info.active.c + 1)}</b>${info.cells > 1 ? ` · ${fmtInt(info.rows)} × ${fmtInt(info.cols)} (${fmtInt(info.cells)} cells)` : ''}${info.text ? ` · ${escapeHtml(info.text)}` : ''}`;
  clearTimeout(selTimer);
  selTimer = setTimeout(selectionStats, 60);
}

/** Like a spreadsheet's status bar: sum, average, min and max of the loaded numbers in the selection. */
function selectionStats() {
  const sel = grid?.getSelection();
  const out = $('#statusAgg');
  if (!sel) { out.textContent = ''; return; }
  let n = 0, sum = 0, min = Infinity, max = -Infinity, seen = 0, missing = 0;
  const LIMIT = 50000;
  outer: for (const r of sel.ranges) {
    for (let row = Math.min(r.r0, r.r1); row <= Math.max(r.r0, r.r1); row++) {
      for (let col = Math.min(r.c0, r.c1); col <= Math.max(r.c0, r.c1); col++) {
        if (++seen > LIMIT) break outer;
        const v = grid.cellValue(row, col);
        if (v === undefined) { missing++; continue; }
        if (typeof v === 'number' && Number.isFinite(v)) { n++; sum += v; if (v < min) min = v; if (v > max) max = v; }
      }
    }
  }
  if (n < 2) { out.textContent = ''; return; }
  const f = numberFormatter();
  out.innerHTML = `Sum <b>${f.format(sum)}</b> · Avg <b>${f.format(sum / n)}</b> · Min <b>${f.format(min)}</b> · Max <b>${f.format(max)}</b> · Count <b>${fmtInt(n)}</b>${missing || seen > LIMIT ? ' <span class="muted">(loaded cells)</span>' : ''}`;
}

function openMenu(e) {
  const menu = $('#ctxMenu');
  const items = [];
  items.push(['Copy selection', () => grid.copySelection()]);
  if (state.mode === 'pivot') {
    if (!dataset.virtual) items.push(['Show records behind this cell', () => openDrill(e)]);
    items.push('-');
    items.push(['Sort rows by this column, high → low', () => grid.setSort([{ column: e.colSource, direction: 'desc' }])]);
    items.push(['Sort rows by this column, low → high', () => grid.setSort([{ column: e.colSource, direction: 'asc' }])]);
  } else {
    items.push('-');
    items.push([`Sort by ${e.column?.title}, ascending`, () => grid.setSort([{ key: e.key, direction: 'asc' }])]);
    items.push([`Sort by ${e.column?.title}, descending`, () => grid.setSort([{ key: e.key, direction: 'desc' }])]);
    if (e.column?.type !== 'number' && e.text) {
      const others = () => grid.getFilter().filter((f) => f.key !== e.key);
      items.push('-');
      items.push([`Only "${e.text}"`, () => grid.setFilter([...others(), { key: e.key, op: 'in', values: [e.text] }])]);
      items.push([`Exclude "${e.text}"`, () => grid.setFilter([...others(), { key: e.key, op: 'notin', values: [e.text] }])]);
    }
    if (e.column?.type === 'number' && typeof e.value === 'number') {
      const others = () => grid.getFilter().filter((f) => f.key !== e.key);
      items.push('-');
      items.push([`${e.column.title} ≥ ${e.text}`, () => grid.setFilter([...others(), { key: e.key, op: 'range', min: e.value }])]);
      items.push([`${e.column.title} ≤ ${e.text}`, () => grid.setFilter([...others(), { key: e.key, op: 'range', max: e.value }])]);
    }
    if (e.row && !dataset.virtual) items.push('-', ['Copy row as JSON', () => { navigator.clipboard?.writeText(JSON.stringify(rowAsNamed(e.row), null, 2)); toast('Row copied as JSON'); }]);
  }
  menu.replaceChildren(...items.map((it) => {
    if (it === '-') return document.createElement('hr');
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.textContent = it[0];
    b.onclick = () => { closeMenu(); it[1](); };
    return b;
  }));
  menu.hidden = false;
  const { clientX: x, clientY: y } = e.event;
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
  menu.querySelector('button')?.focus();
}
function closeMenu() { $('#ctxMenu').hidden = true; }
document.addEventListener('pointerdown', (e) => { if (!$('#ctxMenu').contains(e.target)) closeMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

function rowAsNamed(row) {
  const out = {};
  for (const f of dataset.fields) if (f.key in row) out[f.name] = row[f.key];
  return out;
}

let drillGrid = null;
async function openDrill(e) {
  const dlg = $('#drillDialog');
  $('#drillMeta').innerHTML = 'Loading…';
  drillGrid?.destroy();
  $('#drillGrid').replaceChildren();
  dlg.showModal();
  try {
    const res = await net('drill', { cfg: pivotCfg(), query: plain(grid.getQuery()), row: e.rowSource, col: e.colSource, limit: 1000 }, { kind: 'drill', detail: `r${e.rowSource} c${e.colSource}` });
    const f = numberFormatter();
    $('#drillTitle').textContent = res.measure ? `${res.measure}: ${res.value == null ? '–' : f.format(res.value)}` : 'Records behind this cell';
    $('#drillMeta').innerHTML = `${res.path.length ? res.path.map((p) => `<span>${escapeHtml(p)}</span>`).join('') : '<span>All records</span>'}<span><b>${fmtInt(res.total)}</b> records${res.total > res.rows.length ? ` (first ${fmtInt(res.rows.length)} shown)` : ''}</span>`;
    const columns = dataset.fields.map((fd) => ({ key: fd.key, title: fd.name, type: fd.kind === 'num' ? 'number' : undefined, filter: fd.kind === 'num' ? undefined : 'values', format: fd.kind === 'num' ? (v) => (v == null ? '' : /id$/i.test(fd.name) ? String(v) : f.format(v)) : undefined }));
    drillGrid = createGrid($('#drillGrid'), { dataSource: createArraySource(res.rows, { columns }), columns, theme: state.theme, ariaLabel: 'Records behind the cell' });
  } catch (err) {
    $('#drillMeta').textContent = `Could not load the records: ${err.message}`;
  }
}
$('#drillDialog').addEventListener('close', () => { drillGrid?.destroy(); drillGrid = null; });

let toastTimer = 0;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

// ================================================================== performance panel

let fpsFrames = 0, fpsLast = performance.now(), lastFrame = performance.now(), fpsNow = 0;
const fpsHistory = [];
function fpsLoop(now) {
  const gap = now - lastFrame;
  lastFrame = now;
  if (gap > 50 && document.visibilityState === 'visible' && gap < 2000) metrics.longFrames++;
  fpsFrames++;
  if (now - fpsLast >= 1000) {
    fpsNow = (fpsFrames * 1000) / (now - fpsLast);
    fpsHistory.push(fpsNow);
    if (fpsHistory.length > 30) fpsHistory.shift();
    fpsFrames = 0;
    fpsLast = now;
    drawFps();
  }
  requestAnimationFrame(fpsLoop);
}
requestAnimationFrame(fpsLoop);

let perfQueued = false;
function schedulePerf() {
  if (perfQueued) return;
  perfQueued = true;
  setTimeout(() => { perfQueued = false; renderPerf(); }, 200);
}
setInterval(renderPerf, 1000);

const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

function tile(k, v, s = '', cls = '', title = '') {
  return `<div class="tile ${cls}"${title ? ` title="${escapeHtml(title)}"` : ''}><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s || '&nbsp;'}</div></div>`;
}

function renderPerf() {
  if (!state.perfOpen) return;
  let stats = null;
  try { stats = grid?.stats(); } catch { /* not ready */ }
  if (stats) metrics.maxRender = Math.max(metrics.maxRender, stats.renderMsMax ?? 0);
  const d = dataset;
  const html = [];
  html.push('<div class="tile-group-title">Dataset</div>');
  if (d?.virtual) {
    html.push(tile('Rows', fmtInt(d.rows), `${fmtInt(state.mode === 'pivot' ? 68 * d.years : d.cols)} columns`));
    html.push(tile('Stored data', '0 B', 'every cell computed on request', 'good'));
  } else {
  html.push(tile('Rows', d ? fmtInt(d.rows) : '–', d ? `${d.fields.length} columns` : ''));
  html.push(tile('Server memory', d ? fmtBytes(d.bytes + (lastPivotInfo?.aggBytes ?? 0)) : '–', d ? `built in ${fmtMs(d.buildMs)}` : '', '', 'Columnar data plus the current pivot aggregates'));
  }

  html.push('<div class="tile-group-title">Server</div>');
  if (d?.virtual) {
    const lay = [...metrics.log].reverse().find((e) => e.kind === 'layout' && e.status === 'ok');
    const cellsReq = metrics.log.filter((e) => e.kind === 'cells' && e.status === 'ok');
    html.push(tile('Layout compute', fmtMs(lay?.serverMs), 'last sort / filter on the server'));
    html.push(tile('Cells request', fmtMs(avg(cellsReq.map((e) => e.serverMs))), 'average server time'));
  } else if (state.mode === 'pivot' && lastPivotInfo) {
    const t = lastPivotInfo.timing;
    const total = lastPivotInfo.cached ? t.treeMs : t.groupMs + t.aggregateMs + t.rollupMs + t.treeMs + t.prepareMs;
    html.push(tile('Pivot compute', fmtMs(total), lastPivotInfo.cached ? 'aggregates cached · re-sorted' : `group ${fmtMs(t.groupMs)} · agg ${fmtMs(t.aggregateMs)}`, total > 1000 ? 'warn' : '', `Grouping ${fmtMs(t.groupMs)}, aggregating ${fmtMs(t.aggregateMs)}, subtotals ${fmtMs(t.rollupMs)}, trees ${fmtMs(t.treeMs)}`));
    html.push(tile('Aggregated cells', fmtInt(lastPivotInfo.slots), `${fmtInt(lastPivotInfo.rowLeaves)} × ${fmtInt(lastPivotInfo.colLeaves)} leaves`));
  } else if (state.mode === 'table' && lastTable?.timing) {
    html.push(tile('Filter + sort', fmtMs(lastTable.timing.filterMs + lastTable.timing.sortMs), `filter ${fmtMs(lastTable.timing.filterMs)} · sort ${fmtMs(lastTable.timing.sortMs)}`, '', 'Once per sort and filter; pages after that are cached views'));
    html.push(tile('Page size', fmtInt(state.server.pageSize), 'rows per request'));
  } else {
    html.push(tile('Compute', '–'), tile('Result', '–'));
  }
  const srvAvg = avg(metrics.srv);
  html.push(tile('Server time avg', fmtMs(srvAvg), `p95 ${fmtMs(pct(metrics.srv, 95))}`));
  html.push(tile('Latency setting', `${state.server.latency} ms`, `± ${state.server.jitter} ms${state.server.failRate ? ` · ${state.server.failRate}% fail` : ''}`));

  html.push('<div class="tile-group-title">Network</div>');
  html.push(tile('Requests', fmtInt(metrics.requests), `${metrics.inflight} in flight · ${fmtInt(metrics.aborted)} cancelled${metrics.failed ? ` · ${fmtInt(metrics.failed)} failed` : ''}`, metrics.failed ? 'warn' : ''));
  const rttAvg = avg(metrics.rtt);
  html.push(tile('Round trip avg', fmtMs(rttAvg), `p95 ${fmtMs(pct(metrics.rtt, 95))} · max ${fmtMs(metrics.rtt.length ? Math.max(...metrics.rtt) : null)}`));
  html.push(tile('Transferred', fmtBytes(metrics.bytes), `${fmtInt(metrics.cells)} cells`, '', 'JSON size of every response a real server would send'));
  html.push(tile('Cancelled', metrics.requests ? `${Math.round((metrics.aborted / metrics.requests) * 100)}%` : '–', 'requests no longer needed', '', 'Scrolled away before the answer came: the grid aborts them'));

  html.push('<div class="tile-group-title">Browser</div>');
  html.push(tile('Frame rate', `${Math.round(fpsNow)} fps`, `${fmtInt(metrics.longFrames)} long frames (>50 ms)`, fpsNow >= 50 ? 'good' : fpsNow >= 30 ? 'warn' : 'bad'));
  html.push(tile('Grid render', stats ? fmtMs(stats.renderMsEma) : '–', stats ? `max ${fmtMs(metrics.maxRender)} · ${fmtInt(stats.renders)} renders` : '', stats && stats.renderMsEma > 12 ? 'warn' : '', 'Average time of one grid frame (exponential moving average)'));
  html.push(tile('First data', fmtMs(firstDataMs), 'grid created → first cells'));
  html.push(tile('Cells cached', stats ? fmtInt(stats.cache.cached) : '–', stats ? `${stats.cache.inflight} loading · ${stats.cache.queued} queued` : ''));
  const mem = performance.memory;
  if (mem) html.push(tile('JS heap (page)', fmtBytes(mem.usedJSHeapSize), `of ${fmtBytes(mem.jsHeapSizeLimit)}`));
  html.push(tile('DOM nodes', fmtInt($('#grid').getElementsByTagName('*').length), 'in the grid, at any data size', '', 'Only what is on screen is in the DOM'));

  $('#tiles').innerHTML = html.join('');
  $('#fpsNow').textContent = `${Math.round(fpsNow)} fps`;
  drawRtt();
  renderLog();
}

function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function sizeCanvas(c) {
  const dpr = devicePixelRatio || 1;
  const w = c.clientWidth, h = Number(c.getAttribute('height'));
  if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); c.style.height = `${h}px`; }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function drawRtt() {
  const c = $('#rttChart');
  if (!c.clientWidth) return;
  const { ctx, w, h } = sizeCanvas(c);
  const list = metrics.log.filter((e) => e.status !== 'pending').slice(-90);
  if (!list.length) {
    ctx.fillStyle = cssVar('--muted');
    ctx.font = '11px system-ui';
    ctx.fillText('Requests will show here', 8, h / 2);
    return;
  }
  const max = Math.max(50, ...list.map((e) => e.total));
  const bw = w / 90;
  const lat = cssVar('--lat'), srv = cssVar('--srv'), err = cssVar('--err');
  list.forEach((e, i) => {
    const x = i * bw;
    const H = h - 14;
    const total = (e.total / max) * H;
    if (e.status !== 'ok') {
      ctx.fillStyle = err;
      ctx.fillRect(x + 0.5, h - total, Math.max(1, bw - 1), total);
      return;
    }
    const s = Math.min(total, (e.serverMs / max) * H);
    ctx.fillStyle = lat;
    ctx.fillRect(x + 0.5, h - total, Math.max(1, bw - 1), total - s);
    ctx.fillStyle = srv;
    ctx.fillRect(x + 0.5, h - s, Math.max(1, bw - 1), s);
  });
  ctx.fillStyle = cssVar('--muted');
  ctx.font = '10px system-ui';
  ctx.fillText(`max ${fmtMs(max)}`, 4, 10);
}

function drawFps() {
  const c = $('#fpsChart');
  if (!c.clientWidth || !state.perfOpen) return;
  const { ctx, w, h } = sizeCanvas(c);
  ctx.strokeStyle = cssVar('--line');
  ctx.setLineDash([3, 3]);
  const y60 = h - (60 / 70) * h;
  ctx.beginPath(); ctx.moveTo(0, y60); ctx.lineTo(w, y60); ctx.stroke();
  ctx.setLineDash([]);
  if (fpsHistory.length < 2) return;
  ctx.strokeStyle = cssVar('--accent');
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  fpsHistory.forEach((f, i) => {
    const x = (i / 29) * w;
    const y = h - (Math.min(70, f) / 70) * h;
    if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
  });
  ctx.stroke();
}

function renderLog() {
  const rows = metrics.log.slice(-60).reverse();
  $('#logCount').textContent = `${fmtInt(metrics.requests)} total`;
  $('#logBody').innerHTML = rows.map((e) => `<tr class="${e.status}" title="${escapeHtml(e.error ?? `${e.kind} · ${e.detail} · latency ${Math.round(e.latency)} ms${e.bytes ? ` · ${fmtBytes(e.bytes)}` : ''}`)}">
    <td>${e.kind}</td><td>${escapeHtml(e.detail)}</td><td class="r">${e.status === 'ok' ? fmtMs(e.serverMs) : e.status === 'pending' ? '…' : e.status === 'aborted' ? 'cancelled' : 'failed'}</td><td class="r">${e.status === 'pending' ? fmtMs(performance.now() - e.t0) : fmtMs(e.total)}</td></tr>`).join('');
}

$('#resetMetrics').addEventListener('click', () => {
  const inflight = metrics.inflight;
  Object.assign(metrics, newMetrics(), { inflight });
  $('#benchResult').hidden = true;
  renderPerf();
});

// Scroll benchmark: sweep from the top-left to the bottom-right in 6 seconds and measure frames.
$('#benchBtn').addEventListener('click', async () => {
  const scroller = $('#grid .vg-scroller');
  if (!grid || !scroller) { toast('Load some data first'); return; }
  const btn = $('#benchBtn');
  btn.disabled = true;
  btn.textContent = 'Running… (6 s)';
  const maxY = scroller.scrollHeight - scroller.clientHeight;
  const maxX = scroller.scrollWidth - scroller.clientWidth;
  scroller.scrollTo(0, 0);
  await sleep(400);
  const before = { requests: metrics.requests, aborted: metrics.aborted, cells: metrics.cells, bytes: metrics.bytes, renders: grid.stats().renders };
  grid.stats(); // reset the slowest-frame counter
  const frames = [];
  const DUR = 6000;
  await new Promise((resolve) => {
    const start = performance.now();
    let last = start;
    const step = (now) => {
      frames.push(now - last);
      last = now;
      const t = Math.min(1, (now - start) / DUR);
      const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      scroller.scrollTop = e * maxY;
      scroller.scrollLeft = e * maxX;
      if (t < 1) requestAnimationFrame(step); else resolve();
    };
    requestAnimationFrame(step);
  });
  const st = grid.stats();
  await sleep(300);
  frames.shift();
  const sorted = [...frames].sort((a, b) => a - b);
  const avgFps = 1000 / avg(frames);
  const low1 = 1000 / sorted[Math.floor(sorted.length * 0.99)];
  const janky = frames.filter((f) => f > 33.4).length;
  const rowsPerSec = grid.rowCount / (DUR / 1000);
  const r = $('#benchResult');
  r.hidden = false;
  if (frames.length < 30) {
    // A background or throttled tab gets a few frames per second: the numbers would mean nothing.
    r.innerHTML = `<span style="grid-column: 1 / -1">The browser gave this page only ${frames.length} frames in 6 s, so it is throttled (a background tab, a hidden window or power saving). Bring the tab to the front and run it again.</span>`;
    btn.disabled = false;
    btn.textContent = 'Run scroll benchmark';
    return;
  }
  r.innerHTML = [
    ['Average', `${avgFps.toFixed(0)} fps`],
    ['1% low', `${low1.toFixed(0)} fps`],
    ['Frames over 33 ms', `${janky} of ${frames.length}`],
    ['Slowest grid frame', fmtMs(st.renderMsMax)],
    ['Rows travelled', `${fmtInt(grid.rowCount)} (${fmtInt(rowsPerSec)}/s)`],
    ['Requests', `${fmtInt(metrics.requests - before.requests)} (${fmtInt(metrics.aborted - before.aborted)} cancelled)`],
    ['Cells fetched', fmtInt(metrics.cells - before.cells)],
    ['Transferred', fmtBytes(metrics.bytes - before.bytes)],
  ].map(([k, v]) => `<span>${k}</span><b>${v}</b>`).join('');
  btn.disabled = false;
  btn.textContent = 'Run scroll benchmark';
});

// ================================================================== code view

let codePart = 'client';
function optionLines() {
  const g = state.grid, D = DEFAULTS.grid;
  const out = [];
  if (state.theme !== 'auto') out.push(`theme: '${state.theme}',`);
  for (const [k, def] of [['rowHeight', 28], ['headerHeight', 34], ['columnWidth', 132]]) if (g[k] !== def) out.push(`${k}: ${g[k]},`);
  if (g.selection !== 'multi') out.push(`selection: '${g.selection}',`);
  for (const k of ['sortable', 'multiSort', 'filterable', 'resizable', 'reorderable', 'expandable', 'copy', 'keyboard', 'notices']) if (g[k] !== D[k]) out.push(`${k}: ${g[k]},`);
  return out;
}
function formatterCode() {
  const { style, decimals } = state.format;
  const d = decimals === 'auto' ? '' : `, minimumFractionDigits: ${decimals}, maximumFractionDigits: ${decimals}`;
  const o = style === 'compact' ? `{ notation: 'compact'${d} }` : style === 'currency' ? `{ style: 'currency', currency: 'USD'${d} }` : style === 'plain' ? `{ useGrouping: false${d} }` : `{ maximumFractionDigits: ${decimals === 'auto' ? 2 : decimals}${d ? d.replace(/, maximumFractionDigits: \d/, '') : ''} }`;
  return `const number = new Intl.NumberFormat('en-US', ${o});`;
}
const indent = (lines, n) => lines.map((l) => ' '.repeat(n) + l).join('\n');

function clientCode() {
  if (!dataset) return '// Load some data first.';
  const opts = optionLines();
  if (dataset.virtual) {
    return `import { createGrid, createHttpSource } from '@borealjs/grid-core';
import '@borealjs/grid-core/style.css';

// A server speaking the reference HTTP protocol (demo-backend.mjs in the repository is one):
// GET /meta, GET /block, POST /gather, GET /labels, GET /values, GET /progress.
const dataSource = createHttpSource({
  baseUrl: '/api',
  params: { mode: '${state.mode === 'pivot' ? 'pivot' : 'flat'}', rows: ${state.virtual.rows}, ${state.mode === 'pivot' ? `years: ${state.virtual.years}` : `cols: ${state.virtual.cols}`} },
});

const grid = createGrid(document.getElementById('grid'), {
  dataSource,
  ariaLabel: '${state.mode === 'pivot' ? 'Pivot table' : 'Data table'}',
${indent(opts, 2)}
});`;
  }
  if (state.mode === 'pivot') {
    const p = state.pivot;
    const name = (i) => (i === SIGMA ? "'Σ Values'" : `'${dataset.fields[i].name}'`);
    const cond = state.format.conditional;
    return `import { createGrid } from '@borealjs/grid-core';
import '@borealjs/grid-core/style.css';

// What to pivot. Your backend groups and aggregates; the grid asks only for what is on screen.
const pivot = {
  rows: [${p.rows.map(name).join(', ')}],
  columns: [${p.cols.map(name).join(', ')}],
  values: [${p.values.map((v) => `{ field: '${dataset.fields[v.field].name}', agg: '${v.agg}' }`).join(', ') || '/* none: counts rows */'}],
  subtotals: ${p.subtotals},
  grandTotals: ${p.grandTotals},
};

const api = (path, body, signal) =>
  fetch(\`/api/pivot/\${path}\`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pivot, ...body }),
    signal, // the grid cancels requests it no longer needs
  }).then((res) => res.json());

const dataSource = {
  maxCellsPerRequest: ${state.server.maxCells},
  // { type: 'pivot', rows: TreeSpec, cols: TreeSpec, rowMaps, colMaps }: see "Server contract"
  getLayout: ({ query, signal }) => api('layout', { query }, signal),
  // One array of values per rectangle (rows / columns are positions in the expanded trees)
  getCells: async ({ rects, query, signal }) => (await api('cells', { rects, query }, signal)).cells,
  // Header titles: group names per level, leaf names at level = depth
  getLabels: async ({ axis, level, start, count, query, signal }) => (await api('labels', { axis, level, start, count, query }, signal)).names,
  // Distinct values of a dimension, for its filter dialog
  getFilterValues: ({ axis, level, search, limit, signal }) => api('values', { axis, level, search, limit }, signal),
};

${formatterCode()}

const grid = createGrid(document.getElementById('grid'), {
  dataSource,
  ariaLabel: 'Pivot table',
${indent(opts, 2)}${opts.length ? '\n' : ''}  format: (value) => (value == null ? '' : number.format(value)),${cond === 'negative' ? "\n  cellClass: (value) => (value < 0 ? 'negative' : '')," : cond === 'heatmap' ? "\n  // Heatmap: bucket each value within its measure's range (from your layout response)\n  cellClass: (value, { rowSource, colSource }) => heatClass(value, rowSource, colSource)," : cond === 'bars' ? "\n  renderCell: (el, { value, text }) => drawBar(el, value, text), // a bar behind the number" : ''}
  onCellDoubleClick: ({ rowSource, colSource }) => openRecords(rowSource, colSource), // drill-through
});

// Expand / collapse from code
// grid.showLevel('rows', 0); grid.expandAll('rows');`;
  }
  const cols = tableColumns();
  const colLines = cols.map((c) => {
    const parts = [`key: '${c.key}'`, `title: '${c.title.replace(/'/g, "\\'")}'`];
    if (c.type) parts.push(`type: '${c.type}'`);
    if (c.filter) parts.push(`filter: '${c.filter}'`);
    if (c.pinned) parts.push('pinned: true');
    if (c.type === 'number') parts.push('format: money');
    return `{ ${parts.join(', ')} },`;
  });
  return `import { createGrid, createRowSource } from '@borealjs/grid-core';
import '@borealjs/grid-core/style.css';

${formatterCode().replace('const number', 'const nf')}
const money = (value) => (value == null ? '' : nf.format(value));

const columns = [
${indent(colLines, 2)}
];

// Rows by offset / limit, as most REST, GraphQL and SQL backends serve them.
const dataSource = createRowSource({
  pageSize: ${state.server.pageSize},
  async getRows({ offset, limit, sort, filter, signal }) {
    const params = new URLSearchParams({ offset, limit, sort: JSON.stringify(sort), filter: JSON.stringify(filter) });
    const res = await fetch(\`/api/rows?\${params}\`, { signal });
    return res.json(); // { rows: [{ id, ... }], total }
  },
  async getFilterValues({ key, search, limit, signal }) {
    const res = await fetch(\`/api/values?key=\${key}&q=\${encodeURIComponent(search)}&limit=\${limit}\`, { signal });
    return res.json(); // { values: [...], total, matches }
  },
});

const grid = createGrid(document.getElementById('grid'), {
  dataSource,
  columns,
  getRowId: (row) => row.id,
  ariaLabel: 'Data table',
${indent(opts, 2)}${opts.length ? '\n' : ''}${state.grid.rowSelection ? '  rowSelection: true,\n  onRowSelectionChange: (sel) => console.log(sel),\n' : ''}${!state.grid.rowNumbers && !state.grid.rowSelection ? '  rowHeader: false,\n' : ''}  onCellDoubleClick: ({ row }) => openDetail(row),
});`;
}

function truncateJson(value, depth = 0) {
  if (Array.isArray(value)) {
    const head = value.slice(0, depth === 0 ? 3 : 6).map((v) => truncateJson(v, depth + 1));
    if (value.length > head.length) head.push(`… ${value.length - head.length} more`);
    return head;
  }
  if (ArrayBuffer.isView(value)) return `[${value.length} values]`;
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = truncateJson(v, depth + 1);
    return out;
  }
  return value;
}

function serverCode() {
  const show = (title, kind, pick = (s) => s) => {
    const s = samples[kind];
    if (!s) return `// ${title}: no request yet. Scroll or open a filter to make one.`;
    const { args, result } = pick(s);
    const { cfg, ...rest } = args ?? {};
    return `// ${title}\n// request\n${JSON.stringify(truncateJson(rest), null, 2)}\n// response\n${JSON.stringify(truncateJson(result), null, 2)}`;
  };
  const head = `// The exact requests this page just made and what the server answered (long arrays shortened).
// Implement these in your backend and the grid works the same way against it.\n\n`;
  if (state.mode === 'pivot') {
    return head + [
      show('getLayout: the row and column trees for the current sort and filters', 'layout', (s) => ({ args: s.args, result: (({ info, ...r }) => r)(s.result) })),
      show('getCells: values for the rectangles on screen', 'cells'),
      show('getLabels: header names', 'labels'),
      show('getFilterValues: a dimension’s values for its filter', 'values'),
    ].join('\n\n');
  }
  return head + [show('getRows: one page of the sorted, filtered rows', 'rows'), show('getFilterValues', 'values')].join('\n\n');
}

function renderCode() {
  $$('#codeSeg button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === codePart)));
  $('#codeOut').textContent = codePart === 'client' ? clientCode() : serverCode();
}
$('#codeBtn').addEventListener('click', () => { renderCode(); $('#codeDialog').showModal(); });
$('#codeSeg').addEventListener('click', (e) => { const v = e.target.closest('button')?.dataset.v; if (v) { codePart = v; renderCode(); } });
$('#copyCode').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#codeOut').textContent); toast('Code copied'); } catch { toast('Select the code and copy it'); }
});
$('#shareBtn').addEventListener('click', async () => {
  const copy = structuredClone(state);
  const url = `${location.origin}${location.pathname}#${btoa(unescape(encodeURIComponent(JSON.stringify(copy))))}`;
  try { await navigator.clipboard.writeText(url); toast(state.source.type === 'csv' ? 'Link copied (layout and settings; the CSV stays on your machine)' : 'Link copied: it rebuilds this exact dataset and view'); } catch { toast('Could not copy the link'); }
});

// ================================================================== wiring of simple controls

function bindSeg(id, get, set) {
  const seg = $(id);
  const paint = () => $$('button', seg).forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === get())));
  seg.addEventListener('click', (e) => {
    const v = e.target.closest('button')?.dataset.v;
    if (!v || v === get()) return;
    set(v);
    paint();
    saveState();
  });
  paint();
}

function applyTheme() {
  if (state.theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = state.theme;
}
bindSeg('#themeSeg', () => state.theme, (v) => { state.theme = v; applyTheme(); grid?.setOptions({ theme: v }); drillGrid?.setOptions({ theme: v }); setTimeout(renderPerf, 50); });
bindSeg('#modeSeg', () => state.mode, (v) => { state.mode = v; rebuildGrid(); });

$$('#sourceTabs button').forEach((b) => b.addEventListener('click', () => {
  $$('#sourceTabs button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
  $$('.tabpanel').forEach((p) => { p.hidden = p.dataset.panel !== b.dataset.tab; });
}));

// Generate form
const gen = $('#genForm');
function paintGen() {
  gen.rows.value = fmtInt(state.source.rows);
  gen.dims.value = state.source.dims;
  gen.measures.value = state.source.measures;
  gen.years.value = state.source.years;
  gen.seed.value = state.source.seed;
  $$('#rowPresets button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.rows) === state.source.rows)));
}
gen.addEventListener('submit', (e) => {
  e.preventDefault();
  state.source.rows = parseCount(gen.rows.value) || 1000;
  state.source.dims = clamp(Number(gen.dims.value) || 1, 1, 40);
  state.source.measures = clamp(Number(gen.measures.value) || 1, 1, 40);
  state.source.years = clamp(Number(gen.years.value) || 1, 1, 30);
  state.source.seed = Number(gen.seed.value) || 1;
  paintGen();
  generateData();
});
$('#rowPresets').addEventListener('click', (e) => {
  const v = e.target.closest('button')?.dataset.rows;
  if (!v) return;
  gen.rows.value = fmtInt(Number(v));
  gen.requestSubmit();
});

// Virtual data
const vf = $('#virtualForm');
function paintVirtual() {
  vf.rows.value = fmtInt(state.virtual.rows);
  vf.cols.value = fmtInt(state.virtual.cols);
  vf.years.value = state.virtual.years;
  $$('#virtualRowPresets button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.rows) === state.virtual.rows)));
}
vf.addEventListener('submit', (e) => {
  e.preventDefault();
  state.virtual.rows = parseCount(vf.rows.value) || 1;
  state.virtual.cols = parseCount(vf.cols.value) || 1;
  state.virtual.years = Number(vf.years.value) || 1;
  loadVirtual().then(paintVirtual);
});
$('#virtualRowPresets').addEventListener('click', (e) => {
  const v = e.target.closest('button')?.dataset.rows;
  if (!v) return;
  vf.rows.value = fmtInt(Number(v));
  vf.requestSubmit();
});

// CSV
const dz = $('#dropzone');
$('#csvFile').addEventListener('change', (e) => loadCsvFile(e.target.files[0]));
dz.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); dz.classList.add('over'); } });
dz.addEventListener('dragleave', () => dz.classList.remove('over'));
dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('over'); loadCsvFile(e.dataTransfer.files[0]); });
// A CSV dropped anywhere on the page loads too.
document.addEventListener('dragover', (e) => { if (!drag && [...(e.dataTransfer?.types ?? [])].includes('Files')) e.preventDefault(); });
document.addEventListener('drop', (e) => {
  if (drag || !e.dataTransfer?.files?.length || dz.contains(e.target)) return;
  e.preventDefault();
  loadCsvFile(e.dataTransfer.files[0]);
});
$('#sampleCsv').addEventListener('click', () => loadCsvText(sampleCsv(), 'service-metrics.csv'));

// Server simulation
function paintServer() {
  const s = state.server;
  $('#latency').value = s.latency;
  $('#latencyRange').value = Math.min(2000, s.latency);
  $('#jitter').value = s.jitter;
  $('#failRate').value = s.failRate;
  $('#pageSize').value = s.pageSize;
  $('#maxCells').value = s.maxCells;
  $$('#latencyPresets button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.ms) === s.latency)));
}
function setLatency(v) { state.server.latency = clamp(Math.round(Number(v) || 0), 0, 60000); paintServer(); saveState(); renderPerf(); }
$('#latency').addEventListener('input', (e) => setLatency(e.target.value));
$('#latencyRange').addEventListener('input', (e) => setLatency(e.target.value));
$('#latencyPresets').addEventListener('click', (e) => { const v = e.target.closest('button')?.dataset.ms; if (v !== undefined) setLatency(v); });
$('#jitter').addEventListener('input', (e) => { state.server.jitter = clamp(Number(e.target.value) || 0, 0, 10000); saveState(); });
$('#failRate').addEventListener('input', (e) => { state.server.failRate = clamp(Number(e.target.value) || 0, 0, 100); saveState(); });
// Page and request sizes are part of the data source: a new grid picks them up.
$('#pageSize').addEventListener('change', (e) => { state.server.pageSize = clamp(Number(e.target.value) || 100, 10, 5000); paintServer(); saveState(); if (state.mode === 'table') rebuildGrid(); });
$('#maxCells').addEventListener('change', (e) => { state.server.maxCells = clamp(Number(e.target.value) || 20000, 500, 200000); paintServer(); saveState(); if (state.mode === 'pivot') rebuildGrid(); });

// Grid options
const OPT_INPUTS = {
  optRowHeight: ['rowHeight', 'num', true], optHeaderHeight: ['headerHeight', 'num'], optColumnWidth: ['columnWidth', 'num', true], optSelection: ['selection', 'str'],
  optSortable: ['sortable', 'bool'], optMultiSort: ['multiSort', 'bool'], optFilterable: ['filterable', 'bool'], optResizable: ['resizable', 'bool'],
  optReorderable: ['reorderable', 'bool'], optExpandable: ['expandable', 'bool'], optCopy: ['copy', 'bool'], optKeyboard: ['keyboard', 'bool'],
  optNotices: ['notices', 'bool'], optRowSelection: ['rowSelection', 'bool'], optRowNumbers: ['rowNumbers', 'bool'], optZebra: ['zebra', 'bool'],
};
for (const [id, [key, type, pivotLayout]] of Object.entries(OPT_INPUTS)) {
  const el = $(`#${id}`);
  if (type === 'bool') el.checked = state.grid[key]; else el.value = state.grid[key];
  el.addEventListener('change', () => {
    state.grid[key] = type === 'bool' ? el.checked : type === 'num' ? clamp(Number(el.value) || DEFAULTS.grid[key], Number(el.min), Number(el.max)) : el.value;
    if (type === 'num') el.value = state.grid[key];
    saveState();
    // Pivot row heights and column widths come from the layout, so the pivot reloads.
    if (pivotLayout && state.mode === 'pivot') rebuildGrid(); else applyOptions();
  });
}
for (const [id, key] of [['fmtStyle', 'style'], ['fmtDecimals', 'decimals'], ['fmtConditional', 'conditional']]) {
  const el = $(`#${id}`);
  el.value = state.format[key];
  el.addEventListener('change', () => { state.format[key] = el.value; saveState(); applyOptions(); selectionStats(); });
}
$('#pinnedCount').value = state.table.pinned;

$('#togglePerf').addEventListener('click', () => {
  state.perfOpen = !state.perfOpen;
  paintPerfToggle();
  saveState();
  renderPerf();
});
function paintPerfToggle() {
  $('#layout').classList.toggle('no-perf', !state.perfOpen);
  $('#togglePerf').setAttribute('aria-pressed', String(state.perfOpen));
}

// ================================================================== start

// For poking at from the console: playground.grid.stats(), playground.grid.getQuery(), …
window.playground = { get grid() { return grid; }, get dataset() { return dataset; }, state, metrics };

applyTheme();
paintGen();
paintVirtual();
paintServer();
paintPerfToggle();
renderPerf();
if (location.hash) history.replaceState(null, '', location.pathname + location.search);
// A CSV can't be restored from storage; regenerate the last generated dataset (or the default one).
if (state.source.type === 'csv') { state.pivot = null; state.table.hidden = []; }
if (state.source.type === 'virtual') {
  $$('#sourceTabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === 'virtual')));
  $$('.tabpanel').forEach((p) => { p.hidden = p.dataset.panel !== 'virtual'; });
  loadVirtual();
} else generateData();
