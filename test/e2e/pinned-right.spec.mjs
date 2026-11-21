// Columns pinned to the right edge (pinnedColumnsRight): what is on screen, selection, keys, copy, merges and
// dragging. Display order in the fixture with wide=1: ID, Name, City, Amount, X0 … X19 (24 columns); pinr=2 pins
// X18 (column 22) and X19 (column 23).
import { test, expect } from '@playwright/test';

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

const open = async (page, query = '') => {
  await page.goto(`/test/e2e/fixture/index.html${query}`);
  await page.waitForFunction(() => window.__ready === true);
};
const TITLES = { id: 'ID', name: 'Name', city: 'City', amount: 'Amount' };
for (let k = 0; k < 20; k++) TITLES[`x${k}`] = `X${k}`;
const CITIES = ['Oslo', 'Lima', 'Pune', 'Rome'];
const valueOf = (title, r) => {
  if (title === 'ID') return String(r);
  if (title === 'Name') return `Item ${r}`;
  if (title === 'City') return CITIES[r % 4];
  if (title === 'Amount') return String((r * 7) % 50 - 10);
  return `x${title.slice(1)}-${r}`;
};
const displayOrder = async (page) => (await page.evaluate(() => window.__grid.getColumnOrder())).map((k) => TITLES[k]);
const sel = (page) => page.evaluate(() => window.__grid.getSelection());
const frames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const scrollLeft = (page) => page.locator('.vg-scroller').evaluate((el) => el.scrollLeft);
const scrollX = async (page, left) => {
  await page.locator('.vg-scroller').evaluate((el, l) => { el.scrollLeft = l; }, left);
  await frames(page);
};
const maxScroll = (page) => page.locator('.vg-scroller').evaluate((el) => el.scrollWidth - el.clientWidth);
const merges = (list) => `merges=${encodeURIComponent(JSON.stringify(list))}`;
const copy = async (page) => {
  const info = await page.evaluate(() => window.__grid.copySelection());
  expect(info.ok, JSON.stringify(info)).toBe(true);
  return (await page.evaluate(() => navigator.clipboard.readText())).split('\n').map((l) => l.split('\t'));
};
const rightPane = (page) => page.locator('.vg-pinbody.vg-pinright');
const head = (page, name) => page.getByRole('columnheader', { name }).first();

// The headers on screen, left to right, and the cell under the middle of each in the first body row.
async function visibleColumns(page) {
  return page.evaluate(() => {
    const g = document.getElementById('grid').getBoundingClientRect();
    const headY = g.top + 17;
    const bodyY = g.top + 34 + 14;
    const clean = (t) => t.replace(/[⇅▲▼]/g, '').trim();
    const runs = [];
    for (let x = Math.ceil(g.left) + 1; x < g.right - 1; x += 3) {
      const h = document.elementFromPoint(x, headY)?.closest('[role=columnheader]:not(.vg-cn)');
      if (!h) continue;
      const last = runs[runs.length - 1];
      if (last && last.el === h) last.x1 = x;
      else runs.push({ el: h, title: clean(h.textContent), x0: x, x1: x });
    }
    return runs.map((r) => {
      const mid = (r.x0 + r.x1) / 2;
      const c = document.elementFromPoint(mid, bodyY)?.closest('[role=gridcell]');
      return { title: r.title, x0: r.x0, x1: r.x1, cell: c ? c.textContent.trim() : null };
    });
  });
}

