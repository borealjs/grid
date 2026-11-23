import { useEffect, useMemo, useRef, useState } from 'react';
import { VirtualGrid, Column, createHttpSource, useDataSource } from '@borealjs/react-grid';
import { EMPTY_QUERY, TreeAxis } from '@borealjs/grid-core';
import { inBrowserFetch } from './inBrowserApi.js';
import { OptionsPanel, useGridOptions, gridPropsOf, cssVarsOf } from './OptionsPanel.jsx';

// The static build (npm run build:pages, GitHub Pages) has no server: the server tabs then run the
// reference backend's code in the browser behind a fake fetch. Otherwise they call npm start through /api.
const IN_BROWSER = import.meta.env.MODE === 'pages';
const serverSource = (params) => createHttpSource({ baseUrl: '/api', params, ...(IN_BROWSER && { fetch: inBrowserFetch }) });

const TABS = [
  { id: 'memory', label: 'In-memory · React cells' },
  { id: 'custom', label: 'Custom backend' },
  { id: 'pivot', label: 'Server · pivot' },
  { id: 'huge', label: 'Server · 1B × 1M' },
];

export default function App() {
  const [tab, setTab] = useState('memory');
  const options = useGridOptions();
  const [panel, setPanel] = useState(() => window.matchMedia?.('(min-width: 1100px)').matches ?? true);
  const grid = gridPropsOf(options.values);
  const cssVars = cssVarsOf(options.values);
  return (
    <div className={`app app-${options.values.theme}`}>
      {cssVars && <style>{`.app .vg {\n${cssVars}\n}`}</style>}
      <header className="bar">
        <strong>BorealJS Grid</strong>
        <nav className="tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>{t.label}</button>
          ))}
        </nav>
        <nav className="links">
          <a href="https://github.com/borealjs/grid/tree/main/examples/vanilla">Plain JavaScript example</a>
          <a href="https://github.com/borealjs/grid/blob/main/examples/react/src/App.jsx">Source</a>
          <a href="https://github.com/borealjs/grid#readme">Docs</a>
        </nav>
        <button type="button" className={panel ? 'on' : ''} aria-expanded={panel} onClick={() => setPanel(!panel)}>Options</button>
      </header>
      <div className="main">
        {tab === 'memory' && <InMemoryDemo grid={grid} />}
        {tab === 'custom' && <CustomBackendDemo grid={grid} />}
        {tab === 'pivot' && <PivotDemo grid={grid} />}
        {tab === 'huge' && <HugeTableDemo grid={grid} />}
        {panel && <OptionsPanel options={options} onClose={() => setPanel(false)} />}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ in-memory rows, React cells

const STATUSES = ['Active', 'Pending', 'Closed', 'On hold'];
const FIRST = ['Ada', 'Grace', 'Linus', 'Margaret', 'Alan', 'Barbara', 'Ken', 'Radia', 'Edsger', 'Frances'];
const LAST = ['Lovelace', 'Hopper', 'Torvalds', 'Hamilton', 'Turing', 'Liskov', 'Thompson', 'Perlman', 'Dijkstra', 'Allen'];
const OWNERS = ['Ops', 'Sales', 'Support', 'Finance', 'Legal'];

function makeRows(n, seed = 1) {
  let s = seed >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rows = new Array(n);
  for (let i = 0; i < n; i++) {
    const day = new Date(Date.UTC(2020, 0, 1) + Math.floor(rnd() * 2000) * 86_400_000);
    rows[i] = {
      id: i + 1,
      name: `${FIRST[Math.floor(rnd() * FIRST.length)]} ${LAST[Math.floor(rnd() * LAST.length)]}`,
      status: STATUSES[Math.floor(rnd() * STATUSES.length)],
      progress: Math.round(rnd() * 100),
      amount: Math.round((rnd() * 12_000 - 2_000) * 100) / 100,
      signed: day.toISOString().slice(0, 10),
      owner: OWNERS[Math.floor(rnd() * OWNERS.length)],
      score: Math.round(rnd() * 1000) / 10,
    };
  }
  return rows;
}

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
/** Shows `text` with `term` highlighted. */
function Highlighted({ text, term }) {
  if (!term) return text;
  const i = text.toLowerCase().indexOf(term.toLowerCase());
  if (i < 0) return text;
  return <>{text.slice(0, i)}<mark>{text.slice(i, i + term.length)}</mark>{text.slice(i + term.length)}</>;
}

