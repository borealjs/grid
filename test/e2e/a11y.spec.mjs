import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const open = async (page, path, query = '') => {
  await page.goto(`/test/e2e/fixture/${path}${query}`);
  await page.waitForFunction(() => window.__ready === true);
};
const table = (page, q) => open(page, 'index.html', q);
const grid = (page) => page.getByRole('grid');
const cell = (page, text) => page.getByRole('gridcell', { name: text, exact: true }).first();
const sortBtn = (page, title) => page.getByRole('columnheader', { name: title }).first().locator('.vg-sortbtn');

// The automated scan: axe finds missing roles, names, ARIA misuse and contrast problems. No known
// issues are allowed: every scan must come back clean.
const scan = async (page, scope = '#grid') => {
  const { violations } = await new AxeBuilder({ page }).include(scope).analyze();
  return violations.map((v) => `${v.id}: ${v.nodes.length} node(s) · ${v.help} · e.g. ${v.nodes[0]?.target.join(' ')}`);
};

test.describe('automated (axe)', () => {
  test('table has no violations', async ({ page }) => {
    await table(page);
    expect(await scan(page)).toEqual([]);
  });

  test('table with row checkboxes and pinned columns has no violations', async ({ page }) => {
    await table(page, '?checks=1&pin=1&wide=1');
    expect(await scan(page)).toEqual([]);
  });

  test('wide table scrolled sideways has no violations', async ({ page }) => {
    await table(page, '?pin=1&wide=1');
    await page.locator('.vg-scroller').evaluate((el) => { el.scrollLeft = 600; });
    await expect(page.getByRole('columnheader', { name: /^X5/ }).first()).toBeVisible();
    expect(await scan(page)).toEqual([]);
  });

  test('sorted and filtered table has no violations', async ({ page }) => {
    await table(page);
    await sortBtn(page, /Amount/).click();
    await page.evaluate(() => window.__grid.setQuery({ filter: [{ column: 2, key: 'city', op: 'in', values: ['Oslo'] }] }));
    await expect(grid(page)).toHaveAttribute('aria-rowcount', '51');
    expect(await scan(page)).toEqual([]);
  });

  test('pivot has no violations', async ({ page }) => {
    await open(page, 'pivot.html');
    expect(await scan(page)).toEqual([]);
  });

  test('collapsed pivot has no violations', async ({ page }) => {
    await open(page, 'pivot.html');
    await page.evaluate(() => { window.__grid.toggleGroup('rows', 0, 0); window.__grid.toggleGroup('cols', 0, 0); });
    await expect.poll(() => page.evaluate(() => window.__grid.rowCount)).toBe(18);
    expect(await scan(page)).toEqual([]);
  });

  test('with the filter dialog open has no violations', async ({ page }) => {
    await table(page);
    await page.getByRole('columnheader', { name: /City/ }).first().locator('.vg-filterbtn').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(await scan(page)).toEqual([]);
  });

  test('empty grid has no violations', async ({ page }) => {
    await open(page, 'controlled.html', '?rows=0');
    expect(await scan(page)).toEqual([]);
  });

  test('dark theme has no violations', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await table(page);
    expect(await scan(page)).toEqual([]);
  });
});

