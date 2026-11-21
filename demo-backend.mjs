// The reference demo backend, without the HTTP layer: procedural data, sorting, filtering and pivots.
// server.mjs serves it over HTTP; the static demo (GitHub Pages) runs it in the browser behind a fake fetch.
// Plain JavaScript with no Node or DOM APIs, so it runs in both. Two modes, chosen with `mode=flat|pivot` on every call:
//
//   GET /api/meta?mode&rows&cols&years&sort&filter
//                                               flat:  { mode, rows (matching), totalRows, cols, columnKinds,
//                                                        sort: { multiMaxRows }, filter: { maxRows } }
//                                               pivot: { mode, rows: TreeAxis spec, cols: TreeAxis spec,
//                                                        rowMaps: per level, sorted group -> original group (when sorted) }
//   GET /api/block?mode&r0&c0&nr&nc&sort&…      -> { r0, c0, nr, nc, cells: string[] (row-major), merges }
//   POST /api/gather?mode&sort&…  body { rects: [[r0, c0, nr, nc], …] }
//                                               -> { cells: string[][] (one row-major array per rect), merges }
//       merges: merged cells overlapping the requested area, [r0, c0, nr, nc, label?] in source
//       coordinates (flat mode demo data, unsorted only; pivot mode sends none — set them from code instead).
//       Used for scattered rows/columns (collapsed pivot groups): one request carries many thin strips.
//   GET /api/labels?mode&axis&level&from&n&sort&…  -> { from, names: string[] }
//       flat:  axis=cols, level=0 -> column names
//       pivot: axis=rows|cols, level=0..depth-1 -> group names, level=depth -> leaf names (by leaf index)
//   GET /api/values?mode=pivot&axis&level&q&limit  -> { total, matches, values: string[] }
//       Distinct names of a row/column dimension (unfiltered data), for the filter dialog: at most
//       `limit` (≤ MAX_VALUES) of those containing `q`. Columns keep their natural order, rows are sorted.
//       When matches > values.length the client asks the user to refine the search.
//
// Sorting: `sort=<key>,<key>…` (up to 4 keys, highest priority first). A key is `<col>:<a|d>` for a
// value column (source column index) or, in pivot mode, `L<level>:<a|d>` for a row dimension's names.
// Rows in every response are then in sorted order (row indexes are positions in the sorted view).
//   - flat, one effective key: instant at any size (see `flat` below)
//   - flat, several keys: a real stable sort built once per sort order, up to MULTI_SORT_MAX_ROWS rows
//   - pivot: groups are sorted among their siblings at every level (by their subtotal in that column,
//     or by name); leaves inside a deepest group are sorted the first time that group is requested.
//
// Filtering: `filter=<JSON>`, a list of conditions (AND), one per column:
//   { c: col, op: 'range', min?, max? }     numbers, or 'YYYY-MM-DD' for dates (flat)
//   { c: col, op: 'in', v: [text…] }        value is one of the texts (flat)
//   { c: col, op: 'notin', v: [text…] }     value is none of the texts (flat)
//   { c: col, op: 'contains', v: text }     case-insensitive substring (flat)
//   { dim: level, op: 'in' | 'notin' | 'contains', … } a pivot row dimension's names (groups or products)
// Row indexes are then positions among the matching rows (after sorting, if any).
// Column filtering (pivot): `colfilter=<JSON>`, [{ dim: level, op: 'in' | 'notin' | 'contains', v }] on the column
// dimensions (Measure, Year, Quarter, Month). Column indexes — in requests and in sort keys — are then
// positions among the remaining columns, and column totals are recomputed over what is left.
// (Flat mode ignores colfilter: the client hides columns itself and addresses the source columns.)
//   - flat: the server scans the table once per filter (cached), up to FILTER_MAX_ROWS rows; long scans
//     report how far they are at GET /api/progress (same parameters as /api/meta), and stop when every
//     request waiting for them is cancelled
//   - pivot: filtered-out groups disappear and every total is recomputed over what is left
//     ("visual totals"); filtering products by name scans products, up to PIVOT_LEAF_FILTER_MAX
//
//   GET /api/progress?…same as /api/meta  -> { active, phase, done, total, ms } of the sort or scan that
//       request is waiting for (active: false when none is running)
//
// Every /api call accepts `latency` (ms) to simulate a slow network or database.
// Data is procedural (same value for the same cell every time), so any size works without storage.
// Pivot values are built top-down so every subtotal is exactly the sum of its children.

import { TreeAxis } from '@borealjs/grid-core';

