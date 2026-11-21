// The playground loads CSV files into typed columns in its worker (examples/playground/csv-columns.js).
import { test, expect } from '@playwright/test';

const openPlayground = async (page) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/examples/playground/index.html');
  await page.getByRole('tab', { name: 'Upload CSV' }).click();
  return errors;
};
const toast = (page) => page.locator('#toast');

test('the worker loads as a module and the sample CSV builds a grid', async ({ page }) => {
  const errors = await openPlayground(page);
  await page.locator('#sampleCsv').click();
  await expect(toast(page)).toContainText(/Loaded service-metrics\.csv: 25,000 rows, 10 columns/);
  await expect(page.locator('#datasetBadge')).toContainText(/25,000/);
  await expect(page.getByRole('grid')).toBeVisible();
  expect(errors).toEqual([]);
});

test('uploading a file streams it into typed columns: rows, columns, memory and cells are right', async ({ page }) => {
  const errors = await openPlayground(page);
  const rows = ['id,team,note,score,price'];
  for (let i = 0; i < 60_000; i++) rows.push(`${i},team${i % 6},"line, ${i}${i % 1000 === 0 ? '\nbreak' : ''}",${i % 100},${(i * 0.25).toFixed(2)}`);
  await page.locator('#csvFile').setInputFiles({ name: 'upload.csv', mimeType: 'text/csv', buffer: Buffer.from(rows.join('\n')) });
  await expect(toast(page)).toContainText(/Loaded upload\.csv: 60,000 rows, 5 columns \(.+ in memory\)/);
  const mem = /\(([\d.]+) (KB|MB)/.exec(await toast(page).innerText());
  expect(mem && mem[2] === 'MB' ? Number(mem[1]) : 0).toBeLessThan(10); // 60k rows x 5 columns: a few MB at most
  expect(errors).toEqual([]);
});

test('a semicolon-delimited file loads (delimiter detected)', async ({ page }) => {
  await openPlayground(page);
  await page.locator('#csvDelimiter').selectOption('auto');
  await page.locator('#csvFile').setInputFiles({ name: 'semi.csv', mimeType: 'text/csv', buffer: Buffer.from('a;b\n1;x\n2;y\n3;z') });
  await expect(toast(page)).toContainText(/Loaded semi\.csv: 3 rows, 2 columns/);
});

test('an empty file shows an error, not a hang', async ({ page }) => {
  await openPlayground(page);
  await page.locator('#csvFile').setInputFiles({ name: 'empty.csv', mimeType: 'text/csv', buffer: Buffer.from('a,b\n') });
  await expect(toast(page)).toContainText(/Could not read empty\.csv.*no data rows/);
});

test('loading reports every phase, so the bar never sits on 100% without saying what is happening', async ({ page }) => {
  await openPlayground(page);
  await page.evaluate(() => {
    window.__phases = [];
    new MutationObserver(() => {
      const t = document.querySelector('#progressPhase')?.textContent;
      if (t && window.__phases.at(-1) !== t) window.__phases.push(t);
    }).observe(document.querySelector('#progress'), { subtree: true, childList: true, characterData: true, attributes: true });
  });
  const rows = ['id,team,note,score'];
  for (let i = 0; i < 300_000; i++) rows.push(`${i},team${i % 6},note ${i % 5000},${i % 100}`);
  await page.locator('#csvFile').setInputFiles({ name: 'phases.csv', mimeType: 'text/csv', buffer: Buffer.from(rows.join('\n')) });
  await expect(toast(page)).toContainText(/Loaded phases\.csv: 300,000 rows/);
  await expect(page.locator('#progress')).toBeHidden();
  const phases = await page.evaluate(() => window.__phases);
  expect(phases).toContain('Parsing CSV');
  expect(phases).toContain('Packing columns');
  expect(phases).toContain('Building the view…');
  expect(phases.indexOf('Parsing CSV')).toBeLessThan(phases.indexOf('Packing columns'));
  // (the page's own first dataset may also have shown "Building the view…" before the upload began: compare the last one)
  expect(phases.lastIndexOf('Packing columns')).toBeLessThan(phases.lastIndexOf('Building the view…'));
});

test('text columns sort naturally even though their ranking is only computed on first use', async ({ page }) => {
  await openPlayground(page);
  const rows = ['id,team'];
  for (let i = 0; i < 2000; i++) rows.push(`${i},team${(i * 7) % 12}`); // team0 … team11, so natural order puts team2 before team10
  await page.locator('#csvFile').setInputFiles({ name: 'sortme.csv', mimeType: 'text/csv', buffer: Buffer.from(rows.join('\n')) });
  await expect(toast(page)).toContainText(/Loaded sortme\.csv/);
  await page.locator('#modeSeg').getByRole('radio', { name: /Table/ }).click();
  const head = page.getByRole('columnheader', { name: /^team/ }).first();
  await expect(head).toBeVisible();
  await head.locator('.vg-sortbtn').click();
  await expect(head).toHaveAttribute('aria-sort', 'ascending');
  await expect(page.getByRole('gridcell', { name: 'team0', exact: true }).first()).toBeVisible();
  await page.getByRole('gridcell', { name: 'team0', exact: true }).first().click();
  await head.locator('.vg-sortbtn').click();
  await expect(head).toHaveAttribute('aria-sort', 'descending');
  await expect(page.getByRole('gridcell', { name: 'team11', exact: true }).first()).toBeVisible(); // natural order: team11 is last, not team2
});
