// What the user actually SEES: elementFromPoint is scanned along the header row and the first body row, so a
// column hidden under a pinned one, a duplicate, a gap, or a header that no longer matches its cells all fail.
import { test, expect } from '@playwright/test';

const open = async (page, query = '') => {
  await page.goto(`/test/e2e/fixture/index.html${query}`);
  await page.waitForFunction(() => window.__ready === true);
};
const TITLES = { id: 'ID', name: 'Name', city: 'City', amount: 'Amount' };
for (let k = 0; k < 20; k++) TITLES[`x${k}`] = `X${k}`;
const CITIES = ['Oslo', 'Lima', 'Pune', 'Rome'];
// The value a column shows in data row r (see the fixture).
const valueOf = (title, r) => {
  if (title === 'ID') return String(r);
  if (title === 'Name') return `Item ${r}`;
  if (title === 'City') return CITIES[r % 4];
  if (title === 'Amount') return String((r * 7) % 50 - 10);
  return `x${title.slice(1)}-${r}`;
};
const displayOrder = async (page) => (await page.evaluate(() => window.__grid.getColumnOrder())).map((k) => TITLES[k]);

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

// Pinned columns come first and stay in order; the rest is a gap-free, in-order slice of the remaining columns.
async function expectColumns(page, { pinned, scrolled = false }) {
  const order = await displayOrder(page);
  const seen = await visibleColumns(page);
  const titles = seen.map((s) => s.title);
  expect(titles.slice(0, pinned), 'pinned columns are first, in display order').toEqual(order.slice(0, pinned));
  const rest = titles.slice(pinned);
  expect(rest.length).toBeGreaterThan(0);
  const at = order.indexOf(rest[0], pinned);
  expect(at, 'the first scrolling column is one of the unpinned columns').toBeGreaterThanOrEqual(pinned);
  expect(rest, 'no gaps, repeats or reordering among the scrolling columns').toEqual(order.slice(at, at + rest.length));
  if (!scrolled) expect(rest[0], 'unscrolled: the scrolling area starts with the first unpinned column').toBe(order[pinned]);
  for (const col of seen) expect(col.cell, `${col.title}: the first-row cell under its header`).toBe(valueOf(col.title, 0));
  return { order, seen };
}
const scrollX = async (page, left) => {
  await page.locator('.vg-scroller').evaluate((el, l) => { el.scrollLeft = l; }, left);
  await expect.poll(() => page.locator('.vg-scroller').evaluate((el) => el.scrollLeft)).toBeGreaterThan(left - 2);
};
const head = (page, name) => page.getByRole('columnheader', { name }).first();
async function dragHeader(page, from, to, side = 'left') {
  const a = await head(page, from).boundingBox();
  const b = await head(page, to).boundingBox();
  const y = a.y + a.height / 2;
  await page.mouse.move(a.x + 10, y);
  await page.mouse.down();
  await page.mouse.move(side === 'left' ? b.x + 8 : b.x + b.width - 8, y, { steps: 10 });
  await page.mouse.up();
}

