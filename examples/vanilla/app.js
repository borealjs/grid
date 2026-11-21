// Demo of @borealjs/grid-core against the reference server (server.mjs): the grid only sees a data source.
import { createGrid, createHttpSource, EMPTY_QUERY } from '../../packages/grid-core/dist/index.js';

const fmt = new Intl.NumberFormat('en-US');
const parseCount = (s) => Number(String(s).replace(/[,_\s]/g, ''));

const params = new URLSearchParams(location.search);
const mode = params.get('mode') === 'flat' ? 'flat' : 'pivot';
const apiParams = new URLSearchParams({ mode });
for (const key of ['rows', 'cols', 'years', 'latency']) {
  if (params.has(key)) apiParams.set(key, params.get(key));
}

const source = createHttpSource({ baseUrl: '/api', params: Object.fromEntries(apiParams) });
// Read the layout once here (the grid reuses it). A million columns are described by the server on demand
// (its /columns request: title, type, filter, group, width), so nothing about them is listed up front; the
// column chooser on the "#" corner asks the server for the groups.
const layout = await source.getLayout({ query: EMPTY_QUERY });
const shape = layout.type === 'table' ? { layout, columnCount: layout.columnCount, columnChooser: true } : { layout };

// Toast for copy results -----------------------------------------------------
const toast = document.createElement('div');
toast.className = 'toast';
toast.setAttribute('role', 'status');
toast.setAttribute('aria-live', 'polite');
document.body.appendChild(toast);
let toastTimer = 0;
function showToast(message, isError = false) {
  toast.textContent = message;
  toast.classList.toggle('toast-error', isError);
  toast.classList.add('toast-show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('toast-show'), isError ? 4000 : 2200);
}

const grid = createGrid(document.getElementById('grid'), {
  dataSource: source,
  ...shape,
  // The grid's own notices show slow sorts and filters (with Cancel) and refusals; this page adds toasts
  // for results and copies.
  // The row limits are this demo backend's (it scans rows, with no index), not the grid's.
  messages: {
    filterLimit: (limit, total) => `This demo's backend filters up to ${fmt.format(limit)} rows by scanning them, and this table has ${fmt.format(total)}. A backend with database indexes can filter tables of any size. Set fewer rows above to try filtering here.`,
    sortLimit: (limit, total) => `This demo's backend sorts by several columns up to ${fmt.format(limit)} rows, and this table has ${fmt.format(total)}. A backend with database indexes can do it at any size. Set fewer rows above to try it here.`,
  },
  onViewChange: (info) => {
    if (info.pending) return;
    if (info.cancelled) return showToast(`${info.what === 'sort' ? 'Sort' : 'Filter'} cancelled`);
    if (!info.ok) return;
    if (info.what === 'columns') {
      const dropped = info.droppedSorts ? ` · ${info.droppedSorts} column sort${info.droppedSorts > 1 ? 's' : ''} cleared (columns moved)` : '';
      return showToast(info.filter ? `Showing ${fmt.format(info.cols)} columns · ${info.filter}${dropped}` : `Column filter cleared${dropped}`);
    }
    if (info.what === 'filter') {
      return showToast(info.filter ? `Showing ${fmt.format(info.rows)}${info.totalRows ? ` of ${fmt.format(info.totalRows)}` : ''} rows · ${info.filter}` : 'Filter cleared');
    }
    showToast(info.sort ? `Sorted by ${info.sort}` : 'Sort cleared');
  },
});
await grid.ready;
const engine = grid.engine; // the demo reads internals (axes, stats) for its status bar and merge demo
const model = engine.model;

// Merges set from code (pivot demo) ----------------------------------------
// Source coordinates, built from the pivot structure so they cross group boundaries: collapse the
// city / quarter they cross and they split into a piece on each side.
function pivotDemoMerges() {
  const rt = model.rows;
  const ct = model.cols.base;
  const cityStart = (g) => rt.fullItemStart[2][g];
  const citySubtotal = (g) => rt.fullItemStart[2][g] + rt.fullItems[2][g] - 1;
  const monthStart = (q) => ct.fullItemStart[2][q];
  const quarterTotal = (q) => ct.fullItemStart[2][q] + ct.fullItems[2][q] - 1;
  const r = cityStart(0);
  const acrossCityTop = citySubtotal(0) - 1;
  const acrossCityBottom = cityStart(2) + 1;
  return [
    { r0: r + 1, c0: monthStart(0), nr: 1, nc: 3 },
    { r0: r + 3, c0: monthStart(1), nr: 4, nc: 3 },
    { r0: r + 8, c0: quarterTotal(0), nr: 2, nc: quarterTotal(1) - quarterTotal(0) + 2, label: 'Q1 total → Jul (collapse Q2 to split)' },
    { r0: acrossCityTop, c0: monthStart(0), nr: acrossCityBottom - acrossCityTop + 1, nc: 2, label: 'Spans a whole city (collapse it to split)' },
  ];
}
const demoRow = () => model.rows.fromSource(model.rows.fullItemStart[2][0] + model.rows.fullItems[2][0] - 4, true);

if (layout.type === 'pivot') {
  const box = document.createElement('span');
  box.className = 'seg-buttons';
  const title = document.createElement('span');
  title.className = 'seg-title';
  title.textContent = 'Merges';
  box.appendChild(title);
  const add = (text, run) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = text;
    btn.addEventListener('click', run);
    box.appendChild(btn);
  };
  add('Demo', () => {
    grid.setMerges(pivotDemoMerges());
    grid.scrollToCell(0, 0);
  });
  add('City edge', () => {
    grid.setMerges(pivotDemoMerges());
    grid.scrollToCell(demoRow(), 0);
  });
  add('Clear', () => grid.setMerges([]));
  document.getElementById('levels').appendChild(box);
}
window.grid = grid;
window.engine = engine; // handy for poking at it from devtools