function Progress({ value }) {
  return (
    <span className="progress" role="meter" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100} aria-label="Progress">
      <span className="progress-bar" style={{ width: `${value}%` }} />
      <span className="progress-text">{value}%</span>
    </span>
  );
}

/** A custom filter: "score at least …" with a slider. The grid's Apply button sends setValue's value. */
function MinScoreFilter({ value, setValue }) {
  const [min, setMin] = useState(value ?? 50);
  useEffect(() => setValue(min), [min, setValue]);
  return (
    <label className="slider">
      <span>At least <b>{min}</b></span>
      <input type="range" min={0} max={100} step={1} value={min} onChange={(e) => setMin(Number(e.target.value))} />
    </label>
  );
}

const PersonIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="5" r="3" fill="currentColor" /><path d="M2 15c0-3.3 2.7-5 6-5s6 1.7 6 5z" fill="currentColor" /></svg>
);

const TITLES = { id: 'ID', name: 'Customer', status: 'Status', progress: 'Progress', amount: 'Amount', signed: 'Signed', owner: 'Owner', score: 'Score' };
const describeSort = (sort) => sort.map((s) => `${TITLES[s.key] ?? s.key} ${s.direction === 'desc' ? '▼' : '▲'}`).join(', ');
const describeFilter = (filter) => filter.map((f) => `${TITLES[f.key] ?? f.key} ${f.op}${f.values ? ` ${f.values.join(', ')}` : f.text ? ` "${f.text}"` : f.value !== undefined ? ` ${f.value}` : ''}`).join('; ');

function InMemoryDemo({ grid: gridProps }) {
  const [count, setCount] = useState(200_000);
  const [seed, setSeed] = useState(1);
  // Plain React state: a new array updates the grid in place (scroll, sort and filter stay).
  const [rows, setRows] = useState(() => makeRows(200_000, 1));
  // Controlled query: the grid reports what the user asks for (onQueryChange) and shows what we pass back.
  const [query, setQuery] = useState({ sort: [{ key: 'amount', direction: 'desc' }], filter: [] });
  const { sort, filter } = query;
  const clearFilters = () => setQuery((q) => ({ ...q, filter: [] }));
  const [highlight, setHighlight] = useState('');
  const [selection, setSelection] = useState(null);
  const [checked, setChecked] = useState({ checks: [] });
  const grid = useRef(null);

  return (
    <section className="demo">
      <div className="controls">
        <label className="field">Rows
          <select value={count} onChange={(e) => { const n = Number(e.target.value); setCount(n); setRows(makeRows(n, seed)); }}>
            {[0, 1_000, 200_000, 1_000_000].map((n) => <option key={n} value={n}>{n.toLocaleString()}</option>)}
          </select>
        </label>
        <button type="button" onClick={() => { const s = seed + 1; setSeed(s); setRows(makeRows(count, s)); }}>New data</button>
        <label className="field">Highlight <input value={highlight} onChange={(e) => setHighlight(e.target.value)} placeholder="name contains…" /></label>
        <button type="button" onClick={() => setQuery((q) => ({ ...q, sort: [] }))} disabled={!sort.length}>Clear sort</button>
        <button type="button" onClick={clearFilters} disabled={!filter.length}>Clear filters</button>
      </div>
      {/* Columns as JSX, with inline functions: no useMemo needed. */}
      <VirtualGrid
        ref={grid}
        className="grid"
        aria-label="Customers"
        data={rows}
        {...gridProps}
        query={query}
        onQueryChange={setQuery}
        onSelectionChange={setSelection}
        getRowId={(row) => row.id}
        rowSelection
        selectedRows={checked}
        onRowSelectionChange={setChecked}
        filterFns={{ atLeast: (value, min) => value >= min }}
        emptyState={({ filtered }) => (filtered
          ? <div className="empty">No customers match. <button type="button" onClick={clearFilters}>Clear filters</button></div>
          : <div className="empty">No customers yet.</div>)}
        onError={(err) => console.error(err)}
      >
        <Column field="id" title="ID" type="number" width={90} pinned format={(v) => `#${v}`} />
        <Column
          field="name"
          title="Customer"
          width={200}
          pinned
          renderHeader={(h) => <span className="hdr"><PersonIcon /> {h.label}</span>}
          renderCell={({ value }) => <Highlighted text={value} term={highlight} />}
        />
        <Column
          field="status"
          title="Status"
          width={120}
          filter="values"
          renderCell={({ value }) => <span className={`badge badge-${value.replace(/\s/g, '').toLowerCase()}`}>{value}</span>}
        />
        <Column field="progress" title="Progress" type="number" width={150} renderCell={({ value }) => <Progress value={value} />} />
        <Column field="amount" title="Amount" type="number" width={130} format={(v) => money.format(v)} cellClass={(v) => (v < 0 ? 'neg' : '')} />
        <Column field="signed" title="Signed" type="date" width={120} />
        <Column field="owner" title="Owner" width={110} filter="values" />
        <Column field="score" title="Score" type="number" width={110} filter={{ op: 'atLeast', render: (api) => <MinScoreFilter {...api} /> }} />
        <Column
          field="link"
          title="Open"
          width={90}
          pinned="right"
          sortable={false}
          filter={false}
          value={(row) => row.id}
          renderCell={({ row }) => <a className="link" href={`#customer-${row.id}`} title={`${row.name} · ${row.owner}`}>Open ↗</a>}
        />
      </VirtualGrid>
      <footer className="status">
        <span>Sort: {sort.length ? describeSort(sort) : 'none'}</span>
        <span>Filter: {filter.length ? describeFilter(filter) : 'none'}</span>
        <span>{rows.length.toLocaleString()} rows loaded</span>
        <span>{describeChecked(grid.current, checked)}</span>
        {selection && <span>Cell {selection.active.r + 1}, {selection.active.c + 1}: {selection.text ?? '…'}{selection.cells > 1 ? ` · ${selection.cells.toLocaleString()} cells` : ''}</span>}
      </footer>
    </section>
  );
}

