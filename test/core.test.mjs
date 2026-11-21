// npm test   (node --test, with tsx for the TypeScript sources). The public API is tested on the built bundle. The HTTP source test starts server.mjs on a free port.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createArraySource, createHttpSource, createRowSource, compareValues, EMPTY_QUERY } from '../packages/grid-core/dist/index.js';
import { sortFromPublic, sortToPublic, filterFromPublic, filterToPublic, columnFilterFromPublic, columnFilterToPublic } from '../packages/grid-core/src/query.ts';

const rows = [
  { id: 1, name: 'Item 10', city: 'Oslo', amount: 5, day: '2024-03-01' },
  { id: 2, name: 'item 2', city: 'Lima', amount: -3, day: '2023-12-31' },
  { id: 3, name: 'Item 1', city: 'Oslo', amount: null, day: '2024-01-15' },
  { id: 4, name: 'Item 3', city: 'Pune', amount: 5, day: '2024-02-29' },
];
const columns = [{ key: 'id' }, { key: 'name' }, { key: 'city' }, { key: 'amount' }, { key: 'day' }];
const q = (over) => ({ ...EMPTY_QUERY, ...over });
const ids = async (src, query) => {
  const { rowCount } = await src.getLayout({ query });
  if (!rowCount) return [];
  const [cells] = await src.getCells({ rects: [{ row: 0, col: 0, rowCount, colCount: 1 }], query });
  return cells.map((r) => r[0]);
};

test('compareValues: numbers, natural text, empties last', () => {
  assert.ok(compareValues(2, 10) < 0);
  assert.ok(compareValues('Item 2', 'Item 10') < 0);
  assert.ok(compareValues(null, 1) > 0);
  assert.ok(compareValues(1, '') < 0);
});

test('array source: layout, cells, multi-key stable sort', async () => {
  const src = createArraySource(rows, { columns });
  assert.deepEqual(await src.getLayout({ query: EMPTY_QUERY }), { rowCount: 4, totalRowCount: 4, columnCount: 5 });
  const [block] = await src.getCells({ rects: [{ row: 1, col: 1, rowCount: 2, colCount: 2 }], query: EMPTY_QUERY });
  assert.deepEqual(block, [['item 2', 'Lima'], ['Item 1', 'Oslo']]);
  assert.deepEqual(await ids(src, q({ sort: [{ column: 1, direction: 'asc' }] })), [3, 2, 4, 1]); // natural, case-insensitive
  assert.deepEqual(await ids(src, q({ sort: [{ column: 3, direction: 'desc' }] })), [1, 4, 2, 3]); // ties keep order, empty last also when descending
  assert.deepEqual(await ids(src, q({ sort: [{ column: 2, direction: 'asc' }, { column: 0, direction: 'desc' }] })), [2, 3, 1, 4]);
});

test('array source: filters (range, dates, in, notin, contains, custom)', async () => {
  const src = createArraySource(rows, { columns, filterFns: { even: (v, on) => (v % 2 === 0) === on } });
  assert.deepEqual(await ids(src, q({ filter: [{ column: 3, op: 'range', min: 0 }] })), [1, 4]);
  assert.deepEqual(await ids(src, q({ filter: [{ column: 4, op: 'range', min: '2024-01-01', max: '2024-02-29' }] })), [3, 4]);
  assert.deepEqual(await ids(src, q({ filter: [{ column: 2, op: 'in', values: ['Oslo'] }] })), [1, 3]);
  assert.deepEqual(await ids(src, q({ filter: [{ column: 2, op: 'notin', values: ['Oslo'] }] })), [2, 4]);
  assert.deepEqual(await ids(src, q({ filter: [{ column: 1, op: 'contains', text: 'ITEM 1' }] })), [1, 3]);
  assert.deepEqual(await ids(src, q({ filter: [{ column: 0, op: 'even', value: true }] })), [2, 4]);
  assert.deepEqual(await ids(src, q({ filter: [{ column: 2, op: 'in', values: ['Oslo'] }], sort: [{ column: 0, direction: 'desc' }] })), [3, 1]);
  await assert.rejects(() => src.getLayout({ query: q({ filter: [{ column: 0, op: 'nope' }] }) }), /no filter function/);
});

test('array source: value lists with search and limit; setRows', async () => {
  const src = createArraySource(rows, { columns });
  assert.deepEqual(await src.getFilterValues({ column: 2, search: '', limit: 1000 }), { total: 3, matches: 3, values: ['Lima', 'Oslo', 'Pune'] });
  assert.deepEqual(await src.getFilterValues({ column: 2, search: 'L', limit: 1 }), { total: 3, matches: 2, values: ['Lima'] });
  src.setRows(rows.slice(0, 2));
  assert.equal((await src.getLayout({ query: EMPTY_QUERY })).rowCount, 2);
});