/** Largest index in [lo, hi] whose value is <= v (assumes arr[lo] <= v). */
function lastLE(arr, lo, hi, v) {
  while (lo < hi) {
    const mid = lo + Math.ceil((hi - lo) / 2);
    if (arr[mid] <= v) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

const DEFAULT_ROWS = 1_000_000_000;
const DEFAULT_COLS = 1_000_000;
const DEFAULT_YEARS = 10;
const MAX_ROWS = 1e14; // offsets (rows × row height) must stay exact JS numbers on the client
const MAX_COLS = 1e12;
const MAX_YEARS = 20_000; // ~1.36M pivot columns
const MAX_BLOCK_CELLS = 20_000;
const MAX_LABELS = 2000;
const MAX_VALUES = 1000; // names per filter-dialog response; beyond that the user refines the search
const MAX_IN_VALUES = 5000; // texts in one 'in' / 'notin' condition
const MAX_GATHER_RECTS = 500;
const DEFAULT_LATENCY = 40;
const MAX_SORT_KEYS = 4;
const MULTI_SORT_MAX_ROWS = 5_000_000;
// Filters on up to EXACT_FILTER_ROWS rows keep a list of the matching rows. Larger tables (up to
// FILTER_MAX_ROWS) are scanned once to count matches per chunk of rows; a chunk's rows are found again
// when a request needs them. That takes seconds per billion rows, reported through /api/progress.
const EXACT_FILTER_ROWS = 5_000_000;
const FILTER_MAX_ROWS = 2_000_000_000;
const FILTER_CHUNK = 65_536;
const PIVOT_LEAF_FILTER_MAX = 5_000_000;
const MAX_FILTERS = 16;

const fmtCount = (n) => n.toLocaleString('en-US');
const httpError = (message, status = 400) => Object.assign(new Error(message), { status });
// Lets other work run during long scans (other requests on the server, rendering in the browser).
// In the browser a MessageChannel message is used: setTimeout(0) waits at least 4 ms once nested.
const yieldToEventLoop = typeof setImmediate === 'function'
  ? () => new Promise((resolve) => setImmediate(resolve))
  : typeof MessageChannel === 'function'
    ? (() => {
      const channel = new MessageChannel();
      const queue = [];
      channel.port1.onmessage = () => queue.shift()?.();
      return () => new Promise((resolve) => {
        queue.push(resolve);
        channel.port2.postMessage(0);
      });
    })()
    : () => new Promise((resolve) => setTimeout(resolve, 0));

// ------------------------------------------------------------------ hashing

// 32-bit mix of (a, b). `a` may be any safe integer; it is split so every value gets its own hash.
function mix(a, b) {
  const lo = a % 4294967296;
  const hi = Math.floor(a / 4294967296);
  let h = Math.imul(lo ^ 0x9e3779b9, 0x85ebca6b);
  h ^= Math.imul((hi + 0x632be5ab) | 0, 0xc2b2ae35);
  h ^= Math.imul((b % 4294967296) ^ 0x27d4eb2f, 0x165667b1);
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}
const unit = (h) => h / 4294967296;

/**
 * A keyed bijection on [0, n): a 4-round Feistel network on the smallest even-bit domain >= n, with
 * cycle walking to stay inside [0, n). enc() scrambles, dec() undoes it. O(1) per call.
 */
function feistel(n, key) {
  const bits = Math.max(2, Math.ceil(Math.log2(Math.max(2, n))));
  const h = Math.ceil(bits / 2);
  const half = 2 ** h;
  const mask = half - 1;
  // Round function: mix(R, key) & mask with the key's share precomputed (R < 2^32 always here), so a
  // scan over a billion rows spends its time on the data, not on the hash. Same values as mix().
  const HI0 = Math.imul(0x632be5ab, 0xc2b2ae35);
  const [m0, m1, m2, m3] = [0x51ed270b, 0x2f1a8c33, 0x7c3d9a61, 0x1b873593].map((salt) => Math.imul(mix(key, salt) ^ 0x27d4eb2f, 0x165667b1) ^ HI0);
  const F = (R, m) => {
    let x = Math.imul(R ^ 0x9e3779b9, 0x85ebca6b) ^ m;
    x ^= x >>> 16;
    x = Math.imul(x, 0x85ebca6b);
    x ^= x >>> 13;
    x = Math.imul(x, 0xc2b2ae35);
    x ^= x >>> 16;
    return x & mask;
  };
  // Up to 2^30 (h <= 15) everything stays in 31-bit integers; larger domains split with float math.
  const small = h <= 15;
  const once = (x) => {
    let L = small ? x >>> h : Math.floor(x / half);
    let R = small ? x & mask : x - L * half;
    let t = L ^ F(R, m0); L = R; R = t;
    t = L ^ F(R, m1); L = R; R = t;
    t = L ^ F(R, m2); L = R; R = t;
    t = L ^ F(R, m3); L = R; R = t;
    return small ? (L << h) + R : L * half + R;
  };
  const onceInverse = (y) => {
    let L = small ? y >>> h : Math.floor(y / half);
    let R = small ? y & mask : y - L * half;
    let t = R ^ F(L, m3); R = L; L = t;
    t = R ^ F(L, m2); R = L; L = t;
    t = R ^ F(L, m1); R = L; L = t;
    t = R ^ F(L, m0); R = L; L = t;
    return small ? (L << h) + R : L * half + R;
  };
  return {
    enc(x) {
      let y = once(x);
      while (y >= n) y = once(y);
      return y;
    },
    dec(y) {
      let x = onceInverse(y);
      while (x >= n) x = onceInverse(x);
      return x;
    },
  };
}

// ------------------------------------------------------------------ sort spec

/** `3:d,L1:a` -> [{ col: 3, desc: true }, { dim: 1, desc: false }]. Duplicate keys keep the first. */
function parseSort(param, { cols, depth }) {
  if (!param) return [];
  const keys = [];
  const seen = new Set();
  for (const part of param.split(',')) {
    const m = /^(L?)(\d+):([ad])$/.exec(part.trim());
    if (!m) throw httpError(`bad sort key "${part}"`);
    const isDim = m[1] === 'L';
    const idx = Number(m[2]);
    if (isDim ? depth === undefined || idx > depth : idx >= cols) throw httpError(`sort key out of range: "${part}"`);
    const id = `${m[1]}${idx}`;
    if (seen.has(id)) continue;
    seen.add(id);
    keys.push(isDim ? { dim: idx, desc: m[3] === 'd' } : { col: idx, desc: m[3] === 'd' });
  }
  if (keys.length > MAX_SORT_KEYS) throw httpError(`at most ${MAX_SORT_KEYS} sort keys`);
  return keys;
}

const sortSignature = (keys) => keys.map((k) => `${k.dim !== undefined ? `L${k.dim}` : k.col}:${k.desc ? 'd' : 'a'}`).join(',');

/**
 * Parses and normalizes `filter` (JSON). Returns conditions sorted by column, so equal filters have
 * equal signatures. Value checks that depend on the column's type happen when a condition is compiled.
 */
function parseFilter(param, { cols, depth }) {
  if (!param) return [];
  let list;
  try {
    list = JSON.parse(param);
  } catch {
    throw httpError('filter must be JSON');
  }
  if (!Array.isArray(list) || list.length > MAX_FILTERS) throw httpError(`filter must be a list of at most ${MAX_FILTERS} conditions`);
  const out = [];
  const seen = new Set();
  const bound = (x) => {
    if (x === undefined || x === null || x === '') return undefined;
    if (typeof x === 'number' && Number.isFinite(x)) return x;
    if (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x)) return x;
    throw httpError('range bounds must be numbers or YYYY-MM-DD dates');
  };
  for (const f of list) {
    const isDim = f?.dim !== undefined;
    const idx = isDim ? f.dim : f?.c;
    if (!Number.isSafeInteger(idx) || idx < 0 || (isDim ? depth === undefined || idx > depth : idx >= cols)) throw httpError('filter column out of range');
    const id = `${isDim ? 'L' : ''}${idx}`;
    if (seen.has(id)) throw httpError('one condition per column');
    seen.add(id);
    const base = isDim ? { dim: idx } : { c: idx };
    if (f.op === 'range') {
      const min = bound(f.min);
      const max = bound(f.max);
      if (min === undefined && max === undefined) throw httpError('range needs min or max');
      out.push({ ...base, op: 'range', min, max });
    } else if (f.op === 'in' || f.op === 'notin') {
      if (!Array.isArray(f.v) || !f.v.every((x) => typeof x === 'string')) throw httpError(`"${f.op}" needs a list of texts`);
      if (f.v.length > MAX_IN_VALUES) throw httpError(`"${f.op}" takes at most ${MAX_IN_VALUES} texts (${f.v.length} given): search for fewer`);
      out.push({ ...base, op: f.op, v: [...new Set(f.v)].sort() });
    } else if (f.op === 'contains') {
      if (typeof f.v !== 'string' || !f.v.trim() || f.v.length > 200) throw httpError('"contains" needs some text');
      out.push({ ...base, op: 'contains', v: f.v.trim().toLowerCase() });
    } else {
      throw httpError(`unknown filter op "${f.op}"`);
    }
  }
  return out.sort((a, b) => (a.dim ?? -1) - (b.dim ?? -1) || (a.c ?? -1) - (b.c ?? -1));
}

const filterSignature = (filters) => JSON.stringify(filters);

/** A test on a name for an 'in' / 'notin' / 'contains' condition. */
function nameTest(f) {
  if (f.op === 'in' || f.op === 'notin') {
    const set = new Set(f.v);
    return f.op === 'in' ? (name) => set.has(name) : (name) => !set.has(name);
  }
  return (name) => name.toLowerCase().includes(f.v);
}

function lruSet(map, key, value, max) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value);
}

// ------------------------------------------------------------------ flat dataset

/**
 * Sortable demo data. Every value column c has its own bijection π_c over the rows, and a cell shows
 * value(π_c(r)) where value() is monotone in its argument (a rank). So the column looks shuffled, yet
 * "row at sorted position p" is just π_c⁻¹(p) — instant at any size. Several sort keys need the real
 * thing: a stable sort that is built once per sort order (limited to MULTI_SORT_MAX_ROWS rows here; a
 * production backend would use a database index or a columnar engine).
 */