// Toolbar ------------------------------------------------------------------
const dims = document.getElementById('dims');
const showModeFields = () => {
  for (const el of dims.querySelectorAll('[data-mode]')) el.hidden = el.dataset.mode !== dims.mode.value;
  dims.querySelector('[data-rows-label]').textContent = dims.mode.value === 'pivot' ? 'Leaf rows' : 'Rows';
};
dims.mode.value = mode;
dims.rows.value = params.has('rows') ? fmt.format(parseCount(params.get('rows'))) : fmt.format(1_000_000_000);
dims.cols.value = params.has('cols') ? fmt.format(parseCount(params.get('cols'))) : fmt.format(1_000_000);
dims.years.value = params.get('years') ?? '10';
dims.latency.value = params.get('latency') ?? '40';
showModeFields();
dims.mode.addEventListener('change', showModeFields);
dims.addEventListener('submit', (e) => {
  e.preventDefault();
  const next = new URLSearchParams({ mode: dims.mode.value });
  const rows = parseCount(dims.rows.value);
  const cols = parseCount(dims.cols.value);
  const years = parseCount(dims.years.value);
  if (Number.isSafeInteger(rows) && rows >= 0) next.set('rows', String(rows));
  if (dims.mode.value === 'flat' && Number.isSafeInteger(cols) && cols >= 0) next.set('cols', String(cols));
  if (dims.mode.value === 'pivot' && Number.isSafeInteger(years) && years > 0) next.set('years', String(years));
  next.set('latency', dims.latency.value);
  location.search = next.toString();
});

// Expand/collapse by level: "Rows: Region · Country · City · All" -----------
const levelsBox = document.getElementById('levels');
if (model.levels) {
  levelsBox.hidden = false;
  for (const axis of ['rows', 'cols']) {
    const wrap = document.createElement('span');
    wrap.className = 'seg-buttons';
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', `Show ${axis} down to level`);
    const title = document.createElement('span');
    title.className = 'seg-title';
    title.textContent = axis === 'rows' ? 'Rows' : 'Cols';
    wrap.appendChild(title);
    const add = (text, run) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = text;
      btn.addEventListener('click', run);
      wrap.appendChild(btn);
    };
    model.levels[axis].forEach((level, i) => {
      if (level.collapsible) add(level.name, () => grid.showLevel(axis, i));
    });
    add('All', () => grid.expandAll(axis));
    levelsBox.appendChild(wrap);
  }
}

const goto = document.getElementById('goto');
goto.addEventListener('submit', (e) => {
  e.preventDefault();
  const row = parseCount(goto.row.value || '1');
  const col = parseCount(goto.col.value || '1');
  if (!Number.isFinite(row) || !Number.isFinite(col)) return;
  grid.scrollToCell(row - 1, col - 1);
  grid.focus();
});

// Status bar -----------------------------------------------------------------
const status = document.getElementById('status');
function updateStatus() {
  const s = grid.stats();
  const v = grid.visibleRange;
  const parts = [];
  const sel = grid.selectionInfo();
  const value = sel.text === undefined ? '…' : sel.text === '' ? '(empty)' : sel.text;
  if (engine.filterSpec.length) parts.push(`Filtered: ${engine.filterSummary()}`);
  if (engine.sortSpec.length) parts.push(`Sorted by ${engine.sortSummary()}`);
  parts.push(`Cell ${fmt.format(sel.active.r + 1)}, ${fmt.format(sel.active.c + 1)}: ${value}`);
  if (sel.cells > 1) parts.push(`selected ${sel.ranges > 1 ? `${sel.ranges} ranges, ` : ''}${fmt.format(sel.rows)} × ${fmt.format(sel.cols)}${sel.ranges > 1 ? ' (last)' : ''} = ${fmt.format(sel.cells)} cells`);
  if (v) {
    parts.push(`Rows ${fmt.format(v.firstRow + 1)}–${fmt.format(v.lastRow + 1)} of ${fmt.format(grid.rowCount)}${engine.filterSpec.length && model.totalRows ? ` (filtered from ${fmt.format(model.totalRows)})` : ''}`);
    parts.push(`Cols ${fmt.format(v.firstCol + 1)}–${fmt.format(v.lastCol + 1)} of ${fmt.format(grid.columnCount)}`);
  }
  parts.push(`render ${s.renderMsEma.toFixed(2)} ms avg · ${s.renderMsMax.toFixed(2)} ms max`);
  parts.push(`blocks ${s.cache.cached} cached · ${s.cache.inflight} loading · ${s.cache.queued} queued`);
  parts.push(`${fmt.format(s.cache.requests)} requests (${fmt.format(s.cache.gatherRequests)} gathered, ${fmt.format(s.cache.aborted)} cancelled${s.cache.errors ? `, ${s.cache.errors} failed` : ''})`);
  parts.push(`${fmt.format(s.cache.cellsFetched)} cells fetched`);
  if (engine.merges.size) parts.push(`${fmt.format(engine.merges.code.size)} code + ${fmt.format(engine.merges.server.size)} server merges`);
  if (s.cache.lastMs) parts.push(`last fetch ${Math.round(s.cache.lastMs)} ms`);
  if (engine.ratioY > 1) parts.push(`scrollbar scaled ×${fmt.format(Math.round(engine.ratioY))}`);
  status.textContent = parts.join('  ·  ');
}
setInterval(updateStatus, 250);
updateStatus();
grid.focus();