test.describe('structure', () => {
  test('the grid role, label and counts', async ({ page }) => {
    await table(page);
    await expect(grid(page)).toHaveAttribute('aria-label', 'Fixture');
    await expect(grid(page)).toHaveAttribute('aria-rowcount', '201'); // 200 rows + the header row
    await expect(grid(page)).toHaveAttribute('aria-colcount', '5'); // 4 columns + the row-number band
  });

  test('column headers have the columnheader role and names', async ({ page }) => {
    await table(page);
    for (const name of ['ID', 'Name', 'City', 'Amount']) await expect(page.getByRole('columnheader', { name: new RegExp(`^${name}`) }).first()).toBeVisible();
  });

  test('every header is inside a row, so screen readers can navigate them', async ({ page }) => {
    await table(page, '?checks=1');
    const orphans = await page.evaluate(() => [...document.querySelectorAll('#grid [role=columnheader], #grid [role=rowheader]')].filter((h) => !h.closest('[role=row]')).length);
    expect(orphans).toBe(0);
  });

  test('cells carry their row and column index, offset by the header', async ({ page }) => {
    await table(page);
    const c = cell(page, 'Item 0');
    await expect(c).toHaveAttribute('aria-colindex', '3'); // row numbers (1) + id (2) + name (3)
    const row = c.locator('xpath=ancestor::*[@role="row"][1]');
    await expect(row).toHaveAttribute('aria-rowindex', '2'); // the header is row 1
  });

  test('aria-rowcount follows filtering', async ({ page }) => {
    await table(page);
    await page.evaluate(() => window.__grid.setQuery({ filter: [{ column: 2, key: 'city', op: 'in', values: ['Oslo'] }] }));
    await expect(grid(page)).toHaveAttribute('aria-rowcount', '51');
  });

  test('virtualized rows keep correct indexes after scrolling', async ({ page }) => {
    await table(page);
    await page.locator('.vg-scroller').evaluate((el) => { el.scrollTop = 150 * 28; });
    const c = cell(page, 'Item 150');
    await expect(c).toBeVisible();
    await expect(c.locator('xpath=ancestor::*[@role="row"][1]')).toHaveAttribute('aria-rowindex', '152');
  });

  test('aria-selected marks exactly the selected cells', async ({ page }) => {
    await table(page);
    await cell(page, 'Item 1').click();
    await page.keyboard.press('Shift+ArrowDown');
    await expect(page.locator('[role=gridcell][aria-selected=true]')).toHaveCount(2);
  });

  test('aria-sort follows the primary sort and is removed when cleared', async ({ page }) => {
    await table(page);
    const head = page.getByRole('columnheader', { name: /Amount/ }).first();
    await expect(head).not.toHaveAttribute('aria-sort', /.+/);
    await sortBtn(page, /Amount/).click();
    await expect(head).toHaveAttribute('aria-sort', 'ascending');
    await sortBtn(page, /Amount/).click();
    await expect(head).toHaveAttribute('aria-sort', 'descending');
    await sortBtn(page, /Amount/).click();
    await expect(head).not.toHaveAttribute('aria-sort', /.+/);
  });

  test('with several sorts only the primary column has aria-sort', async ({ page }) => {
    await table(page);
    await sortBtn(page, /City/).click();
    await sortBtn(page, /Amount/).click({ modifiers: ['Shift'] });
    await expect(page.getByRole('columnheader', { name: /City/ }).first()).toHaveAttribute('aria-sort', 'ascending');
    await expect(page.getByRole('columnheader', { name: /Amount/ }).first()).not.toHaveAttribute('aria-sort', /.+/);
  });

  test('row checkboxes are labelled', async ({ page }) => {
    await table(page, '?checks=1');
    const boxes = page.locator('.vg-check');
    expect(await boxes.count()).toBeGreaterThan(1);
    for (const box of await boxes.all()) {
      const name = await box.evaluate((el) => el.getAttribute('aria-label') ?? el.labels?.[0]?.textContent ?? '');
      expect(name.length).toBeGreaterThan(0);
    }
  });

  test('the empty state and notices are live regions', async ({ page }) => {
    await open(page, 'controlled.html', '?rows=0');
    await expect(page.locator('.vg-empty')).toHaveAttribute('aria-live', 'polite');
    await open(page, 'controlled.html');
    await page.evaluate(() => { window.__ctl.fail = true; return window.__grid.setQuery({ sort: [{ column: 3, key: 'amount', direction: 'asc' }] }); });
    const n = page.locator('.vg-notice:not(.vg-work)');
    await expect(n).toHaveAttribute('role', 'status');
    await expect(n).toHaveAttribute('aria-live', 'polite');
  });

  test('pivot headers expose roles and the grid counts include header tiers', async ({ page }) => {
    await open(page, 'pivot.html');
    await expect(grid(page)).toHaveAttribute('aria-label', 'Pivot');
    const rows = Number(await grid(page).getAttribute('aria-rowcount'));
    expect(rows).toBeGreaterThanOrEqual(33 + 1); // data rows + at least one header tier
    expect(await page.getByRole('columnheader').count()).toBeGreaterThan(5);
  });
});

