// Unit tests for the engine's pure building blocks (no DOM): axes, merges, selection geometry,
// clipboard helpers and cache keys. Imported from the TypeScript sources (npm test loads them with tsx).
import { test } from 'node:test';
import assert from 'node:assert/strict';
// Internals are not exported from the package: tests import them from their modules.
import { TreeAxis } from '../packages/grid-core/src/index.ts';
import { UniformAxis } from '../packages/grid-core/src/axes/axis.ts';
import { ResizableAxis } from '../packages/grid-core/src/axes/resizable.ts';
import { createTableModel } from '../packages/grid-core/src/model/table.ts';
import { EMPTY_QUERY } from '../packages/grid-core/src/query.ts';
import { RunOrder } from '../packages/grid-core/src/model/column-order.ts';
import { MergeIndex, mergePieces, normalizeMerge } from '../packages/grid-core/src/engine/merges.ts';
import { cellRange, rangeOf, isActiveOnly, inRanges, cellCount } from '../packages/grid-core/src/engine/selection.ts';
import { buildCopy, coalesceRects, batchRects, planCopy, tsvField } from '../packages/grid-core/src/engine/clipboard.ts';
import { lookupCell, classifyRuns, labelKey, parseLabelKey } from '../packages/grid-core/src/engine/blocks.ts';
import { sortParamOf, filterParamOf, viewKeyId, parseViewKeyId } from '../packages/grid-core/src/query.ts';

// Two regions × three countries × four cities; regions and countries have subtotals, plus a grand total.
const spec = {
  levels: [{ name: 'Region', subtotal: true }, { name: 'Country', subtotal: true }],
  leafName: 'City',
  leafSize: 10,
  roots: 2,
  fanout: [3, 4],
  grandTotal: true,
};

test('TreeAxis: layout, lookups and source mapping', () => {
  const t = new TreeAxis(spec);
  // Per region: 3 × (4 cities + 1 subtotal) + 1 subtotal = 16; two regions + grand total = 33.
  assert.equal(t.count, 33);
  assert.equal(t.total, 330);
  assert.deepEqual(t.locate(0), { kind: 'leaf', level: 2, path: [0, 0], leafInGroup: 0, leaf: 0 });
  assert.equal(t.locate(4).kind, 'subtotal'); // first country's total
  assert.equal(t.locate(15).kind, 'subtotal'); // first region's total
  assert.equal(t.locate(32).kind, 'grand');
  for (const i of [0, 4, 15, 16, 31, 32]) assert.equal(t.indexAt(t.offsetOf(i)), i);
  for (let i = 0; i < t.count; i++) assert.equal(t.fromSource(t.sourceOf(i)), i);
});

test('TreeAxis: collapsing keeps source indexes stable', () => {
  const t = new TreeAxis(spec);
  const regionTotal = t.sourceOf(15);
  t.toggle(0, 0); // collapse region 0 into one item standing for its subtotal
  assert.equal(t.count, 33 - 15);
  assert.equal(t.locate(0).kind, 'collapsed');
  assert.equal(t.sourceOf(0), regionTotal);
  assert.equal(t.fromSource(3), -1); // a city inside the collapsed region
  assert.equal(t.fromSource(3, true), 0); // ... shown by the collapsed item
  assert.equal(t.anchorSourceOf(0), 0); // anchored at the region's first item
  t.showLevel(1); // every country collapsed, regions open
  assert.equal(t.count, 2 * (3 + 1) + 1);
  t.expandAll();
  assert.equal(t.count, 33);
});

test('ResizableAxis keeps overrides by source index', () => {
  const tree = new TreeAxis(spec);
  const axis = new ResizableAxis(tree);
  axis.setSize(5, 50); // a city in the second country
  assert.equal(axis.total, 330 + 40);
  assert.equal(axis.sizeOf(5), 50);
  assert.equal(axis.indexAt(axis.offsetOf(6)), 6);
  tree.toggle(1, 0); // collapse the first country: the resized city moves up by 4 items
  axis.refresh();
  assert.equal(axis.sizeOf(1), 50);
  const flat = new ResizableAxis(new UniformAxis(100, 20));
  flat.setSize(10, 20); // same as the base size: no override
  assert.equal(flat.keys.length, 0);
});