// Checked rows are steps (ids and position ranges); the grid counts them when it can without the server.
const describeChecked = (grid, sel) => {
  if (!sel.checks.length) return 'None checked';
  const n = grid?.checkedCount();
  return n === undefined ? 'Some rows checked' : `${n.toLocaleString()} checked`;
};

// ------------------------------------------------------------------ custom backend (useDataSource)

/** A pretend API: 10 million orders, filtered by a search term on the "server", with network delay. */
const fakeApi = (() => {
  const TOTAL = 10_000_000;
  const PRODUCTS = ['Lamp', 'Desk', 'Chair', 'Shelf', 'Kettle', 'Monitor', 'Fan', 'Drill'];
  const product = (i) => PRODUCTS[(i * 2654435761) % PRODUCTS.length];
  const delay = (ms, signal) => new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); });
  });
  // Rows whose product contains the term: a fixed stride pattern, so counting and indexing stay O(1).
  const plan = (term) => {
    const keep = PRODUCTS.map((p, k) => (p.toLowerCase().includes(term.toLowerCase()) ? k : -1)).filter((k) => k >= 0);
    const stride = PRODUCTS.length;
    return { count: Math.floor((TOTAL / stride) * keep.length), rowAt: (i) => Math.floor(i / keep.length) * stride + keep[i % keep.length] };
  };
  return {
    async count(term, signal) {
      await delay(150, signal);
      return plan(term).count;
    },
    /** GET /orders?q=&offset=&limit= -> { rows, total }: the shape most REST APIs have. */
    async orders(term, offset, limit, signal) {
      await delay(150, signal);
      const p = plan(term);
      const n = Math.max(0, Math.min(limit, p.count - offset));
      const rows = Array.from({ length: n }, (_, i) => {
        const id = p.rowAt(offset + i);
        return { id: id + 1, product: PRODUCTS[id % PRODUCTS.length], qty: (id % 97) + 1, price: ((id * 7919) % 100000) / 100 };
      });
      return { rows, total: p.count };
    },
  };
})();

