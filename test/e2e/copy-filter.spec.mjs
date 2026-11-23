import { test, expect } from '@playwright/test';

const open = async (page, query = '') => {
  await page.goto(`/test/e2e/fixture/index.html${query}`);
  await page.waitForFunction(() => window.__ready === true);
};
const events = (page, type) => page.evaluate((t) => window.__events.filter((e) => e.type === t), type);
const cell = (page, text) => page.getByRole('gridcell', { name: text, exact: true }).first();
const rowCount = (page) => page.evaluate(() => window.__grid.rowCount);
const lastFilter = async (page) => (await events(page, 'filter')).at(-1)?.payload;
const filterBtn = (page, title) => page.getByRole('columnheader', { name: title }).first().locator('.vg-filterbtn');
const dialog = (page) => page.getByRole('dialog');
const apply = (page) => dialog(page).locator('.vg-filter-apply');
const clear = (page) => dialog(page).getByRole('button', { name: /^clear$/i });

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const readClipboard = (page) => page.evaluate(() => navigator.clipboard.readText());

test.describe('copy', () => {
  test('Cmd/Ctrl+C copies one cell as plain text', async ({ page }) => {
    await open(page);
    await cell(page, 'Item 3').click();
    await page.keyboard.press(`${mod}+c`);
    await expect.poll(() => events(page, 'copy').then((e) => e.length)).toBe(1);
    expect(await readClipboard(page)).toBe('Item 3');
    expect((await events(page, 'copy'))[0].payload).toMatchObject({ ok: true, cells: 1, rows: 1, cols: 1 });
  });

  test('a range copies as tab-separated rows', async ({ page }) => {
    await open(page);
    await cell(page, 'Item 1').click();
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press(`${mod}+c`);
    // rows 1..2, columns name..city
    await expect.poll(() => readClipboard(page)).toBe('Item 1\tLima\nItem 2\tPune');
    expect((await events(page, 'copy')).at(-1).payload).toMatchObject({ cells: 4, rows: 2, cols: 2 });
  });

  test('copy follows the current sort order', async ({ page }) => {
    await open(page);
    await page.evaluate(() => window.__grid.setQuery({ sort: [{ column: 3, key: 'amount', direction: 'desc' }] }));
    await expect.poll(() => page.evaluate(() => window.__grid.cellText(0, 3))).not.toBe('-10');
    const top = await page.evaluate(() => window.__grid.cellText(0, 1));
    await cell(page, top).click();
    await page.keyboard.press(`${mod}+c`);
    await expect.poll(() => readClipboard(page)).toBe(top);
  });

  test('copy includes rows that were never rendered (select all of 5,000 rows)', async ({ page }) => {
    await open(page, '?rows=5000');
    await cell(page, 'Item 0').click();
    await page.keyboard.press(`${mod}+a`);
    await page.keyboard.press(`${mod}+c`);
    await expect.poll(() => events(page, 'copy').then((e) => e.at(-1)?.payload.rows)).toBe(5000);
    const text = await readClipboard(page);
    expect(text.split('\n')).toHaveLength(5000);
    expect(text.split('\n')[4999]).toBe(`4,999\tItem 4999\tRome\t${(4999 * 7) % 50 - 10}`); // numbers are copied as displayed, with the thousands separator
  });

  test('API: copySelection resolves with the info', async ({ page }) => {
    await open(page);
    await cell(page, 'Item 2').click();
    const info = await page.evaluate(() => window.__grid.copySelection());
    expect(info).toMatchObject({ ok: true, cells: 1 });
  });

  test('two separate ranges (ctrl-click adds a range)', async ({ page }) => {
    await open(page);
    await cell(page, 'Item 1').click();
    await cell(page, 'Item 5').click({ modifiers: ['ControlOrMeta'] });
    const info = await page.evaluate(() => window.__grid.copySelection());
    expect(info.ranges).toBe(2);
  });
});

