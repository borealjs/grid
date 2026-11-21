// Long spans (tall merged cells, pivot group headers), and selection + copy with pinning and pivots.
// Copy is checked against values worked out independently from the fixtures, plus grid.cellText as a cross-check.
import { test, expect } from '@playwright/test';

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const ROW = 28;

const openTable = async (page, query = '') => {
  await page.goto(`/test/e2e/fixture/index.html${query}`);
  await page.waitForFunction(() => window.__ready === true);
};
const openPivot = async (page, query = '') => {
  await page.goto(`/test/e2e/fixture/pivot.html${query}`);
  await page.waitForFunction(() => window.__ready === true);
};
const merges = (list) => `merges=${encodeURIComponent(JSON.stringify(list))}`;
const scrollY = async (page, row) => {
  await page.locator('.vg-scroller').evaluate((el, r) => { el.scrollTop = r * 28; }, row);
  await expect.poll(() => page.locator('.vg-scroller').evaluate((el) => el.scrollTop)).toBeGreaterThan(row * ROW - 2);
};
const scrollX = async (page, left) => {
  await page.locator('.vg-scroller').evaluate((el, l) => { el.scrollLeft = l; }, left);
  await expect.poll(() => page.locator('.vg-scroller').evaluate((el) => el.scrollLeft)).toBeGreaterThan(left - 2);
};
const sel = (page) => page.evaluate(() => window.__grid.getSelection());
const frames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))); // let a render pass finish
// Scroll with the API: very tall grids scale their scrollbar, so scrollTop is not row * rowHeight there.
const scrollToRow = async (page, row) => {
  await page.evaluate((r) => window.__grid.scrollToCell(r, 0), row);
  await expect.poll(() => page.evaluate((r) => { const v = window.__grid.visibleRange; return !!v && v.firstRow <= r && r <= v.lastRow; }, row)).toBe(true);
  await frames(page);
};
const clip = (page) => page.evaluate(() => navigator.clipboard.readText());
const copy = async (page) => {
  const info = await page.evaluate(() => window.__grid.copySelection());
  expect(info.ok, JSON.stringify(info)).toBe(true);
  return { info, lines: (await clip(page)).split('\n').map((l) => l.split('\t')) };
};
const gridRect = (page) => page.locator('#grid').boundingBox();

const CITIES = ['Oslo', 'Lima', 'Pune', 'Rome'];
const TITLES = { id: 'ID', name: 'Name', city: 'City', amount: 'Amount' };
for (let k = 0; k < 20; k++) TITLES[`x${k}`] = `X${k}`;
const valueOf = (key, r) => (key === 'id' ? String(r) : key === 'name' ? `Item ${r}` : key === 'city' ? CITIES[r % 4] : key === 'amount' ? String((r * 7) % 50 - 10) : `x${key.slice(1)}-${r}`);
const order = (page) => page.evaluate(() => window.__grid.getColumnOrder());
const head = (page, name) => page.getByRole('columnheader', { name }).first();