function CustomBackendDemo({ grid: gridProps }) {
  const [term, setTerm] = useState('');
  const [open, setOpen] = useState(null);
  const [menu, setMenu] = useState(null);
  const grid = useRef(null);
  const [checked, setChecked] = useState({ checks: [] });
  // getRows: pages of rows by offset / limit. Callbacks may use props and state; when `term` changes the
  // grid reloads in place.
  const source = useDataSource({
    getRows: ({ offset, limit, signal }) => fakeApi.orders(term, offset, limit, signal),
  }, [term]);
  useEffect(() => {
    if (!menu) return undefined;
    const close = () => setMenu(null);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [menu]);
  return (
    <section className="demo">
      <div className="controls">
        <label className="field">Product contains <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="e.g. la" /></label>
        <span className="muted">10M orders from a pretend REST API (offset / limit, ~150 ms). Double-click a row to open it; right-click for a menu.</span>
      </div>
      <div className="split">
        <VirtualGrid
          ref={grid}
          className="grid"
          aria-label="Orders"
          data={source}
          {...gridProps}
          getRowId={(row) => row.id}
          rowSelection
          selectedRows={checked}
          onRowSelectionChange={setChecked}
          onCellDoubleClick={({ row }) => row && setOpen(row)}
          onCellContextMenu={({ row, event }) => {
            if (!row || !('clientX' in event)) return;
            event.preventDefault();
            setMenu({ row, x: event.clientX, y: event.clientY });
          }}
          filterable={false}
          sortable={false}
          emptyState="No products match."
        >
          <Column field="id" title="Order" type="number" format={(v) => `#${v}`} />
          <Column field="product" title="Product" renderCell={({ value }) => <strong>{value}</strong>} />
          <Column field="qty" title="Qty" type="number" />
          <Column field="price" title="Price" type="number" format={(v) => money.format(v)} />
          <Column
            field="actions"
            title=""
            width={110}
            sortable={false}
            filter={false}
            renderCell={({ row }) => row && <button type="button" className="link-btn" onClick={() => setOpen(row)}>Open</button>}
          />
        </VirtualGrid>
        {open && (
          <aside className="detail">
            <header><strong>Order #{open.id}</strong><button type="button" onClick={() => setOpen(null)} aria-label="Close">×</button></header>
            <dl>
              <dt>Product</dt><dd>{open.product}</dd>
              <dt>Quantity</dt><dd>{open.qty}</dd>
              <dt>Price</dt><dd>{money.format(open.price)}</dd>
              <dt>Total</dt><dd>{money.format(open.price * open.qty)}</dd>
            </dl>
          </aside>
        )}
      </div>
      {menu && (
        <ul className="menu" style={{ left: menu.x, top: menu.y }} onPointerDown={(e) => e.stopPropagation()}>
          <li><button type="button" onClick={() => { setOpen(menu.row); setMenu(null); }}>Open order #{menu.row.id}</button></li>
          <li><button type="button" onClick={() => { navigator.clipboard?.writeText(String(menu.row.id)); setMenu(null); }}>Copy order number</button></li>
        </ul>
      )}
      <footer className="status">
        <span>{describeChecked(grid.current, checked)}</span>
      </footer>
    </section>
  );
}

// ------------------------------------------------------------------ server tabs: controls and stats

const fmt = (n) => Number(n).toLocaleString('en-US');
const parseCount = (text) => Number(String(text).replace(/[,_\s]/g, ''));
const LATENCIES = [0, 40, 150, 500, 1000];

/**
 * Size and latency of the demo backend's data (applied with Load, so typing doesn't reload), plus
 * "go to row / column". `fields` lists the size inputs: [{ name, label, value }].
 */
function ServerToolbar({ fields, latency, onLoad, grid, children }) {
  const [draft, setDraft] = useState(() => Object.fromEntries(fields.map((f) => [f.name, fmt(f.value)])));
  const [lat, setLat] = useState(latency);
  const [goto, setGoto] = useState({ row: '', col: '' });
  const load = (e) => {
    e.preventDefault();
    const next = {};
    for (const f of fields) {
      const n = parseCount(draft[f.name]);
      if (Number.isSafeInteger(n) && n >= (f.min ?? 0) && n <= f.max) next[f.name] = n;
    }
    onLoad({ ...next, latency: lat });
  };
  const go = (e) => {
    e.preventDefault();
    const row = parseCount(goto.row || '1');
    const col = parseCount(goto.col || '1');
    if (!Number.isFinite(row) || !Number.isFinite(col)) return;
    grid.current?.scrollToCell(Math.max(0, row - 1), Math.max(0, col - 1));
    grid.current?.focus();
  };
  return (
    <div className="controls">
      <form className="seg" onSubmit={load}>
        {fields.map((f) => (
          <label key={f.name} className="field" title={f.title}>{f.label}
            <input value={draft[f.name]} onChange={(e) => setDraft({ ...draft, [f.name]: e.target.value })} inputMode="numeric" size={f.size ?? 13} />
          </label>
        ))}
        <label className="field">Latency
          <select value={lat} onChange={(e) => setLat(Number(e.target.value))}>
            {LATENCIES.map((ms) => <option key={ms} value={ms}>{ms} ms</option>)}
          </select>
        </label>
        <button type="submit">Load</button>
      </form>
      <form className="seg" onSubmit={go}>
        <label className="field">Row <input value={goto.row} onChange={(e) => setGoto({ ...goto, row: e.target.value })} inputMode="numeric" size={13} placeholder="734,000,123" /></label>
        <label className="field">Col <input value={goto.col} onChange={(e) => setGoto({ ...goto, col: e.target.value })} inputMode="numeric" size={7} placeholder="1" /></label>
        <button type="submit">Go</button>
      </form>
      {children}
    </div>
  );
}

/** Timing of the last sort or filter: "Filtered to 83,333,333 rows in 24.1 s". */
function useViewTiming() {
  const started = useRef(0);
  const [last, setLast] = useState(null);
  const onViewChange = (info) => {
    if (info.pending) {
      if (!info.progress) started.current = performance.now();
      return;
    }
    const seconds = (performance.now() - started.current) / 1000;
    const verb = info.what === 'sort' ? 'Sorted' : info.what === 'columns' ? 'Columns updated' : 'Filtered';
    if (info.cancelled) setLast(`${info.what === 'sort' ? 'Sort' : 'Filter'} cancelled after ${seconds.toFixed(1)} s`);
    else if (info.ok) setLast(`${verb}${info.what === 'filter' ? ` to ${fmt(info.rows)} rows` : ''} in ${seconds < 1 ? `${Math.round(seconds * 1000)} ms` : `${seconds.toFixed(1)} s`}`);
  };
  return [last, onViewChange];
}

/** What the grid is doing, refreshed four times a second: rows and columns on screen, render time, requests. */
function StatsBar({ grid, timing }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(t);
  }, []);
  const g = grid.current;
  const s = g?.stats();
  const v = g?.visibleRange;
  if (!g || !s || !v) return <footer className="status">Loading…</footer>;
  const q = g.getQuery();
  const parts = [
    `Rows ${fmt(v.firstRow + 1)}–${fmt(v.lastRow + 1)} of ${fmt(g.rowCount)}`,
    `Cols ${fmt(v.firstCol + 1)}–${fmt(v.lastCol + 1)} of ${fmt(g.columnCount)}`,
    `render ${s.renderMsEma.toFixed(1)} ms avg, ${s.renderMsMax.toFixed(1)} max`,
    `${fmt(s.cache.requests)} ${s.cache.requests === 1 ? 'request' : 'requests'} (${fmt(s.cache.gatherRequests)} batched, ${fmt(s.cache.aborted)} cancelled)`,
    `${fmt(s.cache.cellsFetched)} cells loaded`,
    `${s.cache.inflight} loading`,
  ];
  if (s.cache.lastMs) parts.push(`last response ${Math.round(s.cache.lastMs)} ms`);
  if (q.filter.length || q.sort.length) parts.unshift(`${q.sort.length} sort · ${q.filter.length} filter`);
  if (timing) parts.unshift(timing);
  return <footer className="status" aria-live="off">{parts.join('  ·  ')}</footer>;
}

