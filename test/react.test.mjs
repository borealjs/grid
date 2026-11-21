// The React bindings must be safe to import and render on the server (Next.js, Remix, …): no DOM access
// until the component mounts in a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { VirtualGrid, Column, createColumnHelper, useDataSource } from '@borealjs/react-grid';
import { readFile } from 'node:fs/promises';

test('VirtualGrid renders on the server without touching the DOM', () => {
  const html = renderToString(
    createElement(
      VirtualGrid,
      { rows: [{ a: 1 }], className: 'grid', style: { height: 300 }, 'aria-label': 'Demo' },
      createElement(Column, { field: 'a', title: 'A' }),
    ),
  );
  assert.match(html, /class="grid"/);
});

test('useDataSource works during server rendering', () => {
  function Server() {
    const source = useDataSource({ getCells: async () => [] }, ['x']);
    return createElement(VirtualGrid, { dataSource: source, columns: [{ field: 'a' }] });
  }
  assert.doesNotThrow(() => renderToString(createElement(Server)));
});

test('createColumnHelper builds plain column objects', () => {
  const col = createColumnHelper();
  assert.deepEqual(col.field('amount', { title: 'Amount' }), { title: 'Amount', field: 'amount' });
  const total = col.computed('total', (r) => r.a + r.b);
  assert.equal(total.field, 'total');
  assert.equal(total.value({ a: 1, b: 2 }), 3);
});

test("the package is marked 'use client' for React Server Components", async () => {
  const src = await readFile(new URL('../packages/react-grid/dist/index.js', import.meta.url), 'utf8');
  assert.ok(src.startsWith("'use client';"));
});