test.describe('tall merged cells', () => {
  const TALL = merges([{ r0: 10, c0: 1, nr: 150, nc: 1, label: 'TALL' }]); // rows 10-159 of the name column
  const tall = (page) => page.locator('.vg-merge:visible').filter({ hasText: 'TALL' });

  // The merge is drawn as tall as it is, but its label must stay inside the visible part of it.
  async function expectLabelInView(page) {
    const g = await gridRect(page);
    const lab = await tall(page).locator('.vg-ml').boundingBox();
    expect(lab.y, 'label below the header').toBeGreaterThanOrEqual(g.y + 34 - 1);
    expect(lab.y + lab.height, 'label above the grid bottom').toBeLessThanOrEqual(g.y + g.height + 1);
  }

  for (const row of [0, 4, 30, 80, 148, 156]) {
    test(`scrolled to row ${row}: the merge is drawn when in view, label stays visible, width is the column's`, async ({ page }) => {
      await openTable(page, `?${TALL}`);
      await scrollY(page, row);
      const inView = row + 12 > 10 && row < 160; // the grid shows about 12 rows
      if (!inView) return expect(tall(page)).toHaveCount(0);
      await expect(tall(page)).toBeVisible();
      await expectLabelInView(page);
      const box = await tall(page).boundingBox();
      expect(Math.round(box.width)).toBe(140);
    });
  }

  test('scrolled past the end of the merge it is gone and normal cells are back', async ({ page }) => {
    await openTable(page, `?${TALL}`);
    await scrollY(page, 170);
    await expect(tall(page)).toHaveCount(0);
    await expect(page.getByRole('gridcell', { name: 'Item 172', exact: true })).toBeVisible();
  });

  test('cells next to the merge keep their own values while scrolled inside it', async ({ page }) => {
    await openTable(page, `?${TALL}`);
    await scrollY(page, 80);
    await expect(page.getByRole('gridcell', { name: '85', exact: true }).first()).toBeVisible(); // id column
    await expect(tall(page)).toBeVisible();
    await expect(page.getByRole('gridcell', { name: 'Item 85', exact: true })).toHaveCount(0); // hidden behind the merge
  });

  test('clicking the merge while scrolled inside it selects a cell inside the merge', async ({ page }) => {
    await openTable(page, `?${TALL}`);
    await scrollY(page, 80);
    await tall(page).click({ position: { x: 20, y: 100 } });
    const { active, ranges } = await sel(page);
    expect(active.r).toBeGreaterThanOrEqual(10);
    expect(active.r).toBeLessThanOrEqual(159);
    expect(ranges).toEqual([{ r0: active.r, c0: 1, r1: active.r, c1: 1 }]);
  });

  // Regression: the drawn piece of a merge taller than the drawn rows is clipped to them; arrow keys must step off
  // the merge's real far edge (row 160), not the end of the drawn part (row 27).
  test('ArrowDown from the top of a tall merge steps off its far edge (row 160)', async ({ page }) => {
    await openTable(page, `?${TALL}`);
    await page.evaluate(() => { window.__grid.focus(); window.__grid.setSelection({ active: { r: 10, c: 1 }, ranges: [{ r0: 10, c0: 1, r1: 10, c1: 1 }] }); });
    await frames(page);
    await page.keyboard.press('ArrowDown');
    expect((await sel(page)).active.r).toBe(160);
  });

  test('ArrowDown from the top of a short merge steps off its far edge (control for the test above)', async ({ page }) => {
    await openTable(page, `?${merges([{ r0: 10, c0: 1, nr: 4, nc: 1, label: 'SHORT' }])}`);
    await page.evaluate(() => { window.__grid.focus(); window.__grid.setSelection({ active: { r: 10, c: 1 }, ranges: [{ r0: 10, c0: 1, r1: 10, c1: 1 }] }); });
    await frames(page);
    await page.keyboard.press('ArrowDown');
    expect((await sel(page)).active.r).toBe(14);
  });

  test('ArrowUp from below lands back in the merge and the merge with its label is in view', async ({ page }) => {
    await openTable(page, `?${TALL}`);
    await scrollY(page, 160);
    await page.getByRole('gridcell', { name: 'Item 160', exact: true }).click();
    await page.keyboard.press('ArrowUp');
    const { active } = await sel(page);
    expect(active.r).toBeGreaterThanOrEqual(10);
    expect(active.r).toBeLessThanOrEqual(159);
    await expect(tall(page)).toBeVisible();
    await expectLabelInView(page);
  });

  test('a drag-free range over the whole merge: click above, scroll, shift+click below', async ({ page }) => {
    await openTable(page, `?${TALL}`);
    await scrollY(page, 3);
    await page.getByRole('gridcell', { name: 'Item 5', exact: true }).click();
    await scrollY(page, 160);
    await page.getByRole('gridcell', { name: 'Item 165', exact: true }).click({ modifiers: ['Shift'] });
    expect((await sel(page)).ranges.at(-1)).toEqual({ r0: 5, c0: 1, r1: 165, c1: 1 }); // as drawn, not grown
  });

  test('copy of a range over the merge: the label on the merge\'s first row, blanks after, neighbours intact', async ({ page }) => {
    await openTable(page, `?${TALL}`);
    await page.evaluate(() => window.__grid.setSelection({ active: { r: 5, c: 1 }, ranges: [{ r0: 5, c0: 1, r1: 165, c1: 1 }] }));
    const { lines } = await copy(page);
    expect(lines).toHaveLength(161);
    expect(lines.slice(0, 5).map((l) => l[0])).toEqual(['Item 5', 'Item 6', 'Item 7', 'Item 8', 'Item 9']);
    expect(lines[5][0]).toBe('TALL'); // row 10: top of the merge
    expect(lines.slice(6, 155).every((l) => l[0] === '')).toBe(true); // rows 11-159
    expect(lines.slice(155).map((l) => l[0])).toEqual(['Item 160', 'Item 161', 'Item 162', 'Item 163', 'Item 164', 'Item 165']);
  });

  test('copy of a range wider than the merge copies the neighbours\' real values', async ({ page }) => {
    await openTable(page, `?${TALL}`);
    await page.evaluate(() => window.__grid.setSelection({ active: { r: 80, c: 0 }, ranges: [{ r0: 80, c0: 0, r1: 81, c1: 2 }] }));
    const { lines } = await copy(page);
    // Starting inside the merge, the label is on the first copied row of the merge's part, blanks after it.
    expect(lines).toEqual([['80', 'TALL', 'Oslo'], ['81', '', 'Lima']]);
  });
});