test('query format round-trips through the internal format', () => {
  const keyOf = (c) => ['id', 'name'][c];
  const colOfKey = (k) => ['id', 'name'].indexOf(k);
  const sort = [{ key: 'name', direction: 'desc' }, { level: 1, direction: 'asc' }];
  assert.deepEqual(sortToPublic(sortFromPublic(sort, colOfKey), keyOf), [{ column: 1, key: 'name', direction: 'desc' }, { level: 1, direction: 'asc' }]);
  const filter = [{ column: 0, op: 'range', min: 1 }, { key: 'name', op: 'in', values: ['a'] }, { level: 2, op: 'contains', text: 'x' }, { column: 1, op: 'mine', value: { a: 1 } }];
  assert.deepEqual(filterToPublic(filterFromPublic(filter, colOfKey), keyOf), [
    { column: 0, key: 'id', op: 'range', min: 1 },
    { column: 1, key: 'name', op: 'in', values: ['a'] },
    { level: 2, op: 'contains', text: 'x' },
    { column: 1, key: 'name', op: 'mine', value: { a: 1 } },
  ]);
  assert.deepEqual(columnFilterToPublic(columnFilterFromPublic([{ level: 3, op: 'notin', values: ['Jan'] }])), [{ level: 3, op: 'notin', values: ['Jan'] }]);
  assert.throws(() => sortFromPublic([{ key: 'missing', direction: 'asc' }], colOfKey), /unknown column/);
});

test('http source speaks the reference protocol (server.mjs)', async (t) => {
  const port = 5300 + Math.floor(Math.random() * 500);
  const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
  t.after(() => server.kill());
  const base = `http://127.0.0.1:${port}/api`;
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${base}/meta`);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const flat = createHttpSource({ baseUrl: base, params: { mode: 'flat', rows: 100_000, cols: 40 } });
  const layout = await flat.getLayout({ query: EMPTY_QUERY });
  assert.equal(layout.type, 'table');
  assert.equal(layout.rowCount, 100_000);
  const inQ = q({ filter: [{ column: 2, op: 'in', values: ['Accra'] }] });
  const outQ = q({ filter: [{ column: 2, op: 'notin', values: ['Accra'] }] });
  const a = (await flat.getLayout({ query: inQ })).rowCount;
  const b = (await flat.getLayout({ query: outQ })).rowCount;
  assert.equal(a + b, 100_000);
  const one = await flat.getCells({ rects: [{ row: 0, col: 0, rowCount: 2, colCount: 3 }], query: EMPTY_QUERY });
  assert.equal(one.cells[0].length, 6);
  const many = await flat.getCells({ rects: [{ row: 5, col: 1, rowCount: 1, colCount: 2 }, { row: 9, col: 0, rowCount: 2, colCount: 1 }], query: inQ });
  assert.deepEqual(many.cells.map((c) => c.length), [2, 2]);

  const pivot = createHttpSource({ baseUrl: base, params: { mode: 'pivot', rows: 5000, years: 3 } });
  const pl = await pivot.getLayout({ query: q({ sort: [{ level: 0, direction: 'desc' }], columnFilter: [{ level: 1, op: 'in', values: ['FY 2002'] }] }) });
  assert.equal(pl.type, 'pivot');
  assert.equal(pl.cols.fanout[0].length, 4); // measures
  assert.ok(pl.rowMaps);
  const names = await pivot.getLabels({ axis: 'cols', level: 1, start: 0, count: 3, query: EMPTY_QUERY });
  assert.deepEqual(names, ['FY 2001', 'FY 2002', 'FY 2003']);
  const vals = await pivot.getFilterValues({ axis: 'cols', level: 1, search: '2002', limit: 1000, query: EMPTY_QUERY });
  assert.deepEqual(vals, { total: 3, matches: 1, values: ['FY 2002'] });
});

test('demo backend: big filters are exact, and sorted results stay sorted', async () => {
  const { handleApiRequest } = await import('../demo-backend.mjs');
  const call = async (path, extra) => (await handleApiRequest({ url: new URL(`http://x/api/${path}?mode=flat&rows=6000000&cols=8&latency=0${extra}`) })).body;
  const f = (cond) => `&filter=${encodeURIComponent(JSON.stringify([cond]))}`;
  // 6M rows is above the exact-list limit, so this goes through the chunked path.
  const inOslo = await call('meta', f({ c: 2, op: 'in', v: ['Oslo'] }));
  const notOslo = await call('meta', f({ c: 2, op: 'notin', v: ['Oslo'] }));
  assert.equal(inOslo.rows + notOslo.rows, 6_000_000);
  for (const r0 of [0, 123_457, inOslo.rows - 3]) {
    const block = await call('block', `${f({ c: 2, op: 'in', v: ['Oslo'] })}&r0=${r0}&c0=2&nr=3&nc=1`);
    assert.deepEqual(block.cells, ['Oslo', 'Oslo', 'Oslo']);
  }
  const sorted = await call('block', `${f({ c: 2, op: 'in', v: ['Oslo'] })}&sort=3:d&r0=1000&c0=2&nr=50&nc=2`);
  const amounts = sorted.cells.filter((_, i) => i % 2 === 1).map(Number);
  assert.ok(sorted.cells.filter((_, i) => i % 2 === 0).every((c) => c === 'Oslo'));
  assert.ok(amounts.every((a, i) => i === 0 || amounts[i - 1] >= a), 'descending by amount');
});