test('merges: validation, priority, and splitting around collapsed items', () => {
  assert.equal(normalizeMerge({ r0: 0, c0: 0, nr: 1, nc: 1 }, true), null); // 1×1
  assert.equal(normalizeMerge([0, -1, 2, 2], true), null);
  const index = new MergeIndex();
  index.addServer([[0, 0, 2, 2, 'server']]);
  index.setCode([{ r0: 1, c0: 1, nr: 2, nc: 2, label: 'code' }]);
  const cover = new Uint8Array(4 * 4);
  const src = Float64Array.from([0, 1, 2, 3]);
  const exact = Uint8Array.from([1, 1, 1, 1]);
  const pieces = mergePieces(index, 0, src, exact, 0, src, exact, cover);
  // The code merge wins; the server merge overlaps it and is dropped.
  assert.deepEqual(pieces.map((p) => p.merge.label), ['code']);
  assert.deepEqual([...cover], [0, 0, 0, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0]);
  // Row 1 stands for many source rows (a collapsed group): a tall merge splits into a piece before it
  // and a piece after it, and the collapsed row keeps its own value.
  index.setCode([{ r0: 0, c0: 0, nr: 4, nc: 1 }]);
  const split = mergePieces(index, 0, src, Uint8Array.from([1, 0, 1, 1]), 0, src, exact, cover);
  assert.deepEqual(split.filter((p) => p.merge.code).map((p) => [p.vr0, p.vr1]), [[0, 0], [2, 3]]);
  assert.equal(cover[1 * 4 + 0], 0);
});

test('selection geometry: a merged cell is one cell, ranges stay as drawn', () => {
  const pieces = [{ key: 'm', merge: {}, vr0: 2, vr1: 4, vc0: 1, vc1: 2 }];
  assert.deepEqual(cellRange(pieces, { r: 3, c: 2 }), { r0: 2, c0: 1, r1: 4, c1: 2 });
  // A range that only touches a merged cell does not grow to cover it.
  assert.deepEqual(rangeOf({ r: 3, c: 1 }, { r: 0, c: 0 }), { r0: 0, c0: 0, r1: 3, c1: 1 });
  // The clicked cell inside a merged cell, or the whole merged cell, counts as just the active cell.
  assert.ok(isActiveOnly(pieces, { r0: 3, c0: 2, r1: 3, c1: 2 }, { r: 3, c: 2 }));
  assert.ok(isActiveOnly(pieces, { r0: 2, c0: 1, r1: 4, c1: 2 }, { r: 3, c: 2 }));
  assert.ok(!isActiveOnly(pieces, { r0: 2, c0: 1, r1: 3, c1: 2 }, { r: 3, c: 2 }));
  assert.ok(inRanges([{ r0: 0, c0: 0, r1: 1, c1: 1 }], 1, 1));
  assert.equal(cellCount([{ r0: 0, c0: 0, r1: 1, c1: 2 }, { r0: 5, c0: 5, r1: 5, c1: 5 }]), 7);
});

test('copy: rect coalescing, batching, TSV + HTML output', () => {
  const missing = new Map([[0, new Set([1, 2])], [1, new Set([1, 2])], [2, new Set([5])]]);
  assert.deepEqual(coalesceRects(missing), [[0, 1, 2, 2], [2, 5, 1, 1]]);
  assert.deepEqual(batchRects([[0, 0, 1, 3], [1, 0, 1, 3], [2, 0, 1, 3]], 2).map((b) => b.length), [2, 1]);
  assert.equal(tsvField('a\tb'), '"a\tb"');
  assert.equal(tsvField('say "hi"'), '"say ""hi"""');
  const index = new MergeIndex();
  index.setCode([{ r0: 0, c0: 0, nr: 1, nc: 2, label: 'AB' }]);
  const plan = planCopy({ r0: 0, c0: 0, r1: 1, c1: 1 }, { rowSource: (r) => r, colSource: (c) => c, merges: index });
  const out = buildCopy([plan], (rs, cs) => `${rs}${cs}`);
  assert.equal(out.text, 'AB\t\n10\t11');
  assert.match(out.html, /<td colspan="2">AB<\/td><\/tr><tr><td>10<\/td><td>11<\/td>/);
});