test.describe('merges and pinned columns', () => {
  const PIN = merges([{ r0: 2, c0: 0, nr: 3, nc: 2, label: 'PINMERGE' }, { r0: 6, c0: 1, nr: 2, nc: 2, label: 'CROSS' }]);
  const m = (page, label) => page.locator('.vg-merge:visible').filter({ hasText: label });

  test('unscrolled: both merges are drawn in the right place', async ({ page }) => {
    await openTable(page, `?pin=2&wide=1&${PIN}`);
    await expect(m(page, 'PINMERGE')).toBeVisible();
    const pm = await m(page, 'PINMERGE').boundingBox();
    expect(Math.round(pm.x)).toBe(72); // starts at the first column
    expect(Math.round(pm.width)).toBe(220); // ID (80) + Name (140)
    // CROSS crosses the pin boundary: two separate parts, each showing the value.
    await expect(m(page, 'CROSS')).toHaveCount(2);
    const pinned = await page.locator('.vg-pinbody .vg-merge:visible', { hasText: 'CROSS' }).boundingBox();
    const body = await page.locator('.vg-body:not(.vg-pinbody) .vg-merge:visible', { hasText: 'CROSS' }).boundingBox();
    expect([Math.round(pinned.x), Math.round(pinned.width)]).toEqual([152, 140]); // Name
    expect([Math.round(body.x), Math.round(body.width)]).toEqual([292, 120]); // City
  });

  test('a merge crossing the pin boundary is still one cell: selected whole, copied once', async ({ page }) => {
    await openTable(page, `?pin=2&wide=1&${PIN}`);
    await page.locator('.vg-body:not(.vg-pinbody) .vg-merge:visible', { hasText: 'CROSS' }).click({ position: { x: 10, y: 8 } });
    expect((await sel(page)).ranges).toEqual([{ r0: 6, c0: 2, r1: 6, c1: 2 }]); // the clicked cell, not the span
    await page.evaluate(() => window.__grid.setSelection({ active: { r: 6, c: 1 }, ranges: [{ r0: 6, c0: 1, r1: 7, c1: 2 }] }));
    const { lines } = await copy(page);
    expect(lines).toEqual([['CROSS', ''], ['', '']]);
  });

  // Regression: merges over pinned columns are drawn in the pinned layer, so they stay put while the body scrolls
  // sideways; a merge crossing the pin boundary keeps its pinned part (with the label) in place.
  test('a merge inside the pinned columns stays put while scrolling sideways', async ({ page }) => {
    await openTable(page, `?pin=2&wide=1&${PIN}`);
    await scrollX(page, 500);
    await expect(m(page, 'PINMERGE')).toBeVisible();
    const pm = await m(page, 'PINMERGE').boundingBox();
    expect(Math.round(pm.x)).toBe(72);
  });

  test('a merge crossing the pin boundary keeps its pinned part in place', async ({ page }) => {
    await openTable(page, `?pin=2&wide=1&${PIN}`);
    await scrollX(page, 500);
    // CROSS covers rows 6-7 of columns Name (pinned, x 152-292) and City (scrolled away): Name's part must still show it.
    const owner = await page.evaluate(() => {
      const g = document.getElementById('grid').getBoundingClientRect();
      const el = document.elementFromPoint(g.left + 72 + 80 + 60, g.top + 34 + 6 * 28 + 14);
      return el?.closest('.vg-merge')?.textContent ?? el?.textContent ?? null;
    });
    expect(owner).toContain('CROSS');
  });
});