test.describe('filter dialog', () => {
  test('the funnel opens a dialog titled for the column; Escape closes it', async ({ page }) => {
    await open(page);
    await filterBtn(page, /City/).click();
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toHaveAttribute('aria-label', /City/);
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
  });

  test('clicking outside dismisses the dialog', async ({ page }) => {
    await open(page);
    await filterBtn(page, /City/).click();
    await expect(dialog(page)).toBeVisible();
    await page.mouse.click(780, 300); // empty body area to the right of the columns, away from the dialog
    await expect(dialog(page)).toHaveCount(0);
  });

  test('values filter: uncheck a city, Apply hides those rows and reports the condition', async ({ page }) => {
    await open(page);
    await filterBtn(page, /City/).click();
    await dialog(page).getByRole('checkbox', { name: 'Oslo' }).uncheck();
    await apply(page).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect.poll(() => rowCount(page)).toBe(150);
    await expect(page.getByRole('gridcell', { name: 'Oslo', exact: true })).toHaveCount(0);
    const f = await lastFilter(page);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ key: 'city' });
    expect(['in', 'notin']).toContain(f[0].op);
  });

  test('values filter: None, then pick one city', async ({ page }) => {
    await open(page);
    await filterBtn(page, /City/).click();
    await dialog(page).getByRole('button', { name: 'None' }).click();
    await dialog(page).getByRole('checkbox', { name: 'Lima' }).check();
    await apply(page).click();
    await expect.poll(() => rowCount(page)).toBe(50);
    expect((await lastFilter(page))[0]).toMatchObject({ op: 'in', values: ['Lima'] });
  });

  test('values filter: searching narrows the list', async ({ page }) => {
    await open(page);
    await filterBtn(page, /City/).click();
    await dialog(page).getByRole('searchbox').fill('rom'); // only "Rome" matches
    await expect(dialog(page).getByRole('checkbox')).toHaveCount(1);
    await expect(dialog(page).getByRole('checkbox', { name: 'Rome' })).toBeVisible();
    await dialog(page).getByRole('searchbox').fill('zzz');
    await expect(dialog(page).getByRole('checkbox')).toHaveCount(0);
    await expect(dialog(page).locator('.vg-filter-note')).not.toBeEmpty();
  });

  test('Clear removes an applied filter; it is disabled when none is set', async ({ page }) => {
    await open(page);
    await filterBtn(page, /City/).click();
    await expect(clear(page)).toBeDisabled();
    await dialog(page).getByRole('button', { name: 'None' }).click();
    await dialog(page).getByRole('checkbox', { name: 'Pune' }).check();
    await apply(page).click();
    await expect.poll(() => rowCount(page)).toBe(50);
    await filterBtn(page, /City/).click();
    await expect(clear(page)).toBeEnabled();
    await clear(page).click();
    await expect.poll(() => rowCount(page)).toBe(200);
    expect(await lastFilter(page)).toEqual([]);
  });

  test('the dialog reopens showing the applied filter', async ({ page }) => {
    await open(page);
    await filterBtn(page, /City/).click();
    await dialog(page).getByRole('checkbox', { name: 'Rome' }).uncheck();
    await apply(page).click();
    await expect.poll(() => rowCount(page)).toBe(150);
    await filterBtn(page, /City/).click();
    await expect(dialog(page).getByRole('checkbox', { name: 'Rome' })).not.toBeChecked();
    await expect(dialog(page).getByRole('checkbox', { name: 'Oslo' })).toBeChecked();
  });

  test('Enter in the dialog applies', async ({ page }) => {
    await open(page);
    await filterBtn(page, /Amount/).click();
    await dialog(page).getByLabel('Min').fill('30');
    await page.keyboard.press('Enter');
    await expect(dialog(page)).toHaveCount(0);
    await expect.poll(() => rowCount(page)).toBeLessThan(200);
  });

  test('number range: min and max keep rows inside (inclusive)', async ({ page }) => {
    await open(page);
    await filterBtn(page, /Amount/).click();
    await dialog(page).getByLabel('Min').fill('0');
    await dialog(page).getByLabel('Max').fill('10');
    await apply(page).click();
    const expected = Array.from({ length: 200 }, (_, i) => (i * 7) % 50 - 10).filter((v) => v >= 0 && v <= 10).length;
    await expect.poll(() => rowCount(page)).toBe(expected);
    expect((await lastFilter(page))[0]).toMatchObject({ key: 'amount', op: 'range', min: 0, max: 10 });
  });

  test('number range: only a max', async ({ page }) => {
    await open(page);
    await filterBtn(page, /Amount/).click();
    await dialog(page).getByLabel('Max').fill('-5');
    await apply(page).click();
    const expected = Array.from({ length: 200 }, (_, i) => (i * 7) % 50 - 10).filter((v) => v <= -5).length;
    await expect.poll(() => rowCount(page)).toBe(expected);
  });

  test('applying an emptied range clears the filter', async ({ page }) => {
    await open(page);
    await filterBtn(page, /Amount/).click();
    await dialog(page).getByLabel('Min').fill('30');
    await apply(page).click();
    await expect.poll(() => rowCount(page)).toBeLessThan(200);
    await filterBtn(page, /Amount/).click();
    await dialog(page).getByLabel('Min').fill('');
    await apply(page).click();
    await expect.poll(() => rowCount(page)).toBe(200);
  });

  test('filter and sort combine; the funnel shows an active state', async ({ page }) => {
    await open(page);
    await filterBtn(page, /City/).click();
    await dialog(page).getByRole('button', { name: 'None' }).click();
    await dialog(page).getByRole('checkbox', { name: 'Oslo' }).check();
    await apply(page).click();
    await expect.poll(() => rowCount(page)).toBe(50);
    await expect(filterBtn(page, /City/)).toHaveClass(/vg-filter-on/);
    await page.evaluate(() => window.__grid.setQuery({ sort: [{ column: 0, key: 'id', direction: 'desc' }] }));
    await expect.poll(() => page.evaluate(() => window.__grid.cellText(0, 2))).toBe('Oslo');
    expect(await page.evaluate(() => window.__grid.cellText(0, 0))).toBe('196'); // largest id below 200 with i % 4 == 0
  });

  test('API: setFilter and the dialog agree on state', async ({ page }) => {
    await open(page);
    await page.evaluate(() => window.__grid.setQuery({ filter: [{ column: 2, key: 'city', op: 'in', values: ['Pune'] }] }));
    await expect.poll(() => rowCount(page)).toBe(50);
    await filterBtn(page, /City/).click();
    await expect(dialog(page).getByRole('checkbox', { name: 'Pune' })).toBeChecked();
    await expect(dialog(page).getByRole('checkbox', { name: 'Oslo' })).not.toBeChecked();
  });

  test('a filter matching nothing leaves zero rows', async ({ page }) => {
    await open(page);
    await page.evaluate(() => window.__grid.setQuery({ filter: [{ column: 3, key: 'amount', op: 'range', min: 1000, max: 2000 }] }));
    await expect.poll(() => rowCount(page)).toBe(0);
    await expect(page.getByRole('gridcell')).toHaveCount(0);
  });
});
