import { test, expect } from '@playwright/test';

const openPivot = async (page) => {
  await page.goto('/test/e2e/fixture/pivot.html');
  await page.waitForFunction(() => window.__ready === true);
};
const openTable = async (page, query = '') => {
  await page.goto(`/test/e2e/fixture/index.html${query}`);
  await page.waitForFunction(() => window.__ready === true);
};
const counts = (page) => page.evaluate(() => [window.__grid.rowCount, window.__grid.columnCount]);
// Collapsing leaves pooled, hidden nodes in the DOM: always look at the visible ones.
const toggle = (page, id) => page.locator(`[data-toggle="${id}"]`).locator('visible=true').first();
const rowLabel = (page, text) => page.locator('.vg-rowhead .vg-seg', { hasText: text }).locator('visible=true').first();
const colLabel = (page, text) => page.locator('.vg-colhead .vg-seg', { hasText: text }).locator('visible=true').first();
// Click the left edge of a header: its centre can be the sort button.
const clickEdge = (loc, modifiers) => loc.click({ position: { x: 6, y: 8 }, modifiers });
const cellText = (page, r, c) => page.evaluate(([a, b]) => window.__grid.cellText(a, b), [r, c]);
const selection = (page) => page.evaluate(() => window.__grid.getSelection());

test.describe('pivot', () => {
  test('layout: 33 rows x 10 columns, with grouped headers and subtotals', async ({ page }) => {
    await openPivot(page);
    expect(await counts(page)).toEqual([33, 10]);
    await expect(page.getByRole('grid')).toHaveAttribute('aria-rowcount', /\d+/);
    for (const t of ['Region 0', 'Region 0 total', 'Country 0', 'Country 0 total', 'City 0']) await expect(rowLabel(page, t)).toBeVisible();
    for (const t of ['Year 0', 'Year 0 total', 'Quarter 0']) await expect(colLabel(page, t)).toBeVisible();
    await expect(page.locator('.vg-sub').first()).toBeVisible(); // subtotal rows are styled
  });

  test('cells hold the data source values (positions are source indexes)', async ({ page }) => {
    await openPivot(page);
    expect(await cellText(page, 0, 0)).toBe('r0c0');
    expect(await cellText(page, 3, 2)).toBe('r3c2');
    expect(await cellText(page, 32, 9)).toBe('r32c9'); // grand total row, last column
  });

  test('clicking a row group toggle collapses it, and again expands it', async ({ page }) => {
    await openPivot(page);
    await toggle(page, 'rows:0:0').click(); // Region 0: 16 rows collapse into 1
    await expect.poll(() => counts(page)).toEqual([18, 10]);
    await expect(rowLabel(page, 'City 0')).toHaveCount(0);
    await expect(rowLabel(page, 'Region 1')).toBeVisible();
    await toggle(page, 'rows:0:0').click();
    await expect.poll(() => counts(page)).toEqual([33, 10]);
    await expect(rowLabel(page, 'City 0')).toBeVisible();
  });

  test('collapsing a nested group (country) leaves its siblings', async ({ page }) => {
    await openPivot(page);
    await toggle(page, 'rows:1:0').click();
    await expect.poll(() => counts(page)).toEqual([29, 10]);
    await expect(rowLabel(page, 'City 0')).toHaveCount(0);
    await expect(rowLabel(page, 'City 4')).toBeVisible(); // next country untouched
  });

  test('column groups collapse too (year -> one column)', async ({ page }) => {
    await openPivot(page);
    await toggle(page, 'cols:0:0').click();
    await expect.poll(() => counts(page)).toEqual([33, 6]);
    await expect(colLabel(page, 'Quarter 0')).toHaveCount(0);
    await expect(colLabel(page, 'Quarter 4')).toBeVisible();
  });

  test('collapsing rows and columns together', async ({ page }) => {
    await openPivot(page);
    await toggle(page, 'rows:0:1').click();
    await toggle(page, 'cols:0:1').click();
    await expect.poll(() => counts(page)).toEqual([18, 6]);
  });

  test('API: showLevel collapses deeper levels, expandAll restores', async ({ page }) => {
    await openPivot(page);
    await page.evaluate(() => window.__grid.showLevel('rows', 0));
    await expect.poll(() => counts(page).then((c) => c[0])).toBeLessThan(33);
    const collapsedRows = (await counts(page))[0];
    await page.evaluate(() => window.__grid.showLevel('rows', 1));
    await expect.poll(() => counts(page).then((c) => c[0])).toBeGreaterThan(collapsedRows);
    await page.evaluate(() => window.__grid.expandAll('rows'));
    await expect.poll(() => counts(page)).toEqual([33, 10]);
  });

  test('API: toggleGroup', async ({ page }) => {
    await openPivot(page);
    await page.evaluate(() => window.__grid.toggleGroup('rows', 0, 0));
    await expect.poll(() => counts(page)).toEqual([18, 10]);
    await page.evaluate(() => window.__grid.toggleGroup('rows', 0, 0));
    await expect.poll(() => counts(page)).toEqual([33, 10]);
  });

  test('keyboard: Alt+Shift+Left/Right collapse and expand the row group; Up/Down the column group', async ({ page }) => {
    await openPivot(page);
    await page.evaluate(() => window.__grid.setSelection({ active: { r: 1, c: 0 }, ranges: [{ r0: 1, c0: 0, r1: 1, c1: 0 }] }));
    await page.evaluate(() => window.__grid.focus());
    await page.keyboard.press('Alt+Shift+ArrowLeft'); // row groups nest left to right
    await expect.poll(() => counts(page).then((c) => c[0])).toBeLessThan(33);
    await page.keyboard.press('Alt+Shift+ArrowRight');
    await expect.poll(() => counts(page)).toEqual([33, 10]);
    await page.keyboard.press('Alt+Shift+ArrowUp'); // column group tiers stack top to bottom
    await expect.poll(() => counts(page).then((c) => c[1])).toBeLessThan(10);
    await page.keyboard.press('Alt+Shift+ArrowDown');
    await expect.poll(() => counts(page)).toEqual([33, 10]);
  });

  test('clicking a leaf row header selects that row across all columns', async ({ page }) => {
    await openPivot(page);
    await rowLabel(page, 'City 1').click();
    const sel = await selection(page);
    expect(sel.ranges.at(-1)).toMatchObject({ r0: 1, r1: 1, c0: 0, c1: 9 });
  });

  test('clicking a subtotal row header selects that row', async ({ page }) => {
    await openPivot(page);
    await rowLabel(page, 'Country 0 total').click();
    expect((await selection(page)).ranges.at(-1)).toMatchObject({ r0: 4, r1: 4, c0: 0, c1: 9 });
  });

  test('ctrl/cmd-clicking a group label selects its rows instead of toggling; shift extends', async ({ page }) => {
    await openPivot(page);
    await rowLabel(page, 'Country 1').click({ modifiers: ['ControlOrMeta'] });
    expect(await counts(page)).toEqual([33, 10]); // not collapsed
    expect((await selection(page)).ranges.at(-1)).toMatchObject({ r0: 5, r1: 8 });
    await rowLabel(page, 'Region 0').click({ modifiers: ['Shift'] });
    expect((await selection(page)).ranges.at(-1)).toMatchObject({ r0: 0 });
  });

  test('clicking a column header selects the whole column; shift extends', async ({ page }) => {
    await openPivot(page);
    await clickEdge(colLabel(page, 'Quarter 1'));
    expect((await selection(page)).ranges.at(-1)).toMatchObject({ c0: 1, c1: 1, r0: 0, r1: 32 });
    await clickEdge(colLabel(page, 'Quarter 3'), ['Shift']);
    expect((await selection(page)).ranges.at(-1)).toMatchObject({ c0: 1, c1: 3, r0: 0, r1: 32 });
  });

  test('a collapsed group is selectable as the one row or column it became', async ({ page }) => {
    await openPivot(page);
    await toggle(page, 'rows:0:0').click();
    await expect.poll(() => counts(page)).toEqual([18, 10]);
    await rowLabel(page, 'Region 1 total').click();
    const r = (await selection(page)).ranges.at(-1);
    expect(r.r0).toBe(r.r1);
    expect(r.c1).toBe(9);
  });

  test('copy of a pivot range gives the cell values', async ({ page }) => {
    await openPivot(page);
    await page.getByRole('gridcell', { name: 'r0c0', exact: true }).first().click();
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Shift+ArrowRight');
    const info = await page.evaluate(() => window.__grid.copySelection());
    expect(info).toMatchObject({ ok: true, cells: 4, rows: 2, cols: 2 });
  });
});