test.describe('pivot group headers spanning thousands of rows (big pivot)', () => {
  const regionSeg = (page, n) => page.locator('.vg-rowhead .vg-seg', { hasText: `Region ${n}` }).locator('visible=true').filter({ hasNotText: 'total' }).first();

  test('layout: 2,463 rows', async ({ page }) => {
    await openPivot(page, '?big=1');
    expect(await page.evaluate(() => window.__grid.rowCount)).toBe(2463);
  });

  for (const row of [0, 5, 600, 1170, 1500]) { // pivot rows are 10px tall, so ~45 rows are in view: 1170 still ends inside region 0
    test(`scrolled to row ${row}: the right region label is in view, nothing from the other region`, async ({ page }) => {
      await openPivot(page, '?big=1');
      await scrollToRow(page, row);
      const n = row < 1232 ? 0 : 1;
      const seg = regionSeg(page, n);
      await expect(seg).toBeVisible();
      const g = await gridRect(page);
      const lab = await seg.locator('.vg-sl').boundingBox();
      expect(lab.y).toBeGreaterThanOrEqual(g.y + 34 - 1); // below the column header, not clipped under it
      expect(lab.y + lab.height).toBeLessThanOrEqual(g.y + g.height + 1);
      await expect(page.locator('.vg-rowhead .vg-seg', { hasText: `Region ${1 - n}` }).locator('visible=true').filter({ hasNotText: 'total' })).toHaveCount(0);
    });
  }

  test('scrolled into the middle of a country, its label and its region label are both in view', async ({ page }) => {
    await openPivot(page, '?big=1');
    await scrollToRow(page, 600);
    const seg = page.locator('.vg-rowhead .vg-seg', { hasText: /Country \d+/ }).locator('visible=true').filter({ hasNotText: 'total' }).first();
    await expect(seg).toBeVisible();
    await expect(regionSeg(page, 0)).toBeVisible();
  });

  test('the grand total is reachable at the end', async ({ page }) => {
    await openPivot(page, '?big=1');
    await scrollToRow(page, 2462);
    await expect(page.getByRole('gridcell', { name: 'r2462c0', exact: true })).toBeVisible();
    await expect(page.locator('.vg-rowhead .vg-seg', { hasText: /total/i }).locator('visible=true').last()).toBeVisible();
  });

  test('ctrl/cmd-click on a region label selects all its rows (as one range) and the label shows selected', async ({ page }) => {
    await openPivot(page, '?big=1');
    await regionSeg(page, 0).click({ modifiers: ['ControlOrMeta'] });
    // Ctrl/Cmd ADDS to the selection, and the initial active cell (0,0) is part of it, as in a spreadsheet.
    const ranges = (await sel(page)).ranges;
    expect(ranges).toHaveLength(2);
    const r = ranges.at(-1);
    expect(r.r0).toBe(0);
    expect(r.r1).toBeGreaterThan(1200); // ~1,230 rows
    expect(r.c0).toBe(0);
    expect(r.c1).toBe(9);
  });

  test('copying a region copies every row of it, rows never rendered included', async ({ page }) => {
    await openPivot(page, '?big=1');
    await page.getByRole('gridcell', { name: 'r3c3', exact: true }).first().click(); // a plain click first: one clean range
    await regionSeg(page, 0).click({ modifiers: ['ControlOrMeta'] });
    const ranges = (await sel(page)).ranges;
    const r = ranges.at(-1);
    const { info } = await copy(page);
    const text = await clip(page);
    const block = text.split('\n\n').at(-1).split('\n').map((l) => l.split('\t')); // ranges are separated by a blank line
    expect(info.ranges).toBe(2);
    expect(block).toHaveLength(r.r1 - r.r0 + 1);
    expect(block[0].slice(0, 2)).toEqual(['r0c0', 'r0c1']);
    expect(block.at(-1)[0]).toBe(`r${r.r1}c0`);
    expect(block.every((l) => l.length === 10)).toBe(true);
  });

  test('a selection spanning the viewport is still highlighted while scrolling inside it', async ({ page }) => {
    await openPivot(page, '?big=1');
    await regionSeg(page, 0).click({ modifiers: ['ControlOrMeta'] });
    await scrollToRow(page, 700);
    await expect(page.locator('.vg-sel-layer > *:visible').first()).toBeVisible();
  });
});

