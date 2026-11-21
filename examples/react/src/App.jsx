import { useEffect, useMemo, useRef, useState } from 'react';
import { VirtualGrid, Column, createHttpSource, useDataSource } from '@borealjs/react-grid';
import { EMPTY_QUERY } from '@borealjs/grid-core';
import { inBrowserFetch } from './inBrowserApi.js';

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
  const [theme, setTheme] = useState('auto');
  return (
    <div className={`app app-${theme}`}>
      <header className="bar">
        <strong>BorealJS Grid</strong>
        {IN_BROWSER && <a className="muted" href="https://github.com/borealjs/grid">GitHub</a>}
        <nav className="tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>{t.label}</button>
          ))}
        </nav>
        <label className="field">Theme
          <select value={theme} onChange={(e) => setTheme(e.target.value)}>
            <option value="auto">Auto</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
      </header>
      {tab === 'memory' && <InMemoryDemo theme={theme} />}
      {tab === 'custom' && <CustomBackendDemo theme={theme} />}
      {tab === 'pivot' && <PivotDemo theme={theme} />}
      {tab === 'huge' && <HugeTableDemo theme={theme} />}
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

function InMemoryDemo({ theme }) {
  const [count, setCount] = useState(200_000);
  const [seed, setSeed] = useState(1);
  // Plain React state: a new array updates the grid in place (scroll, sort and filter stay).
  const [rows, setRows] = useState(() => makeRows(200_000, 1));
  const [sort, setSort] = useState([{ key: 'amount', direction: 'desc' }]); // controlled
  const [filter, setFilter] = useState([]); // controlled
  const [highlight, setHighlight] = useState('');
  const [features, setFeatures] = useState({ sortable: true, filterable: true, multi: true });
  const [selection, setSelection] = useState(null);
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
        <label className="check"><input type="checkbox" checked={features.sortable} onChange={(e) => setFeatures({ ...features, sortable: e.target.checked })} /> Sorting</label>
        <label className="check"><input type="checkbox" checked={features.filterable} onChange={(e) => setFeatures({ ...features, filterable: e.target.checked })} /> Filters</label>
        <label className="check"><input type="checkbox" checked={features.multi} onChange={(e) => setFeatures({ ...features, multi: e.target.checked })} /> Range selection</label>
        <button type="button" onClick={() => setSort([])} disabled={!sort.length}>Clear sort</button>
        <button type="button" onClick={() => setFilter([])} disabled={!filter.length}>Clear filters</button>
      </div>
      {/* Columns as JSX, with inline functions: no useMemo needed. */}
      <VirtualGrid
        ref={grid}
        className="grid"
        aria-label="Customers"
        rows={rows}
        theme={theme}
        sortable={features.sortable}
        filterable={features.filterable}
        selection={features.multi ? 'multi' : 'single'}
        sort={sort}
        onSortChange={setSort}
        filter={filter}
        onFilterChange={setFilter}
        onSelectionChange={setSelection}
        filterFns={{ atLeast: (value, min) => value >= min }}
        emptyState={({ filtered }) => (filtered
          ? <div className="empty">No customers match. <button type="button" onClick={() => setFilter([])}>Clear filters</button></div>
          : <div className="empty">No customers yet.</div>)}
        onError={(err) => console.error(err)}
      >
        <Column field="id" title="ID" type="number" width={90} format={(v) => `#${v}`} />
        <Column
          field="name"
          title="Customer"
          width={200}
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
        {selection && <span>Cell {selection.active.r + 1}, {selection.active.c + 1}: {selection.text ?? '…'}{selection.cells > 1 ? ` · ${selection.cells.toLocaleString()} cells` : ''}</span>}
      </footer>
    </section>
  );
}

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
    async rows(term, start, n, signal) {
      await delay(120, signal);
      const p = plan(term);
      return Array.from({ length: n }, (_, i) => {
        const id = p.rowAt(start + i);
        return [id + 1, PRODUCTS[id % PRODUCTS.length], (id % 97) + 1, ((id * 7919) % 100000) / 100];
      });
    },
  };
})();