test.describe('merged cells', () => {
  const merged = (page) => page.locator('.vg-merge:visible'); // removed / scrolled-away merges stay pooled and hidden

  test('a code merge draws one cell with its label over the covered area', async ({ page }) => {
    await openTable(page, '?merges=1');
    await expect(merged(page)).toHaveCount(2);
    const m = merged(page).filter({ hasText: 'MERGED' });
    await expect(m).toBeVisible();
    const box = await m.boundingBox();
    expect(Math.round(box.width)).toBeGreaterThanOrEqual(140 + 120 - 4); // name + city columns
    expect(Math.round(box.height)).toBeGreaterThanOrEqual(2 * 28 - 4); // two rows
  });

  test('a merge without a label shows its top-left cell value', async ({ page }) => {
    await openTable(page, '?merges=1');
    // rows 5-8 of the amount column merged: shows row 5 amount = (5*7)%50-10 = 25
    await expect(merged(page).filter({ hasText: '25' })).toBeVisible();
  });

  // Design rule (selection.ts): a merge is one cell for the ACTIVE cell and arrow keys, but a selected
  // range stays exactly the rectangle the user drew. It never jumps to cover a merge it only touches.
  test('clicking inside a merge: active cell is in the merge, the range stays that single cell', async ({ page }) => {
    await openTable(page, '?merges=1');
    await merged(page).filter({ hasText: 'MERGED' }).click();
    const sel = await page.evaluate(() => window.__grid.getSelection());
    expect(sel.active.r).toBeGreaterThanOrEqual(1);
    expect(sel.active.r).toBeLessThanOrEqual(2);
    expect(sel.active.c).toBeGreaterThanOrEqual(1);
    expect(sel.active.c).toBeLessThanOrEqual(2);
    expect(sel.ranges).toHaveLength(1);
    expect(sel.ranges[0]).toEqual({ r0: sel.active.r, c0: sel.active.c, r1: sel.active.r, c1: sel.active.c }); // not grown to rows 1-2 x columns 1-2
  });

  test('dragging a selection over part of a merge does not grow it to cover the merge', async ({ page }) => {
    await openTable(page, '?merges=1');
    const from = await page.getByRole('gridcell', { name: 'Item 0', exact: true }).boundingBox(); // row 0, name column
    const m = await merged(page).filter({ hasText: 'MERGED' }).boundingBox(); // rows 1-2, name + city columns
    await page.mouse.move(from.x + 10, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(m.x + 10, m.y + 8, { steps: 8 }); // top-left cell of the merge
    await page.mouse.up();
    const sel = await page.evaluate(() => window.__grid.getSelection());
    expect(sel.ranges.at(-1)).toEqual({ r0: 0, c0: 1, r1: 1, c1: 1 }); // exactly what was dragged, not rows 0-2 x columns 1-2
  });

  test('select all stays one rectangle over the whole grid, merges or not', async ({ page }) => {
    await openTable(page, '?merges=1');
    await page.getByRole('gridcell', { name: 'Item 0', exact: true }).click();
    await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+a`);
    const sel = await page.evaluate(() => window.__grid.getSelection());
    expect(sel.ranges).toEqual([{ r0: 0, c0: 0, r1: 199, c1: 3 }]);
  });

  test('copying a range that ends inside a merge copies only the cells in the range', async ({ page }) => {
    await openTable(page, '?merges=1');
    await page.evaluate(() => window.__grid.setSelection({ active: { r: 0, c: 1 }, ranges: [{ r0: 0, c0: 1, r1: 1, c1: 1 }] }));
    const info = await page.evaluate(() => window.__grid.copySelection());
    expect(info).toMatchObject({ ok: true, rows: 2, cols: 1, cells: 2 });
  });

  test('arrow keys treat a merge as one cell: from its top-left cell one step crosses all of it', async ({ page }) => {
    await openTable(page, '?merges=1'); // MERGED covers rows 1-2, columns 1-2
    const at = async (r, c, key) => {
      await page.evaluate(([a, b]) => { window.__grid.focus(); window.__grid.setSelection({ active: { r: a, c: b }, ranges: [{ r0: a, c0: b, r1: a, c1: b }] }); }, [r, c]);
      await page.evaluate(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)))); // let the merge be drawn
      await page.keyboard.press(key);
      return (await page.evaluate(() => window.__grid.getSelection())).active;
    };
    expect(await at(1, 1, 'ArrowDown')).toMatchObject({ r: 3, c: 1 }); // from the top row: past row 2 as well
    expect(await at(1, 1, 'ArrowRight')).toMatchObject({ r: 1, c: 3 }); // from the left column: past column 2 as well
    expect(await at(2, 2, 'ArrowUp')).toMatchObject({ r: 0, c: 2 }); // from the bottom-right: past row 1 as well
    expect(await at(2, 2, 'ArrowLeft')).toMatchObject({ r: 2, c: 0 });
  });

  test('a range drawn over part of a merge is not grown to cover it', async ({ page }) => {
    await openTable(page, '?merges=1');
    await page.getByRole('gridcell', { name: 'Item 0', exact: true }).click();
    await page.keyboard.press('Shift+ArrowDown');
    const sel = await page.evaluate(() => window.__grid.getSelection());
    expect(sel.ranges.at(-1)).toMatchObject({ r0: 0, r1: 1, c0: 1, c1: 1 });
  });

  test('setMerges([]) removes the merges', async ({ page }) => {
    await openTable(page, '?merges=1');
    await expect(merged(page)).toHaveCount(2);
    await page.evaluate(() => window.__grid.setMerges([]));
    await expect(merged(page)).toHaveCount(0);
  });

  test('invalid and 1x1 merges are ignored', async ({ page }) => {
    await openTable(page);
    await page.evaluate(() => window.__grid.setMerges([{ r0: 0, c0: 0, nr: 1, nc: 1 }, { r0: -1, c0: 0, nr: 2, nc: 2 }, { r0: 'x', c0: 0, nr: 2, nc: 2 }]));
    await expect(merged(page)).toHaveCount(0);
  });

  test('a merge scrolled out of view is not rendered, and returns when scrolled back', async ({ page }) => {
    await openTable(page, '?merges=1');
    await expect(merged(page)).toHaveCount(2);
    await page.locator('.vg-scroller').evaluate((el) => { el.scrollTop = 150 * 28; });
    await expect(merged(page)).toHaveCount(0);
    await page.locator('.vg-scroller').evaluate((el) => { el.scrollTop = 0; });
    await expect(merged(page)).toHaveCount(2);
  });
});