const flat = (() => {
  const FIRST = ['Ava', 'Liam', 'Noah', 'Emma', 'Mia', 'Arjun', 'Zara', 'Kenji', 'Sofia', 'Omar', 'Lena', 'Ravi', 'Ines', 'Mateo', 'Yara', 'Hugo'];
  const LAST = ['Patel', 'Garcia', 'Kim', 'Novak', 'Okafor', 'Silva', 'Haddad', 'Ito', 'Muller', 'Rossi', 'Khan', 'Dubois', 'Larsen', 'Moreau', 'Sato', 'Reyes'];
  const NAMES = FIRST.flatMap((f) => LAST.map((l) => `${f} ${l}`)).sort();
  const CITIES = ['Lisbon', 'Pune', 'Osaka', 'Austin', 'Nairobi', 'Oslo', 'Lima', 'Krakow', 'Seoul', 'Dublin', 'Accra', 'Porto'].sort();
  const STATUSES = ['Active', 'Closed', 'On hold', 'Pending', 'Review']; // alphabetical
  const STATUS_SHARE = [0.35, 0.6, 0.7, 0.9, 1]; // cumulative frequency, in the same order
  const LABELS = ['ID', 'Name', 'City', 'Amount', 'Date', 'Status', 'Score', 'Code'];
  const DAY = 86_400_000;
  const EPOCH = Date.UTC(2000, 0, 1);

  // Per column type: D distinct values; bucket(u) maps a rank fraction u in [0, 1) to a value index
  // (monotone); text(b) renders value index b. Value order == bucket order == text sort order.
  const TYPES = [
    null, // ID: the row number itself
    { D: NAMES.length, bucket: (u) => Math.floor(u * NAMES.length), text: (b) => NAMES[b] },
    { D: CITIES.length, bucket: (u) => Math.floor(u * CITIES.length), text: (b) => CITIES[b] },
    { D: 1e7, bucket: (u) => Math.floor(u * 1e7), text: (b) => (b / 100).toFixed(2) },
    { D: 9000, bucket: (u) => Math.floor(u * 9000), text: (b) => new Date(EPOCH + b * DAY).toISOString().slice(0, 10) },
    { D: STATUSES.length, bucket: (u) => STATUS_SHARE.findIndex((t) => u < t), text: (b) => STATUSES[b] },
    { D: 1000, bucket: (u) => Math.floor(u * 1000), text: (b) => (b / 10).toFixed(1) },
    { D: 36 ** 7, bucket: (u) => Math.floor(u * 36 ** 7), text: (b) => b.toString(36).toUpperCase().padStart(7, '0') },
  ];

  // What kind of filter each column type takes (sent to the client in meta).
  const KINDS = [
    { kind: 'number' }, // ID
    { kind: 'text' }, // Name
    { kind: 'values', values: CITIES },
    { kind: 'number' }, // Amount
    { kind: 'date' },
    { kind: 'values', values: STATUSES },
    { kind: 'number' }, // Score
    { kind: 'text' }, // Code
  ];
  const NUMBER_OF = [null, null, null, (b) => b / 100, null, null, (b) => b / 10, null];
  const dayOf = (iso) => Math.round((Date.parse(`${iso}T00:00:00Z`) - EPOCH) / DAY);

  const perms = new Map();
  function perm(n, c) {
    const key = `${n}|${c}`;
    let p = perms.get(key);
    if (!p) {
      p = feistel(n, mix(c, 0xc0ffee));
      lruSet(perms, key, p, 4096);
    }
    return p;
  }

  function cell(n, r, c) {
    const t = c % 8;
    if (t === 0) return String(r + 1);
    const T = TYPES[t];
    return T.text(T.bucket(perm(n, c).enc(r) / n));
  }

  // A key whose values are all different decides the order on its own; later keys cannot matter.
  const allDistinct = (n, c) => c % 8 === 0 || TYPES[c % 8].D >= n;

  const views = new Map(); // "n|sort|filter" -> Promise<{ count, rowAt }>
  const scans = new Map(); // "n|filter" -> Promise<Uint32Array> (matching rows, in row order)
  const jobs = new Map(); // "n|sort|filter" -> the sort or scan building that view, while it runs

  /** Sort keys that matter: a key whose values are all different decides the order on its own. */
  function effectiveKeys(n, keys) {
    const effective = [];
    for (const k of keys) {
      effective.push(k);
      if (allDistinct(n, k.col)) break;
    }
    return effective;
  }
  const viewKey = (n, effective, filters) => `${n}|${sortSignature(effective)}|${filterSignature(filters)}`;

  /**
   * Long work behind a view: how far it is (for /api/progress), and a stop once every request waiting
   * for it has been cancelled. tick() lets other work run and throws when the work is no longer wanted.
   */
  function startJob(key) {
    const job = {
      phase: '',
      done: 0,
      total: 0,
      started: Date.now(),
      waiters: new Set(),
      step(phase, total) {
        job.phase = phase;
        job.total = total;
        job.done = 0;
      },
      async tick(done) {
        job.done = done;
        await yieldToEventLoop();
        if (job.waiters.size && [...job.waiters].every((gaveUp) => gaveUp())) throw httpError('cancelled', 499);
      },
    };
    jobs.set(key, job);
    return job;
  }

  /** How far the work for this view is: { active, phase, done, total, ms }. */
  function progress(n, keys, filters) {
    const job = jobs.get(viewKey(n, effectiveKeys(n, keys), filters));
    if (!job) return { active: false };
    return { active: true, phase: job.phase, done: job.done, total: job.total, ms: Date.now() - job.started };
  }

  /**
   * Maps a position in the (filtered, sorted) view to a data row: { count, rowAt(p) }.
   * Throws a 422 error when the request needs a scan or a multi-column sort larger than the demo allows.
   * `cancelled()` says whether the caller gave up; work nobody waits for any more is stopped.
   */
  async function view(n, keys, filters = [], cancelled = () => false) {
    const effective = effectiveKeys(n, keys);
    if (effective.length > 1 && n > MULTI_SORT_MAX_ROWS) {
      throw httpError(`Sorting by several columns is limited to ${fmtCount(MULTI_SORT_MAX_ROWS)} rows in this demo server (this table has ${fmtCount(n)})`, 422);
    }
    if (filters.length && n > FILTER_MAX_ROWS) {
      throw httpError(`Filtering is limited to ${fmtCount(FILTER_MAX_ROWS)} rows in this demo server (this table has ${fmtCount(n)})`, 422);
    }
    if (filters.length === 0 && effective.length <= 1) return { count: n, rowAt: baseOrder(n, effective[0]) };
    // Check the conditions before any long work starts.
    const tests = filters.map((cond) => compile(n, cond));
    const key = viewKey(n, effective, filters);
    let pending = views.get(key);
    if (!pending) {
      const job = startJob(key);
      pending = (async () => {
        if (filters.length === 0) {
          const order = await buildOrder(n, effective, job);
          return { count: n, rowAt: (p) => order[p] };
        }
        if (n > EXACT_FILTER_ROWS) return chunkedView(n, effective[0], tests, job);
        const matches = await scan(n, filters, tests, job);
        const order = effective.length ? await sortRows(n, matches, effective, job) : matches;
        return { count: order.length, rowAt: (p) => order[p] };
      })();
      pending.catch(() => views.delete(key));
      pending.then(() => jobs.delete(key), () => jobs.delete(key));
      lruSet(views, key, pending, 6);
    }
    const job = jobs.get(key);
    job?.waiters.add(cancelled);
    try {
      return await pending;
    } finally {
      job?.waiters.delete(cancelled);
    }
  }

  /** Row at position p with at most one sort key and no filter: instant, via the column's bijection. */
  function baseOrder(n, sortKey) {
    if (!sortKey) return (p) => p;
    const { col, desc } = sortKey;
    if (col % 8 === 0) return desc ? (p) => n - 1 - p : (p) => p;
    const f = perm(n, col);
    return desc ? (p) => f.dec(n - 1 - p) : (p) => f.dec(p);
  }

  /**
   * A filtered view of a big table (at most one sort key): one pass counts the matching rows in each
   * chunk of FILTER_CHUNK positions; a chunk's matching rows are listed again when a request needs them.
   */
  async function chunkedView(n, sortKey, tests, job) {
    const base = baseOrder(n, sortKey);
    const matches = (r) => {
      for (const test of tests) if (!test(r)) return false;
      return true;
    };
    const chunks = Math.ceil(n / FILTER_CHUNK);
    const before = new Float64Array(chunks + 1); // matching rows before each chunk
    job.step('Checking rows', n);
    let lastYield = Date.now();
    for (let k = 0; k < chunks; k++) {
      const end = Math.min(n, (k + 1) * FILTER_CHUNK);
      let count = 0;
      for (let p = k * FILTER_CHUNK; p < end; p++) if (matches(base(p))) count++;
      before[k + 1] = before[k] + count;
      if (Date.now() - lastYield > 12) {
        await job.tick(end);
        lastYield = Date.now();
      }
    }
    const lists = new Map(); // chunk -> its matching rows, in view order (a few recent chunks)
    const listOf = (k) => {
      let list = lists.get(k);
      if (!list) {
        list = new Float64Array(before[k + 1] - before[k]);
        let i = 0;
        const end = Math.min(n, (k + 1) * FILTER_CHUNK);
        for (let p = k * FILTER_CHUNK; p < end; p++) {
          const r = base(p);
          if (matches(r)) list[i++] = r;
        }
        lruSet(lists, k, list, 64);
      }
      return list;
    };
    return {
      count: before[chunks],
      rowAt(p) {
        let lo = 0;
        let hi = chunks - 1;
        while (lo < hi) { // the chunk holding the p-th match: before[k] <= p < before[k + 1]
          const mid = (lo + hi + 1) >> 1;
          if (before[mid] <= p) lo = mid;
          else hi = mid - 1;
        }
        return listOf(lo)[p - before[lo]];
      },
    };
  }

  /** A row test for one condition. Value columns test the value index, mostly via a lookup table. */
  function compile(n, cond) {
    const t = cond.c % 8;
    const { kind } = KINDS[t];
    if (cond.op === 'range' && kind !== 'number' && kind !== 'date') throw httpError(`a range filter needs a number or date column (column ${cond.c + 1} is ${kind})`);
    if (cond.op === 'range' && (kind === 'date') !== (typeof (cond.min ?? cond.max) === 'string')) throw httpError(`range bounds for column ${cond.c + 1} must be ${kind === 'date' ? 'YYYY-MM-DD dates' : 'numbers'}`);
    if (t === 0) {
      if (cond.op === 'range') {
        const lo = cond.min ?? -Infinity;
        const hi = cond.max ?? Infinity;
        return (r) => r + 1 >= lo && r + 1 <= hi;
      }
      const test = nameTest(cond);
      return (r) => test(String(r + 1));
    }
    const T = TYPES[t];
    const f = perm(n, cond.c);
    let allowed;
    if (cond.op === 'range' && kind === 'date') {
      const lo = cond.min !== undefined ? dayOf(cond.min) : -Infinity;
      const hi = cond.max !== undefined ? dayOf(cond.max) : Infinity;
      allowed = (b) => b >= lo && b <= hi;
    } else if (cond.op === 'range') {
      const lo = cond.min ?? -Infinity;
      const hi = cond.max ?? Infinity;
      const value = NUMBER_OF[t];
      allowed = (b) => {
        const v = value(b);
        return v >= lo && v <= hi;
      };
    } else {
      const test = nameTest(cond);
      allowed = (b) => test(T.text(b));
    }
    if (T.D <= 10_000) {
      const table = new Uint8Array(T.D);
      for (let b = 0; b < T.D; b++) table[b] = allowed(b) ? 1 : 0;
      return (r) => table[T.bucket(f.enc(r) / n)] === 1;
    }
    return (r) => allowed(T.bucket(f.enc(r) / n));
  }

  /** Rows matching every condition, in row order (cached per filter, so a new sort does not rescan). */
  function scan(n, filters, tests, job) {
    const key = `${n}|${filterSignature(filters)}`;
    let pending = scans.get(key);
    if (!pending) {
      pending = (async () => {
        job.step('Checking rows', n);
        const out = new Uint32Array(n);
        let m = 0;
        for (let r = 0; r < n; r++) {
          let ok = true;
          for (const test of tests) {
            if (!test(r)) {
              ok = false;
              break;
            }
          }
          if (ok) out[m++] = r;
          if ((r & 262143) === 0) await job.tick(r);
        }
        return out.slice(0, m);
      })();
      pending.catch(() => scans.delete(key));
      lruSet(scans, key, pending, 4);
    }
    return pending;
  }

  /**
   * Sorts a subset of rows (given in row order, the final tie-break) by the keys: stable counting sorts
   * from the lowest-priority key to the highest. A key whose values are all distinct sorts by rank.
   */
  async function sortRows(n, rows, keys, job) {
    const m = rows.length;
    let order = rows.slice();
    let next = new Uint32Array(m);
    const values = new Uint32Array(m);
    job.step('Sorting matching rows', keys.length * m);
    for (let ki = keys.length - 1; ki >= 0; ki--) {
      const { col, desc } = keys[ki];
      const t = col % 8;
      const unique = allDistinct(n, col);
      const D = unique ? n : TYPES[t].D;
      const f = t === 0 ? null : perm(n, col);
      for (let i = 0; i < m; i++) {
        const r = order[i];
        const v = t === 0 ? r : unique ? f.enc(r) : TYPES[t].bucket(f.enc(r) / n);
        values[i] = desc ? D - 1 - v : v;
        if ((i & 262143) === 0) await job.tick((keys.length - 1 - ki) * m + i);
      }
      const start = new Uint32Array(D + 1);
      for (let i = 0; i < m; i++) start[values[i] + 1]++;
      for (let b = 0; b < D; b++) start[b + 1] += start[b];
      for (let i = 0; i < m; i++) next[start[values[i]]++] = order[i];
      [order, next] = [next, order];
    }
    return order;
  }

  /**
   * Stable LSD sort: start from row order (the final tie-break), then for each key from the lowest
   * priority to the highest, a stable counting sort by that key's value index. A key whose values are
   * all distinct (only ever the last effective key) sets the whole order directly via π⁻¹.
   */
  async function buildOrder(n, keys, job) {
    let order = new Uint32Array(n);
    let next = new Uint32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    const STEP = 1 << 18;
    job.step('Sorting rows', keys.length * n);
    for (let ki = keys.length - 1; ki >= 0; ki--) {
      const doneBefore = (keys.length - 1 - ki) * n;
      const { col, desc } = keys[ki];
      if (allDistinct(n, col)) {
        const f = col % 8 === 0 ? null : perm(n, col);
        for (let p = 0; p < n; p++) {
          const q = desc ? n - 1 - p : p;
          order[p] = f ? f.dec(q) : q;
          if ((p & (STEP - 1)) === 0) await job.tick(doneBefore + p);
        }
        continue;
      }
      const T = TYPES[col % 8];
      const f = perm(n, col);
      const bucket = new Uint32Array(n);
      for (let r = 0; r < n; r++) {
        const b = T.bucket(f.enc(r) / n);
        bucket[r] = desc ? T.D - 1 - b : b;
        if ((r & (STEP - 1)) === 0) await job.tick(doneBefore + r);
      }
      const start = new Float64Array(T.D + 1);
      for (let r = 0; r < n; r++) start[bucket[r] + 1]++;
      for (let b = 0; b < T.D; b++) start[b + 1] += start[b];
      for (let i = 0; i < n; i++) {
        const r = order[i];
        next[start[bucket[r]]++] = r;
      }
      [order, next] = [next, order];
    }
    return order;
  }

  // First index >= from whose index % period === rem.
  const firstAt = (from, period, rem) => from + ((((rem - from) % period) + period) % period);

  /**
   * Merged cells overlapping rows [r0, r0+nr) × cols [c0, c0+nc), as [r0, c0, nr, nc, label?].
   * Built so they never overlap each other:
   * - every 1000th row: a section banner across its group of 8 columns (with its own label)
   * - Status column: some 5-row runs merged (shows the first row's status)
   * - Name + City: merged side by side on ~10% of rows
   * - Code column of every 8th column group: rows 1..999 of each thousand merged into one tall cell
   */
  function merges(rows, cols, r0, c0, nr, nc) {
    const out = [];
    const r1 = r0 + nr - 1;
    const c1 = c0 + nc - 1;
    for (let r = Math.ceil(r0 / 1000) * 1000; r <= r1; r += 1000) {
      for (let g = Math.floor(c0 / 8); g <= Math.floor(c1 / 8); g++) {
        const a = g * 8;
        const n = Math.min(8, cols - a);
        if (n > 1) out.push([r, a, 1, n, `Section ${r / 1000 + 1} · rows ${r + 1}–${Math.min(r + 1000, rows)}`]);
      }
    }
    for (let c = firstAt(c0, 8, 5); c <= c1; c += 8) {
      for (let k = Math.floor(r0 / 5); k <= Math.floor(r1 / 5); k++) {
        if (k % 200 === 0 || mix(k, c + 900) % 4 !== 0) continue;
        const n = Math.min(5, rows - k * 5);
        if (n > 1) out.push([k * 5, c, n, 1]);
      }
    }
    for (let c = firstAt(Math.max(0, c0 - 1), 8, 1); c <= c1; c += 8) {
      if (c + 1 >= cols) continue;
      for (let r = r0; r <= r1; r++) {
        if (r % 1000 !== 0 && mix(r, c + 1700) % 10 === 0) out.push([r, c, 1, 2]);
      }
    }
    for (let c = firstAt(c0, 64, 7); c <= c1; c += 64) {
      for (let j = Math.floor(r0 / 1000); j <= Math.floor(r1 / 1000); j++) {
        const a = j * 1000 + 1;
        const n = Math.min(999, rows - a);
        if (n > 1) out.push([a, c, n, 1, `Batch ${j + 1}`]);
      }
    }
    return out;
  }

  return {
    view,
    progress,
    merges,
    meta: (rows, cols, matching = rows) => ({
      mode: 'flat',
      rows: matching,
      totalRows: rows,
      cols,
      columnKinds: KINDS,
      columnTypes: LABELS,
      sort: { multiMaxRows: MULTI_SORT_MAX_ROWS },
      filter: { maxRows: FILTER_MAX_ROWS },
    }),
    block(rows, v, r0, c0, nr, nc) {
      const cells = new Array(nr * nc);
      let i = 0;
      for (let r = r0; r < r0 + nr; r++) {
        const dataRow = v.rowAt(r);
        for (let c = c0; c < c0 + nc; c++) cells[i++] = cell(rows, dataRow, c);
      }
      return cells;
    },
    labels(cols, axis, level, from, n) {
      if (axis !== 'cols' || level !== 0 || from >= cols) return null;
      const names = [];
      for (let c = from; c < Math.min(cols, from + n); c++) names.push(`${LABELS[c % 8]} ${Math.floor(c / 8) + 1}`);
      return names;
    },
  };
})();