test.describe('selection and copy with pinned columns', () => {
  test('a range crossing the pin boundary copies in display order, values in the right columns', async ({ page }) => {
    await openTable(page, '?pin=2&wide=1');
    await page.evaluate(() => window.__grid.setSelection({ active: { r: 0, c: 0 }, ranges: [{ r0: 0, c0: 0, r1: 2, c1: 5 }] }));
    const keys = (await order(page)).slice(0, 6);
    const { lines } = await copy(page);
    expect(lines).toEqual([0, 1, 2].map((r) => keys.map((k) => valueOf(k, r))));
  });

  test('same range while scrolled sideways: the copy does not depend on what is scrolled into view', async ({ page }) => {
    await openTable(page, '?pin=2&wide=1');
    await page.evaluate(() => window.__grid.setSelection({ active: { r: 0, c: 0 }, ranges: [{ r0: 0, c0: 0, r1: 2, c1: 5 }] }));
    await scrollX(page, 900);
    const keys = (await order(page)).slice(0, 6);
    const { lines } = await copy(page);
    expect(lines).toEqual([0, 1, 2].map((r) => keys.map((k) => valueOf(k, r))));
  });

  test('mouse: click a pinned cell, scroll right, shift+click a scrolled cell: the range spans the columns between', async ({ page }) => {
    await openTable(page, '?pin=2&wide=1');
    await page.getByRole('gridcell', { name: 'Item 1', exact: true }).click(); // pinned Name, row 1
    await scrollX(page, 600);
    await page.getByRole('gridcell', { name: /^x\d+-3$/ }).first().click({ modifiers: ['Shift'] });
    const r = (await sel(page)).ranges.at(-1);
    expect(r).toMatchObject({ r0: 1, r1: 3, c0: 1 });
    expect(r.c1).toBeGreaterThan(5);
    const keys = await order(page);
    const { lines } = await copy(page);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toEqual(keys.slice(r.c0, r.c1 + 1).map((k) => valueOf(k, 1)));
    expect(lines[2]).toEqual(keys.slice(r.c0, r.c1 + 1).map((k) => valueOf(k, 3)));
  });

  test('keyboard: shift+arrows from a pinned cell extend across the boundary and copy', async ({ page }) => {
    await openTable(page, '?pin=2&wide=1');
    await page.getByRole('gridcell', { name: 'Item 0', exact: true }).click();
    for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Shift+ArrowDown');
    expect((await sel(page)).ranges.at(-1)).toEqual({ r0: 0, c0: 1, r1: 1, c1: 4 });
    const keys = await order(page);
    const { lines } = await copy(page);
    expect(lines).toEqual([0, 1].map((r) => keys.slice(1, 5).map((k) => valueOf(k, r))));
  });

  // Regression: in a reorderable grid (the default) a press on a column header may start a drag; the pointer is
  // captured only once it moves, so a plain click still reaches the header and selects the column.
  test('default grid: clicking a column header selects the column', async ({ page }) => {
    await openTable(page, '?pin=2&wide=1');
    await page.locator('.vg-pinhead [role=columnheader]', { hasText: /^Name/ }).click({ position: { x: 6, y: 8 } });
    expect((await sel(page)).ranges.at(-1)).toMatchObject({ c0: 1, c1: 1, r0: 0, r1: 199 });
  });

  test('reordering off: clicking a pinned column header selects that column; copy is its values', async ({ page }) => {
    await openTable(page, '?pin=2&wide=1&reorder=0');
    await page.locator('.vg-pinhead [role=columnheader]', { hasText: /^Name/ }).click({ position: { x: 6, y: 8 } });
    expect((await sel(page)).ranges.at(-1)).toMatchObject({ c0: 1, c1: 1, r0: 0, r1: 199 });
    const { lines } = await copy(page);
    expect(lines).toHaveLength(200);
    expect(lines[0][0]).toBe('Item 0');
    expect(lines[199][0]).toBe('Item 199');
  });

  test('reordering off: shift+clicking a scrolled header extends the column selection across the pin boundary', async ({ page }) => {
    await openTable(page, '?pin=2&wide=1&reorder=0');
    await page.locator('.vg-pinhead [role=columnheader]', { hasText: /^ID/ }).click({ position: { x: 6, y: 8 } });
    await scrollX(page, 600);
    await page.locator('.vg-colhead [role=columnheader]', { hasText: /^X6/ }).locator('visible=true').first().click({ position: { x: 6, y: 8 }, modifiers: ['Shift'] });
    const r = (await sel(page)).ranges.at(-1);
    expect(r).toMatchObject({ c0: 0, c1: 10, r0: 0, r1: 199 }); // ID … X6 (display column 10)
    const keys = await order(page);
    const { lines } = await copy(page);
    expect(lines[0]).toEqual(keys.slice(0, 11).map((k) => valueOf(k, 0)));
  });

  test('after reordering a pinned column, selecting and copying follows the new order', async ({ page }) => {
    await openTable(page, '?pin=2&wide=1');
    await page.evaluate(() => window.__grid.setColumnOrder(['name', 'id', 'city', 'amount']));
    await page.evaluate(() => window.__grid.setSelection({ active: { r: 4, c: 0 }, ranges: [{ r0: 4, c0: 0, r1: 4, c1: 3 }] }));
    const { lines } = await copy(page);
    expect(lines).toEqual([['Item 4', '4', 'Oslo', '-10'.replace('-10', String((4 * 7) % 50 - 10))]]);
    await page.getByRole('gridcell', { name: 'Item 5', exact: true }).first().click(); // the first column is now Name
    const { lines: one } = await copy(page);
    expect(one).toEqual([['Item 5']]);
  });

  test('select all + copy with pinning, a reorder and row checkboxes: 200 rows x 24 columns in display order, no checkbox column', async ({ page }) => {
    await openTable(page, '?pin=2&wide=1&checks=1');
    await page.evaluate(() => window.__grid.setColumnOrder(['name', 'id', 'city', 'amount']));
    await page.getByRole('gridcell', { name: 'Item 0', exact: true }).first().click();
    await page.keyboard.press(`${MOD}+a`);
    const keys = await order(page);
    const { lines } = await copy(page);
    expect(lines).toHaveLength(200);
    expect(lines.every((l) => l.length === 24)).toBe(true);
    expect(lines[0]).toEqual(keys.map((k) => valueOf(k, 0)));
    expect(lines[199]).toEqual(keys.map((k) => valueOf(k, 199)));
  });

  test('checking a row does not change what is selected or copied', async ({ page }) => {
    await openTable(page, '?pin=2&wide=1&checks=1');
    await page.getByRole('gridcell', { name: 'Item 2', exact: true }).click();
    await page.locator('.vg-rowhead .vg-check').nth(5).click();
    expect((await sel(page)).ranges).toEqual([{ r0: 2, c0: 1, r1: 2, c1: 1 }]);
    const { lines } = await copy(page);
    expect(lines).toEqual([['Item 2']]);
  });
});