test.describe('visible columns', () => {
  test('no pinning: columns start with the first one', async ({ page }) => {
    await open(page, '?wide=1');
    const { seen } = await expectColumns(page, { pinned: 0 });
    expect(seen[0].title).toBe('ID');
  });

  test('pin 2: ID and Name first, then City, Amount, X0…', async ({ page }) => {
    await open(page, '?pin=2&wide=1');
    const { seen } = await expectColumns(page, { pinned: 2 });
    expect(seen.slice(0, 4).map((s) => s.title)).toEqual(['ID', 'Name', 'City', 'Amount']);
  });

  for (const left of [50, 130, 600, 1500]) {
    test(`pin 2, scrolled right by ${left}px: pinned stay first, the rest is contiguous`, async ({ page }) => {
      await open(page, '?pin=2&wide=1');
      await scrollX(page, left);
      const { seen } = await expectColumns(page, { pinned: 2, scrolled: true });
      expect(seen.slice(0, 2).map((s) => s.title)).toEqual(['ID', 'Name']);
      if (left >= 130) expect(seen[2].title).not.toBe('City'); // City (120px wide) is fully under the pinned columns by then; at 50px it still peeks out
    });
  }

  test('pin 2, scrolled all the way right then back: columns return in order', async ({ page }) => {
    await open(page, '?pin=2&wide=1');
    await scrollX(page, 1500);
    await page.locator('.vg-scroller').evaluate((el) => { el.scrollLeft = 0; });
    await expect.poll(async () => (await visibleColumns(page)).map((s) => s.title).slice(0, 4)).toEqual(['ID', 'Name', 'City', 'Amount']);
    await expectColumns(page, { pinned: 2 });
  });

  test('pin 2 with row checkboxes: same columns, shifted right by the checkbox band', async ({ page }) => {
    await open(page, '?pin=2&wide=1&checks=1');
    const { seen } = await expectColumns(page, { pinned: 2 });
    expect(seen[0].title).toBe('ID');
    expect(seen[0].x0).toBeGreaterThan(72); // the row header band with checkboxes is wider than plain row numbers
    await scrollX(page, 600);
    await expectColumns(page, { pinned: 2, scrolled: true });
  });

  test('checkboxes without pinning: first column is still ID', async ({ page }) => {
    await open(page, '?wide=1&checks=1');
    const { seen } = await expectColumns(page, { pinned: 0 });
    expect(seen[0].title).toBe('ID');
  });

  test('reordering two pinned columns: Name, ID are now first', async ({ page }) => {
    await open(page, '?pin=2&wide=1');
    await dragHeader(page, /^Name/, /^ID/, 'left');
    await expect.poll(() => displayOrder(page).then((o) => o.slice(0, 2))).toEqual(['Name', 'ID']);
    const { seen } = await expectColumns(page, { pinned: 2 });
    expect(seen.slice(0, 2).map((s) => s.title)).toEqual(['Name', 'ID']);
    await scrollX(page, 600);
    await expectColumns(page, { pinned: 2, scrolled: true });
  });

  test('reordering an unpinned column to the first scrolling place (pin 2)', async ({ page }) => {
    await open(page, '?pin=2&wide=1');
    await dragHeader(page, /^Amount/, /^City/, 'left');
    await expect.poll(() => displayOrder(page).then((o) => o.slice(0, 4))).toEqual(['ID', 'Name', 'Amount', 'City']);
    const { seen } = await expectColumns(page, { pinned: 2 });
    expect(seen.slice(0, 4).map((s) => s.title)).toEqual(['ID', 'Name', 'Amount', 'City']);
  });

  test('reordering while scrolled right keeps pinned first and everything aligned', async ({ page }) => {
    await open(page, '?pin=2&wide=1');
    await scrollX(page, 600);
    const titles = (await visibleColumns(page)).map((s) => s.title);
    // move the first two scrolling columns' neighbours: drag the 4th visible header onto the 3rd
    await dragHeader(page, new RegExp(`^${titles[3]}`), new RegExp(`^${titles[2]}`), 'left');
    await expect.poll(async () => (await visibleColumns(page)).map((s) => s.title).slice(2, 4)).toEqual([titles[3], titles[2]]);
    await expectColumns(page, { pinned: 2, scrolled: true });
  });

  test('no pinning, reorder: Amount first, scrolling keeps order and alignment', async ({ page }) => {
    await open(page, '?wide=1');
    await dragHeader(page, /^Amount/, /^ID/, 'left');
    await expect.poll(() => displayOrder(page).then((o) => o[0])).toBe('Amount');
    const { seen } = await expectColumns(page, { pinned: 0 });
    expect(seen[0].title).toBe('Amount');
    await scrollX(page, 700);
    await expectColumns(page, { pinned: 0, scrolled: true });
  });

  test('setColumnOrder with pin 1: the pinned column is the new first one', async ({ page }) => {
    await open(page, '?pin=1&wide=1');
    await page.evaluate(() => window.__grid.setColumnOrder(['amount', 'id', 'name', 'city']));
    await expect.poll(() => visibleColumns(page).then((v) => v[0]?.title)).toBe('Amount');
    await expectColumns(page, { pinned: 1 });
    await scrollX(page, 600);
    await expectColumns(page, { pinned: 1, scrolled: true });
  });

  test('pin 2 + checkboxes + reorder: all together', async ({ page }) => {
    await open(page, '?pin=2&wide=1&checks=1');
    await dragHeader(page, /^Name/, /^ID/, 'left');
    await expect.poll(() => displayOrder(page).then((o) => o.slice(0, 2))).toEqual(['Name', 'ID']);
    await page.locator('.vg-rowhead .vg-check').nth(1).click();
    expect(await page.evaluate(() => window.__grid.checkedCount())).toBe(1);
    await expectColumns(page, { pinned: 2 });
    await scrollX(page, 600);
    await expectColumns(page, { pinned: 2, scrolled: true });
  });
});