// ------------------------------------------------------------------ pivot dataset

const pivot = (() => {
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
  const money = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const whole = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const ROW_SEED = 1;
  const COL_SEED = 2;

  const cache = new Map();

  function build(leafTarget, years) {
    const key = `${leafTarget}|${years}`;
    const hit = cache.get(key);
    if (hit) return hit;

    // Row hierarchy: Region › Country › City › Product (leaves). Irregular fan-out, decided by hash.
    const regions = REGIONS.length;
    const countries = Array.from({ length: regions }, (_, i) => 3 + (mix(i, 101) % 6));
    const nCountries = countries.reduce((a, b) => a + b, 0);
    const cities = Array.from({ length: nCountries }, (_, i) => 4 + (mix(i, 202) % 9));
    const nCities = cities.reduce((a, b) => a + b, 0);
    const target = Math.max(leafTarget, nCities);
    const weights = Array.from({ length: nCities }, (_, i) => 1 + (mix(i, 303) % 9));
    const W = weights.reduce((a, b) => a + b, 0);
    const leaves = weights.map((w) => Math.max(1, Math.floor((target * w) / W)));
    let diff = target - leaves.reduce((a, b) => a + b, 0);
    for (let i = 0; diff !== 0 && i < nCities * 4; i++) {
      const j = i % nCities;
      if (diff > 0) { leaves[j]++; diff--; } else if (leaves[j] > 1) { leaves[j]--; diff++; }
    }
    const rowSpec = {
      levels: [
        { name: 'Region', subtotal: true, subtotalSize: 36 },
        { name: 'Country', subtotal: true, subtotalSize: 32 },
        { name: 'City', subtotal: true, subtotalSize: 30 },
      ],
      leafName: 'Product',
      leafSize: 28,
      roots: regions,
      fanout: [countries, cities, leaves],
      grandTotal: true,
      grandSize: 40,
    };

    // Column hierarchy: Measure › Year › Quarter › Month (leaves). Regular fan-out.
    const colSpec = {
      levels: [
        { name: 'Measure', subtotal: true, subtotalSize: 132 },
        { name: 'Year', subtotal: true, subtotalSize: 120 },
        { name: 'Quarter', subtotal: true, subtotalSize: 108 },
      ],
      leafName: 'Month',
      leafSize: 96,
      roots: MEASURES.length,
      fanout: [years, 4, 3],
      grandTotal: false,
    };

    const rowTree = new TreeAxis(rowSpec);
    const colTree = new TreeAxis(colSpec);
    const leafCells = rowTree.leafCount * years * 12; // leaf cells per measure
    const grand = { sales: 1200 * leafCells, profit: 0.25 * 1200 * leafCells, units: 40 * leafCells };
    const model = { key, rowSpec, colSpec, rowTree, colTree, grand, years, views: new Map() };
    cache.set(key, model);
    if (cache.size > 8) cache.delete(cache.keys().next().value);
    return model;
  }

  // Share of child k among n siblings, for [sales, profit, units]. Each set of shares sums to exactly 1
  // (siblings are paired with opposite deltas), so every subtotal equals the sum of its children.
  const ONE = [1, 1, 1];
  function split(k, n, level, parent, seed) {
    if (n <= 1) return ONE;
    const base = 1 / n;
    if (n % 2 === 1 && k === n - 1) return [base, base, base];
    const pair = Math.floor(k / 2);
    const salt = ((parent * 16 + level) * 16 + seed) * 4;
    const d = (unit(mix(pair, salt)) - 0.5) * 0.8 * base;
    const eta = (unit(mix(pair, salt + 1)) - 0.5) * 0.16;
    const du = (unit(mix(pair, salt + 2)) - 0.5) * 0.8 * base;
    const sEven = base + d;
    const sOdd = base - d;
    return k % 2 === 0 ? [sEven, sEven * (1 + eta), base + du] : [sOdd, sOdd - sEven * eta, base - du];
  }

  // Product of shares along an item's path. `fromLevel` skips levels that are not splits (the measure).
  function shares(tree, loc, seed, fromLevel) {
    if (loc.kind === 'grand') return ONE;
    let s = 1;
    let p = 1;
    let u = 1;
    const { path } = loc;
    for (let L = fromLevel; L < path.length; L++) {
      const parent = L === 0 ? 0 : path[L - 1];
      const first = L === 0 ? 0 : tree.childStart[L - 1][parent];
      const count = L === 0 ? tree.cnt[0] : tree.childStart[L - 1][parent + 1] - first;
      const f = split(path[L] - first, count, L, parent, seed);
      s *= f[0]; p *= f[1]; u *= f[2];
    }
    if (loc.kind === 'leaf') {
      const D = tree.depth;
      const g = path[path.length - 1];
      const count = tree.childStart[D - 1][g + 1] - tree.childStart[D - 1][g];
      const f = split(loc.leafInGroup, count, D, g, seed);
      s *= f[0]; p *= f[1]; u *= f[2];
    }
    return [s, p, u];
  }

  const colInfoOf = (m, c) => {
    const loc = m.colTree.locate(c);
    return { measure: loc.path[0], f: shares(m.colTree, loc, COL_SEED, 1) };
  };

  /** The number behind a cell, given the row's shares and the column's measure/shares. */
  function measureValue(m, rf, measure, f) {
    const sales = m.grand.sales * rf[0] * f[0];
    switch (measure) {
      case 0: return sales;
      case 1: return m.grand.units * rf[2] * f[2];
      case 2: return m.grand.profit * rf[1] * f[1];
      default: return (m.grand.profit * rf[1] * f[1]) / sales;
    }
  }

  function formatValue(measure, v) {
    if (measure === 1) return whole.format(v);
    if (measure === 3) return `${(v * 100).toFixed(1)}%`;
    return money.format(v);
  }

  function nameOf(m, axis, level, i) {
    if (axis === 'rows') {
      if (level === 0) return REGIONS[i % REGIONS.length];
      if (level === 1) return COUNTRIES[i % COUNTRIES.length];
      if (level === 2) { const h = mix(i, 404); return CITY_A[h % 16] + CITY_B[(h >>> 8) % 16]; }
      const h = mix(i, 505);
      return `${ADJ[h % 16]} ${NOUN[(h >>> 8) % 16]} ${((h >>> 16) % 900) + 100}`;
    }
    if (level === 0) return MEASURES[i];
    if (level === 1) return `FY ${2001 + (i % m.years)}`;
    if (level === 2) return `Q${(i % 4) + 1}`;
    return MONTHS[i % 12];
  }

  /** Comparator over aligned per-key arrays; ties fall back to the original order. */
  function comparator(columns, ids) {
    return (a, b) => {
      for (const { values, desc, text } of columns) {
        const va = values[a];
        const vb = values[b];
        const d = text ? (va < vb ? -1 : va > vb ? 1 : 0) : va - vb;
        if (d !== 0) return desc ? -d : d;
      }
      return ids[a] - ids[b];
    };
  }

  /**
   * Distinct names of one dimension in the unfiltered data (cached): columns in natural order (FY 2001,
   * FY 2002…), rows sorted. Returns the first `limit` names containing `q`, and how many match.
   */
  function values(m, axis, level, q, limit) {
    const t = axis === 'cols' ? m.colTree : axis === 'rows' ? m.rowTree : null;
    if (!t || level < 0 || level > t.depth) return null;
    if (axis === 'rows' && level === t.depth) throw httpError('Products are filtered by text: there are too many names to list');
    m.distinct ??= new Map();
    const key = `${axis}|${level}`;
    let all = m.distinct.get(key);
    if (!all) {
      const n = level === t.depth ? t.leafCount : t.cnt[level];
      const set = new Set();
      for (let i = 0; i < n; i++) set.add(nameOf(m, axis, level, i));
      all = [...set];
      if (axis === 'rows') all.sort((a, b) => a.localeCompare(b));
      m.distinct.set(key, all);
    }
    const needle = q.trim().toLowerCase();
    if (!needle) return { total: all.length, matches: all.length, values: all.slice(0, limit) };
    const out = [];
    let matches = 0;
    for (const name of all) {
      if (!name.toLowerCase().includes(needle)) continue;
      if (out.length < limit) out.push(name);
      matches++;
    }
    return { total: all.length, matches, values: out };
  }

  /**
   * The column axis as seen under a column filter: the measures/years/quarters/months whose names pass,
   * with totals recomputed over the remaining columns (a year total with only Q1 and Q2 is Q1 + Q2).
   * Resolves to { sig, tree, maps, spec, colInfo(c) -> { measure, f }, colName(level, i) }.
   */
  function colView(m, colFilters) {
    const t = m.colTree;
    if (colFilters.length === 0) {
      m.plainColView ??= { sig: '', tree: t, maps: null, spec: m.colSpec, colInfo: (c) => colInfoOf(m, c), colName: (L, i) => nameOf(m, 'cols', L, i) };
      return m.plainColView;
    }
    for (const f of colFilters) {
      if (f.dim === undefined || f.op === 'range') throw httpError('Column filters work on column dimensions: a list of names, or text to search for');
    }
    const sig = filterSignature(colFilters);
    m.colViews ??= new Map();
    let v = m.colViews.get(sig);
    if (v) return v;
    const D = t.depth;
    const parent = [null];
    for (let L = 1; L < D; L++) {
      const arr = new Uint32Array(t.cnt[L]);
      for (let i = 0; i < t.cnt[L - 1]; i++) for (let j = t.childStart[L - 1][i]; j < t.childStart[L - 1][i + 1]; j++) arr[j] = i;
      parent.push(arr);
    }
    const groupPath = (L, g) => {
      const path = new Array(L + 1);
      let x = g;
      for (let l = L; l >= 0; l--) {
        path[l] = x;
        if (l > 0) x = parent[l][x];
      }
      return path;
    };
    // Column shares skip level 0: the measure is not a split of anything.
    const pathShares = (L, g) => shares(t, { kind: 'subtotal', level: L, path: groupPath(L, g) }, COL_SEED, 1);
    const tests = Array.from({ length: D + 1 }, (_, L) => colFilters.filter((f) => f.dim === L).map(nameTest));
    const passes = (L, name) => tests[L].every((fn) => fn(name));
    const pass = [];
    for (let L = 0; L < D; L++) {
      const arr = new Uint8Array(t.cnt[L]);
      for (let g = 0; g < t.cnt[L]; g++) {
        const parentOk = L === 0 || pass[L - 1][parent[L][g]] === 1;
        arr[g] = parentOk && (tests[L].length === 0 || passes(L, nameOf(m, 'cols', L, g))) ? 1 : 0;
      }
      pass.push(arr);
    }
    const kept = t.cnt.map((n) => new Uint8Array(n));
    const complete = t.cnt.map((n) => new Uint8Array(n));
    const sum = t.cnt.map((n) => new Float64Array(n * 3));
    const keptLeaves = new Map();
    const groupShareCache = new Map();
    const leavesOf = (g) => t.childStart[D - 1][g + 1] - t.childStart[D - 1][g];
    for (let g = 0; g < t.cnt[D - 1]; g++) {
      if (!pass[D - 1][g]) continue;
      const cs = pathShares(D - 1, g);
      groupShareCache.set(g, cs);
      const n = leavesOf(g);
      const base = t.childStart[D - 1][g];
      const list = [];
      let ss = 0;
      let sp = 0;
      let su = 0;
      for (let i = 0; i < n; i++) {
        if (tests[D].length && !passes(D, nameOf(m, 'cols', D, base + i))) continue;
        list.push(i);
        const f = split(i, n, D, g, COL_SEED);
        ss += f[0];
        sp += f[1];
        su += f[2];
      }
      if (list.length === 0) continue;
      kept[D - 1][g] = 1;
      complete[D - 1][g] = list.length === n ? 1 : 0;
      if (list.length < n) keptLeaves.set(g, Uint32Array.from(list));
      sum[D - 1].set(complete[D - 1][g] ? cs : [cs[0] * ss, cs[1] * sp, cs[2] * su], g * 3);
    }
    for (let L = D - 2; L >= 0; L--) {
      for (let g = 0; g < t.cnt[L]; g++) {
        if (!pass[L][g]) continue;
        let any = false;
        let all = true;
        let ss = 0;
        let sp = 0;
        let su = 0;
        for (let j = t.childStart[L][g]; j < t.childStart[L][g + 1]; j++) {
          if (!kept[L + 1][j]) {
            all = false;
            continue;
          }
          any = true;
          if (!complete[L + 1][j]) all = false;
          ss += sum[L + 1][j * 3];
          sp += sum[L + 1][j * 3 + 1];
          su += sum[L + 1][j * 3 + 2];
        }
        if (!any) continue;
        kept[L][g] = 1;
        complete[L][g] = all ? 1 : 0;
        sum[L].set(all ? pathShares(L, g) : [ss, sp, su], g * 3);
      }
    }
    const sigma = [[]];
    for (let g = 0; g < t.cnt[0]; g++) if (kept[0][g]) sigma[0].push(g);
    for (let L = 1; L < D; L++) {
      const out = [];
      for (const p of sigma[L - 1]) for (let j = t.childStart[L - 1][p]; j < t.childStart[L - 1][p + 1]; j++) if (kept[L][j]) out.push(j);
      sigma.push(out);
    }
    const fanout = sigma.map((list, L) => list.map((o) => {
      if (L < D - 1) {
        let n = 0;
        for (let j = t.childStart[L][o]; j < t.childStart[L][o + 1]; j++) if (kept[L + 1][j]) n++;
        return n;
      }
      return keptLeaves.get(o)?.length ?? leavesOf(o);
    }));
    const spec = { ...m.colSpec, roots: sigma[0].length, fanout };
    const tree = new TreeAxis(spec);
    const leafAt = (i) => {
      const g = lastLE(tree.childStart[D - 1], 0, tree.cnt[D - 1] - 1, i);
      const o = sigma[D - 1][g];
      const inGroup = i - tree.childStart[D - 1][g];
      const list = keptLeaves.get(o);
      return { o, k: list ? list[inGroup] : inGroup };
    };
    const colInfo = (c) => {
      const loc = tree.locate(c);
      const measure = sigma[0][loc.path[0]];
      if (loc.kind === 'leaf') {
        const { o, k } = leafAt(tree.childStart[D - 1][loc.path[D - 1]] + loc.leafInGroup);
        const cs = groupShareCache.get(o);
        const sh = split(k, leavesOf(o), D, o, COL_SEED);
        return { measure, f: [cs[0] * sh[0], cs[1] * sh[1], cs[2] * sh[2]] };
      }
      const g = sigma[loc.level][loc.path[loc.level]];
      return { measure, f: [sum[loc.level][g * 3], sum[loc.level][g * 3 + 1], sum[loc.level][g * 3 + 2]] };
    };
    const colName = (L, i) => {
      if (L < D) return nameOf(m, 'cols', L, sigma[L][i]);
      const { o, k } = leafAt(i);
      return nameOf(m, 'cols', D, t.childStart[D - 1][o] + k);
    };
    v = { sig, tree, maps: sigma, spec, colInfo, colName };
    lruSet(m.colViews, sig, v, 8);
    return v;
  }

  /**
   * The row axis as seen under a sort and/or filter.
   * - unfiltered, unsorted: the original tree
   * - otherwise a tree of the groups that survive the filters, reordered among their siblings
   *   (sigma[L][i] = original index of displayed group i at level L); leaves inside each deepest group
   *   are the matching ones, sorted the first time that group is needed.
   * Totals are "visual totals": a group's value is the sum over what is left of it. Where nothing below
   * a group was filtered out it is computed exactly as in the unfiltered view, so the numbers agree.
   * Resolves to { tree, maps, spec, rowShares(r), rowName(level, i) }.
   */
  function view(m, keys, filters = [], cv = colView(m, [])) {
    const t = m.rowTree;
    if (keys.length === 0 && filters.length === 0) {
      m.plainView ??= {
        tree: t,
        maps: null,
        spec: m.rowSpec,
        rowShares: (r) => shares(t, t.locate(r), ROW_SEED, 0),
        rowName: (L, i) => nameOf(m, 'rows', L, i),
      };
      return Promise.resolve(m.plainView);
    }
    for (const f of filters) {
      if (f.dim === undefined || f.op === 'range') throw httpError('Pivot filters work on row dimensions: a list of names, or text to search for');
    }
    const sig = `${sortSignature(keys)}|${filterSignature(filters)}|${cv.sig}`;
    let pending = m.views.get(sig);
    if (!pending) {
      pending = buildView(m, keys, filters, cv);
      pending.catch(() => m.views.delete(sig));
      lruSet(m.views, sig, pending, 8);
    }
    return pending;
  }

  async function buildView(m, keys, filters, cv) {
    const t = m.rowTree;
    const D = t.depth;
    const parent = [null];
    for (let L = 1; L < D; L++) {
      const arr = new Uint32Array(t.cnt[L]);
      for (let i = 0; i < t.cnt[L - 1]; i++) for (let j = t.childStart[L - 1][i]; j < t.childStart[L - 1][i + 1]; j++) arr[j] = i;
      parent.push(arr);
    }
    const groupPath = (L, g) => {
      const path = new Array(L + 1);
      let x = g;
      for (let l = L; l >= 0; l--) {
        path[l] = x;
        if (l > 0) x = parent[l][x];
      }
      return path;
    };
    const pathShares = (L, g) => shares(t, { kind: 'subtotal', level: L, path: groupPath(L, g) }, ROW_SEED, 0);
    const leavesOf = (g) => t.childStart[D - 1][g + 1] - t.childStart[D - 1][g];

    // Name tests per level (all must pass).
    const tests = Array.from({ length: D + 1 }, (_, L) => filters.filter((f) => f.dim === L).map(nameTest));
    const passes = (L, name) => tests[L].every((fn) => fn(name));
    const leafFiltered = tests[D].length > 0;
    if (leafFiltered && t.leafCount > PIVOT_LEAF_FILTER_MAX) {
      throw httpError(`Filtering products is limited to ${fmtCount(PIVOT_LEAF_FILTER_MAX)} products in this demo server (this pivot has ${fmtCount(t.leafCount)})`, 422);
    }

    // 1) A group passes when it and all its ancestors pass their level's filters.
    const pass = [];
    for (let L = 0; L < D; L++) {
      const arr = new Uint8Array(t.cnt[L]);
      for (let g = 0; g < t.cnt[L]; g++) {
        const parentOk = L === 0 || pass[L - 1][parent[L][g]] === 1;
        arr[g] = parentOk && (tests[L].length === 0 || passes(L, nameOf(m, 'rows', L, g))) ? 1 : 0;
      }
      pass.push(arr);
    }

    // 2) Bottom-up: matching leaves, whether a group is kept (something left below), whether it is
    //    complete (nothing below removed), and the shares of what is left.
    const kept = t.cnt.map((n) => new Uint8Array(n));
    const complete = t.cnt.map((n) => new Uint8Array(n));
    const sum = t.cnt.map((n) => new Float64Array(n * 3));
    const keptLeaves = new Map(); // deepest group -> Uint32Array of matching leaf indexes (only when leaves are filtered)
    const groupShareCache = new Map(); // deepest group -> its own path shares (leaf values derive from it)
    let scanned = 0;
    for (let g = 0; g < t.cnt[D - 1]; g++) {
      if (!pass[D - 1][g]) continue;
      const cs = pathShares(D - 1, g);
      groupShareCache.set(g, cs);
      const n = leavesOf(g);
      if (!leafFiltered) {
        kept[D - 1][g] = 1;
        complete[D - 1][g] = 1;
        sum[D - 1].set(cs, g * 3);
        continue;
      }
      const base = t.childStart[D - 1][g];
      const list = [];
      let ss = 0;
      let sp = 0;
      let su = 0;
      for (let i = 0; i < n; i++) {
        if (passes(D, nameOf(m, 'rows', D, base + i))) {
          list.push(i);
          const f = split(i, n, D, g, ROW_SEED);
          ss += f[0];
          sp += f[1];
          su += f[2];
        }
        if ((++scanned & 262143) === 0) await yieldToEventLoop();
      }
      if (list.length === 0) continue;
      kept[D - 1][g] = 1;
      complete[D - 1][g] = list.length === n ? 1 : 0;
      if (list.length < n) keptLeaves.set(g, Uint32Array.from(list));
      sum[D - 1].set(complete[D - 1][g] ? cs : [cs[0] * ss, cs[1] * sp, cs[2] * su], g * 3);
    }
    for (let L = D - 2; L >= 0; L--) {
      for (let g = 0; g < t.cnt[L]; g++) {
        if (!pass[L][g]) continue;
        let any = false;
        let all = true;
        let ss = 0;
        let sp = 0;
        let su = 0;
        for (let j = t.childStart[L][g]; j < t.childStart[L][g + 1]; j++) {
          if (!kept[L + 1][j]) {
            all = false;
            continue;
          }
          any = true;
          if (!complete[L + 1][j]) all = false;
          ss += sum[L + 1][j * 3];
          sp += sum[L + 1][j * 3 + 1];
          su += sum[L + 1][j * 3 + 2];
        }
        if (!any) continue;
        kept[L][g] = 1;
        complete[L][g] = all ? 1 : 0;
        sum[L].set(all ? pathShares(L, g) : [ss, sp, su], g * 3);
      }
    }
    let allRoots = true;
    const grand = [0, 0, 0];
    for (let g = 0; g < t.cnt[0]; g++) {
      if (!kept[0][g] || !complete[0][g]) allRoots = false;
      if (!kept[0][g]) continue;
      grand[0] += sum[0][g * 3];
      grand[1] += sum[0][g * 3 + 1];
      grand[2] += sum[0][g * 3 + 2];
    }
    const grandShares = allRoots ? ONE : grand;
    const groupShares = (L, g) => [sum[L][g * 3], sum[L][g * 3 + 1], sum[L][g * 3 + 2]];

    // 3) Order: kept groups sorted among their siblings by the keys that apply (value columns use the
    //    group's total over what is left; a name key applies to its own level).
    const colInfos = new Map(keys.filter((k) => k.col !== undefined).map((k) => [k.col, cv.colInfo(k.col)]));
    const sortGroups = (L, groups) => {
      const applicable = keys.filter((k) => k.col !== undefined || k.dim === L);
      if (applicable.length === 0 || groups.length < 2) return groups;
      const columns = applicable.map((k) => {
        if (k.dim !== undefined) return { desc: k.desc, text: true, values: groups.map((g) => nameOf(m, 'rows', L, g)) };
        const { measure, f } = colInfos.get(k.col);
        return { desc: k.desc, values: groups.map((g) => measureValue(m, groupShares(L, g), measure, f)) };
      });
      const idx = groups.map((_, i) => i).sort(comparator(columns, groups));
      return idx.map((i) => groups[i]);
    };
    const keptChildren = (L, p) => {
      const out = [];
      for (let j = t.childStart[L][p]; j < t.childStart[L][p + 1]; j++) if (kept[L + 1][j]) out.push(j);
      return out;
    };
    const roots = [];
    for (let g = 0; g < t.cnt[0]; g++) if (kept[0][g]) roots.push(g);
    const sigma = [sortGroups(0, roots)];
    for (let L = 1; L < D; L++) {
      const out = [];
      for (const p of sigma[L - 1]) for (const g of sortGroups(L, keptChildren(L - 1, p))) out.push(g);
      sigma.push(out);
    }
    const fanout = sigma.map((list, L) => list.map((o) => (L < D - 1 ? keptChildren(L, o).length : keptLeaves.get(o)?.length ?? leavesOf(o))));
    const spec = { ...m.rowSpec, roots: sigma[0].length, fanout };
    const tree = new TreeAxis(spec);

    // Leaves in a deepest group: the matching ones (all if leaves are not filtered), sorted by value
    // columns and by a name key on the leaf level. Built the first time the group is needed.
    const leafKeys = keys.filter((k) => k.col !== undefined || k.dim === D);
    const leafOrders = new Map();
    const leafList = (o) => {
      const matching = keptLeaves.get(o) ?? null;
      if (leafKeys.length === 0) return matching;
      let order = leafOrders.get(o);
      if (order) return order;
      const n = leavesOf(o);
      const base = t.childStart[D - 1][o];
      const ids = matching ?? Uint32Array.from({ length: n }, (_, i) => i);
      const cs = groupShareCache.get(o);
      const columns = leafKeys.map((k) => {
        if (k.dim !== undefined) return { desc: k.desc, text: true, values: Array.from(ids, (i) => nameOf(m, 'rows', D, base + i)) };
        const { measure, f } = colInfos.get(k.col);
        const values = new Float64Array(ids.length);
        ids.forEach((i, x) => {
          const sh = split(i, n, D, o, ROW_SEED);
          values[x] = measureValue(m, [cs[0] * sh[0], cs[1] * sh[1], cs[2] * sh[2]], measure, f);
        });
        return { desc: k.desc, values };
      });
      const idx = new Uint32Array(ids.length);
      for (let x = 0; x < ids.length; x++) idx[x] = x;
      idx.sort(comparator(columns, ids));
      order = Uint32Array.from(idx, (x) => ids[x]);
      lruSet(leafOrders, o, order, 64);
      return order;
    };

    const rowShares = (r) => {
      const loc = tree.locate(r);
      if (loc.kind === 'grand') return grandShares;
      if (loc.kind !== 'leaf') return groupShares(loc.level, sigma[loc.level][loc.path[loc.level]]);
      const o = sigma[D - 1][loc.path[D - 1]];
      const list = leafList(o);
      const k = list ? list[loc.leafInGroup] : loc.leafInGroup;
      const cs = groupShareCache.get(o);
      const sh = split(k, leavesOf(o), D, o, ROW_SEED);
      return [cs[0] * sh[0], cs[1] * sh[1], cs[2] * sh[2]];
    };
    const rowName = (L, i) => {
      if (L < D) return nameOf(m, 'rows', L, sigma[L][i]);
      const g = lastLE(tree.childStart[D - 1], 0, tree.cnt[D - 1] - 1, i);
      const o = sigma[D - 1][g];
      const inGroup = i - tree.childStart[D - 1][g];
      const list = leafList(o);
      return nameOf(m, 'rows', D, t.childStart[D - 1][o] + (list ? list[inGroup] : inGroup));
    };
    return { tree, maps: sigma, spec, rowShares, rowName };
  }

  return {
    build,
    view,
    colView,
    values,
    meta(m, v, cv) {
      return { mode: 'pivot', rows: v.spec, cols: cv.spec, rowMaps: v.maps, colMaps: cv.maps, filter: { maxLeafRows: PIVOT_LEAF_FILTER_MAX } };
    },
    block(m, v, cv, r0, c0, nr, nc) {
      const colInfo = [];
      for (let c = c0; c < c0 + nc; c++) colInfo.push(cv.colInfo(c));
      const cells = new Array(nr * nc);
      let i = 0;
      for (let r = r0; r < r0 + nr; r++) {
        const rf = v.rowShares(r);
        for (const { measure, f } of colInfo) cells[i++] = formatValue(measure, measureValue(m, rf, measure, f));
      }
      return cells;
    },
    labels(m, v, cv, axis, level, from, n) {
      const tree = axis === 'rows' ? v.tree : axis === 'cols' ? cv.tree : null;
      if (!tree || level < 0 || level > tree.depth) return null;
      const size = level === tree.depth ? tree.leafCount : tree.cnt[level];
      if (from >= size) return null;
      const names = [];
      for (let i = from; i < Math.min(size, from + n); i++) names.push(axis === 'rows' ? v.rowName(level, i) : cv.colName(level, i));
      return names;
    },
  };
})();

