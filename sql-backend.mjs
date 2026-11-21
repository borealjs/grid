// A real database behind the grid's /api protocol: DuckDB (an embedded columnar SQL engine) instead of the
// procedural data in demo-backend.mjs. Same endpoints, same request and response shapes, so the grid clients
// work against it unchanged. `npm run seed:sql` builds the database file, `npm run start:sql` serves it.
//
// What it shows is how a SQL backend answers a grid that asks for cells *by position* (row 734,912,001,
// columns 40..60) without ever using OFFSET:
//
// Flat table (mode=flat)
//   - Columns are split into shard tables of 64 columns each (flat_s0, flat_s1, …), all keyed by row_id.
//     No SQL engine takes a million physical columns (Postgres stops at 1,600), but a million columns are
//     15,625 shards, and a block of cells touches at most a few of them.
//   - Unsorted and unfiltered, position == row_id: a block is `WHERE row_id >= r0 AND row_id < r0 + nr`,
//     a range read that DuckDB's per-row-group min/max (zone maps) narrows to one or two row groups.
//   - A sort or a filter builds a position table once per (sort, filter): `pos -> row_id`, made with
//     row_number() OVER (ORDER BY …) and stored in pos order. A block then reads a pos range from it and
//     looks the row_ids up through an ART index. The build is the only full scan; it is shown through
//     /api/progress (DuckDB's own query progress) and stopped (connection.interrupt()) when every request
//     waiting for it has been cancelled.
//
// Pivot (mode=pivot)
//   - A star schema: sales(product_id, month_id, sales, units, profit), the row dimension
//     region › country › city › product and the column dimension year › quarter › month.
//     Dimension ids are numbered depth first, so a group's children are a contiguous id range.
//   - agg(rl, rk, cl, ck, sales, units, profit) holds every subtotal: one GROUP BY GROUPING SETS over the
//     fact table for each (row level × column level). rl/cl: -1 grand total / 0 region or all months /
//     1 country or year / 2 city or quarter / 3 product or month. A block of cells is one indexed read.
//   - Filters on row or column dimensions ("visual totals": a total counts only what is left) build a
//     filtered copy of agg once per filter; sorts reorder siblings in memory (groups are few) and products
//     through a position table, like the flat table.
//   - The axis trees (TreeAxis specs) are built from the dimension tables, so the client lays out exactly
//     the hierarchy that is in the database.
//
// The `rows`, `cols`, `years` and `latency` parameters the demo backend reads are ignored here: the data is
// whatever the database holds, and the timings are the database's own.

import { mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { TreeAxis } from '@borealjs/grid-core';
import { filterSignature, parseFilter, parseSort, sortSignature } from './demo-backend.mjs';

const COLS_PER_SHARD = 64;
const MAX_BLOCK_CELLS = 20_000;
const MAX_LABELS = 2000;
const MAX_VALUES = 1000;
const MAX_GATHER_RECTS = 500;
const MAX_CACHED_VIEWS = 16; // position tables / filtered aggregates kept per kind
const NO_LIMIT = 1e15; // sorts and filters work at any size here: the client never shows a size limit
const READ_CONNECTIONS = 4;

const httpError = (message, status = 400) => Object.assign(new Error(message), { status });
const lit = (s) => `'${String(s).replaceAll("'", "''")}'`;
const sqlList = (arr) => `[${arr.map(lit).join(', ')}]`;
const intList = (arr) => arr.map((x) => String(Math.trunc(Number(x)))).join(', '); // our own integers only

/** Largest index in [lo, hi] whose value is <= v (assumes arr[lo] <= v). */
function lastLE(arr, lo, hi, v) {
  while (lo < hi) {
    const mid = lo + Math.ceil((hi - lo) / 2);
    if (arr[mid] <= v) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** 32-bit hash of (a, b), for the dimension shapes chosen at seed time. */
function mix(a, b) {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b ^ 0x27d4eb2f, 0x165667b1);
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

function nameTest(f) {
  if (f.op === 'in' || f.op === 'notin') {
    const set = new Set(f.v);
    return f.op === 'in' ? (name) => set.has(name) : (name) => !set.has(name);
  }
  return (name) => name.toLowerCase().includes(f.v);
}

/** SQL condition for a name filter on `expr`, with its parameters. */
function nameCondition(f, expr, params) {
  if (f.op === 'contains') {
    params.push(f.v);
    return `contains(lower(${expr}), ?)`;
  }
  if (f.v.length === 0) return f.op === 'in' ? 'FALSE' : 'TRUE';
  params.push(...f.v);
  return `${expr} ${f.op === 'in' ? 'IN' : 'NOT IN'} (${f.v.map(() => '?').join(', ')})`;
}

function lruSet(map, key, value, max, onEvict) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const [oldKey, old] = map.entries().next().value;
    map.delete(oldKey);
    onEvict?.(old);
  }
}

// ------------------------------------------------------------------ data definitions

const FIRST = ['Ava', 'Liam', 'Noah', 'Emma', 'Mia', 'Arjun', 'Zara', 'Kenji', 'Sofia', 'Omar', 'Lena', 'Ravi', 'Ines', 'Mateo', 'Yara', 'Hugo'];
const LAST = ['Patel', 'Garcia', 'Kim', 'Novak', 'Okafor', 'Silva', 'Haddad', 'Ito', 'Muller', 'Rossi', 'Khan', 'Dubois', 'Larsen', 'Moreau', 'Sato', 'Reyes'];
const NAMES = FIRST.flatMap((f) => LAST.map((l) => `${f} ${l}`)).sort();
const CITIES = ['Lisbon', 'Pune', 'Osaka', 'Austin', 'Nairobi', 'Oslo', 'Lima', 'Krakow', 'Seoul', 'Dublin', 'Accra', 'Porto'].sort();
const STATUSES = ['Active', 'Closed', 'On hold', 'Pending', 'Review'];
const LABELS = ['ID', 'Name', 'City', 'Amount', 'Date', 'Status', 'Score', 'Code'];
const KINDS = [
  { kind: 'number' }, { kind: 'text' }, { kind: 'values', values: CITIES }, { kind: 'number' },
  { kind: 'date' }, { kind: 'values', values: STATUSES }, { kind: 'number' }, { kind: 'text' },
];

/** SQL that generates flat column c from row_id (seed time). Column type = c % 8, as in the demo data. */
function flatSeedExpr(c) {
  const h = `hash(row_id, ${c})`;
  switch (c % 8) {
    case 1: return `${sqlList(NAMES)}[1 + (${h} % ${NAMES.length})::INTEGER]`;
    case 2: return `${sqlList(CITIES)}[1 + (${h} % ${CITIES.length})::INTEGER]`;
    case 3: return `((${h} % 10000000)::DECIMAL(18, 0) / 100)::DECIMAL(10, 2)`;
    case 4: return `DATE '2000-01-01' + (${h} % 9000)::INTEGER`;
    case 5: return `CASE WHEN ${h} % 100 < 35 THEN 'Active' WHEN ${h} % 100 < 60 THEN 'Closed' WHEN ${h} % 100 < 70 THEN 'On hold' WHEN ${h} % 100 < 90 THEN 'Pending' ELSE 'Review' END`;
    case 6: return `((${h} % 1000)::DECIMAL(18, 0) / 10)::DECIMAL(4, 1)`;
    default: return `upper(to_base((${h} % 78364164096)::BIGINT, 36, 7))`;
  }
}

const shardOf = (c) => Math.floor(c / COLS_PER_SHARD);
/** A flat column's value in queries. ID columns are the row number, so they are not stored. */
const flatExpr = (c) => (c % 8 === 0 ? '(row_id + 1)' : `s${shardOf(c)}.c${c}`);

const REGIONS = ['North America', 'Latin America', 'Western Europe', 'Northern Europe', 'Eastern Europe', 'Middle East', 'Africa', 'South Asia', 'East Asia'];
const COUNTRIES = ['United States', 'Canada', 'Mexico', 'Brazil', 'Argentina', 'Chile', 'France', 'Germany', 'Spain', 'Italy', 'Portugal',
  'Netherlands', 'Sweden', 'Norway', 'Denmark', 'Finland', 'Poland', 'Czechia', 'Hungary', 'Romania', 'UAE', 'Saudi Arabia', 'Israel',
  'Egypt', 'Nigeria', 'Kenya', 'South Africa', 'Ghana', 'India', 'Pakistan', 'Bangladesh', 'Sri Lanka', 'Japan', 'South Korea', 'China',
  'Vietnam', 'Indonesia', 'Thailand', 'Philippines', 'Malaysia', 'Singapore', 'Australia', 'New Zealand', 'Colombia', 'Peru', 'Ireland',
  'Belgium', 'Austria', 'Greece', 'Turkey', 'Morocco', 'Nepal'];
const CITY_A = ['North', 'South', 'East', 'West', 'Lake', 'River', 'Stone', 'Green', 'Silver', 'Bright', 'Oak', 'Maple', 'Pine', 'Red', 'Fair', 'High'];
const CITY_B = ['field', 'port', 'bridge', 'haven', 'ford', 'wood', 'ton', 'view', 'gate', 'brook', 'stead', 'mouth', 'crest', 'dale', 'mere', 'wick'];
const ADJ = ['Classic', 'Ultra', 'Compact', 'Smart', 'Eco', 'Pro', 'Mini', 'Max', 'Prime', 'Swift', 'Nova', 'Terra', 'Aero', 'Zen', 'Flex', 'Core'];
const NOUN = ['Kettle', 'Lamp', 'Chair', 'Desk', 'Speaker', 'Router', 'Blender', 'Drill', 'Backpack', 'Monitor', 'Heater', 'Scale', 'Camera', 'Fan', 'Mixer', 'Shelf'];
const MEASURES = ['Sales', 'Units', 'Profit', 'Margin %'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const ROW_LEVELS = [
  { name: 'Region', subtotal: true, subtotalSize: 36 },
  { name: 'Country', subtotal: true, subtotalSize: 32 },
  { name: 'City', subtotal: true, subtotalSize: 30 },
];
const COL_LEVELS = [
  { name: 'Measure', subtotal: true, subtotalSize: 132 },
  { name: 'Year', subtotal: true, subtotalSize: 120 },
  { name: 'Quarter', subtotal: true, subtotalSize: 108 },
];

/**
 * CREATE TABLE for the subtotal table: every (row level × column level) aggregate of the fact table,
 * optionally restricted by `where` (a filtered view). Sorted by key, so a block of cells is a narrow read.
 */
function aggSql(table, where) {
  const rowSets = ['', 'region_id', 'country_id', 'city_id', 'product_id'];
  const colSets = ['', 'year_id', 'quarter_id', 'month_id'];
  const sets = rowSets.flatMap((r) => colSets.map((c) => `(${[r, c].filter(Boolean).join(', ')})`)).join(', ');
  return `CREATE TABLE ${table} AS
WITH f AS (
  SELECT s.product_id, p.city_id, ci.country_id, co.region_id, s.month_id, m.year_id, m.quarter_id, s.sales, s.units, s.profit
  FROM sales s
  JOIN product p ON p.id = s.product_id
  JOIN city ci ON ci.id = p.city_id
  JOIN country co ON co.id = ci.country_id
  JOIN month m ON m.id = s.month_id
  ${where ? `WHERE ${where}` : ''}
)
SELECT
  (CASE WHEN GROUPING(product_id) = 0 THEN 3 WHEN GROUPING(city_id) = 0 THEN 2 WHEN GROUPING(country_id) = 0 THEN 1 WHEN GROUPING(region_id) = 0 THEN 0 ELSE -1 END)::TINYINT AS rl,
  coalesce(product_id, city_id, country_id, region_id, 0)::INTEGER AS rk,
  (CASE WHEN GROUPING(month_id) = 0 THEN 3 WHEN GROUPING(quarter_id) = 0 THEN 2 WHEN GROUPING(year_id) = 0 THEN 1 ELSE 0 END)::TINYINT AS cl,
  coalesce(month_id, quarter_id, year_id, 0)::INTEGER AS ck,
  sum(sales) AS sales, sum(units) AS units, sum(profit) AS profit
FROM f
GROUP BY GROUPING SETS (${sets})
ORDER BY rl, rk, cl, ck`;
}

// ------------------------------------------------------------------ seeding

/**
 * Builds a database file from scratch (deleting any file at `path`):
 * - flat: `rows` rows × `groups` groups of 8 columns, in shard tables of 64 columns
 * - pivot: about `leaves` products under 9 regions, `years` years of monthly sales per product
 */
export async function seedDatabase(path, { rows = 10_000_000, groups = 4, leaves = 100_000, years = 10, log = () => {} } = {}) {
  await mkdir(dirname(path), { recursive: true });
  await rm(path, { force: true });
  await rm(`${path}.wal`, { force: true });
  const db = await DuckDBInstance.create(path);
  const conn = await db.connect();
  const run = (sql, params) => conn.run(sql, params);
  const timed = async (label, fn) => {
    const t0 = Date.now();
    await fn();
    log(`${label} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  };

  // Flat table.
  const cols = groups * 8;
  for (let s = 0; s * COLS_PER_SHARD < cols; s++) {
    const list = [];
    for (let c = s * COLS_PER_SHARD; c < Math.min(cols, (s + 1) * COLS_PER_SHARD); c++) if (c % 8 !== 0) list.push(`${flatSeedExpr(c)} AS c${c}`);
    await timed(`flat_s${s}: ${rows.toLocaleString('en-US')} rows × ${list.length + 1} columns`, async () => {
      await run(`CREATE TABLE flat_s${s} AS SELECT row_id${list.map((x) => `, ${x}`).join('')} FROM (SELECT range AS row_id FROM range(${rows}))`);
      await run(`CREATE UNIQUE INDEX flat_s${s}_row ON flat_s${s} (row_id)`);
    });
  }

  // Pivot dimensions: irregular fan-out, decided by hash (like the demo data).
  const countriesPer = REGIONS.map((_, i) => 3 + (mix(i, 101) % 6));
  const nCountries = countriesPer.reduce((a, b) => a + b, 0);
  const citiesPer = Array.from({ length: nCountries }, (_, i) => 4 + (mix(i, 202) % 9));
  const nCities = citiesPer.reduce((a, b) => a + b, 0);
  const target = Math.max(leaves, nCities);
  const weights = Array.from({ length: nCities }, (_, i) => 1 + (mix(i, 303) % 9));
  const W = weights.reduce((a, b) => a + b, 0);
  const leavesPer = weights.map((w) => Math.max(1, Math.floor((target * w) / W)));
  let diff = target - leavesPer.reduce((a, b) => a + b, 0);
  for (let i = 0; diff !== 0 && i < nCities * 4; i++) {
    const j = i % nCities;
    if (diff > 0) { leavesPer[j]++; diff--; } else if (leavesPer[j] > 1) { leavesPer[j]--; diff++; }
  }
  const values = (rowsOf) => rowsOf.map((r) => `(${r.join(', ')})`).join(', ');
  await timed(`dimensions: ${REGIONS.length} regions, ${nCountries} countries, ${nCities} cities`, async () => {
    await run(`CREATE TABLE region (id INTEGER PRIMARY KEY, name VARCHAR)`);
    await run(`INSERT INTO region VALUES ${values(REGIONS.map((n, i) => [i, lit(n)]))}`);
    const countryRows = [];
    countriesPer.forEach((n, r) => { for (let k = 0; k < n; k++) countryRows.push([countryRows.length, r, lit(COUNTRIES[countryRows.length % COUNTRIES.length])]); });
    await run(`CREATE TABLE country (id INTEGER PRIMARY KEY, region_id INTEGER, name VARCHAR)`);
    await run(`INSERT INTO country VALUES ${values(countryRows)}`);
    const cityRows = [];
    let pstart = 0;
    citiesPer.forEach((n, co) => {
      for (let k = 0; k < n; k++) {
        const id = cityRows.length;
        const h = mix(id, 404);
        cityRows.push([id, co, lit(CITY_A[h % 16] + CITY_B[(h >>> 8) % 16]), pstart, leavesPer[id]]);
        pstart += leavesPer[id];
      }
    });
    await run(`CREATE TABLE city (id INTEGER PRIMARY KEY, country_id INTEGER, name VARCHAR, pstart BIGINT, pcount BIGINT)`);
    await run(`INSERT INTO city VALUES ${values(cityRows)}`);
  });
  await timed(`product: ${target.toLocaleString('en-US')} products`, async () => {
    const h = 'hash(p.id, 505)';
    await run(`CREATE TABLE product AS
      SELECT p.id::INTEGER AS id, c.id AS city_id,
        ${sqlList(ADJ)}[1 + (${h} % 16)::INTEGER] || ' ' || ${sqlList(NOUN)}[1 + ((${h} // 256) % 16)::INTEGER] || ' ' || (100 + (${h} // 65536) % 900)::VARCHAR AS name
      FROM (SELECT range AS id FROM range(${target})) p
      ASOF JOIN city c ON p.id >= c.pstart
      ORDER BY p.id`);
    await run(`CREATE UNIQUE INDEX product_id ON product (id)`);
  });
  await run(`CREATE TABLE month AS SELECT range::INTEGER AS id, (range // 12)::INTEGER AS year_id, (range // 3)::INTEGER AS quarter_id FROM range(${years * 12})`);
  await timed(`sales: ${(target * years * 12).toLocaleString('en-US')} fact rows`, async () => {
    // Per product: a size and a price; per month: season, growth and noise; margins can go negative.
    await run(`CREATE TABLE sales AS
      SELECT product_id, month_id, sales, round(sales / price) AS units, round(sales * margin, 2) AS profit
      FROM (
        SELECT p.id AS product_id, m.id AS month_id,
          round((200 + hash(p.id, 1) % 1800) * (1 + 0.25 * sin(2 * pi() * (m.id % 12) / 12)) * (1 + 0.04 * m.year_id)
                * (0.75 + (hash(p.id, m.id, 2) % 500) / 1000), 2) AS sales,
          5 + hash(p.id, 3) % 95 AS price,
          ((hash(p.id, 4) % 45)::DOUBLE - 5) / 100 + ((hash(p.id, m.id, 5) % 10)::DOUBLE - 5) / 100 AS margin
        FROM product p, month m
      )
      ORDER BY product_id, month_id`);
  });
  await timed('agg: every subtotal (GROUPING SETS)', () => run(aggSql('agg', '')));

  await run(`CREATE TABLE dataset (k VARCHAR PRIMARY KEY, v BIGINT)`);
  await run(`INSERT INTO dataset VALUES ('rows', ${rows}), ('cols', ${cols}), ('years', ${years})`);
  await run('CHECKPOINT');
  conn.closeSync();
}

// ------------------------------------------------------------------ serving

/** Opens a database built by seedDatabase() and returns { handleApiRequest, close }. */
export async function openSqlBackend(path, { threads } = {}) {
  const db = await DuckDBInstance.create(path, threads ? { threads: String(threads) } : {});

  // A small pool of connections: one query at a time per connection, several in parallel.
  const idle = await Promise.all(Array.from({ length: READ_CONNECTIONS }, () => db.connect()));
  const all = [...idle];
  const waiting = [];
  async function withConnection(fn) {
    const conn = idle.pop() ?? (await new Promise((resolve) => waiting.push(resolve)));
    try {
      return await fn(conn);
    } finally {
      const next = waiting.shift();
      if (next) next(conn);
      else idle.push(conn);
    }
  }
  const query = (sql, params) => withConnection(async (conn) => (await conn.runAndReadAll(sql, params)).getRowsJS());

  await query('DROP SCHEMA IF EXISTS cache CASCADE');
  await query('CREATE SCHEMA cache');
  let tableSeq = 0;
  const newTable = (prefix) => `cache.${prefix}_${++tableSeq}`;
  const dropTables = (entry) => {
    entry.promise.then((v) => { for (const t of v?.tables ?? []) query(`DROP TABLE IF EXISTS ${t}`).catch(() => {}); }, () => {});
  };

  const info = Object.fromEntries((await query('SELECT k, v FROM dataset')).map(([k, v]) => [k, Number(v)]));
  const ROWS = info.rows;
  const COLS = info.cols;
  const Y = info.years;

  // Long builds (position tables, filtered aggregates): one connection each, progress and cancellation.
  const jobs = new Map(); // key -> { phase, started, conn, waiters }
  function build(cache, key, phase, cancelled, fn) {
    let entry = cache.get(key);
    if (!entry) {
      const job = { phase, started: Date.now(), conn: null, waiters: new Set() };
      jobs.set(key, job);
      const promise = (async () => {
        const conn = await db.connect();
        job.conn = conn;
        const timer = setInterval(() => {
          if (job.waiters.size && [...job.waiters].every((gaveUp) => gaveUp())) conn.interrupt();
        }, 150);
        try {
          return await fn(conn, job);
        } catch (err) {
          if (/interrupt/i.test(String(err?.message))) throw httpError('cancelled', 499);
          throw err;
        } finally {
          clearInterval(timer);
          jobs.delete(key);
          conn.closeSync();
        }
      })();
      entry = { promise };
      promise.catch(() => { if (cache.get(key) === entry) cache.delete(key); });
      lruSet(cache, key, entry, MAX_CACHED_VIEWS, dropTables);
    }
    jobs.get(key)?.waiters.add(cancelled);
    return entry.promise;
  }
  function progress(key) {
    const job = jobs.get(key);
    if (!job) return { active: false };
    let pct = -1;
    try { pct = job.conn ? job.conn.progress.percentage : -1; } catch { /* not started yet */ }
    return { active: true, phase: job.phase, done: pct >= 0 ? Math.round(pct * 10) : 0, total: pct >= 0 ? 1000 : 0, ms: Date.now() - job.started };
  }
  const readAll = async (conn, sql, params) => (await conn.runAndReadAll(sql, params)).getRowsJS();

  // ---------------------------------------------------------------- flat

  const flatViews = new Map();

  function compileFlatFilters(filters, params) {
    const parts = [];
    for (const f of filters) {
      const kind = KINDS[f.c % 8].kind;
      const e = flatExpr(f.c);
      if (f.op === 'range') {
        if (kind !== 'number' && kind !== 'date') throw httpError('range filters work on numbers and dates');
        for (const [bound, op] of [[f.min, '>='], [f.max, '<=']]) {
          if (bound === undefined) continue;
          if ((kind === 'date') !== (typeof bound === 'string')) throw httpError(kind === 'date' ? 'date ranges take YYYY-MM-DD bounds' : 'number ranges take numbers');
          parts.push(`${e} ${op} ?${kind === 'date' ? '::DATE' : ''}`);
          params.push(bound);
        }
      } else {
        parts.push(nameCondition(f, `${e}::VARCHAR`, params));
      }
    }
    return parts;
  }

  /** The rows in view order: { count, table } (table null: position == row_id). */
  function flatView(keys, filters, cancelled) {
    if (keys.length === 0 && filters.length === 0) return Promise.resolve({ count: ROWS, table: null });
    const key = flatKey(keys, filters);
    return build(flatViews, key, filters.length ? 'Filtering rows' : 'Sorting rows', cancelled, async (conn) => {
      const shards = new Set();
      for (const c of [...keys.map((k) => k.col), ...filters.map((f) => f.c)]) if (c % 8 !== 0) shards.add(shardOf(c));
      if (shards.size === 0) shards.add(0);
      const [first, ...rest] = [...shards];
      const from = `flat_s${first} s${first}${rest.map((s) => ` JOIN flat_s${s} s${s} USING (row_id)`).join('')}`;
      const params = [];
      const where = compileFlatFilters(filters, params);
      const order = [...keys.map((k) => `${flatExpr(k.col)} ${k.desc ? 'DESC' : 'ASC'}`), 'row_id'].join(', ');
      const table = newTable('flat');
      await conn.run(`CREATE TABLE ${table} AS
        SELECT (row_number() OVER (ORDER BY ${order}) - 1)::BIGINT AS pos, row_id
        FROM ${from} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY pos`, params);
      const [[count]] = await readAll(conn, `SELECT count(*) FROM ${table}`);
      return { count: Number(count), table, tables: [table] };
    });
  }
  const flatKey = (keys, filters) => `flat|${sortSignature(keys)}|${filterSignature(filters)}`;

  async function flatBlock(view, r0, c0, nr, nc) {
    const ids = view.table
      ? (await query(`SELECT row_id FROM ${view.table} WHERE pos >= ${r0} AND pos < ${r0 + nr} ORDER BY pos`)).map((r) => Number(r[0]))
      : Array.from({ length: nr }, (_, i) => r0 + i);
    const at = new Map(ids.map((id, i) => [id, i]));
    const cells = new Array(nr * nc).fill('');
    const byShard = new Map();
    for (let c = c0; c < c0 + nc; c++) {
      if (c % 8 === 0) {
        ids.forEach((id, i) => { cells[i * nc + (c - c0)] = String(id + 1); });
        continue;
      }
      const s = shardOf(c);
      if (!byShard.has(s)) byShard.set(s, []);
      byShard.get(s).push(c);
    }
    if (ids.length === 0) return cells;
    const where = view.table ? `row_id IN (${intList(ids)})` : `row_id >= ${r0} AND row_id < ${r0 + nr}`;
    await Promise.all([...byShard].map(async ([s, list]) => {
      const rows = await query(`SELECT row_id, ${list.map((c) => `c${c}::VARCHAR`).join(', ')} FROM flat_s${s} WHERE ${where}`);
      for (const row of rows) {
        const i = at.get(Number(row[0]));
        list.forEach((c, k) => { cells[i * nc + (c - c0)] = row[k + 1] ?? ''; });
      }
    }));
    return cells;
  }

  // ---------------------------------------------------------------- pivot: dimensions

  const regionRows = await query('SELECT name FROM region ORDER BY id');
  const countryRows = await query('SELECT region_id, name FROM country ORDER BY id');
  const cityRows = await query('SELECT country_id, name, pstart, pcount FROM city ORDER BY id');
  const groupNames = [regionRows.map((r) => r[0]), countryRows.map((r) => r[1]), cityRows.map((r) => r[1])];
  const parentOf = [null, countryRows.map((r) => r[0]), cityRows.map((r) => r[0])];
  const pstart = cityRows.map((r) => Number(r[2]));
  const pcount = cityRows.map((r) => Number(r[3]));
  const countBy = (parents, n) => {
    const out = new Array(n).fill(0);
    for (const p of parents) out[p]++;
    return out;
  };
  const rowSpec = {
    levels: ROW_LEVELS,
    leafName: 'Product',
    leafSize: 28,
    roots: groupNames[0].length,
    fanout: [countBy(parentOf[1], groupNames[0].length), countBy(parentOf[2], groupNames[1].length), pcount],
    grandTotal: true,
    grandSize: 40,
  };
  const colSpec = { levels: COL_LEVELS, leafName: 'Month', leafSize: 96, roots: MEASURES.length, fanout: [Y, 4, 3], grandTotal: false };
  const rowTree = new TreeAxis(rowSpec);
  const colTree = new TreeAxis(colSpec);
  const ROW_DEPTH = rowTree.depth; // 3: products are level 3
  const aggs = new Map(); // filtered subtotal tables: where-signature -> Promise<{ table, tables }>
  const rowViews = new Map();
  const colViews = new Map();

  const money = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const whole = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  function measureValue(measure, sales, units, profit) {
    if (measure === 0) return sales;
    if (measure === 1) return units;
    if (measure === 2) return profit;
    return sales ? profit / sales : null;
  }
  function formatValue(measure, v) {
    if (v === null || v === undefined || Number.isNaN(v)) return '';
    if (measure === 1) return whole.format(v);
    if (measure === 3) return `${(v * 100).toFixed(1)}%`;
    return money.format(v);
  }
  const measureSql = (measure, a) => [`${a}.sales`, `${a}.units`, `${a}.profit`, `${a}.profit / nullif(${a}.sales, 0)`][measure];

  // ---------------------------------------------------------------- pivot: column axis

  /**
   * The column axis under a column filter (names of measures, years, quarters, months). Month names do
   * not depend on the measure, so the kept months are the same under every measure: the totals are
   * recomputed from the fact table restricted to those months (`months`, null when all are kept).
   */
  function colView(colFilters) {
    for (const f of colFilters) {
      if (f.dim === undefined || f.op === 'range') throw httpError('Column filters work on column dimensions: a list of names, or text to search for');
    }
    const sig = filterSignature(colFilters);
    let v = colViews.get(sig);
    if (v) return v;
    const tests = [0, 1, 2, 3].map((L) => colFilters.filter((f) => f.dim === L).map(nameTest));
    const ok = (L, name) => tests[L].every((fn) => fn(name));
    const keptMq = [0, 1, 2, 3].map((q) => [0, 1, 2].filter((mq) => ok(3, MONTHS[q * 3 + mq])));
    const quarters = [0, 1, 2, 3].filter((q) => ok(2, `Q${q + 1}`) && keptMq[q].length > 0);
    const years = Array.from({ length: Y }, (_, y) => y).filter((y) => ok(1, `FY ${2001 + y}`) && quarters.length > 0);
    const measures = [0, 1, 2, 3].filter((m) => ok(0, MEASURES[m]) && years.length > 0);
    const sigma = [measures, measures.flatMap((m) => years.map((y) => m * Y + y))];
    sigma.push(sigma[1].flatMap((g) => quarters.map((q) => g * 4 + q)));
    const fanout = [measures.map(() => years.length), sigma[1].map(() => quarters.length), sigma[2].map((o) => keptMq[o % 4].length)];
    const spec = colFilters.length ? { ...colSpec, roots: measures.length, fanout } : colSpec;
    const tree = colFilters.length ? new TreeAxis(spec) : colTree;
    const months = years.flatMap((y) => quarters.flatMap((q) => keptMq[q].map((mq) => y * 12 + q * 3 + mq)));
    const leafGroup = (i) => lastLE(tree.childStart[2], 0, tree.cnt[2] - 1, i);
    v = {
      sig,
      tree,
      spec,
      maps: colFilters.length ? sigma : null,
      months: months.length < Y * 12 ? months : null,
      /** Column c -> its measure and subtotal key (cl, ck) in agg. */
      node(c) {
        const loc = tree.locate(c);
        const measure = sigma[0][loc.path[0]];
        if (loc.kind === 'leaf') {
          const o = sigma[2][loc.path[2]];
          return { measure, cl: 3, ck: (o % (4 * Y)) * 3 + keptMq[o % 4][loc.leafInGroup] };
        }
        const o = sigma[loc.level][loc.path[loc.level]];
        if (loc.level === 0) return { measure, cl: 0, ck: 0 };
        return loc.level === 1 ? { measure, cl: 1, ck: o % Y } : { measure, cl: 2, ck: o % (4 * Y) };
      },
      name(L, i) {
        if (L === 0) return MEASURES[sigma[0][i]];
        if (L === 1) return `FY ${2001 + (sigma[1][i] % Y)}`;
        if (L === 2) return `Q${(sigma[2][i] % 4) + 1}`;
        const g = leafGroup(i);
        const o = sigma[2][g];
        return MONTHS[(o % 4) * 3 + keptMq[o % 4][i - tree.childStart[2][g]]];
      },
    };
    lruSet(colViews, sig, v, MAX_CACHED_VIEWS);
    return v;
  }

  // ---------------------------------------------------------------- pivot: row axis

  const pivotKey = (keys, filters, cv) => `pivot|${sortSignature(keys)}|${filterSignature(filters)}|${cv.sig}`;
  const identity = (n) => Array.from({ length: n }, (_, i) => i);
  const plainRowView = {
    tree: rowTree,
    spec: rowSpec,
    maps: null,
    agg: 'agg',
    sigma: rowTree.cnt.map(identity),
    leafTable: null,
  };

  /**
   * The row axis under a sort and/or filter, and the subtotal table its cells come from:
   * { tree, spec, maps, sigma, agg, leafTable }. sigma[L][i] = id of displayed group i at level L.
   * leafTable (when products are filtered or sorted): leaf position -> product id.
   */
  function rowView(keys, filters, cv, cancelled) {
    if (keys.length === 0 && filters.length === 0 && !cv.months) return Promise.resolve(plainRowView);
    for (const f of filters) {
      if (f.dim === undefined || f.op === 'range') throw httpError('Pivot filters work on row dimensions: a list of names, or text to search for');
    }
    return build(rowViews, pivotKey(keys, filters, cv), filters.length || cv.months ? 'Filtering' : 'Sorting', cancelled, (conn, job) => buildRowView(conn, job, keys, filters, cv, cancelled));
  }

  async function buildRowView(conn, job, keys, filters, cv, cancelled) {
    const D = ROW_DEPTH;
    // 1) Groups that pass their own level's filters and their ancestors'.
    const tests = [0, 1, 2].map((L) => filters.filter((f) => f.dim === L).map(nameTest));
    const pass = groupNames.map((names, L) => names.map(() => false));
    for (let L = 0; L < D; L++) {
      groupNames[L].forEach((name, g) => {
        pass[L][g] = (L === 0 || pass[L - 1][parentOf[L][g]]) && tests[L].every((fn) => fn(name));
      });
    }
    // 2) Products that pass (SQL), counted per city.
    const prodParams = [];
    const prodConds = filters.filter((f) => f.dim === D).map((f) => nameCondition(f, 'p.name', prodParams));
    const leafCount = new Array(pcount.length).fill(0);
    if (prodConds.length) {
      job.phase = 'Filtering products';
      for (const [city, n] of await readAll(conn, `SELECT city_id, count(*) FROM product p WHERE ${prodConds.join(' AND ')} GROUP BY city_id`, prodParams)) {
        if (pass[2][city]) leafCount[city] = Number(n);
      }
    } else {
      pcount.forEach((n, city) => { if (pass[2][city]) leafCount[city] = n; });
    }
    // 3) Kept groups: something is left below them.
    const kept = [null, null, leafCount.map((n) => n > 0)];
    for (let L = D - 2; L >= 0; L--) {
      kept[L] = groupNames[L].map(() => false);
      kept[L + 1].forEach((k, g) => { if (k) kept[L][parentOf[L + 1][g]] = true; });
    }
    const children = [0, 1].map((L) => groupNames[L].map(() => []));
    for (let L = 1; L < D; L++) parentOf[L].forEach((p, g) => { if (kept[L][g]) children[L - 1][p].push(g); });

    // 4) The subtotals: the whole agg table, or a copy restricted to what the filters leave.
    let agg = 'agg';
    const tables = [];
    const removedCities = kept[2].some((k, city) => !k && pcount[city] > 0);
    if (removedCities || prodConds.length || cv.months) {
      const params = [];
      const where = [];
      if (removedCities) where.push(`p.city_id IN (${intList(kept[2].flatMap((k, city) => (k ? [city] : [])))})`);
      if (prodConds.length) { where.push(...prodConds); params.push(...prodParams); }
      if (cv.months) where.push(`s.month_id IN (${intList(cv.months)})`);
      const aggKey = JSON.stringify([where, params]);
      let entry = aggs.get(aggKey);
      if (!entry) {
        const table = newTable('agg');
        job.phase = 'Computing totals';
        entry = { promise: conn.run(aggSql(table, where.join(' AND ')), params).then(() => ({ table, tables: [table] })) };
        entry.promise.catch(() => aggs.delete(aggKey));
        lruSet(aggs, aggKey, entry, MAX_CACHED_VIEWS, dropTables);
      }
      ({ table: agg } = await entry.promise);
    }

    // 5) Order: siblings sorted by the keys that apply to their level (a value column: the group's total).
    const sortedValues = new Map();
    const levelValues = async (L, k) => {
      const id = `${L}|${k.col}`;
      if (!sortedValues.has(id)) {
        const { measure, cl, ck } = cv.node(k.col);
        const rows = await readAll(conn, `SELECT rk, ${measureSql(measure, 'a')} FROM ${agg} a WHERE rl = ${L} AND cl = ${cl} AND ck = ${ck}`);
        sortedValues.set(id, new Map(rows.map(([rk, v]) => [Number(rk), v === null ? null : Number(v)])));
      }
      return sortedValues.get(id);
    };
    const sortGroups = async (L, groups) => {
      const applicable = keys.filter((k) => k.col !== undefined || k.dim === L);
      if (applicable.length === 0 || groups.length < 2) return groups;
      const columns = [];
      for (const k of applicable) {
        if (k.dim !== undefined) columns.push({ desc: k.desc, get: (g) => groupNames[L][g], text: true });
        else { const vals = await levelValues(L, k); columns.push({ desc: k.desc, get: (g) => vals.get(g) ?? -Infinity }); }
      }
      return [...groups].sort((a, b) => {
        for (const { desc, get, text } of columns) {
          const va = get(a);
          const vb = get(b);
          const d = text ? (va < vb ? -1 : va > vb ? 1 : 0) : va - vb;
          if (d !== 0) return desc ? -d : d;
        }
        return a - b;
      });
    };
    const sigma = [await sortGroups(0, groupNames[0].map((_, g) => g).filter((g) => kept[0][g]))];
    for (let L = 1; L < D; L++) {
      const out = [];
      for (const p of sigma[L - 1]) out.push(...(await sortGroups(L, children[L - 1][p])));
      sigma.push(out);
    }
    const fanout = sigma.map((list, L) => list.map((g) => (L < D - 1 ? children[L][g].length : leafCount[g])));
    const spec = { ...rowSpec, roots: sigma[0].length, fanout };
    const tree = new TreeAxis(spec);

    // 6) Products: a position table when they are filtered or sorted (cities in display order, then keys).
    let leafTable = null;
    const leafKeys = keys.filter((k) => k.col !== undefined || k.dim === D);
    if ((prodConds.length || leafKeys.length) && sigma[D - 1].length) {
      job.phase = 'Ordering products';
      const joins = [];
      const order = ['o.ord'];
      leafKeys.forEach((k, i) => {
        if (k.dim !== undefined) { order.push(`p.name ${k.desc ? 'DESC' : 'ASC'}`); return; }
        const { measure, cl, ck } = cv.node(k.col);
        joins.push(`LEFT JOIN ${agg} a${i} ON a${i}.rl = 3 AND a${i}.rk = p.id AND a${i}.cl = ${cl} AND a${i}.ck = ${ck}`);
        order.push(`${measureSql(measure, `a${i}`)} ${k.desc ? 'DESC' : 'ASC'} NULLS LAST`);
      });
      order.push('p.id');
      leafTable = newTable('leaves');
      tables.push(leafTable);
      await conn.run(`CREATE TABLE ${leafTable} AS
        SELECT (row_number() OVER (ORDER BY ${order.join(', ')}) - 1)::BIGINT AS leaf, p.id
        FROM product p
        JOIN (VALUES ${sigma[D - 1].map((city, ord) => `(${city}, ${ord})`).join(', ')}) o(city_id, ord) ON o.city_id = p.city_id
        ${joins.join('\n')}
        ${prodConds.length ? `WHERE ${prodConds.join(' AND ')}` : ''}
        ORDER BY leaf`, prodParams);
    }
    if (cancelled()) throw httpError('cancelled', 499);
    return { tree, spec, maps: sigma, sigma, agg, leafTable, tables };
  }

  /** Product ids of leaf positions (view order). Positions come in runs; each run is one range read. */
  async function productIds(view, leaves) {
    const out = new Map();
    if (leaves.length === 0) return out;
    if (!view.leafTable) {
      const t = view.tree;
      for (const i of leaves) {
        const g = lastLE(t.childStart[2], 0, t.cnt[2] - 1, i);
        out.set(i, pstart[view.sigma[2][g]] + (i - t.childStart[2][g]));
      }
      return out;
    }
    const sorted = [...new Set(leaves)].sort((a, b) => a - b);
    const ranges = [];
    for (const i of sorted) {
      const last = ranges[ranges.length - 1];
      if (last && i <= last[1] + 64) last[1] = i;
      else ranges.push([i, i]);
    }
    const where = ranges.map(([a, b]) => `(leaf BETWEEN ${a} AND ${b})`).join(' OR ');
    for (const [leaf, id] of await query(`SELECT leaf, id FROM ${view.leafTable} WHERE ${where}`)) out.set(Number(leaf), Number(id));
    return out;
  }

  /** Cells of several rects (row-major arrays, one per rect) with one subtotal query. */
  async function pivotCells(view, cv, rects) {
    const t = view.tree;
    const rowNode = new Map(); // view row -> { rl, rk } or { leaf }
    const colNode = new Map();
    for (const [r0, c0, nr, nc] of rects) {
      for (let r = r0; r < r0 + nr; r++) {
        if (rowNode.has(r)) continue;
        const loc = t.locate(r);
        if (loc.kind === 'grand') rowNode.set(r, { rl: -1, rk: 0 });
        else if (loc.kind === 'leaf') rowNode.set(r, { rl: 3, leaf: loc.leaf });
        else rowNode.set(r, { rl: loc.level, rk: view.sigma[loc.level][loc.path[loc.level]] });
      }
      for (let c = c0; c < c0 + nc; c++) if (!colNode.has(c)) colNode.set(c, cv.node(c));
    }
    const ids = await productIds(view, [...rowNode.values()].filter((n) => n.leaf !== undefined).map((n) => n.leaf));
    for (const n of rowNode.values()) if (n.leaf !== undefined) n.rk = ids.get(n.leaf);

    const byRl = new Map();
    for (const { rl, rk } of rowNode.values()) {
      if (!byRl.has(rl)) byRl.set(rl, new Set());
      byRl.get(rl).add(rk);
    }
    const byCl = new Map();
    for (const { cl, ck } of colNode.values()) {
      if (!byCl.has(cl)) byCl.set(cl, new Set());
      byCl.get(cl).add(ck);
    }
    const colCond = [...byCl].map(([cl, cks]) => `(cl = ${cl} AND ck IN (${intList([...cks])}))`).join(' OR ');
    const sql = [...byRl].map(([rl, rks]) => {
      const list = [...rks];
      return `SELECT rl, rk, cl, ck, sales, units, profit FROM ${view.agg}
        WHERE rl = ${rl} AND rk BETWEEN ${Math.min(...list)} AND ${Math.max(...list)} AND rk IN (${intList(list)}) AND (${colCond})`;
    }).join(' UNION ALL ');
    const values = new Map();
    for (const [rl, rk, cl, ck, s, u, p] of await query(sql)) values.set(`${rl}|${rk}|${cl}|${ck}`, [Number(s), Number(u), Number(p)]);

    return rects.map(([r0, c0, nr, nc]) => {
      const cells = new Array(nr * nc);
      let i = 0;
      for (let r = r0; r < r0 + nr; r++) {
        const { rl, rk } = rowNode.get(r);
        for (let c = c0; c < c0 + nc; c++) {
          const { measure, cl, ck } = colNode.get(c);
          const v = values.get(`${rl}|${rk}|${cl}|${ck}`);
          cells[i++] = v ? formatValue(measure, measureValue(measure, ...v)) : '';
        }
      }
      return cells;
    });
  }

  async function pivotLabels(view, cv, axis, level, from, n) {
    const tree = axis === 'rows' ? view.tree : axis === 'cols' ? cv.tree : null;
    if (!tree || level < 0 || level > tree.depth) return null;
    const size = level === tree.depth ? tree.leafCount : tree.cnt[level];
    if (from >= size) return null;
    const to = Math.min(size, from + n);
    const range = Array.from({ length: to - from }, (_, i) => from + i);
    if (axis === 'cols') return range.map((i) => cv.name(level, i));
    if (level < tree.depth) return range.map((i) => groupNames[level][view.sigma[level][i]]);
    const ids = await productIds(view, range);
    const idList = range.map((i) => ids.get(i));
    const names = new Map((await query(`SELECT id, name FROM product WHERE id IN (${intList(idList)})`)).map(([id, name]) => [Number(id), name]));
    return idList.map((id) => names.get(id) ?? '');
  }

  const distinctCache = new Map();
  async function pivotValues(axis, level, q, limit) {
    const needle = q.trim().toLowerCase();
    if (axis === 'rows' && level === ROW_DEPTH) {
      // Products: too many to hold in memory, so the database searches them.
      if (!distinctCache.has('products')) distinctCache.set('products', Number((await query('SELECT count(DISTINCT name) FROM product'))[0][0]));
      const total = distinctCache.get('products');
      const cond = needle ? 'WHERE contains(lower(name), ?)' : '';
      const params = needle ? [needle] : [];
      const [[matches]] = needle ? await query(`SELECT count(DISTINCT name) FROM product ${cond}`, params) : [[total]];
      const values = (await query(`SELECT DISTINCT name FROM product ${cond} ORDER BY name LIMIT ${limit}`, params)).map((r) => r[0]);
      return { total, matches: Number(matches), values };
    }
    let all;
    if (axis === 'rows' && level >= 0 && level < ROW_DEPTH) all = [...new Set(groupNames[level])].sort((a, b) => a.localeCompare(b));
    else if (axis === 'cols' && level >= 0 && level <= 3) {
      all = [MEASURES, Array.from({ length: Y }, (_, y) => `FY ${2001 + y}`), ['Q1', 'Q2', 'Q3', 'Q4'], MONTHS][level];
    } else return null;
    const matching = needle ? all.filter((name) => name.toLowerCase().includes(needle)) : all;
    return { total: all.length, matches: matching.length, values: matching.slice(0, limit) };
  }

  // ---------------------------------------------------------------- requests

  function int(value, fallback, min, max) {
    if (value === null || value === '') return fallback;
    const n = Number(value);
    if (!Number.isSafeInteger(n)) return fallback;
    return Math.min(Math.max(n, min), max);
  }

  /** Same contract as demo-backend.mjs handleApiRequest(). */
  async function handleApiRequest({ url, method = 'GET', readBody = async () => null, cancelled = () => false }) {
    const reply = (status, body) => ({ status, body });
    const p = url.searchParams;
    const isPivot = p.get('mode') !== 'flat';
    const cv = isPivot ? colView(parseFilter(p.get('colfilter') ?? '', { cols: 0, depth: colTree.depth })) : null;
    const shape = isPivot ? { cols: cv.tree.count, depth: ROW_DEPTH } : { cols: COLS };
    const keys = parseSort(p.get('sort') ?? '', shape);
    const filters = parseFilter(p.get('filter') ?? '', shape);

    if (url.pathname === '/api/progress') {
      return reply(200, progress(isPivot ? pivotKey(keys, filters, cv) : flatKey(keys, filters)));
    }

    if (url.pathname === '/api/values') {
      if (!isPivot) return reply(400, { error: 'values are listed for pivot dimensions only' });
      const q = p.get('q') ?? '';
      if (q.length > 200) return reply(400, { error: 'search text too long' });
      const out = await pivotValues(p.get('axis'), int(p.get('level'), -1, -1, 64), q, int(p.get('limit'), MAX_VALUES, 1, MAX_VALUES));
      return out ? reply(200, out) : reply(400, { error: 'unknown dimension' });
    }

    let body = null;
    if (url.pathname === '/api/gather') {
      if (method !== 'POST') return reply(405, { error: 'use POST' });
      body = await readBody();
    }

    const view = isPivot ? await rowView(keys, filters, cv, cancelled) : await flatView(keys, filters, cancelled);
    if (cancelled()) return null;

    if (url.pathname === '/api/meta') {
      if (isPivot) return reply(200, { mode: 'pivot', rows: view.spec, cols: cv.spec, rowMaps: view.maps, colMaps: cv.maps, filter: { maxLeafRows: NO_LIMIT } });
      return reply(200, {
        mode: 'flat', rows: view.count, totalRows: ROWS, cols: COLS, columnKinds: KINDS, columnTypes: LABELS,
        sort: { multiMaxRows: NO_LIMIT }, filter: { maxRows: NO_LIMIT },
      });
    }

    const rowCount = isPivot ? view.tree.count : view.count;
    const colCount = isPivot ? cv.tree.count : COLS;
    const cellsOf = (rects) => (isPivot ? pivotCells(view, cv, rects) : Promise.all(rects.map((r) => flatBlock(view, ...r))));

    if (url.pathname === '/api/block') {
      const r0 = int(p.get('r0'), -1, -1, NO_LIMIT);
      const c0 = int(p.get('c0'), -1, -1, NO_LIMIT);
      if (r0 < 0 || c0 < 0 || r0 >= rowCount || c0 >= colCount) return reply(400, { error: 'block out of range' });
      const nr = Math.min(int(p.get('nr'), 100, 1, 1000), rowCount - r0);
      const nc = Math.min(int(p.get('nc'), 20, 1, 200), colCount - c0);
      if (nr * nc > MAX_BLOCK_CELLS) return reply(400, { error: 'block too large' });
      const [cells] = await cellsOf([[r0, c0, nr, nc]]);
      if (cancelled()) return null;
      return reply(200, { r0, c0, nr, nc, cells, merges: [] });
    }

    if (url.pathname === '/api/gather') {
      const rects = body?.rects;
      if (!Array.isArray(rects) || rects.length === 0 || rects.length > MAX_GATHER_RECTS) {
        return reply(400, { error: `rects must be an array of 1..${MAX_GATHER_RECTS}` });
      }
      let total = 0;
      for (const rect of rects) {
        const ok = Array.isArray(rect) && rect.length === 4 && rect.every(Number.isSafeInteger);
        const [r0, c0, nr, nc] = ok ? rect : [];
        if (!ok || r0 < 0 || c0 < 0 || nr < 1 || nc < 1 || r0 + nr > rowCount || c0 + nc > colCount) return reply(400, { error: 'rect out of range' });
        total += nr * nc;
      }
      if (total > MAX_BLOCK_CELLS) return reply(400, { error: 'too many cells' });
      const cells = await cellsOf(rects);
      if (cancelled()) return null;
      return reply(200, { cells, merges: [] });
    }

    if (url.pathname === '/api/labels') {
      const axis = p.get('axis');
      const level = int(p.get('level'), -1, -1, 64);
      const from = int(p.get('from'), -1, -1, NO_LIMIT);
      const n = int(p.get('n'), 500, 1, MAX_LABELS);
      if (from < 0) return reply(400, { error: 'bad label range' });
      let names = null;
      if (isPivot) names = await pivotLabels(view, cv, axis, level, from, n);
      else if (axis === 'cols' && level === 0 && from < COLS) {
        names = [];
        for (let c = from; c < Math.min(COLS, from + n); c++) names.push(`${LABELS[c % 8]} ${Math.floor(c / 8) + 1}`);
      }
      if (!names) return reply(400, { error: 'labels out of range' });
      return reply(200, { from, names });
    }

    return reply(404, { error: 'not found' });
  }

  return {
    handleApiRequest,
    close() {
      for (const conn of all) conn.closeSync();
    },
  };
}
