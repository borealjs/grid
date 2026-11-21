// Unit tests for the engine's pure building blocks (no DOM): axes, merges, selection geometry,
// clipboard helpers and cache keys. Imported from the TypeScript sources (npm test loads them with tsx).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TreeAxis, UniformAxis, ResizableAxis, createTableModel, EMPTY_QUERY } from '../packages/grid-core/src/index.ts';
import { MergeIndex, mergePieces, normalizeMerge } from '../packages/grid-core/src/engine/merges.ts';
import { cellRange, spanRange, inRanges, cellCount } from '../packages/grid-core/src/engine/selection.ts';
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

test('selection geometry grows ranges over merged cells', () => {
  const pieces = [{ key: 'm', merge: {}, vr0: 2, vr1: 4, vc0: 1, vc1: 2 }];
  assert.deepEqual(cellRange(pieces, { r: 3, c: 2 }), { r0: 2, c0: 1, r1: 4, c1: 2 });
  assert.deepEqual(spanRange(pieces, { r: 0, c: 0 }, { r: 3, c: 1 }), { r0: 0, c0: 0, r1: 4, c1: 2 });
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
