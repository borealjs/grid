import { test, expect } from '@playwright/test';

const open = async (page, query = '') => {
  await page.goto(`/test/e2e/fixture/controlled.html${query}`);
  await page.waitForFunction(() => window.__ready === true);
};
const events = (page, type) => page.evaluate((t) => window.__events.filter((e) => e.type === t), type);
const ctl = (page, fn, arg) => page.evaluate(([f, a]) => { const c = window.__ctl; return new Function('c', 'a', f)(c, a); }, [fn, arg]);
const notice = (page) => page.locator('.vg-notice:not(.vg-work).vg-notice-show');
const work = (page) => page.locator('.vg-work.vg-notice-show');
const scrollTo = (page, row) => page.locator('.vg-scroller').evaluate((el, r) => { el.scrollTop = r * 28; }, row);
const sortAmount = (page) => page.evaluate(() => window.__grid.setSort([{ column: 3, key: 'amount', direction: 'asc' }]));

test.describe('loading', () => {
  test('cells show a placeholder while their rows load, then the values', async ({ page }) => {
    await open(page);
    await ctl(page, 'c.latency = 600');
    await scrollTo(page, 200);
    await expect(page.locator('.vg-ph').first()).toBeVisible();
    await expect(page.getByRole('gridcell', { name: 'Item 205', exact: true })).toBeVisible();
    await expect(page.locator('.vg-cell.vg-ph')).toHaveCount(0);
  });

  test('scrolling back to loaded rows needs no new request (cache)', async ({ page }) => {
    await open(page);
    const before = await ctl(page, 'return c.calls.rows');
    await scrollTo(page, 120);
    await expect(page.getByRole('gridcell', { name: 'Item 125', exact: true })).toBeVisible();
    const mid = await ctl(page, 'return c.calls.rows');
    expect(mid).toBeGreaterThan(before);
    await scrollTo(page, 0);
    await expect(page.getByRole('gridcell', { name: 'Item 3', exact: true })).toBeVisible();
    expect(await ctl(page, 'return c.calls.rows')).toBe(mid);
  });

  test('refresh() reloads the data', async ({ page }) => {
    await open(page);
    const before = await ctl(page, 'return c.calls.rows');
    await page.evaluate(() => window.__grid.refresh());
    await expect.poll(() => ctl(page, 'return c.calls.rows')).toBeGreaterThan(before);
    await expect(page.getByRole('gridcell', { name: 'Item 3', exact: true })).toBeVisible();
  });
});

test.describe('errors', () => {
  test('a failing first load reports onError(layout) and renders no cells', async ({ page }) => {
    await open(page, '?fail=1');
    expect((await events(page, 'error'))[0].extra).toEqual({ kind: 'layout' });
    await expect(page.getByRole('gridcell')).toHaveCount(0);
  });

  test('a failing page of cells reports onError(cells), then recovers by itself when the server does', async ({ page }) => {
    await open(page);
    await ctl(page, 'c.fail = true');
    await scrollTo(page, 200);
    await expect.poll(async () => (await events(page, 'error')).some((e) => e.extra?.kind === 'cells')).toBe(true);
    await expect(page.getByRole('gridcell', { name: 'Item 205', exact: true })).toHaveCount(0);
    await ctl(page, 'c.fail = false');
    await expect(page.getByRole('gridcell', { name: 'Item 205', exact: true })).toBeVisible({ timeout: 15000 }); // automatic retry
  });

  test('a failing sort shows an error notice and keeps the old order', async ({ page }) => {
    await open(page);
    await ctl(page, 'c.fail = true');
    const ok = await sortAmount(page);
    expect(ok).toBe(false);
    await expect(notice(page).filter({ hasText: /Sorting failed/ })).toBeVisible();
    await expect(notice(page)).toHaveClass(/vg-notice-error/);
    await ctl(page, 'c.fail = false');
    await expect(page.getByRole('gridcell', { name: 'Item 0', exact: true })).toBeVisible(); // unsorted order is intact
  });

  test('a failing filter shows an error notice', async ({ page }) => {
    await open(page);
    await ctl(page, 'c.fail = true');
    await page.evaluate(() => window.__grid.setFilter([{ column: 2, key: 'city', op: 'in', values: ['Oslo'] }]));
    await expect(notice(page).filter({ hasText: /Filtering failed/ })).toBeVisible();
  });

  test('error notices disappear on their own', async ({ page }) => {
    await open(page);
    await ctl(page, 'c.fail = true');
    await sortAmount(page);
    await expect(notice(page)).toBeVisible();
    await expect(notice(page)).toHaveCount(0, { timeout: 8000 });
  });
});