// Left-pinned columns first, right-pinned last (both in display order), and between them a gap-free, in-order
// slice of the scrolling columns; every header has its own column's value under it.
async function expectPanes(page, opts) {
  let out;
  // After scrolling, newly shown cells may still be loading: retry until they are in.
  await expect(async () => { out = await checkPanes(page, opts); }).toPass({ timeout: 5000 });
  return out;
}
async function checkPanes(page, { left = 0, right = 0, scrolled = false }) {
  const order = await displayOrder(page);
  const seen = await visibleColumns(page);
  const titles = seen.map((s) => s.title);
  expect(titles.slice(0, left), 'left-pinned columns first').toEqual(order.slice(0, left));
  if (right) expect(titles.slice(-right), 'right-pinned columns last').toEqual(order.slice(-right));
  const mid = titles.slice(left, titles.length - right);
  expect(mid.length).toBeGreaterThan(0);
  const at = order.indexOf(mid[0], left);
  expect(at, 'the first scrolling column is a scrolling one').toBeGreaterThanOrEqual(left);
  expect(mid, 'no gaps, repeats or reordering among the scrolling columns').toEqual(order.slice(at, at + mid.length));
  expect(at + mid.length, 'no right-pinned column shows in the scrolling area').toBeLessThanOrEqual(order.length - right);
  if (!scrolled) expect(mid[0]).toBe(order[left]);
  for (const col of seen) expect(col.cell, `${col.title}: the first-row cell under its header`).toBe(valueOf(col.title, 0));
  return { order, seen, mid };
}

