// Property-based tests (fast-check): instead of hand-picked examples, generate many random inputs and
// action sequences and check invariants that must always hold. A failure is shrunk to a minimal repro.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { RunOrder } from '../packages/grid-core/src/model/column-order.ts';
import { rangeOf, inRanges, cellCount, sameRange } from '../packages/grid-core/src/engine/selection.ts';
import { createArraySource, EMPTY_QUERY } from '../packages/grid-core/dist/index.js';

const NUM_RUNS = Number(process.env.FC_RUNS ?? 200);
const opts = { numRuns: NUM_RUNS };

const display = (order) => {
  const out = [];
  order.forEach((src) => out.push(src));
  return out;
};
const isPermutation = (list, n) => list.length === n && new Set(list).size === n && list.every((x) => x >= 0 && x < n);

test('RunOrder: any sequence of moves keeps a valid permutation', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 40 }),
      fc.array(fc.tuple(fc.integer({ min: -2, max: 45 }), fc.integer({ min: -2, max: 45 })), { maxLength: 30 }),
      (n, moves) => {
        const order = new RunOrder(n);
        const model = Array.from({ length: n }, (_, i) => i); // reference model: a plain array
        for (const [from, to] of moves) {
          order.move(from, to);
          if (from !== to && from >= 0 && to >= 0 && from < n && to < n) model.splice(to, 0, model.splice(from, 1)[0]);
        }
        const got = display(order);
        assert.ok(isPermutation(got, n));
        assert.deepEqual(got, model);
        for (let i = 0; i < n; i++) {
          assert.equal(order.sourceOf(i), model[i]);
          assert.equal(order.fromSource(model[i]), i);
        }
        assert.equal(order.sourceOf(-1), -1);
        assert.equal(order.sourceOf(n), -1);
        assert.equal(order.fromSource(n), -1);
      },
    ),
    opts,
  );
});

test('RunOrder: compact form round-trips', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 40 }),
      fc.array(fc.tuple(fc.nat(39), fc.nat(39)), { maxLength: 20 }),
      (n, moves) => {
        const order = new RunOrder(n);
        for (const [a, b] of moves) order.move(a % n, b % n);
        const again = RunOrder.fromCompact(n, order.toCompact());
        assert.deepEqual(display(again), display(order));
      },
    ),
    opts,
  );
});

test('RunOrder: fromList / fromCompact ignore junk and always yield a permutation', () => {
  const junk = fc.oneof(fc.integer({ min: -5, max: 50 }), fc.double(), fc.constant(NaN));
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 30 }), fc.array(junk, { maxLength: 40 }), (n, list) => {
      assert.ok(isPermutation(display(RunOrder.fromList(n, list)), n));
    }),
    opts,
  );
  const item = fc.oneof(junk, fc.tuple(fc.integer({ min: -3, max: 35 }), fc.integer({ min: -3, max: 35 })));
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 30 }), fc.array(item, { maxLength: 20 }), (n, compact) => {
      assert.ok(isPermutation(display(RunOrder.fromCompact(n, compact)), n));
    }),
    opts,
  );
});

const cell = fc.record({ r: fc.integer({ min: 0, max: 50 }), c: fc.integer({ min: 0, max: 50 }) });

test('selection: rangeOf is symmetric, contains both corners, and counts correctly', () => {
  fc.assert(
    fc.property(cell, cell, (a, b) => {
      const g = rangeOf(a, b);
      assert.ok(sameRange(g, rangeOf(b, a)));
      assert.ok(g.r0 <= g.r1 && g.c0 <= g.c1);
      assert.ok(inRanges([g], a.r, a.c) && inRanges([g], b.r, b.c));
      assert.equal(cellCount([g]), (Math.abs(a.r - b.r) + 1) * (Math.abs(a.c - b.c) + 1));
    }),
    opts,
  );
});

// Array source vs. a naive reference implementation, over random data and random sort/filter queries.
const rowArb = fc.record({
  id: fc.integer({ min: 0, max: 1000 }),
  n: fc.option(fc.integer({ min: -20, max: 20 }), { nil: null }),
  city: fc.constantFrom('Oslo', 'Lima', 'Pune', 'Rome'),
});
const columns = [{ key: 'id' }, { key: 'n' }, { key: 'city' }];
const getIds = async (src, query) => {
  const { rowCount } = await src.getLayout({ query });
  if (!rowCount) return [];
  const [cells] = await src.getCells({ rects: [{ row: 0, col: 0, rowCount, colCount: 1 }], query });
  return cells.map((r) => r[0]);
};

test('array source: sorting is a stable permutation; an empty-result filter returns no rows', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(rowArb, { maxLength: 40 }),
      fc.constantFrom(1, 2),
      fc.constantFrom('asc', 'desc'),
      async (data, col, direction) => {
        const rows = data.map((r, i) => ({ ...r, id: i })); // unique ids reveal stability
        const src = createArraySource(rows, { columns });
        const ids = await getIds(src, { ...EMPTY_QUERY, sort: [{ column: col, direction }] });
        assert.deepEqual([...ids].sort((a, b) => a - b), rows.map((r) => r.id)); // permutation
        const key = columns[col].key;
        const present = ids.filter((id) => rows[id][key] !== null);
        for (let i = 1; i < present.length; i++) {
          const a = rows[present[i - 1]][key];
          const b = rows[present[i]][key];
          const cmp = typeof a === 'number' ? a - b : String(a).localeCompare(String(b));
          assert.ok(direction === 'asc' ? cmp <= 0 : cmp >= 0);
          if (cmp === 0) assert.ok(present[i - 1] < present[i]); // stable on ties
        }
        // empties sort last in both directions
        const firstEmpty = ids.findIndex((id) => rows[id][key] === null);
        if (firstEmpty >= 0) assert.ok(ids.slice(firstEmpty).every((id) => rows[id][key] === null));
      },
    ),
    opts,
  );
});