test.describe('keyboard', () => {
  test('the grid is one tab stop and Tab leaves it', async ({ page }) => {
    await table(page);
    await expect(grid(page)).toHaveAttribute('tabindex', '0');
    await page.keyboard.press('Tab');
    await expect(grid(page)).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(grid(page)).not.toBeFocused(); // no keyboard trap
  });

  test('aria-activedescendant points at the active cell and follows the arrows', async ({ page }) => {
    await table(page);
    await cell(page, 'Item 1').click();
    const id1 = await grid(page).getAttribute('aria-activedescendant');
    expect(id1).toBeTruthy();
    await expect(page.locator(`[id="${id1}"]`)).toHaveText('Item 1');
    await page.keyboard.press('ArrowDown');
    const id2 = await grid(page).getAttribute('aria-activedescendant');
    expect(id2).not.toBe(id1);
    await expect(page.locator(`[id="${id2}"]`)).toHaveText('Item 2');
  });

  test('keyboard-only: arrows, Home/End, PageDown move the active cell', async ({ page }) => {
    await table(page);
    await page.keyboard.press('Tab');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => window.__grid.getSelection().active)).toEqual({ r: 1, c: 1 });
    await page.keyboard.press('PageDown');
    expect((await page.evaluate(() => window.__grid.getSelection().active)).r).toBeGreaterThan(5);
    await page.keyboard.press('Home');
    expect((await page.evaluate(() => window.__grid.getSelection().active)).c).toBe(0);
  });

  test('keyboard-only sort: Alt+S sorts the active column', async ({ page }) => {
    await table(page);
    await cell(page, 'Item 1').click();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight'); // amount
    await page.keyboard.press('Alt+s');
    await expect(page.getByRole('columnheader', { name: /Amount/ }).first()).toHaveAttribute('aria-sort', 'ascending');
  });

  test('the sort and filter icon buttons are not tab stops (keyboard has Alt+S / Alt+F)', async ({ page }) => {
    await table(page);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    const inGrid = await page.evaluate(() => !!document.activeElement?.closest('#grid'));
    expect(inGrid).toBe(false);
  });

  test('Alt+F opens the filter dialog for the active column, focus goes in, Escape returns it to the grid', async ({ page }) => {
    await table(page);
    await cell(page, 'Item 1').click();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Alt+f');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(':focus')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(grid(page)).toBeFocused();
  });

  test('keys typed in the filter dialog do not move the grid selection', async ({ page }) => {
    await table(page);
    await cell(page, 'Item 1').click();
    const before = await page.evaluate(() => window.__grid.getSelection().active);
    await page.getByRole('columnheader', { name: /Amount/ }).first().locator('.vg-filterbtn').click();
    await page.getByLabel('Min').press('ArrowDown');
    await page.getByLabel('Min').press('ArrowUp');
    expect(await page.evaluate(() => window.__grid.getSelection().active)).toEqual(before);
  });

  test('Space checks a row with the keyboard; the corner checkbox is reachable by the mouse', async ({ page }) => {
    await table(page, '?checks=1');
    await cell(page, 'Item 2').click();
    await page.keyboard.press('Space');
    expect(await page.evaluate(() => window.__grid.checkedCount())).toBe(1);
  });

  test('a mouse-free column header drag alternative: setColumnOrder keeps focus usable', async ({ page }) => {
    await table(page);
    await cell(page, 'Item 1').click();
    await page.evaluate(() => window.__grid.setColumnOrder(['name', 'id', 'city', 'amount']));
    await page.keyboard.press('ArrowRight');
    await expect(grid(page)).toBeFocused();
  });
});