test('cache keys and lookups', () => {
  const blocks = new Map([
    ['0:0', { r0: 0, c0: 0, nr: 2, nc: 2, cells: ['a', 'b', 'c', 'd'] }],
    ['R7:0', { r0: 7, c0: 0, nr: 1, nc: 2, cells: ['x', 'y'] }],
  ]);
  const get = (k) => blocks.get(k);
  assert.equal(lookupCell(get, 1, 1, 100, 20), 'd');
  assert.equal(lookupCell(get, 7, 1, 2, 20), 'y'); // not in a dense block: found in the row strip
  assert.equal(lookupCell(get, 50, 50, 100, 20), undefined);
  assert.deepEqual(parseLabelKey(labelKey('cols', 1, 1234)), { axis: 'cols', level: 1, from: 1000 });
  const { isDense } = classifyRuns(0, 9, (i) => (i < 6 ? i : 100 + 2 * i), 4);
  assert.deepEqual([...isDense], [1, 1, 1, 1, 1, 1, 0, 0, 0, 0]);
});

test('query signatures and view key ids', () => {
  assert.equal(sortParamOf([{ key: { col: 3 }, dir: 'd' }, { key: { dim: 1 }, dir: 'a' }]), '3:d,L1:a');
  // Equal filters give equal signatures whatever their order.
  assert.equal(filterParamOf([{ c: 2, op: 'in', v: ['a'] }, { dim: 0, op: 'contains', v: 'x' }]), filterParamOf([{ dim: 0, op: 'contains', v: 'x' }, { c: 2, op: 'in', v: ['a'] }]));
  for (const key of [{ col: 4 }, { dim: 2 }, { cdim: 0 }]) assert.deepEqual(parseViewKeyId(viewKeyId(key)), key);
});

test('table model: hidden columns, groups, keys and filter descriptions', async () => {
  const columns = [
    { key: 'name', title: 'Name', group: 'Info' },
    { key: 'secret', hidden: true },
    { key: 'amount', type: 'number', group: 'Money', width: 90 },
    { key: 'status', filter: { type: 'values', values: ['On', 'Off'] }, group: 'Info' },
  ];
  const source = { getCells: () => [], getLayout: () => ({ rowCount: 10 }) };
  const model = createTableModel({ columns }, { rowCount: 10 }, source);
  assert.equal(model.cols.count, 3);
  assert.deepEqual([0, 1, 2].map((c) => model.colSource(c)), [0, 2, 3]);
  assert.equal(model.colOfKey('amount'), 2);
  assert.equal(model.cols.sizeOf(1), 90);
  assert.equal(model.columnInfo(2).cls, ' vg-end');
  const label = () => undefined;
  assert.deepEqual(model.filterOptions({ col: 2 }, label), { kind: 'number', name: 'amount' });
  assert.deepEqual(model.filterOptions({ col: 3 }, label), { kind: 'values', name: 'status', values: ['On', 'Off'] });
  assert.deepEqual(model.filterOptions({ cdim: 0 }, label), { kind: 'values', values: ['Info', 'Money'], name: 'Columns' });
  // A column filter on groups hides the "Money" column.
  await model.applyView({ sort: '', filter: '', colfilter: JSON.stringify([{ dim: 0, op: 'in', v: ['Info'] }]), query: EMPTY_QUERY });
  assert.deepEqual([0, 1].map((c) => model.colSource(c)), [0, 3]);
  assert.equal(model.cols.count, 2);
});