// ------------------------------------------------------------------ server pivot

// Merged cells set from code (grid.setMerges). Positions are in the fully expanded pivot, worked out from
// the data source's pivot layout with TreeAxis, so they cross group boundaries: collapse the city or quarter
// a merge crosses and it splits into a piece on each side.
function pivotDemoMerges(rt, ct) {
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

async function showMerges(grid, source, where) {
  const layout = await source.getLayout({ query: EMPTY_QUERY });
  const rows = new TreeAxis(layout.rows);
  grid.setMerges(pivotDemoMerges(rows, new TreeAxis(layout.cols)));
  const row = where === 'edge' ? rows.fromSource(rows.fullItemStart[2][0] + rows.fullItems[2][0] - 4, true) : 0;
  grid.scrollToCell(row, 0);
}

function PivotDemo({ grid: gridProps }) {
  const [params, setParams] = useState({ rows: 50_000, years: 10, latency: 40 });
  const source = useMemo(() => serverSource({ mode: 'pivot', ...params }), [params]);
  const grid = useRef(null);
  const [levels, setLevels] = useState(null);
  const [timing, onViewChange] = useViewTiming();
  return (
    <section className="demo">
      <ServerToolbar
        grid={grid}
        latency={params.latency}
        onLoad={setParams}
        fields={[{ name: 'rows', label: 'Products', value: params.rows, max: 1e9 }, { name: 'years', label: 'Years of columns', title: 'Each year adds 68 columns: 4 measures × (12 months + 4 quarter totals + a year total)', value: params.years, min: 1, max: 20_000, size: 6 }]}
      >
        {levels && ['rows', 'cols'].map((axis) => (
          <span key={axis} className="seg">
            <span className="muted">{axis === 'rows' ? 'Rows' : 'Cols'}</span>
            {levels[axis].map((l, i) => l.collapsible && <button key={l.name} type="button" onClick={() => grid.current.showLevel(axis, i)}>{l.name}</button>)}
            <button type="button" onClick={() => grid.current.expandAll(axis)}>All</button>
          </span>
        ))}
        {levels && (
          <span className="seg">
            <span className="muted">Merged cells</span>
            <button type="button" onClick={() => showMerges(grid.current, source, 'top')}>Show</button>
            <button type="button" onClick={() => showMerges(grid.current, source, 'edge')}>Across a city</button>
            <button type="button" onClick={() => grid.current.setMerges([])}>Clear</button>
          </span>
        )}
      </ServerToolbar>
      <VirtualGrid
        key={JSON.stringify(params)}
        ref={grid}
        className="grid"
        aria-label="Sales pivot"
        data={source}
        {...gridProps}
        onReady={(g) => setLevels(g.levels)}
        onViewChange={onViewChange}
        cellClass={(value) => (typeof value === 'string' && value.startsWith('-') ? 'neg' : '')}
      />
      <StatsBar grid={grid} timing={timing} />
    </section>
  );
}

// ------------------------------------------------------------------ server table, a billion rows

// Sorting by several columns is limited by this demo backend (it sorts in memory), not by the grid.
const DEMO_LIMITS = {
  sortLimit: (limit, total) => `This demo's backend sorts by several columns up to ${fmt(limit)} rows (it sorts in memory), and this table has ${fmt(total)}. A backend with database indexes can do it at any size. Sort by one column, or load fewer rows.`,
  filterLimit: (limit, total) => `This demo's backend filters up to ${fmt(limit)} rows, and this table has ${fmt(total)}. Load fewer rows to filter.`,
};

function HugeTableDemo({ grid: gridProps }) {
  const [params, setParams] = useState({ rows: 1_000_000_000, cols: 1_000_000, latency: 40 });
  const source = useMemo(() => serverSource({ mode: 'flat', ...params }), [params]);
  const grid = useRef(null);
  const [layout, setLayout] = useState(null);
  const [error, setError] = useState(null);
  const [timing, onViewChange] = useViewTiming();
  const [checked, setChecked] = useState({ checks: [] });
  useEffect(() => {
    setLayout(null);
    source.getLayout({ query: EMPTY_QUERY }).then(setLayout, setError);
  }, [source]);
  if (error) return <p className="note">{IN_BROWSER ? 'Could not load the table' : 'Start the reference server first (npm run dev, port 5174)'}: {error.message}</p>;
  return (
    <section className="demo">
      <ServerToolbar
        grid={grid}
        latency={params.latency}
        onLoad={setParams}
        fields={[{ name: 'rows', label: 'Rows', value: params.rows, max: 1e14 }, { name: 'cols', label: 'Columns', value: params.cols, max: 1e12, size: 11 }]}
      >
        <span className="muted">Filtering a billion rows scans them all here (about half a minute); the grid shows progress and lets you cancel.</span>
        <span className="muted">{describeChecked(grid.current, checked)}</span>
      </ServerToolbar>
      {layout ? (
        <VirtualGrid
          key={JSON.stringify(params)}
          ref={grid}
          className="grid"
          aria-label="A billion rows"
          data={source}
          layout={layout}
          columnCount={layout.columnCount}
          columnChooser
          pinnedColumns={1}
          rowSelection
          selectedRows={checked}
          onRowSelectionChange={setChecked}
          onViewChange={onViewChange}
          {...gridProps}
          messages={{ ...DEMO_LIMITS, ...gridProps.messages }}
        />
      ) : <p className="note grid">Loading…</p>}
      <StatsBar grid={grid} timing={timing} />
    </section>
  );
}
