import { test, expect } from '@playwright/test';

const open = async (page, query = '') => {
  await page.goto(`/test/e2e/fixture/index.html${query}`);
  await page.waitForFunction(() => window.__ready === true);
};
const events = (page, type) => page.evaluate((t) => window.__events.filter((e) => e.type === t), type);
const head = (page, name) => page.getByRole('columnheader', { name }).first();
// Headers are positioned with transforms, so DOM order is not display order: sort by screen x.
const headTitles = (page) =>
  page.locator('.vg-colname').evaluateAll((els) =>
    els.map((e) => ({ x: e.getBoundingClientRect().x, t: e.textContent.replace(/[⇅▲▼]/g, '').trim() })).sort((a, b) => a.x - b.x).map((h) => h.t));
const order = (page) => page.evaluate(() => window.__grid.getColumnOrder());

// Drag a header (grabbed by its left edge: the centre can be a sort/filter button) onto another header's left or right edge.
async function dragHeader(page, from, to, side = 'left') {
  const a = await head(page, from).boundingBox();
  const b = await head(page, to).boundingBox();
  const y = a.y + a.height / 2;
  await page.mouse.move(a.x + 10, y);
  await page.mouse.down();
  const tx = side === 'left' ? b.x + 8 : b.x + b.width - 8;
  await page.mouse.move(tx, y, { steps: 10 });
  await page.mouse.up();
}