test('table model: columns pinned left and right, with hidden columns and a column order', () => {
  const columns = [
    { key: 'a' }, { key: 'b', pinned: 'right' }, { key: 'c', pinned: 'left' }, { key: 'd', hidden: true }, { key: 'e' }, { key: 'f', pinned: 'right', width: 60 },
  ];
  const source = { getCells: () => [], getLayout: () => ({ rowCount: 3 }) };
  const model = createTableModel({ columns, columnOrder: ['f', 'e', 'b', 'a', 'c', 'd'] }, { rowCount: 3 }, source);
  // Left-pinned c first, then e, a, then the right-pinned f, b (in their order); hidden d is skipped.
  const shown = () => Array.from({ length: model.cols.count }, (_, i) => model.colSource(i));
  assert.deepEqual(shown(), [2, 4, 0, 5, 1]);
  assert.equal(model.pinnedCols(), 1);
  assert.equal(model.pinnedColsRight(), 2);
  assert.equal(model.cols.sizeOf(3), 60);
  // A new order keeps the pinned columns on their sides.
  model.setColumnOrder(['b', 'a', 'f', 'e', 'c', 'd']);
  assert.deepEqual(shown(), [2, 0, 4, 1, 5]);
  // pinnedColumnsRight overrides the marks, and never takes columns already pinned on the left.
  const counted = createTableModel({ columnCount: 1_000_000, getColumn: (i) => ({ title: `C${i}` }), pinnedColumns: 2, pinnedColumnsRight: 3 }, { rowCount: 3 }, source);
  assert.equal(counted.pinnedColsRight(), 3);
  const tiny = createTableModel({ columnCount: 3, pinnedColumns: 2, pinnedColumnsRight: 5 }, { rowCount: 3 }, source);
  assert.equal(tiny.pinnedColsRight(), 1);
});

test('table model: column order, pinned columns first, row checkbox band', () => {
  const columns = [
    { key: 'a' }, { key: 'b', pinned: true }, { key: 'c', hidden: true }, { key: 'd' }, { key: 'e', pinned: true, width: 50 },
  ];
  const source = { getCells: () => [], getLayout: () => ({ rowCount: 3 }) };
  const model = createTableModel({ columns, columnOrder: ['d', 'a'], rowSelection: true }, { rowCount: 3 }, source);
  // Pinned b and e come first (in their order), then d, a; hidden c is skipped.
  assert.deepEqual(Array.from({ length: model.cols.count }, (_, i) => model.colSource(i)), [1, 4, 3, 0]);
  assert.equal(model.pinnedCols(), 2);
  assert.deepEqual(model.columnOrder(), [1, 4, 3, 0, 2]);
  assert.equal(model.cols.base.fromSource(0), 3);
  assert.equal(model.cols.base.fromSource(2), -1);
  // Widths follow their column, whatever its place.
  assert.equal(model.cols.sizeOf(1), 50);
  model.setColumnOrder([0, 3, 2, 1, 4]);
  assert.deepEqual(Array.from({ length: model.cols.count }, (_, i) => model.colSource(i)), [1, 4, 0, 3]);
  assert.equal(model.rowBands[0].width, 100);
  const noNumbers = createTableModel({ columns, rowHeader: false, rowSelection: true }, { rowCount: 3 }, source);
  assert.equal(noNumbers.rowBands[0].width, 40);
  assert.equal(createTableModel({ columns, rowHeader: false }, { rowCount: 3 }, source).rowBands.length, 0);
});

test('table model: row sources load the first page of a new sort with progress', async () => {
  const calls = [];
  const source = {
    layoutOnSort: true,
    getCells: () => [],
    getLayout: ({ query, onProgress }) => { calls.push(query.sort.length); onProgress?.({ done: 1, total: 1 }); return { rowCount: 7 }; },
  };
  const model = createTableModel({ columns: [{ key: 'a' }] }, { rowCount: 7 }, source);
  const progress = [];
  await model.applyView({ sort: '0:a', filter: '', colfilter: '', query: { sort: [{ column: 0, direction: 'asc' }], filter: [], columnFilter: [] }, onProgress: (p) => progress.push(p) });
  await model.applyView({ sort: '0:a', filter: '', colfilter: '', query: { sort: [{ column: 0, direction: 'asc' }], filter: [], columnFilter: [] } });
  assert.deepEqual(calls, [1]);
  assert.equal(progress.length, 1);
});