test.describe('columns pinned to the right', () => {
  test('pinr 2: X18 and X19 sit at the right edge, the others start from ID', async ({ page }) => {
    await open(page, '?pinr=2&wide=1');
    const { seen } = await expectPanes(page, { right: 2 });
    expect(seen.slice(-2).map((s) => s.title)).toEqual(['X18', 'X19']);
    expect(seen[0].title).toBe('ID');
  });

  for (const left of [300, 1200]) {
    test(`pinr 2, scrolled right by ${left}px: the pane stays, the middle is contiguous`, async ({ page }) => {
      await open(page, '?pinr=2&wide=1');
      const before = await rightPane(page).boundingBox();
      await scrollX(page, left);
      await expectPanes(page, { right: 2, scrolled: true });
      expect(await rightPane(page).boundingBox()).toEqual(before);
    });
  }

  test('pinr 2, scrolled to the end: X17 shows whole, right before the pane', async ({ page }) => {
    await open(page, '?pinr=2&wide=1');
    await scrollX(page, await maxScroll(page));
    const { mid } = await expectPanes(page, { right: 2, scrolled: true });
    expect(mid.at(-1)).toBe('X17');
    const x17 = await page.getByRole('gridcell', { name: 'x17-0', exact: true }).boundingBox();
    const pane = await rightPane(page).boundingBox();
    expect(x17.x + x17.width).toBeLessThanOrEqual(pane.x + 1);
  });

  test('pinned on both sides (pin 2, pinr 2), unscrolled and scrolled', async ({ page }) => {
    await open(page, '?pin=2&pinr=2&wide=1');
    await expectPanes(page, { left: 2, right: 2 });
    await scrollX(page, 900);
    const { seen } = await expectPanes(page, { left: 2, right: 2, scrolled: true });
    expect(seen.slice(0, 2).map((s) => s.title)).toEqual(['ID', 'Name']);
    expect(seen.slice(-2).map((s) => s.title)).toEqual(['X18', 'X19']);
  });

  test('when every column fits, the pane follows the last column with no gap', async ({ page }) => {
    await open(page, '?pinr=1'); // ID, Name, City, Amount: 460px in an 728px body
    const seen = await visibleColumns(page);
    expect(seen.map((s) => s.title)).toEqual(['ID', 'Name', 'City', 'Amount']);
    for (const col of seen) expect(col.cell).toBe(valueOf(col.title, 0));
    expect(seen[3].x0 - seen[2].x1).toBeLessThanOrEqual(4); // the scan steps 3px
  });

  test('clicking a right-pinned cell selects it; clicking its header selects the column', async ({ page }) => {
    await open(page, '?pinr=2&wide=1');
    await page.getByRole('gridcell', { name: 'x19-3', exact: true }).click();
    expect((await sel(page)).active).toEqual({ r: 3, c: 23 });
    await page.locator('.vg-pinhead.vg-pinright [role=columnheader]', { hasText: /^X18/ }).click({ position: { x: 6, y: 8 } });
    expect((await sel(page)).ranges.at(-1)).toMatchObject({ c0: 22, c1: 22, r0: 0, r1: 199 });
  });

  test('ArrowRight walks into the pane; the columns before it are revealed clear of it', async ({ page }) => {
    await open(page, '?pinr=2&wide=1');
    await page.getByRole('gridcell', { name: valueOf('Amount', 0), exact: true }).first().click(); // column 3
    for (let i = 0; i < 18; i++) await page.keyboard.press('ArrowRight');
    expect((await sel(page)).active).toEqual({ r: 0, c: 21 }); // X17
    await frames(page);
    const x17 = await page.getByRole('gridcell', { name: 'x17-0', exact: true }).boundingBox();
    const pane = await rightPane(page).boundingBox();
    expect(x17.x + x17.width).toBeLessThanOrEqual(pane.x + 1);
    const at = await scrollLeft(page);
    await page.keyboard.press('ArrowRight');
    expect((await sel(page)).active).toEqual({ r: 0, c: 22 }); // X18, in the pane
    await frames(page);
    expect(await scrollLeft(page)).toBe(at); // already in view: no scrolling
    await page.keyboard.press('Home');
    await expect.poll(() => scrollLeft(page)).toBe(0);
  });

  test('Shift+arrows extend into the pane; copy is in display order', async ({ page }) => {
    await open(page, '?pinr=2&wide=1');
    await page.evaluate(() => { window.__grid.focus(); window.__grid.setSelection({ active: { r: 0, c: 20 }, ranges: [{ r0: 0, c0: 20, r1: 0, c1: 20 }] }); });
    for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowRight');
    expect((await sel(page)).ranges.at(-1)).toEqual({ r0: 0, c0: 20, r1: 0, c1: 23 });
    expect(await copy(page)).toEqual([['x16-0', 'x17-0', 'x18-0', 'x19-0']]);
  });

  test('a merge crossing into the pane: both parts show the value; it is still one cell for copy', async ({ page }) => {
    await open(page, `?pinr=2&wide=1&${merges([{ r0: 3, c0: 20, nr: 2, nc: 3, label: 'RMERGE' }])}`);
    await scrollX(page, await maxScroll(page));
    await expect(page.locator('.vg-merge:visible', { hasText: 'RMERGE' })).toHaveCount(2);
    const inPane = await page.locator('.vg-pinright .vg-merge:visible', { hasText: 'RMERGE' }).boundingBox();
    const x18 = await page.getByRole('gridcell', { name: 'x18-0', exact: true }).boundingBox();
    expect(Math.round(inPane.x)).toBe(Math.round(x18.x));
    expect(Math.round(inPane.width)).toBe(120); // X18 only
    await page.evaluate(() => window.__grid.setSelection({ active: { r: 3, c: 20 }, ranges: [{ r0: 3, c0: 20, r1: 4, c1: 22 }] }));
    expect(await copy(page)).toEqual([['RMERGE', '', ''], ['', '', '']]);
  });

  test('a merge inside the pane stays put while scrolling', async ({ page }) => {
    await open(page, `?pinr=2&wide=1&${merges([{ r0: 2, c0: 22, nr: 2, nc: 2, label: 'RPIN' }])}`);
    const m = page.locator('.vg-merge:visible', { hasText: 'RPIN' });
    await expect(m).toHaveCount(1);
    const before = await m.boundingBox();
    expect(Math.round(before.width)).toBe(240); // X18 + X19
    await scrollX(page, 700);
    expect(await m.boundingBox()).toEqual(before);
  });

  test('dragging within the pane reorders it; a scrolling column stays out of it', async ({ page }) => {
    await open(page, '?pinr=2&wide=1');
    const drag = async (from, to) => {
      const a = await head(page, from).boundingBox();
      const b = await head(page, to).boundingBox();
      const y = a.y + a.height / 2;
      await page.mouse.move(a.x + 10, y);
      await page.mouse.down();
      await page.mouse.move(b.x + 8, y, { steps: 10 });
      await page.mouse.up();
    };
    await drag(/^X19/, /^X18/);
    await expect.poll(() => displayOrder(page).then((o) => o.slice(-2))).toEqual(['X19', 'X18']);
    await expectPanes(page, { right: 2 });
    await drag(/^Amount/, /^X19/); // dropped over the pane: lands at the end of the scrolling columns in view
    const order = await displayOrder(page);
    expect(order.slice(-2)).toEqual(['X19', 'X18']);
    expect(order.indexOf('Amount')).toBeLessThan(22);
    await expectPanes(page, { right: 2 });
  });
});
