// Builds the DuckDB database served by sql-backend.mjs (`npm run start:sql`).
//
//   npm run seed:sql -- [--db=data/grid.duckdb] [--rows=10000000] [--groups=4] [--leaves=100000] [--years=10]
//
// --rows    flat table rows
// --groups  flat column groups of 8 (ID, Name, City, Amount, Date, Status, Score, Code)
// --leaves  pivot products (the pivot's leaf rows); the fact table has leaves × years × 12 rows
// --years   pivot years (columns: 4 measures × years × (12 months + 4 quarters + 1) + 4)
//
// Deletes and rebuilds the file. Sizes scale linearly: the defaults take well under a minute and about
// 1–2 GB of disk; a billion flat rows takes tens of minutes and hundreds of GB.

import { seedDatabase } from '../sql-backend.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([a-z]+)=(.*)$/.exec(a);
  if (!m) throw new Error(`unknown argument "${a}" (use --name=value)`);
  return [m[1], m[2]];
}));
const count = (name, fallback) => {
  if (args[name] === undefined) return fallback;
  const n = Number(String(args[name]).replace(/[,_]/g, ''));
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`--${name} must be a positive integer`);
  return n;
};

const db = args.db ?? 'data/grid.duckdb';
const opts = { rows: count('rows', 1_00_000_000), groups: count('groups', 4), leaves: count('leaves', 100_000), years: count('years', 10) };
console.log(`Building ${db}:`, opts);
const t0 = Date.now();
await seedDatabase(db, { ...opts, log: (line) => console.log(`  ${line}`) });
console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)} s. Serve it with: npm run start:sql`);
