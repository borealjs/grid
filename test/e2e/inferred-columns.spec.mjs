// Columns taken from the rows when none are given: an array of objects and a { getRows } source show each
// field as a column, titled with its name; sorting by a header sends that field's key.
import { test, expect } from '@playwright/test';

const open = async (page, query = '') => {
  await page.goto(`/test/e2e/fixture/inferred.html${query}`);
  await page.waitForFunction(() => window.__ready === true);
};
const headers = (page) => page.evaluate(() => [...document.querySelectorAll('.vg-colhead [role=columnheader]')]
  .map((h) => h.textContent.replace(/[⇅▲▼]/g, '').trim()).filter(Boolean));
const firstRow = (page) => page.evaluate(() => {
  const row = document.querySelector('.vg-body [role=row][aria-rowindex="2"]');
  return row ? [...row.querySelectorAll('[role=gridcell]')].map((c) => c.textContent.trim()) : [];
});
const sortBy = async (page, title) => {
  const head = page.locator('.vg-colhead [role=columnheader]', { hasText: new RegExp(`^${title}`) });
  await head.hover();
  await head.locator('.vg-sortbtn').click();
};

test('an array of objects without columns: one column per field, titled with its name', async ({ page }) => {
  await open(page, '?kind=array');
  expect(await headers(page)).toEqual(['id', 'name', 'city', 'amount']);
  await expect.poll(() => firstRow(page)).toEqual(['0', 'Item 0', 'Oslo', '-10']);
  await sortBy(page, 'amount');
  expect((await page.evaluate(() => window.__grid.getQuery())).sort).toMatchObject([{ key: 'amount' }]);
});

test('a { getRows } source without columns: fields from the first page, and sorts send the field key', async ({ page }) => {
  await open(page, '?kind=rows');
  expect(await headers(page)).toEqual(['id', 'name', 'city', 'amount']);
  await expect.poll(() => firstRow(page)).toEqual(['0', 'Item 0', 'Oslo', '-10']);
  await sortBy(page, 'name');
  await expect.poll(() => page.evaluate(() => window.__calls.at(-1)?.sort)).toMatchObject([{ key: 'name' }]);
  await expect.poll(() => firstRow(page).then((r) => r[1])).toBe('Item 0'); // "Item 0" sorts first by name too
  await sortBy(page, 'name'); // descending
  await expect.poll(() => page.evaluate(() => window.__calls.at(-1)?.sort)).toMatchObject([{ key: 'name', direction: 'desc' }]);
});

test('rows that are arrays: columns by position', async ({ page }) => {
  await open(page, '?kind=arrays');
  expect(await headers(page)).toEqual(['Column 1', 'Column 2']);
  await expect.poll(() => firstRow(page)).toEqual(['0', 'Item 0']);
});

test('new rows with other fields bring their own columns', async ({ page }) => {
  await open(page, '?kind=array');
  await page.evaluate(() => window.__grid.setOptions({ data: [{ sku: 'A-1', qty: 3 }, { sku: 'B-2', qty: 5 }] }));
  await expect.poll(() => headers(page)).toEqual(['sku', 'qty']);
  await expect.poll(() => firstRow(page)).toEqual(['A-1', '3']);
});

test('columns that are given win: only those, with their titles', async ({ page }) => {
  await open(page, '?kind=given');
  expect(await headers(page)).toEqual(['Customer', 'Amount']);
  await expect.poll(() => firstRow(page)).toEqual(['Item 0', '-10']);
});