test.describe('slow sort / filter', () => {
  test('a slow sort shows a working line after a moment', async ({ page }) => {
    await open(page);
    await ctl(page, 'c.held = true');
    void sortAmount(page);
    await expect(work(page)).toHaveCount(0); // not at once: quick operations stay quiet
    await expect(work(page)).toBeVisible();
    await expect(work(page)).toContainText(/Sorting/);
    await ctl(page, 'c.release()');
    await expect(work(page)).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.__grid.getQuery().sort)).toMatchObject([{ key: 'amount', direction: 'asc' }]);
  });

  test('a fast sort never shows the working line', async ({ page }) => {
    await open(page);
    await sortAmount(page);
    await expect(work(page)).toHaveCount(0);
  });

  test('Cancel (clicked with the mouse) stops the sort and leaves the view unchanged', async ({ page }) => {
    await open(page);
    await ctl(page, 'c.held = true');
    void sortAmount(page);
    await expect(work(page)).toBeVisible();
    await work(page).getByRole('button', { name: 'Cancel' }).click();
    await expect.poll(async () => (await events(page, 'view')).some((e) => e.payload?.cancelled)).toBe(true);
    await expect(work(page)).toHaveCount(0);
    expect(await events(page, 'sort')).toHaveLength(0);
    await ctl(page, 'c.release()');
    expect(await page.evaluate(() => window.__grid.getQuery().sort)).toEqual([]);
  });

  test('a newer sort replaces one still running', async ({ page }) => {
    await open(page);
    await ctl(page, 'c.held = true');
    void sortAmount(page);
    await expect(work(page)).toBeVisible();
    void page.evaluate(() => window.__grid.setSort([{ column: 1, key: 'name', direction: 'desc' }]));
    await ctl(page, 'c.release()');
    await expect.poll(() => page.evaluate(() => window.__grid.getQuery().sort.map((s) => s.key))).toEqual(['name']);
  });

  test('onViewChange reports pending, then the result', async ({ page }) => {
    await open(page);
    await sortAmount(page);
    await expect.poll(async () => (await events(page, 'view')).map((e) => (e.payload.pending ? 'pending' : e.payload.ok ? 'ok' : 'other'))).toEqual(['pending', 'ok']);
  });
});

test.describe('empty states', () => {
  test('no data at all', async ({ page }) => {
    await open(page, '?rows=0');
    await expect(page.locator('.vg-empty')).toBeVisible();
    await expect(page.locator('.vg-empty')).toHaveText('No rows');
  });

  test('a filter that matches nothing says so', async ({ page }) => {
    await open(page);
    await page.evaluate(() => window.__grid.setFilter([{ column: 3, key: 'amount', op: 'range', min: 5000, max: 6000 }]));
    await expect(page.locator('.vg-empty')).toHaveText('No rows match the filter');
  });

  test('clearing the filter brings the rows back and hides the message', async ({ page }) => {
    await open(page);
    await page.evaluate(() => window.__grid.setFilter([{ column: 3, key: 'amount', op: 'range', min: 5000, max: 6000 }]));
    await expect(page.locator('.vg-empty')).toBeVisible();
    await page.evaluate(() => window.__grid.setFilter([]));
    await expect(page.locator('.vg-empty')).toBeHidden();
    await expect(page.getByRole('gridcell', { name: 'Item 1', exact: true })).toBeVisible();
  });
});