test.describe('selection and copy in a pivot', () => {
  const rows = (page) => page.evaluate(() => [window.__grid.rowCount, window.__grid.columnCount]);
  const toggle = (page, id) => page.locator(`[data-toggle="${id}"]`).locator('visible=true').first();
  const select = (page, r0, c0, r1, c1) => page.evaluate(([a, b, c, d]) => window.__grid.setSelection({ active: { r: a, c: b }, ranges: [{ r0: a, c0: b, r1: c, c1: d }] }), [r0, c0, r1, c1]);
  const cellsOf = (rs, cs) => rs.map((r) => cs.map((c) => `r${r}c${c}`));

  test('expanded: a range copies the cells by their positions', async ({ page }) => {
    await openPivot(page);
    await select(page, 0, 0, 1, 1);
    expect((await copy(page)).lines).toEqual(cellsOf([0, 1], [0, 1]));
  });

  test('expanded: a range over subtotals (row 4 is a country total, column 4 a year total) includes them', async ({ page }) => {
    await openPivot(page);
    await select(page, 3, 3, 5, 5);
    expect((await copy(page)).lines).toEqual(cellsOf([3, 4, 5], [3, 4, 5]));
  });

  test('expanded: select all copies 33 x 10, first r0c0, last r32c9 (the grand total)', async ({ page }) => {
    await openPivot(page);
    await page.getByRole('gridcell', { name: 'r0c0', exact: true }).first().click();
    await page.keyboard.press(`${MOD}+a`);
    const { lines } = await copy(page);
    expect(lines).toHaveLength(33);
    expect(lines.every((l) => l.length === 10)).toBe(true);
    expect(lines[0][0]).toBe('r0c0');
    expect(lines[32][9]).toBe('r32c9');
  });

  test('row header click on a leaf row, then copy: that row\'s 10 values', async ({ page }) => {
    await openPivot(page);
    await page.locator('.vg-rowhead .vg-seg', { hasText: 'City 1' }).locator('visible=true').first().click();
    expect((await copy(page)).lines).toEqual([cellsOf([1], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])[0]]);
  });

  test('column header click, then copy: that column from the first row to the grand total', async ({ page }) => {
    await openPivot(page);
    await page.locator('.vg-colhead .vg-seg', { hasText: 'Quarter 1' }).locator('visible=true').first().click({ position: { x: 6, y: 8 } });
    const { lines } = await copy(page);
    expect(lines).toHaveLength(33);
    expect(lines.map((l) => l[0])).toEqual(Array.from({ length: 33 }, (_, r) => `r${r}c1`));
  });

  test('rows collapsed (region 0): visible row 0 is that region\'s total, the next rows follow in source order', async ({ page }) => {
    await openPivot(page);
    await toggle(page, 'rows:0:0').click();
    await expect.poll(() => rows(page)).toEqual([18, 10]);
    await select(page, 0, 0, 2, 1);
    // visible row 0 = source row 15 (region 0 total); visible row 1 = source row 16 (region 1's first row)
    expect((await copy(page)).lines).toEqual(cellsOf([15, 16, 17], [0, 1]));
  });

  test('columns collapsed (year 0): visible column 0 is its total (source 4), then year 1 follows', async ({ page }) => {
    await openPivot(page);
    await toggle(page, 'cols:0:0').click();
    await expect.poll(() => rows(page)).toEqual([33, 6]);
    await select(page, 0, 0, 1, 2);
    expect((await copy(page)).lines).toEqual(cellsOf([0, 1], [4, 5, 6]));
  });

  test('rows and columns collapsed together', async ({ page }) => {
    await openPivot(page);
    await toggle(page, 'rows:0:0').click();
    await toggle(page, 'cols:0:0').click();
    await expect.poll(() => rows(page)).toEqual([18, 6]);
    await select(page, 0, 0, 1, 1);
    expect((await copy(page)).lines).toEqual(cellsOf([15, 16], [4, 5]));
  });

  test('copy agrees with what the grid reports for every cell (cellText) after collapsing', async ({ page }) => {
    await openPivot(page);
    await toggle(page, 'rows:1:0').click();
    await toggle(page, 'cols:0:1').click();
    await expect.poll(() => rows(page)).toEqual([29, 6]);
    await select(page, 0, 0, 28, 5);
    const { lines } = await copy(page);
    const expected = await page.evaluate(() => Array.from({ length: 29 }, (_, r) => Array.from({ length: 6 }, (_, c) => window.__grid.cellText(r, c))));
    expect(lines).toEqual(expected);
  });

  test('selecting a group by its label with ctrl/cmd, then copying: only that group\'s rows', async ({ page }) => {
    await openPivot(page);
    await page.getByRole('gridcell', { name: 'r5c2', exact: true }).first().click();
    await page.locator('.vg-rowhead .vg-seg', { hasText: 'Country 1' }).locator('visible=true').filter({ hasNotText: 'total' }).first().click({ modifiers: ['ControlOrMeta'] });
    expect((await sel(page)).ranges.at(-1)).toMatchObject({ r0: 5, r1: 8, c0: 0, c1: 9 });
    await copy(page);
    const block = (await clip(page)).split('\n\n').at(-1).split('\n').map((l) => l.split('\t'));
    expect(block.map((l) => l[0])).toEqual(['r5c0', 'r6c0', 'r7c0', 'r8c0']); // ranges are separated by a blank line
  });

  test('a collapsed group header selects as one row; copy gives its total row', async ({ page }) => {
    await openPivot(page);
    await toggle(page, 'rows:0:0').click();
    await expect.poll(() => rows(page)).toEqual([18, 10]);
    await select(page, 0, 0, 0, 9);
    const { lines } = await copy(page);
    expect(lines).toEqual([Array.from({ length: 10 }, (_, c) => `r15c${c}`)]);
  });
});
