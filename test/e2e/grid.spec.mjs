import { test, expect } from '@playwright/test';

const open = async (page, query = '') => {
  await page.goto(`/test/e2e/fixture/index.html${query}`);
  await page.waitForFunction(() => window.__ready === true);
};
const events = (page, type) => page.evaluate((t) => window.__events.filter((e) => e.type === t), type);
const grid = (page) => page.getByRole('grid');
const sortBtn = (page, title) => page.getByRole('columnheader', { name: title }).locator('.vg-sortbtn');
const cell = (page, text) => page.getByRole('gridcell', { name: text, exact: true }).first();

test('renders headers and only the visible rows (virtualization)', async ({ page }) => {
  await open(page, '?rows=100000');
  await expect(grid(page)).toHaveAttribute('aria-rowcount', /100001|100000/);
  await expect(page.getByRole('columnheader', { name: /Name/ })).toBeVisible();
  const rendered = await page.getByRole('gridcell').count();
  expect(rendered).toBeGreaterThan(0);
  expect(rendered).toBeLessThan(600); // never the whole table
});

test('scrolling brings later rows into the DOM', async ({ page }) => {
  await open(page);
  await expect(cell(page, 'Item 5')).toBeVisible();
  await expect(cell(page, 'Item 150')).toHaveCount(0);
  await page.locator('.vg-scroller').evaluate((el) => { el.scrollTop = 150 * 28; });
  await expect(cell(page, 'Item 150')).toBeVisible();
});

test('clicking a cell selects it and reports the selection and cell click', async ({ page }) => {
  await open(page);
  await cell(page, 'Item 3').click();
  await expect(cell(page, 'Item 3')).toHaveAttribute('aria-selected', 'true');
  const clicks = await events(page, 'cellClick');
  expect(clicks.at(-1).payload).toMatchObject({ value: 'Item 3' });
  expect((await events(page, 'selection')).length).toBeGreaterThan(0);
});

test('shift+click extends a range, ctrl/cmd+click adds a second range', async ({ page }) => {
  await open(page);
  await cell(page, 'Item 1').click();
  await cell(page, 'Item 3').click({ modifiers: ['Shift'] });
  for (const t of ['Item 1', 'Item 2', 'Item 3']) await expect(cell(page, t)).toHaveAttribute('aria-selected', 'true');
  await expect(cell(page, 'Item 4')).toHaveAttribute('aria-selected', 'false');
  await cell(page, 'Item 6').click({ modifiers: ['ControlOrMeta'] });
  await expect(cell(page, 'Item 6')).toHaveAttribute('aria-selected', 'true');
  await expect(cell(page, 'Item 2')).toHaveAttribute('aria-selected', 'true');
});

test('keyboard: arrows move the active cell, shift+arrows extend', async ({ page }) => {
  await open(page);
  await cell(page, 'Item 2').click();
  await page.keyboard.press('ArrowDown');
  await expect(cell(page, 'Item 3')).toHaveAttribute('aria-selected', 'true');
  await expect(cell(page, 'Item 2')).toHaveAttribute('aria-selected', 'false');
  await page.keyboard.press('Shift+ArrowDown');
  await expect(cell(page, 'Item 4')).toHaveAttribute('aria-selected', 'true');
  await expect(cell(page, 'Item 3')).toHaveAttribute('aria-selected', 'true');
});

test('clicking a header sorts asc, then desc, then clears; the callback fires each time', async ({ page }) => {
  await open(page);
  const head = sortBtn(page, /Amount/);
  await head.click();
  await expect.poll(async () => (await events(page, 'sort')).at(-1)?.payload).toMatchObject([{ key: 'amount', direction: 'asc' }]);
  await head.click();
  await expect.poll(async () => (await events(page, 'sort')).at(-1)?.payload).toMatchObject([{ key: 'amount', direction: 'desc' }]);
  await head.click();
  await expect.poll(async () => (await events(page, 'sort')).at(-1)?.payload).toEqual([]);
});

test('shift+click adds a second sort key', async ({ page }) => {
  await open(page);
  await sortBtn(page, /City/).click();
  await sortBtn(page, /Amount/).click({ modifiers: ['Shift'] });
  await expect.poll(async () => (await events(page, 'sort')).at(-1)?.payload.map((s) => s.key)).toEqual(['city', 'amount']);
});

test('API: setQuery with a filter narrows the rows', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.__grid.setQuery({ filter: [{ column: 2, key: 'city', op: 'in', values: ['Oslo'] }] }));
  await expect(grid(page)).toHaveAttribute('aria-rowcount', '51'); // 200 rows / 4 cities + header
  await expect(page.getByRole('gridcell', { name: 'Lima', exact: true })).toHaveCount(0);
});

test('column resize by dragging the header edge reports the new width', async ({ page }) => {
  await open(page);
  const head = page.getByRole('columnheader', { name: /Name/ });
  const box = await head.boundingBox();
  const x = box.x + box.width - 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 60, y, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await events(page, 'resize')).length).toBeGreaterThan(0);
  const after = await head.boundingBox();
  expect(after.width).toBeGreaterThan(box.width + 40);
});