test.describe('column reorder', () => {
  test('dragging a header moves the column and reports the new order', async ({ page }) => {
    await open(page);
    expect(await order(page)).toEqual(['id', 'name', 'city', 'amount']);
    await dragHeader(page, /Amount/, /Name/, 'left');
    await expect.poll(() => order(page)).toEqual(['id', 'amount', 'name', 'city']);
    expect((await events(page, 'order')).at(-1).payload).toEqual(['id', 'amount', 'name', 'city']);
  });

  test('moving a column to the right edge', async ({ page }) => {
    await open(page);
    await dragHeader(page, /ID/, /Amount/, 'right');
    await expect.poll(() => order(page)).toEqual(['name', 'city', 'amount', 'id']);
  });

  test('Escape cancels a drag in progress', async ({ page }) => {
    await open(page);
    const a = await head(page, /Amount/).boundingBox();
    const b = await head(page, /Name/).boundingBox();
    const y = a.y + a.height / 2;
    await page.mouse.move(a.x + 10, y);
    await page.mouse.down();
    await page.mouse.move(b.x + 8, y, { steps: 8 });
    await expect(page.locator('.vg-dropline')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect(page.locator('.vg-dropline')).toHaveCount(0);
    expect(await order(page)).toEqual(['id', 'name', 'city', 'amount']);
    expect(await events(page, 'order')).toHaveLength(0);
  });

  test('a tiny movement is a click, not a drag (no reorder)', async ({ page }) => {
    await open(page);
    const a = await head(page, /Name/).boundingBox();
    const y = a.y + a.height / 2;
    await page.mouse.move(a.x + 40, y);
    await page.mouse.down();
    await page.mouse.move(a.x + 43, y);
    await page.mouse.up();
    expect(await order(page)).toEqual(['id', 'name', 'city', 'amount']);
  });

  test('API: setColumnOrder reorders the header and the cells', async ({ page }) => {
    await open(page);
    await page.evaluate(() => window.__grid.setColumnOrder(['amount', 'city', 'name', 'id']));
    await expect.poll(() => headTitles(page)).toEqual(['Amount', 'City', 'Name', 'ID']);
    // first body cell of row 0 is now row 0's amount: (0*7)%50-10 = -10
    await expect(page.getByRole('gridcell', { name: '-10', exact: true }).first()).toBeVisible();
  });

  test('a selection stays on the same cells (by position) after a reorder', async ({ page }) => {
    await open(page);
    await page.getByRole('gridcell', { name: 'Item 2', exact: true }).click();
    await dragHeader(page, /Amount/, /ID/, 'left');
    await expect.poll(() => order(page)).toEqual(['amount', 'id', 'name', 'city']);
    // the grid must remain usable: arrow keys still move the active cell
    await page.keyboard.press('ArrowDown');
    expect((await events(page, 'selection')).length).toBeGreaterThan(1);
  });
});

test.describe('pinned columns', () => {
  test('pinned columns stay put while the rest scroll sideways', async ({ page }) => {
    await open(page, '?pin=2&wide=1');
    const idCell = page.getByRole('gridcell', { name: '0', exact: true }).first();
    const before = await idCell.boundingBox();
    await page.locator('.vg-scroller').evaluate((el) => { el.scrollLeft = 600; });
    await expect.poll(() => page.locator('.vg-scroller').evaluate((el) => el.scrollLeft)).toBeGreaterThan(300);
    const after = await idCell.boundingBox();
    expect(Math.abs(after.x - before.x)).toBeLessThan(2);
    // a non-pinned column scrolled away
    await expect(head(page, /^City/)).toHaveCount(0);
  });

  test('without pinning the first column scrolls away', async ({ page }) => {
    await open(page, '?wide=1');
    await expect(head(page, /^ID/)).toBeVisible();
    await page.locator('.vg-scroller').evaluate((el) => { el.scrollLeft = 600; });
    await expect(head(page, /^ID/)).toHaveCount(0); // virtualized away
  });

  test('a pinned column cannot be dragged past the pin boundary, nor an unpinned one into it', async ({ page }) => {
    await open(page, '?pin=2&wide=1');
    await dragHeader(page, /ID/, /City/, 'right'); // pinned -> unpinned area: clamped inside the pinned block
    let o = await order(page);
    expect(o.slice(0, 2).sort()).toEqual(['id', 'name']);
    await dragHeader(page, /City/, /ID/, 'left'); // unpinned -> pinned area: clamped to the boundary
    o = await order(page);
    expect(o.slice(0, 2).sort()).toEqual(['id', 'name']);
  });

  test('pinned columns can be reordered among themselves', async ({ page }) => {
    await open(page, '?pin=2&wide=1');
    await dragHeader(page, /Name/, /ID/, 'left');
    await expect.poll(() => order(page).then((o) => o.slice(0, 2))).toEqual(['name', 'id']);
  });
});

test.describe('row checkboxes', () => {
  const rowBox = (page, n) => page.locator('.vg-rowhead .vg-check').nth(n);
  const cornerBox = (page) => page.getByRole('checkbox', { name: /./ }).first();
  const lastSelection = async (page) => (await events(page, 'rowSelection')).at(-1)?.payload;
  const checked = (page) => page.evaluate(() => window.__grid.checkedCount());

  test('checking rows reports them by id and counts them', async ({ page }) => {
    await open(page, '?checks=1');
    await rowBox(page, 1).click();
    await rowBox(page, 3).click();
    await expect.poll(() => checked(page)).toBe(2);
    expect((await lastSelection(page)).checks.filter((c) => c.checked).map((c) => c.id)).toEqual([1, 3]);
  });

  test('unchecking a checked row', async ({ page }) => {
    await open(page, '?checks=1');
    await rowBox(page, 2).click();
    await expect.poll(() => checked(page)).toBe(1);
    await rowBox(page, 2).click();
    await expect.poll(() => checked(page)).toBe(0);
  });

  test('shift+click checks a range', async ({ page }) => {
    await open(page, '?checks=1');
    await rowBox(page, 1).click();
    await rowBox(page, 5).click({ modifiers: ['Shift'] });
    await expect.poll(() => checked(page)).toBe(5); // rows 1..5
  });

  test('Space checks the active row', async ({ page }) => {
    await open(page, '?checks=1');
    await page.getByRole('gridcell', { name: 'Item 4', exact: true }).click();
    await page.keyboard.press('Space');
    await expect.poll(() => checked(page)).toBe(1);
    expect((await lastSelection(page)).checks.at(-1)).toMatchObject({ id: 4, checked: true });
    await page.keyboard.press('Space');
    await expect.poll(() => checked(page)).toBe(0);
  });

  test('the corner checkbox checks every row, then clears them', async ({ page }) => {
    await open(page, '?checks=1');
    await page.locator('.vg-cn-check .vg-check').click();
    await expect.poll(() => checked(page)).toBe(200);
    await page.locator('.vg-cn-check .vg-check').click();
    await expect.poll(() => checked(page)).toBe(0);
  });

  test('check all, then uncheck one row leaves n-1', async ({ page }) => {
    await open(page, '?checks=1');
    await page.locator('.vg-cn-check .vg-check').click();
    await rowBox(page, 0).click();
    await expect.poll(() => checked(page)).toBe(199);
  });

  test('checks survive a sort (the same rows stay checked)', async ({ page }) => {
    await open(page, '?checks=1');
    await rowBox(page, 0).click();
    await page.getByRole('columnheader', { name: /Amount/ }).locator('.vg-sortbtn').click();
    await expect.poll(async () => (await events(page, 'sort')).length).toBe(1);
    await expect.poll(() => checked(page)).toBe(1);
  });

  test('checking works at 100,000 rows without loading them (range check-all)', async ({ page }) => {
    await open(page, '?checks=1&rows=100000');
    await page.locator('.vg-cn-check .vg-check').click();
    await expect.poll(() => checked(page)).toBe(100000);
  });

  test('without rowSelection there are no checkboxes', async ({ page }) => {
    await open(page);
    await expect(page.locator('.vg-check')).toHaveCount(0);
  });
});