test('run order: moves, lookups and the compact form stay small at a trillion columns', () => {
  const n = 1e12;
  const order = new RunOrder(n);
  assert.ok(order.identity);
  order.move(9, 5); // column 9 now sits at position 5
  order.move(n - 1, 0); // the last column first
  assert.deepEqual(order.toCompact(), [n - 1, [0, 4], 9, [5, 8], [10, n - 2]]);
  assert.equal(order.sourceOf(0), n - 1);
  assert.equal(order.sourceOf(6), 9);
  assert.equal(order.sourceOf(7), 5);
  assert.equal(order.fromSource(9), 6);
  assert.equal(order.fromSource(n - 2), n - 1);
  const back = RunOrder.fromCompact(n, order.toCompact());
  assert.deepEqual(back.toCompact(), order.toCompact());
  // Overlaps are dropped, missing columns appended in order.
  assert.deepEqual(RunOrder.fromCompact(10, [[2, 4], 3, 8]).toCompact(), [[2, 4], 8, [0, 1], [5, 7], 9]);
  assert.deepEqual(RunOrder.fromList(5, [3, 4, 0]).toCompact(), [[3, 4], [0, 2]]);
});

test('table model: very wide tables pin leading columns and reorder without a full order', () => {
  const source = { getCells: () => [], getLayout: () => ({ rowCount: 3 }) };
  const model = createTableModel({ columnCount: 1_000_000, getColumn: (i) => ({ title: `C${i}` }), pinnedColumns: 2, columnOrder: [[0, 4], 9, [5, 8]] }, { rowCount: 3 }, source);
  assert.equal(model.cols.count, 1_000_000);
  assert.equal(model.pinnedCols(), 2);
  assert.equal(model.colSource(5), 9);
  model.moveColumn(999_999, 3);
  assert.equal(model.colSource(3), 999_999);
  assert.deepEqual(model.columnOrder(), [[0, 2], 999_999, [3, 4], 9, [5, 8], [10, 999_998]]);
  assert.ok(model.columnOrder().length < 10);
});

test('table model: columns described on demand, merged under code, renumbered by a server column filter', async () => {
  const described = new Map([[5, { title: 'Amount 5', type: 'number', width: 90, filter: 'number' }]]);
  let columnCount = 1_000_000;
  const source = { getCells: () => [], getColumns: () => [], getLayout: () => ({ rowCount: 10, columnCount }), getFilterValues: () => ({ values: ['A', 'B'] }) };
  const model = createTableModel({ getColumn: (i) => (i === 5 ? { format: (v) => '$' + v } : undefined), columnChooser: true }, { rowCount: 10, columnCount }, source);
  assert.equal(model.describedColumns, true);
  assert.equal(model.serverColFilter, true);
  model.describe = (src) => described.get(src);
  // Not described yet: plain, and asking for the label is what loads the description.
  const asked = [];
  const label = (axis, level, idx) => { asked.push(idx); return undefined; };
  assert.equal(model.colSegments(4, 4, label)[0].label, undefined);
  assert.deepEqual(asked, [4]);
  assert.equal(model.columnInfo(4).cls, '');
  // Described: the server's type and title, code's format on top.
  const info = model.columnInfo(5);
  assert.equal(info.cls, ' vg-end');
  assert.equal(info.format(3), '$3');
  assert.equal(model.colSegments(5, 5, () => 'ignored')[0].label, 'Amount 5');
  assert.deepEqual(model.filterOptions({ col: 5 }, label), { kind: 'number', name: 'Amount 5' });
  // The column chooser asks the data source for groups instead of scanning a million columns.
  const chooser = model.filterOptions({ cdim: 0 }, label);
  assert.deepEqual(await chooser.search('', new AbortController().signal), { values: ['A', 'B'] });
  // A column filter: the server renumbers the columns; the count comes from its layout.
  columnCount = 250_000;
  await model.applyView({ sort: '', filter: '', colfilter: '[{"dim":0,"op":"in","v":["A"]}]', query: { sort: [], filter: [], columnFilter: [{ level: 0, op: 'in', values: ['A'] }] } });
  assert.equal(model.cols.count, 250_000);
});