// ------------------------------------------------------------------ requests

function int(value, fallback, min, max) {
  if (value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Answers one /api call. `url` is a URL whose pathname starts with /api/; `readBody()` resolves with the
 * parsed JSON body (POST /api/gather); `cancelled()` says whether the client gave up while we waited.
 * Resolves with { status, body } (body is JSON-ready), or null when the request was cancelled.
 * Invalid input throws an Error with a 4xx `status`.
 */
export async function handleApiRequest({ url, method = 'GET', readBody = async () => null, cancelled = () => false }) {
  const reply = (status, body) => ({ status, body });
  const p = url.searchParams;
  const mode = p.get('mode') === 'flat' ? 'flat' : 'pivot';
  const rows = int(p.get('rows'), DEFAULT_ROWS, 0, MAX_ROWS);
  const cols = int(p.get('cols'), DEFAULT_COLS, 0, MAX_COLS);
  const years = int(p.get('years'), DEFAULT_YEARS, 1, MAX_YEARS);
  const latency = int(p.get('latency'), DEFAULT_LATENCY, 0, 5000);
  const pv = mode === 'pivot' ? pivot.build(Math.max(rows, 1), years) : null;
  // Pivot column filter first: sort keys and requests address columns of the filtered column axis.
  const colFilters = pv ? parseFilter(p.get('colfilter') ?? '', { cols: 0, depth: pv.colTree.depth }) : [];
  const cv = pv ? pivot.colView(pv, colFilters) : null;
  const shape = pv ? { cols: cv.tree.count, depth: pv.rowTree.depth } : { cols };
  const keys = parseSort(p.get('sort') ?? '', shape);
  const filters = parseFilter(p.get('filter') ?? '', shape);
  const transformed = keys.length > 0 || filters.length > 0;

  // How far the sort or scan for these parameters is (polled while /api/meta waits for it).
  if (url.pathname === '/api/progress') {
    return reply(200, pv ? { active: false } : flat.progress(rows, keys, filters));
  }

  if (url.pathname === '/api/meta') {
    if (pv) return reply(200, pivot.meta(pv, await pivot.view(pv, keys, filters, cv), cv));
    // Flat: only a filter changes the row count (the scan result is reused by the data requests).
    const matching = filters.length ? (await flat.view(rows, keys, filters, cancelled)).count : rows;
    if (cancelled()) return null;
    return reply(200, flat.meta(rows, cols, matching));
  }

  // Read the body before the simulated wait so a cancelled request is detected afterwards.
  let body = null;
  if (url.pathname === '/api/gather') {
    if (method !== 'POST') return reply(405, { error: 'use POST' });
    body = await readBody();
  }

  // The view maps row positions to data (may scan or sort the first time: "database time").
  const view = pv ? await pivot.view(pv, keys, filters, cv) : await flat.view(rows, keys, filters, cancelled);

  // Simulated network/database time, with jitter so responses arrive out of order like real ones.
  if (latency > 0) await sleep(latency * (0.5 + Math.random()));
  if (cancelled()) return null; // the client cancelled this request while we waited

  if (url.pathname === '/api/values') {
    if (!pv) return reply(400, { error: 'values are listed for pivot dimensions only' });
    const q = p.get('q') ?? '';
    if (q.length > 200) return reply(400, { error: 'search text too long' });
    const out = pivot.values(pv, p.get('axis'), int(p.get('level'), -1, -1, 64), q, int(p.get('limit'), MAX_VALUES, 1, MAX_VALUES));
    if (!out) return reply(400, { error: 'unknown dimension' });
    return reply(200, out);
  }

  const rowCount = pv ? view.tree.count : view.count;
  const colCount = pv ? cv.tree.count : cols;
  const blockOf = (r0, c0, nr, nc) => (pv ? pivot.block(pv, view, cv, r0, c0, nr, nc) : flat.block(rows, view, r0, c0, nr, nc));
  // Merged cells belong to the plain layout: in a sorted or filtered view they would join unrelated rows.
  const mergesOf = (r0, c0, nr, nc) => (pv || transformed ? [] : flat.merges(rows, cols, r0, c0, nr, nc));

  if (url.pathname === '/api/block') {
    const r0 = int(p.get('r0'), -1, -1, MAX_ROWS * 2);
    const c0 = int(p.get('c0'), -1, -1, MAX_COLS * 2);
    if (r0 < 0 || c0 < 0 || r0 >= rowCount || c0 >= colCount) return reply(400, { error: 'block out of range' });
    const nr = Math.min(int(p.get('nr'), 100, 1, 1000), rowCount - r0);
    const nc = Math.min(int(p.get('nc'), 20, 1, 200), colCount - c0);
    if (nr * nc > MAX_BLOCK_CELLS) return reply(400, { error: 'block too large' });
    return reply(200, { r0, c0, nr, nc, cells: blockOf(r0, c0, nr, nc), merges: mergesOf(r0, c0, nr, nc) });
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
      if (!ok || r0 < 0 || c0 < 0 || nr < 1 || nc < 1 || r0 + nr > rowCount || c0 + nc > colCount) {
        return reply(400, { error: 'rect out of range' });
      }
      total += nr * nc;
    }
    if (total > MAX_BLOCK_CELLS) return reply(400, { error: 'too many cells' });
    const cells = rects.map(([r0, c0, nr, nc]) => blockOf(r0, c0, nr, nc));
    const merges = rects.flatMap(([r0, c0, nr, nc]) => mergesOf(r0, c0, nr, nc));
    return reply(200, { cells, merges });
  }

  if (url.pathname === '/api/labels') {
    const axis = p.get('axis');
    const level = int(p.get('level'), -1, -1, 64);
    const from = int(p.get('from'), -1, -1, MAX_ROWS * 2);
    const n = int(p.get('n'), 500, 1, MAX_LABELS);
    if (from < 0) return reply(400, { error: 'bad label range' });
    const names = pv ? pivot.labels(pv, view, cv, axis, level, from, n) : flat.labels(cols, axis, level, from, n);
    if (!names) return reply(400, { error: 'labels out of range' });
    return reply(200, { from, names });
  }

  return reply(404, { error: 'not found' });
}