test('http source reports progress of a slow filter and can cancel it', async (t) => {
  const port = 5800 + Math.floor(Math.random() * 500);
  const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
  t.after(() => server.kill());
  const base = `http://127.0.0.1:${port}/api`;
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${base}/meta`);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const src = createHttpSource({ baseUrl: base, params: { mode: 'flat', rows: 400_000_000, cols: 8, latency: 0 } });
  const query = q({ filter: [{ column: 5, op: 'in', values: ['Active'] }] });
  const seen = [];
  const ctrl = new AbortController();
  const pending = src.getLayout({ query, signal: ctrl.signal, onProgress: (p) => seen.push(p) });
  while (!seen.length) await new Promise((r) => setTimeout(r, 100));
  assert.equal(seen[0].phase, 'Checking rows');
  assert.equal(seen[0].total, 400_000_000);
  ctrl.abort();
  await assert.rejects(pending, (err) => err.name === 'AbortError');
  // The server stops the scan once nobody waits for it.
  let progress;
  for (let i = 0; i < 20; i++) {
    progress = await (await fetch(`${base}/progress?mode=flat&rows=400000000&cols=8&filter=${encodeURIComponent(JSON.stringify([{ c: 5, op: 'in', v: ['Active'] }]))}`)).json();
    if (!progress.active) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(progress.active, false);
});

test('array source: indexOfRow finds a row in the sorted / filtered view', async () => {
  const src = createArraySource(rows, { columns });
  const byId = (row) => row.id;
  const sorted = q({ sort: [{ column: 1, key: 'name', direction: 'asc' }] });
  assert.equal(await src.indexOfRow(2, sorted, byId), 1); // Item 1, item 2, Item 3, Item 10
  assert.equal(await src.indexOfRow(1, sorted, byId), 3);
  assert.equal(await src.indexOfRow(2, q({ filter: [{ column: 2, key: 'city', op: 'in', values: ['Oslo'] }] }), byId), -1);
});

test('row source: pages by offset / limit, cells by key, shared requests, row lookup', async () => {
  const data = Array.from({ length: 250 }, (_, i) => ({ id: `r${i}`, n: i, label: `Row ${i}` }));
  const calls = [];
  const src = createRowSource({
    pageSize: 100,
    columns: [{ key: 'label' }, { key: 'n' }, { key: 'twice', value: (row) => row.n * 2 }],
    async getRows({ offset, limit, sort, filter }) {
      calls.push([offset, limit, sort.length, filter.length]);
      await new Promise((r) => setTimeout(r, 5));
      const list = filter.length ? data.filter((d) => d.n % 2 === 0) : data;
      return { rows: list.slice(offset, offset + limit), total: list.length };
    },
  });
  const query = q();
  assert.deepEqual(await src.getLayout({ query }), { rowCount: 250, totalRowCount: 250, columnCount: 3 });
  // Two calls asking for the same pages share one request each.
  const rect = { row: 95, col: 0, rowCount: 10, colCount: 3 };
  const [a, b] = await Promise.all([src.getCells({ rects: [rect], query }), src.getCells({ rects: [rect], query })]);
  assert.deepEqual(a, b);
  assert.deepEqual(a[0].slice(0, 3), ['Row 95', 95, 190]);
  assert.deepEqual(calls, [[0, 100, 0, 0], [100, 100, 0, 0]]);
  // Records are known once loaded (cell renderers get ctx.row), and ids can be found among them.
  assert.equal(src.rowAt(104, query).id, 'r104');
  assert.equal(src.rowAt(240, query), undefined);
  assert.equal(await src.indexOfRow('r150', query, (row) => row.id), 150);
  assert.equal(await src.indexOfRow('r240', query, (row) => row.id), -1);
  // A filtered view has its own pages and keeps the unfiltered total.
  const filtered = q({ filter: [{ key: 'n', op: 'even' }] });
  assert.deepEqual(await src.getLayout({ query: filtered }), { rowCount: 125, totalRowCount: 250, columnCount: 3 });
  src.clearCache();
  assert.equal(src.rowAt(104, query), undefined);
});

test('row source: a page request is aborted only when every caller gave up', async () => {
  let aborted = 0;
  const src = createRowSource({
    columns: ['n'],
    getRows: ({ signal }) => new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve({ rows: [{ n: 1 }], total: 1 }), 30);
      signal.addEventListener('abort', () => { aborted++; clearTimeout(t); reject(new Error('aborted')); });
    }),
  });
  const one = new AbortController();
  const two = new AbortController();
  const rect = { row: 0, col: 0, rowCount: 1, colCount: 1 };
  const p1 = src.getCells({ rects: [rect], query: q(), signal: one.signal });
  const p2 = src.getCells({ rects: [rect], query: q(), signal: two.signal });
  one.abort();
  await assert.rejects(p1);
  assert.equal(aborted, 0);
  assert.deepEqual(await p2, [[1]]);
});