function CustomBackendDemo({ theme }) {
  const [term, setTerm] = useState('');
  // Callbacks may use props and state; when `term` changes the grid reloads in place.
  const source = useDataSource({
    getLayout: async ({ signal }) => ({ rowCount: await fakeApi.count(term, signal) }),
    getCells: ({ rects, signal }) => Promise.all(rects.map(async (r) => {
      const rows = await fakeApi.rows(term, r.row, r.rowCount, signal);
      return rows.map((line) => line.slice(r.col, r.col + r.colCount));
    })),
    maxRectsPerRequest: 1,
  }, [term]);
  return (
    <section className="demo">
      <div className="controls">
        <label className="field">Product contains <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="e.g. la" /></label>
        <span className="muted">10M rows from a pretend API with ~150 ms latency; the search runs "on the server".</span>
      </div>
      <VirtualGrid
        className="grid"
        aria-label="Orders"
        dataSource={source}
        theme={theme}
        filterable={false}
        sortable={false}
        emptyState="No products match."
      >
        <Column field="id" title="Order" type="number" format={(v) => `#${v}`} />
        <Column field="product" title="Product" renderCell={({ value }) => <strong>{value}</strong>} />
        <Column field="qty" title="Qty" type="number" />
        <Column field="price" title="Price" type="number" format={(v) => money.format(v)} />
      </VirtualGrid>
    </section>
  );
}

// ------------------------------------------------------------------ server pivot

function PivotDemo({ theme }) {
  const source = useMemo(() => serverSource({ mode: 'pivot', rows: 50_000, years: 10, latency: 40 }), []);
  const grid = useRef(null);
  const [levels, setLevels] = useState(null);
  return (
    <section className="demo">
      <div className="controls">
        {levels && ['rows', 'cols'].map((axis) => (
          <span key={axis} className="seg">
            <span className="muted">{axis === 'rows' ? 'Rows' : 'Cols'}</span>
            {levels[axis].map((l, i) => l.collapsible && <button key={l.name} type="button" onClick={() => grid.current.showLevel(axis, i)}>{l.name}</button>)}
            <button type="button" onClick={() => grid.current.expandAll(axis)}>All</button>
          </span>
        ))}
      </div>
      <VirtualGrid
        ref={grid}
        className="grid"
        aria-label="Sales pivot"
        dataSource={source}
        theme={theme}
        onReady={(g) => setLevels(g.levels)}
        cellClass={(value) => (typeof value === 'string' && value.startsWith('-') ? 'neg' : '')}
      />
    </section>
  );
}

// ------------------------------------------------------------------ server table, a billion rows

// The row limits are this demo backend's (it scans rows, with no index), not the grid's.
const fmtRows = (n) => n.toLocaleString();
const DEMO_LIMITS = {
  filterLimit: (limit, total) => `This demo's backend filters up to ${fmtRows(limit)} rows by scanning them, and this table has ${fmtRows(total)}. A backend with database indexes can filter tables of any size. The other tabs show filtering.`,
  sortLimit: (limit, total) => `This demo's backend sorts by several columns up to ${fmtRows(limit)} rows, and this table has ${fmtRows(total)}. A backend with database indexes can do it at any size.`,
};

function HugeTableDemo({ theme }) {
  const source = useMemo(() => serverSource({ mode: 'flat', rows: 1_000_000_000, cols: 1_000_000, latency: 40 }), []);
  const [layout, setLayout] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    source.getLayout({ query: EMPTY_QUERY }).then(setLayout, setError);
  }, [source]);
  // A million columns are described by index; titles come from the server (getLabels).
  const getColumn = useMemo(() => {
    if (!layout) return undefined;
    const kinds = layout.meta.columnKinds ?? [];
    const types = layout.meta.columnTypes ?? [];
    return (i) => {
      const k = kinds[i % kinds.length];
      return { group: types[i % types.length], type: k?.kind === 'number' ? 'number' : undefined, filter: k?.kind === 'values' ? { type: 'values', values: k.values } : k?.kind };
    };
  }, [layout]);
  if (error) return <p className="note">{IN_BROWSER ? 'Could not load the table' : 'Start the reference server first (npm start, port 5174)'}: {error.message}</p>;
  if (!layout) return <p className="note">Loading…</p>;
  return (
    <section className="demo">
      <VirtualGrid
        className="grid"
        aria-label="A billion rows"
        dataSource={source}
        layout={layout}
        columnCount={layout.columnCount}
        getColumn={getColumn}
        columnChooser
        columnGroups={layout.meta.columnTypes}
        messages={DEMO_LIMITS}
        theme={theme}
      />
    </section>
  );
}
