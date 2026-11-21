// The playground's "server": a Web Worker that holds the dataset (generated or parsed from CSV) in
// columnar typed arrays and answers the grid's data-source calls the way a real backend would:
//   table mode: rows by offset / limit, sorted and filtered
//   pivot mode: a pivot layout (row and column trees), cells by rectangle, header labels, filter values
// It runs off the main thread, so its compute time is real and measured; network latency is added by
// the page around each call.

const SIGMA = -1; // the "Σ Values" pseudo-dimension (measure names as a level of rows or columns)
const SYN_ROOT = -2; // synthetic "All" level for axes with fewer than two dimensions
const SYN_LEAF = -3; // synthetic single leaf for an axis with no dimensions

let lastAggHit = false;
let ds = null; // { n, fields: Field[], source, buildMs }
const caches = { agg: new Map(), disp: new Map(), table: new Map(), ids: new Map() };

// ------------------------------------------------------------------ utils

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

function lruSet(map, key, value, max) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value);
  return value;
}

function progress(id, phase, done, total) {
  self.postMessage({ id, progress: { phase, done, total } });
}

function rankOf(dict, ordered) {
  const order = dict.map((_, i) => i);
  if (!ordered) order.sort((a, b) => collator.compare(dict[a], dict[b]));
  const rank = new Int32Array(dict.length);
  order.forEach((code, pos) => { rank[code] = pos; });
  return rank;
}

/** A field usable as a dimension needs codes + dict + rank; numeric fields get them on first use. */
function ensureDim(f) {
  if (f.codes) return f;
  const vals = f.values;
  const map = new Map();
  const dictNums = [];
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    const k = Number.isNaN(v) ? 'NaN' : v;
    if (!map.has(k)) { map.set(k, dictNums.length); dictNums.push(v); }
  }
  const order = dictNums.map((_, i) => i).sort((a, b) => {
    const x = dictNums[a], y = dictNums[b];
    if (Number.isNaN(x)) return 1;
    if (Number.isNaN(y)) return -1;
    return x - y;
  });
  const remap = new Int32Array(dictNums.length);
  order.forEach((old, pos) => { remap[old] = pos; });
  const dict = order.map((i) => (Number.isNaN(dictNums[i]) ? '(blank)' : String(dictNums[i])));
  const codes = dict.length < 65536 ? new Uint16Array(vals.length) : new Uint32Array(vals.length);
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    codes[i] = remap[map.get(Number.isNaN(v) ? 'NaN' : v)];
  }
  f.codes = codes;
  f.dict = dict;
  f.rank = rankOf(dict, true);
  return f;
}

function fieldInfo(f, i) {
  return { index: i, key: f.key, name: f.name, kind: f.kind, cardinality: f.dict ? f.dict.length : undefined };
}

function datasetInfo() {
  let bytes = 0;
  for (const f of ds.fields) {
    if (f.codes) bytes += f.codes.byteLength;
    if (f.values) bytes += f.values.byteLength;
  }
  return { rows: ds.n, fields: ds.fields.map(fieldInfo), bytes, source: ds.source, buildMs: ds.buildMs };
}

function resetCaches() {
  caches.agg.clear();
  caches.disp.clear();
  caches.table.clear();
  caches.ids.clear();
}

// ------------------------------------------------------------------ generated dataset

const REGIONS = [
  ['North America', ['United States', 'Canada', 'Mexico']],
  ['Europe', ['Germany', 'France', 'United Kingdom', 'Spain', 'Italy', 'Netherlands', 'Sweden', 'Poland']],
  ['Asia Pacific', ['Japan', 'China', 'India', 'Australia', 'Singapore', 'South Korea']],
  ['Latin America', ['Brazil', 'Argentina', 'Chile', 'Colombia', 'Peru']],
  ['Middle East & Africa', ['UAE', 'Saudi Arabia', 'South Africa', 'Egypt', 'Nigeria', 'Kenya']],
];
const CATEGORIES = [
  ['Electronics', ['Laptop', 'Phone', 'Tablet', 'Monitor', 'Headphones', 'Camera', 'Smartwatch', 'Speaker']],
  ['Furniture', ['Desk', 'Chair', 'Bookcase', 'Sofa', 'Lamp', 'Cabinet']],
  ['Office Supplies', ['Paper', 'Pens', 'Binders', 'Stapler', 'Notebook', 'Envelopes', 'Labels']],
  ['Apparel', ['Jacket', 'Sneakers', 'T-Shirt', 'Jeans', 'Backpack', 'Cap']],
  ['Grocery', ['Coffee', 'Tea', 'Olive Oil', 'Pasta', 'Chocolate', 'Rice', 'Snacks']],
  ['Sports', ['Bicycle', 'Yoga Mat', 'Dumbbells', 'Tent', 'Running Shoes', 'Racket']],
];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SEASON = [0.82, 0.78, 0.95, 0.97, 1.02, 1.0, 0.94, 0.98, 1.05, 1.08, 1.25, 1.45];
const SYL_A = ['Port', 'San', 'New', 'Lake', 'Fort', 'Glen', 'East', 'West', 'North', 'Mount', 'Bay', 'Old'];
const SYL_B = ['haven', 'field', 'ford', 'ridge', 'ton', 'wood', 'vale', 'mouth', 'brook', 'stone', 'gate', 'more'];
const FIRST = ['Ava', 'Liam', 'Noah', 'Emma', 'Mia', 'Lucas', 'Zoe', 'Ivan', 'Aiko', 'Ravi', 'Sofia', 'Omar', 'Lena', 'Kofi', 'Mateo', 'Yara'];
const LAST = ['Patel', 'Garcia', 'Kim', 'Novak', 'Silva', 'Okafor', 'Rossi', 'Tanaka', 'Müller', 'Haddad', 'Larsen', 'Chen'];

/**
 * Builds `rows` records with `dims` dimension columns and `measures` numeric columns (plus Order ID).
 * Hierarchies stay consistent (country in region, product in category, month in quarter) and values
 * carry seasonality and regional growth, so pivots and heatmaps show real patterns.
 */
function generate({ rows, dims, measures, years = 5, seed = 42 }, id) {
  const t0 = performance.now();
  const rnd = mulberry32(seed);
  const n = rows;
  const startYear = 2026 - years;

  // Core per-record draws, shared by the fields that depend on them.
  const countries = REGIONS.flatMap(([, cs], r) => cs.map((c) => [c, r]));
  const products = CATEGORIES.flatMap(([, ps], c) => ps.map((p) => [p, c]));
  const regionWeight = [1.4, 1.2, 1.1, 0.7, 0.6];
  const countryCum = [];
  let acc = 0;
  for (const [, r] of countries) countryCum.push((acc += regionWeight[r]));
  const pickCountry = () => {
    const x = rnd() * acc;
    let lo = 0, hi = countryCum.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (countryCum[mid] < x) lo = mid + 1; else hi = mid; }
    return lo;
  };
  const days = years * 365;
  const country = new Uint16Array(n), product = new Uint16Array(n), day = new Uint16Array(n), city = new Uint8Array(n);
  const base = new Float64Array(n), units = new Float64Array(n), discount = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if ((i & 0x3ffff) === 0) progress(id, 'Generating rows', i, n);
    const c = pickCountry();
    const p = (rnd() * products.length) | 0;
    let d = (rnd() * days) | 0;
    const y = (d / 365) | 0;
    const m = Math.min(11, (((d % 365) / 365) * 12) | 0);
    // Seasonal / growth skew: drop some low-season draws.
    if (rnd() > SEASON[m] / 1.45) d = (rnd() * days) | 0;
    country[i] = c;
    product[i] = p;
    day[i] = d;
    city[i] = (rnd() * 4) | 0;
    const growth = 1 + 0.09 * y * (countries[c][1] === 2 ? 1.6 : 1);
    const priceBase = 20 + ((p * 7919) % 480);
    const u = 1 + Math.floor(-Math.log(1 - rnd()) * 6);
    units[i] = u;
    const disc = rnd() < 0.55 ? 0 : Math.round(rnd() * 8) * 0.05;
    discount[i] = disc;
    base[i] = priceBase * u * (1 - disc) * growth * SEASON[Math.min(11, (((d % 365) / 365) * 12) | 0)] * (0.85 + rnd() * 0.3);
  }

  const fields = [];
  const dim = (name, dict, codesFn, ordered = false) => ({ name, dict, codesFn, ordered });
  const dimDefs = [
    dim('Region', REGIONS.map((r) => r[0]), (i) => countries[country[i]][1], true),
    dim('Country', countries.map((c) => c[0]), (i) => country[i]),
    dim('Category', CATEGORIES.map((c) => c[0]), (i) => products[product[i]][1]),
    dim('Product', products.map((p) => p[0]), (i) => product[i]),
    dim('Year', Array.from({ length: years }, (_, y) => String(startYear + y)), (i) => (day[i] / 365) | 0, true),
    dim('Quarter', ['Q1', 'Q2', 'Q3', 'Q4'], (i) => Math.min(3, ((((day[i] % 365) / 365) * 12) | 0) / 3 | 0), true),
    dim('Month', MONTHS, (i) => Math.min(11, (((day[i] % 365) / 365) * 12) | 0), true),
    dim('Channel', ['Online', 'Retail', 'Wholesale', 'Partner'], (i) => (product[i] * 3 + country[i] + day[i]) % 4 === 0 ? 2 : (country[i] + day[i] * 7) % 4, true),
    dim('Segment', ['Consumer', 'Corporate', 'Small Business', 'Government'], (i) => (product[i] + day[i] * 13 + i) % 7 % 4, true),
    dim('City', countries.flatMap(([c], ci) => [0, 1, 2, 3].map((j) => { const h = (ci * 31 + j * 17) % 144; return `${SYL_A[h % 12]} ${SYL_B[(h / 12) | 0].replace(/^./, (s) => s.toUpperCase())}${j ? '' : ''} (${c.slice(0, 3).toUpperCase()})`; })), (i) => country[i] * 4 + city[i]),
    dim('Order Date', Array.from({ length: days }, (_, d) => {
      const y = startYear + ((d / 365) | 0);
      const doy = d % 365;
      const m = Math.min(11, ((doy / 365) * 12) | 0);
      const dd = Math.min(28, 1 + (doy - Math.round((m * 365) / 12)));
      return `${y}-${String(m + 1).padStart(2, '0')}-${String(Math.max(1, dd)).padStart(2, '0')}`;
    }), (i) => day[i], true),
    dim('Ship Mode', ['Same Day', 'First Class', 'Second Class', 'Standard'], (i) => (i * 2654435761 >>> 28) % 4, true),
    dim('Sales Rep', Array.from({ length: 48 }, (_, k) => `${FIRST[k % 16]} ${LAST[(k * 5) % 12]}`), (i) => (country[i] * 7 + (i % 3)) % 48),
    dim('Customer Tier', ['Bronze', 'Silver', 'Gold', 'Platinum'], (i) => { const h = (i * 40503) >>> 0; const x = (h % 100); return x < 50 ? 0 : x < 80 ? 1 : x < 95 ? 2 : 3; }, true),
    dim('Payment', ['Card', 'Invoice', 'Wallet', 'Bank Transfer', 'Cash'], (i) => (i * 7 + product[i]) % 5),
    dim('Priority', ['Low', 'Medium', 'High', 'Critical'], (i) => (i * 11 + day[i]) % 13 % 4, true),
  ];
  for (let k = dimDefs.length; k < dims; k++) {
    const card = 3 * 2 ** (k % 8);
    const tag = `Attr ${k + 1}`;
    dimDefs.push(dim(tag, Array.from({ length: card }, (_, v) => `${tag}-${String(v + 1).padStart(String(card).length, '0')}`), (i) => (((i + 1) * (2654435761 + k * 97)) >>> 0) % card, true));
  }

  // Order ID first: unique, handy for the table view.
  const ids = new Float64Array(n);
  for (let i = 0; i < n; i++) ids[i] = 100000 + i;
  fields.push({ key: 'f0', name: 'Order ID', kind: 'num', values: ids });

  for (const def of dimDefs.slice(0, dims)) {
    progress(id, `Building ${def.name}`, fields.length, dims + measures);
    const codes = def.dict.length < 65536 ? new Uint16Array(n) : new Uint32Array(n);
    for (let i = 0; i < n; i++) codes[i] = def.codesFn(i);
    fields.push({ key: `f${fields.length}`, name: def.name, kind: 'dim', codes, dict: def.dict, rank: rankOf(def.dict, def.ordered) });
  }

  const mDefs = [
    ['Sales', (i) => Math.round(base[i] * 100) / 100],
    ['Units', (i) => units[i]],
    ['Profit', (i) => Math.round(base[i] * (0.32 - discount[i] * 1.1 + (((i * 2654435761) >>> 0) % 100) / 400 - 0.12) * 100) / 100],
    ['Cost', (i) => Math.round(base[i] * 0.62 * 100) / 100],
    ['Discount', (i) => discount[i]],
    ['Shipping', (i) => Math.round((4 + units[i] * 1.7 + (i % 9)) * 100) / 100],
    ['Rating', (i) => 1 + ((i * 48271) >>> 0) % 5],
    ['Returns', (i) => ((i * 69621) >>> 0) % 23 === 0 ? 1 : 0],
  ];
  for (let k = mDefs.length; k < measures; k++) {
    const scale = 10 ** (k % 4);
    mDefs.push([`Metric ${k + 1}`, (i) => Math.round(((((i + 7) * (2246822519 + k * 131)) >>> 0) % 10000) / 100 * scale) / 100 * (1 + (day[i] / days))]);
  }
  for (const [name, fn] of mDefs.slice(0, measures)) {
    progress(id, `Building ${name}`, fields.length, dims + measures);
    const values = new Float64Array(n);
    for (let i = 0; i < n; i++) values[i] = fn(i);
    fields.push({ key: `f${fields.length}`, name, kind: 'num', values });
  }

  ds = { n, fields, source: { type: 'generated', rows, dims, measures, years, seed }, buildMs: performance.now() - t0 };
  resetCaches();
  return datasetInfo();
}

// ------------------------------------------------------------------ CSV

function detectDelimiter(text) {
  const head = text.slice(0, 20000).split(/\r?\n/).slice(0, 10);
  let best = ',', bestScore = -1;
  for (const d of [',', ';', '\t', '|']) {
    const counts = head.map((l) => l.split(d).length - 1);
    const min = Math.min(...counts);
    const score = min > 0 && counts.every((c) => c === counts[0]) ? min * 10 : min;
    if (score > bestScore) { best = d; bestScore = score; }
  }
  return best;
}

/** RFC 4180 CSV: quoted fields, doubled quotes, newlines inside quotes. Columns are filled as strings. */
function parseCsv({ text, header = true, delimiter = 'auto', name }, id) {
  const t0 = performance.now();
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const d = delimiter === 'auto' ? detectDelimiter(text) : delimiter === 'tab' ? '\t' : delimiter;
  const D = d.charCodeAt(0);
  const len = text.length;
  const cols = [];
  let row = 0, col = 0, i = 0;
  let headerNames = null;
  let rowVals = [];
  const pushVal = (v) => { rowVals.push(v); };
  const endRow = () => {
    if (rowVals.length === 1 && rowVals[0] === '') { rowVals = []; return; } // blank line
    if (header && !headerNames) {
      headerNames = rowVals;
    } else {
      const width = Math.max(rowVals.length, cols.length);
      for (let c = 0; c < width; c++) {
        if (!cols[c]) { cols[c] = new Array(row); for (let r = 0; r < row; r++) cols[c][r] = ''; }
        cols[c].push(rowVals[c] ?? '');
      }
      row++;
      if ((row & 0xffff) === 0) progress(id, 'Parsing CSV', i, len);
    }
    rowVals = [];
  };
  while (i < len) {
    let ch = text.charCodeAt(i);
    if (ch === 34) { // quoted
      let j = i + 1, out = '';
      for (;;) {
        const q = text.indexOf('"', j);
        if (q < 0) { out += text.slice(j); i = len; break; }
        out += text.slice(j, q);
        if (text.charCodeAt(q + 1) === 34) { out += '"'; j = q + 2; continue; }
        i = q + 1;
        break;
      }
      pushVal(out);
      ch = text.charCodeAt(i);
      if (ch === D) i++;
      else if (ch === 13) { i += text.charCodeAt(i + 1) === 10 ? 2 : 1; endRow(); }
      else if (ch === 10) { i++; endRow(); }
      else if (i >= len) endRow();
      continue;
    }
    // unquoted: up to the next delimiter or newline
    let j = i;
    while (j < len) {
      const c = text.charCodeAt(j);
      if (c === D || c === 10 || c === 13) break;
      j++;
    }
    pushVal(text.slice(i, j).trim());
    if (j >= len) { i = len; endRow(); break; }
    const c = text.charCodeAt(j);
    if (c === D) { i = j + 1; if (i >= len) { pushVal(''); endRow(); } }
    else if (c === 13) { i = j + (text.charCodeAt(j + 1) === 10 ? 2 : 1); endRow(); }
    else { i = j + 1; endRow(); }
  }
  if (rowVals.length) endRow();
  col = cols.length;
  if (!col || !row) throw new Error('The CSV has no data rows');

  progress(id, 'Detecting column types', 0, col);
  const fields = [];
  const used = new Set();
  for (let c = 0; c < col; c++) {
    const raw = cols[c];
    let title = (headerNames?.[c] ?? '').trim() || `Column ${c + 1}`;
    while (used.has(title)) title += ' ·';
    used.add(title);
    let nonEmpty = 0, numeric = 0;
    const sample = Math.min(raw.length, 50000);
    const step = Math.max(1, Math.floor(raw.length / sample));
    for (let r = 0; r < raw.length; r += step) {
      const v = raw[r];
      if (v === '') continue;
      nonEmpty++;
      const num = Number(v.replace(/^\$|,(?=\d{3}\b)/g, ''));
      if (v !== '' && Number.isFinite(num)) numeric++;
    }
    const isNum = nonEmpty > 0 && numeric / nonEmpty >= 0.98;
    if (isNum) {
      const values = new Float64Array(row);
      for (let r = 0; r < row; r++) {
        const v = raw[r];
        values[r] = v === '' ? NaN : Number(v.replace(/^\$|,(?=\d{3}\b)/g, ''));
      }
      fields.push({ key: `f${c}`, name: title, kind: 'num', values });
    } else {
      const map = new Map();
      const dict = [];
      const tmp = new Uint32Array(row);
      for (let r = 0; r < row; r++) {
        const v = raw[r] === '' ? '(blank)' : raw[r];
        let code = map.get(v);
        if (code === undefined) { code = dict.length; map.set(v, code); dict.push(v); }
        tmp[r] = code;
      }
      const codes = dict.length < 65536 ? Uint16Array.from(tmp) : tmp;
      fields.push({ key: `f${c}`, name: title, kind: 'dim', codes, dict, rank: rankOf(dict, false) });
    }
    cols[c] = null;
    progress(id, 'Detecting column types', c + 1, col);
  }
  ds = { n: row, fields, source: { type: 'csv', name, delimiter: d === '\t' ? 'tab' : d }, buildMs: performance.now() - t0 };
  resetCaches();
  return datasetInfo();
}

// ------------------------------------------------------------------ filters

/** Keep-mask over a dimension's dictionary for one condition (in / notin / contains). */
function dictMask(f, cond) {
  const dict = f.dict;
  const mask = new Uint8Array(dict.length);
  if (cond.op === 'in' || cond.op === 'notin') {
    const set = new Set((cond.values ?? []).map(String));
    const want = cond.op === 'in';
    for (let i = 0; i < dict.length; i++) mask[i] = set.has(dict[i]) === want ? 1 : 0;
  } else if (cond.op === 'contains') {
    const q = String(cond.text ?? cond.value ?? '').toLowerCase();
    for (let i = 0; i < dict.length; i++) mask[i] = dict[i].toLowerCase().includes(q) ? 1 : 0;
  } else {
    mask.fill(1);
  }
  return mask;
}

/** A per-record test for a table filter: number ranges on numeric fields, value lists / text on the rest. */
function recordTest(f, cond) {
  if (cond.op === 'range') {
    const min = cond.min === undefined || cond.min === null || cond.min === '' ? -Infinity : Number(cond.min);
    const max = cond.max === undefined || cond.max === null || cond.max === '' ? Infinity : Number(cond.max);
    if (f.kind === 'num') {
      const v = f.values;
      return (r) => v[r] >= min && v[r] <= max;
    }
    const lo = cond.min ?? '', hi = cond.max ?? '￿';
    const mask = new Uint8Array(f.dict.length);
    f.dict.forEach((s, i) => { mask[i] = s >= lo && s <= hi ? 1 : 0; });
    const codes = f.codes;
    return (r) => mask[codes[r]] === 1;
  }
  ensureDim(f);
  const mask = dictMask(f, cond);
  const codes = f.codes;
  return (r) => mask[codes[r]] === 1;
}

// ------------------------------------------------------------------ table mode

function tableView(query) {
  const sig = JSON.stringify([query.sort, query.filter]);
  const hit = caches.table.get(sig);
  if (hit) return hit;
  const t0 = performance.now();
  const n = ds.n;
  const byKey = new Map(ds.fields.map((f) => [f.key, f]));
  const tests = (query.filter ?? []).map((c) => recordTest(byKey.get(c.key) ?? ds.fields[c.column], c));
  let idx;
  if (!tests.length) {
    idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
  } else {
    const tmp = new Uint32Array(n);
    let m = 0;
    outer: for (let r = 0; r < n; r++) {
      for (let t = 0; t < tests.length; t++) if (!tests[t](r)) continue outer;
      tmp[m++] = r;
    }
    idx = tmp.slice(0, m);
  }
  const filterMs = performance.now() - t0;
  const keys = (query.sort ?? []).map((s) => ({ f: byKey.get(s.key) ?? ds.fields[s.column], dir: s.direction === 'desc' ? -1 : 1 }));
  if (keys.length) {
    const cmps = keys.map(({ f, dir }) => {
      if (f.kind === 'num') {
        const v = f.values;
        return (a, b) => {
          const x = v[a], y = v[b];
          if (Number.isNaN(x)) return Number.isNaN(y) ? 0 : 1;
          if (Number.isNaN(y)) return -1;
          return (x - y) * dir;
        };
      }
      const codes = f.codes, rank = f.rank;
      return (a, b) => (rank[codes[a]] - rank[codes[b]]) * dir;
    });
    idx.sort((a, b) => {
      for (let k = 0; k < cmps.length; k++) { const c = cmps[k](a, b); if (c) return c; }
      return a - b;
    });
  }
  const view = { idx, filterMs, sortMs: performance.now() - t0 - filterMs };
  return lruSet(caches.table, sig, view, 4);
}

function cellOut(f, r) {
  if (f.kind === 'num') { const v = f.values[r]; return Number.isNaN(v) ? null : v; }
  return f.dict[f.codes[r]];
}

function getRows({ offset, limit, query, keys }) {
  const view = tableView(query);
  const byKey = new Map(ds.fields.map((f) => [f.key, f]));
  const fields = (keys ?? ds.fields.map((f) => f.key)).map((k) => byKey.get(k)).filter(Boolean);
  const end = Math.min(view.idx.length, offset + limit);
  const rows = [];
  for (let i = offset; i < end; i++) {
    const r = view.idx[i];
    const row = { __id: r };
    for (const f of fields) row[f.key] = cellOut(f, r);
    rows.push(row);
  }
  return { rows, total: view.idx.length, totalUnfiltered: ds.n, timing: { filterMs: view.filterMs, sortMs: view.sortMs } };
}

function indexOfRow({ rowId, query }) {
  return tableView(query).idx.indexOf(rowId);
}

function valuesOf(f, search, limit) {
  ensureDim(f);
  const q = (search ?? '').toLowerCase();
  const order = Array.from(f.dict.keys()).sort((a, b) => f.rank[a] - f.rank[b]);
  const values = [];
  let matches = 0;
  for (const code of order) {
    const s = f.dict[code];
    if (q && !s.toLowerCase().includes(q)) continue;
    matches++;
    if (values.length < limit) values.push(s);
  }
  return { values, total: f.dict.length, matches };
}

function tableValues({ key, search, limit }) {
  const f = ds.fields.find((x) => x.key === key);
  if (!f) throw new Error(`unknown column ${key}`);
  return valuesOf(f, search, limit);
}

// ------------------------------------------------------------------ pivot mode

function axisShape(dims) {
  const k = dims.length;
  if (k === 0) return { levels: [SYN_ROOT], leaf: SYN_LEAF };
  if (k === 1) return { levels: [SYN_ROOT], leaf: dims[0] };
  return { levels: dims.slice(0, -1), leaf: dims[k - 1] };
}
const entryAt = (shape, level) => (level < shape.levels.length ? shape.levels[level] : level === shape.levels.length ? shape.leaf : undefined);

function measureLabel(m) {
  if (m.field < 0) return 'Count';
  const name = ds.fields[m.field].name;
  const agg = { sum: 'Sum', avg: 'Avg', min: 'Min', max: 'Max', count: 'Count' }[m.agg] ?? m.agg;
  return `${agg} of ${name}`;
}

function measuresOf(cfg) {
  return cfg.values.length ? cfg.values : [{ field: -1, agg: 'count' }];
}

/** Filters on pivot levels: record tests on real dimensions, a keep-list for the Σ level. */
function compilePivotFilters(list, shape, M) {
  const byField = new Map();
  let keepM = null;
  for (const cond of list ?? []) {
    const e = entryAt(shape, cond.level);
    if (e === undefined || e < SIGMA) continue;
    if (e === SIGMA) {
      const labels = M.map(measureLabel);
      const mask = dictMask({ dict: labels }, cond);
      keepM = keepM ? keepM.map((v, i) => v & mask[i]) : mask;
      continue;
    }
    const f = ensureDim(ds.fields[e]);
    const mask = dictMask(f, cond);
    const prev = byField.get(e);
    byField.set(e, prev ? prev.map((v, i) => v & mask[i]) : mask);
  }
  const tests = [...byField].map(([fi, mask]) => ({ codes: ds.fields[fi].codes, mask }));
  return { tests, keepM };
}

function newTrie(dims) {
  return { dims, codesOf: dims.map((d) => ds.fields[d].codes), parent: [-1], depth: [0], code: [-1], kids: [new Map()] };
}

function trieInsert(t, r) {
  let node = 0;
  for (let d = 0; d < t.dims.length; d++) {
    const code = t.codesOf[d][r];
    const kids = t.kids[node];
    let nx = kids.get(code);
    if (nx === undefined) {
      nx = t.parent.length;
      t.parent.push(node);
      t.depth.push(d + 1);
      t.code.push(code);
      t.kids.push(d + 1 < t.dims.length ? new Map() : null);
      kids.set(code, nx);
    }
    node = nx;
  }
  return node;
}

/**
 * Filters records, builds the row and column tries of real dimensions and aggregates every
 * (row node, column node, measure) pair, subtotals included. Cached per layout + filters (sorting
 * only reorders, so it reuses this).
 */
function buildAgg(cfg, query, id) {
  const M = measuresOf(cfg);
  const rowShape = axisShape(cfg.rows);
  const colShape = axisShape(cfg.cols);
  const rf = compilePivotFilters(query.filter, rowShape, M);
  const cf = compilePivotFilters(query.columnFilter, colShape, M);
  const sig = JSON.stringify([cfg.rows, cfg.cols, cfg.values, query.filter, query.columnFilter]);
  const hit = caches.agg.get(sig);
  if (hit) { lastAggHit = true; return hit; }
  lastAggHit = false;

  const timing = {};
  let t = performance.now();
  const realR = cfg.rows.filter((d) => d >= 0);
  const realC = cfg.cols.filter((d) => d >= 0);
  for (const d of [...realR, ...realC]) ensureDim(ds.fields[d]);
  timing.prepareMs = performance.now() - t;

  t = performance.now();
  const n = ds.n;
  const rowTrie = newTrie(realR);
  const colTrie = newTrie(realC);
  const recR = new Int32Array(n).fill(-1);
  const recC = new Int32Array(n);
  const ct = cf.tests, rt = rf.tests;
  let matched = 0;
  outer: for (let r = 0; r < n; r++) {
    if ((r & 0x7ffff) === 0 && r) progress(id, 'Grouping rows', r, n);
    for (let k = 0; k < ct.length; k++) if (!ct[k].mask[ct[k].codes[r]]) continue outer;
    const cl = trieInsert(colTrie, r);
    for (let k = 0; k < rt.length; k++) if (!rt[k].mask[rt[k].codes[r]]) continue outer;
    recC[r] = cl;
    recR[r] = trieInsert(rowTrie, r);
    matched++;
  }
  timing.groupMs = performance.now() - t;

  // Accumulators: per slot and measure [sum, count, min, max].
  t = performance.now();
  const nM = M.length;
  const W = nM * 4;
  const RN = rowTrie.parent.length, CN = colTrie.parent.length;
  const dense = RN * CN <= 4_000_000;
  const slotIndex = dense ? new Int32Array(RN * CN).fill(-1) : new Map();
  let cap = 1024, used = 0;
  let data = new Float64Array(cap * W);
  const slot = (key) => {
    let s = dense ? slotIndex[key] : slotIndex.get(key);
    if (s === undefined || s < 0) {
      s = used++;
      if (used > cap) {
        cap *= 2;
        const next = new Float64Array(cap * W);
        next.set(data);
        data = next;
      }
      const o = s * W;
      for (let m = 0; m < nM; m++) { data[o + m * 4 + 2] = Infinity; data[o + m * 4 + 3] = -Infinity; }
      if (dense) slotIndex[key] = s; else slotIndex.set(key, s);
    }
    return s;
  };
  const mvals = M.map((m) => (m.field >= 0 && ds.fields[m.field].kind === 'num' && m.agg !== 'count' ? ds.fields[m.field].values : null));
  const countOnly = M.map((m, i) => !mvals[i]);
  const numForCount = M.map((m) => (m.field >= 0 && ds.fields[m.field].kind === 'num' ? ds.fields[m.field].values : null));
  const leafKeys = [];
  for (let r = 0; r < n; r++) {
    const rl = recR[r];
    if (rl < 0) continue;
    if ((r & 0x7ffff) === 0 && r) progress(id, 'Aggregating', r, n);
    const key = rl * CN + recC[r];
    const before = used;
    const s = slot(key);
    if (used !== before) leafKeys.push(key);
    const o = s * W;
    for (let m = 0; m < nM; m++) {
      const p = o + m * 4;
      if (countOnly[m]) {
        const nv = numForCount[m];
        if (!nv || !Number.isNaN(nv[r])) data[p + 1]++;
        continue;
      }
      const v = mvals[m][r];
      if (Number.isNaN(v)) continue;
      data[p] += v;
      data[p + 1]++;
      if (v < data[p + 2]) data[p + 2] = v;
      if (v > data[p + 3]) data[p + 3] = v;
    }
  }
  timing.aggregateMs = performance.now() - t;

  // Leaf ranges per measure (for heatmaps), before roll-up.
  const ranges = M.map(() => ({ min: Infinity, max: -Infinity }));
  const valueAt = (s, m) => {
    const p = s * W + m * 4;
    const cnt = data[p + 1];
    if (!cnt) return null;
    switch (M[m].agg) {
      case 'avg': return data[p] / cnt;
      case 'min': return data[p + 2];
      case 'max': return data[p + 3];
      case 'count': return cnt;
      default: return M[m].field < 0 ? cnt : data[p];
    }
  };
  for (const key of leafKeys) {
    const s = dense ? slotIndex[key] : slotIndex.get(key);
    for (let m = 0; m < nM; m++) {
      const v = valueAt(s, m);
      if (v === null) continue;
      if (v < ranges[m].min) ranges[m].min = v;
      if (v > ranges[m].max) ranges[m].max = v;
    }
  }

  // Roll leaf pairs up into every ancestor pair (subtotals and grand totals).
  t = performance.now();
  const rAnc = (node) => { const out = []; for (let x = node; x >= 0; x = rowTrie.parent[x]) out.push(x); return out; };
  const cAnc = (node) => { const out = []; for (let x = node; x >= 0; x = colTrie.parent[x]) out.push(x); return out; };
  const cAncCache = new Map();
  let lastR = -1, lastRA = null;
  for (let k = 0; k < leafKeys.length; k++) {
    if ((k & 0x3ffff) === 0 && k) progress(id, 'Computing subtotals', k, leafKeys.length);
    const key = leafKeys[k];
    const rl = Math.floor(key / CN), cl = key - rl * CN;
    if (rl !== lastR) { lastR = rl; lastRA = rAnc(rl); }
    let ca = cAncCache.get(cl);
    if (!ca) { ca = cAnc(cl); cAncCache.set(cl, ca); }
    const src = (dense ? slotIndex[key] : slotIndex.get(key)) * W;
    for (const ra of lastRA) {
      for (const cc of ca) {
        if (ra === rl && cc === cl) continue;
        const dst = slot(ra * CN + cc) * W;
        for (let m = 0; m < nM; m++) {
          const ps = src + m * 4, pd = dst + m * 4;
          data[pd] += data[ps];
          data[pd + 1] += data[ps + 1];
          if (data[ps + 2] < data[pd + 2]) data[pd + 2] = data[ps + 2];
          if (data[ps + 3] > data[pd + 3]) data[pd + 3] = data[ps + 3];
        }
      }
    }
  }
  timing.rollupMs = performance.now() - t;

  const stat = (rn, cn, m) => {
    const key = rn * CN + cn;
    const s = dense ? slotIndex[key] : slotIndex.get(key);
    if (s === undefined || s < 0) return null;
    return valueAt(s, m);
  };
  const agg = {
    sig, M, rowShape, colShape, rowTrie, colTrie, recR, stat, ranges, matched, timing, rf, cf,
    slots: used, bytes: data.byteLength + (dense ? slotIndex.byteLength : used * 40),
  };
  return lruSet(caches.agg, sig, agg, 2);
}

/** Stable group ids across sorts and filters (so the grid keeps collapsed groups). */
function stableIdFn(axisSig) {
  let map = caches.ids.get(axisSig);
  if (!map) { map = new Map(); lruSet(caches.ids, axisSig, map, 8); }
  return (key) => {
    let v = map.get(key);
    if (v === undefined) { v = map.size; map.set(key, v); }
    return v;
  };
}

/**
 * The displayed tree of one axis: groups per level and leaves (each a real trie node plus a measure),
 * sorted, plus its TreeSpec and the flat item list in source order (leaves, subtotals, grand total).
 */
function buildAxis({ shape, dims, trie, M, keepM, sigmaAny, cmpFor, size, cfg }) {
  const D = shape.levels.length;
  const sigmaPos = dims.indexOf(SIGMA);
  const realDims = dims.filter((d) => d >= 0);
  const rootM = sigmaAny ? -1 : 0;
  const mList = M.map((_, i) => i).filter((i) => !keepM || keepM[i]);
  const children = (item, e, level) => {
    let out;
    if (e === SIGMA) out = mList.map((m) => ({ real: item.real, m }));
    else if (e === SYN_LEAF) out = [{ real: item.real, m: item.m }];
    else {
      const kids = trie.kids[item.real];
      out = kids ? [...kids.values()].map((c) => ({ real: c, m: item.m })) : [];
    }
    const cmp = cmpFor(level, e);
    if (cmp && out.length > 1) out.sort(cmp);
    return out;
  };
  const root = { real: 0, m: rootM };
  const groups = [];
  const fanout = [];
  groups[0] = shape.levels[0] === SYN_ROOT ? [root] : children(root, shape.levels[0], 0);
  for (let L = 0; L < D; L++) {
    const e = L + 1 < D ? shape.levels[L + 1] : shape.leaf;
    const next = [];
    const f = new Array(groups[L].length);
    groups[L].forEach((g, gi) => {
      const ch = children(g, e, L + 1);
      f[gi] = ch.length;
      for (const c of ch) next.push(c);
    });
    fanout[L] = f;
    if (L + 1 < D) groups[L + 1] = next;
    else groups[D] = next; // leaves
  }
  const leaves = groups[D];

  const sub = shape.levels.map((e, L) => {
    if (e === SYN_ROOT) return cfg.grandTotals && shape.leaf !== SYN_LEAF && sigmaPos < 0;
    return cfg.subtotals && (sigmaPos < 0 || sigmaPos <= L);
  });
  const grand = D >= 1 && shape.levels[0] !== SYN_ROOT && cfg.grandTotals && sigmaPos < 0;

  // Source items in the grid's depth-first order.
  const itemReal = [], itemM = [], itemKind = [];
  const leafStart = new Array(D);
  for (let L = 0; L < D; L++) { leafStart[L] = new Int32Array(groups[L].length + 1); }
  for (let L = 0; L < D; L++) {
    let acc = 0;
    fanout[L].forEach((c, i) => { leafStart[L][i + 1] = (acc += c); });
  }
  const emit = (L, g) => {
    const a = leafStart[L][g], b = leafStart[L][g + 1];
    if (L === D - 1) {
      for (let i = a; i < b; i++) { itemReal.push(leaves[i].real); itemM.push(leaves[i].m); itemKind.push(0); }
    } else {
      for (let i = a; i < b; i++) emit(L + 1, i);
    }
    if (sub[L]) { const gr = groups[L][g]; itemReal.push(gr.real); itemM.push(gr.m); itemKind.push(1); }
  };
  for (let g = 0; g < groups[0].length; g++) emit(0, g);
  if (grand) { itemReal.push(0); itemM.push(rootM); itemKind.push(2); }

  const entryName = (e) => (e === SYN_ROOT ? 'All' : e === SYN_LEAF ? ' ' : e === SIGMA ? 'Values' : ds.fields[e].name);
  const nameOf = (item, e) => {
    if (e === SYN_ROOT) return 'All';
    if (e === SYN_LEAF) return 'Total';
    if (e === SIGMA) return measureLabel(M[item.m]);
    const f = ds.fields[realDims[trie.depth[item.real] - 1]];
    return f.dict[trie.code[item.real]];
  };

  // Path keys for stable ids.
  const pathKey = new Map();
  const keyOf = (real) => {
    if (real === 0) return '';
    let k = pathKey.get(real);
    if (k === undefined) { k = `${keyOf(trie.parent[real])}/${trie.code[real]}`; pathKey.set(real, k); }
    return k;
  };
  const idOf = stableIdFn(JSON.stringify(dims));
  const maps = groups.slice(0, D).map((list) => list.map((g) => idOf(`${keyOf(g.real)}|${g.m}`)));

  const spec = {
    levels: shape.levels.map((e, L) => ({ name: entryName(e), subtotal: sub[L] })),
    leafName: entryName(shape.leaf),
    leafSize: size,
    roots: groups[0].length,
    fanout,
    grandTotal: grand,
  };
  return {
    spec, maps, groups, shape,
    itemReal: Int32Array.from(itemReal), itemM: Int16Array.from(itemM), itemKind: Uint8Array.from(itemKind),
    label: (level, i) => {
      const list = groups[level];
      const item = list?.[i];
      return item ? nameOf(item, entryAt(shape, level)) : '';
    },
    leafCount: leaves.length,
  };
}

function rankCompare(e, trie, M) {
  if (e === SIGMA) return (a, b) => a.m - b.m;
  if (e < SIGMA) return null;
  const rank = ds.fields[e].rank;
  return (a, b) => rank[trie.code[a.real]] - rank[trie.code[b.real]];
}

function buildDisplay(cfg, query, id) {
  const agg = buildAgg(cfg, query, id);
  const sig = JSON.stringify([agg.sig, query.sort, cfg.rowHeight, cfg.colWidth, cfg.subtotals, cfg.grandTotals]);
  const hit = caches.disp.get(sig);
  if (hit) return hit;
  const t = performance.now();
  const { M, rowShape, colShape, rowTrie, colTrie, stat } = agg;
  const sigmaAny = cfg.rows.includes(SIGMA) || cfg.cols.includes(SIGMA);

  const colAxis = buildAxis({
    shape: colShape, dims: cfg.cols, trie: colTrie, M, keepM: agg.cf.keepM, sigmaAny, size: cfg.colWidth, cfg,
    cmpFor: (level, e) => rankCompare(e, colTrie, M),
  });

  // Row siblings: sort keys (by a column's values, or a level's names), then natural order.
  const sortKeys = (query.sort ?? []).map((s) => ({ ...s, dir: s.direction === 'desc' ? -1 : 1 }));
  const valueCmp = (key) => {
    const c = key.column;
    if (c === undefined || c < 0 || c >= colAxis.itemReal.length) return null;
    const cReal = colAxis.itemReal[c], cM = colAxis.itemM[c];
    const memo = new Map();
    const val = (item) => {
      const m = item.m >= 0 ? item.m : cM;
      if (m < 0) return null;
      const k = item.real * 64 + m;
      if (memo.has(k)) return memo.get(k);
      const v = stat(item.real, cReal, m);
      memo.set(k, v);
      return v;
    };
    return (a, b) => {
      const x = val(a), y = val(b);
      if (x === null) return y === null ? 0 : 1;
      if (y === null) return -1;
      return (x - y) * key.dir;
    };
  };
  const rowCmpFor = (level, e) => {
    const chain = [];
    for (const k of sortKeys) {
      if (k.level !== undefined) {
        if (k.level !== level) continue;
        const base = rankCompare(e, rowTrie, M);
        if (base) chain.push((a, b) => base(a, b) * k.dir);
      } else {
        const vc = valueCmp(k);
        if (vc) chain.push(vc);
      }
    }
    const natural = rankCompare(e, rowTrie, M);
    if (natural) chain.push(natural);
    if (!chain.length) return null;
    return (a, b) => {
      for (const c of chain) { const r = c(a, b); if (r) return r; }
      return 0;
    };
  };
  const rowAxis = buildAxis({ shape: rowShape, dims: cfg.rows, trie: rowTrie, M, keepM: agg.rf.keepM, sigmaAny, size: cfg.rowHeight, cfg, cmpFor: rowCmpFor });
  const disp = { sig, agg, rowAxis, colAxis, buildMs: performance.now() - t };
  return lruSet(caches.disp, sig, disp, 3);
}

function cellValue(disp, r, c) {
  const { rowAxis: ra, colAxis: ca, agg } = disp;
  if (r >= ra.itemReal.length || c >= ca.itemReal.length) return null;
  const m = ra.itemM[r] >= 0 ? ra.itemM[r] : ca.itemM[c];
  if (m < 0) return null;
  return agg.stat(ra.itemReal[r], ca.itemReal[c], m);
}

function pivotLayout({ cfg, query }, id) {
  const disp = buildDisplay(cfg, query, id);
  const { rowAxis, colAxis, agg } = disp;
  const sigmaAxis = cfg.cols.includes(SIGMA) ? 'cols' : cfg.rows.includes(SIGMA) ? 'rows' : null;
  return {
    type: 'pivot',
    rows: rowAxis.spec,
    cols: colAxis.spec,
    rowMaps: rowAxis.maps,
    colMaps: colAxis.maps,
    info: {
      matched: agg.matched,
      rowItems: rowAxis.itemReal.length,
      colItems: colAxis.itemReal.length,
      rowLeaves: rowAxis.leafCount,
      colLeaves: colAxis.leafCount,
      slots: agg.slots,
      aggBytes: agg.bytes,
      timing: { ...agg.timing, treeMs: disp.buildMs },
      cached: lastAggHit,
      measures: agg.M.map(measureLabel),
      ranges: agg.ranges,
      sigmaAxis,
      rowKind: rowAxis.itemKind,
      colKind: colAxis.itemKind,
      rowM: rowAxis.itemM,
      colM: colAxis.itemM,
    },
  };
}

function pivotCells({ cfg, query, rects }, id) {
  const disp = buildDisplay(cfg, query, id);
  return rects.map(([r0, c0, nr, nc]) => {
    const out = new Array(nr * nc);
    let k = 0;
    for (let r = r0; r < r0 + nr; r++) for (let c = c0; c < c0 + nc; c++) out[k++] = cellValue(disp, r, c);
    return out;
  });
}

function pivotLabels({ cfg, query, axis, level, start, count }, id) {
  const disp = buildDisplay(cfg, query, id);
  const ax = axis === 'rows' ? disp.rowAxis : disp.colAxis;
  const out = [];
  for (let i = start; i < start + count; i++) out.push(ax.label(level, i));
  return out;
}

function pivotValues({ cfg, axis, level, search, limit }) {
  const shape = axisShape(axis === 'rows' ? cfg.rows : cfg.cols);
  const e = entryAt(shape, level);
  if (e === undefined || e < SIGMA) return { values: [], total: 0, matches: 0 };
  if (e === SIGMA) {
    const labels = measuresOf(cfg).map(measureLabel);
    const q = (search ?? '').toLowerCase();
    const values = labels.filter((s) => s.toLowerCase().includes(q));
    return { values: values.slice(0, limit), total: labels.length, matches: values.length };
  }
  return valuesOf(ds.fields[e], search, limit);
}

/** Records behind one pivot cell (drill-through), with the current filters. */
function drill({ cfg, query, row, col, limit = 500 }, id) {
  const disp = buildDisplay(cfg, query, id);
  const { agg, rowAxis, colAxis } = disp;
  const rNode = rowAxis.itemReal[row], cNode = colAxis.itemReal[col];
  const pathOf = (trie, node) => {
    const p = [];
    for (let x = node; x > 0; x = trie.parent[x]) p.push([trie.depth[x] - 1, trie.code[x]]);
    return p.reverse().map(([d, code]) => ({ codes: ds.fields[trie.dims[d]].codes, code, field: trie.dims[d] }));
  };
  const conds = [...pathOf(agg.rowTrie, rNode), ...pathOf(agg.colTrie, cNode)];
  const out = [];
  let total = 0;
  for (let r = 0; r < ds.n; r++) {
    if (agg.recR[r] < 0) continue;
    let ok = true;
    for (const c of conds) if (c.codes[r] !== c.code) { ok = false; break; }
    if (!ok) continue;
    total++;
    if (out.length < limit) {
      const obj = {};
      for (const f of ds.fields) obj[f.key] = cellOut(f, r);
      out.push(obj);
    }
  }
  const m = rowAxis.itemM[row] >= 0 ? rowAxis.itemM[row] : colAxis.itemM[col];
  return {
    total,
    rows: out,
    path: conds.map((c) => `${ds.fields[c.field].name}: ${ds.fields[c.field].dict[c.code]}`),
    measure: m >= 0 ? measureLabel(agg.M[m]) : null,
    value: cellValue(disp, row, col),
  };
}

// ------------------------------------------------------------------ virtual (procedural) data

// The repository's reference backend (demo-backend.mjs): every cell is computed from its row and column
// number, so a billion rows by a million columns costs no memory. It is loaded once, with its package
// import pointed at the built grid-core next to it, and answers the reference HTTP protocol.
let backend = null;
const cancelledIds = new Set();
function loadBackend() {
  backend ??= (async () => {
    const root = new URL('../../', self.location.href);
    const res = await fetch(new URL('demo-backend.mjs', root));
    if (!res.ok) throw new Error(`could not load demo-backend.mjs (HTTP ${res.status}): run the playground with npm start`);
    const core = new URL('packages/grid-core/dist/index.js', root).href;
    const src = (await res.text()).replace(/from\s+['"]@borealjs\/grid-core['"]/, `from '${core}'`);
    return import(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  })();
  return backend;
}

async function virtualApi({ href, method = 'GET', body }, id) {
  const { handleApiRequest } = await loadBackend();
  let out;
  try {
    out = await handleApiRequest({
      url: new URL(href, self.location.href),
      method,
      readBody: async () => JSON.parse(body ?? 'null'),
      cancelled: () => cancelledIds.has(id),
    });
  } catch (err) {
    if (!err.status || err.status >= 500) throw err;
    out = { status: err.status, body: { error: err.message } };
  }
  if (!out) out = { status: 499, body: { error: 'cancelled' } };
  return out;
}

// ------------------------------------------------------------------ dispatch

const OPS = {
  generate, parseCsv, getRows, indexOfRow, tableValues,
  pivotLayout, pivotCells, pivotLabels, pivotValues, drill, virtualApi,
  loadVirtual: async () => { const t0 = performance.now(); await loadBackend(); return { ms: performance.now() - t0 }; },
  info: () => (ds ? datasetInfo() : null),
};
const NO_DATASET = new Set(['generate', 'parseCsv', 'info', 'virtualApi', 'loadVirtual']);
// Responses whose size is measured as a JSON payload (what a real server would send).
const MEASURED = new Set(['getRows', 'indexOfRow', 'tableValues', 'pivotLayout', 'pivotCells', 'pivotLabels', 'pivotValues', 'drill', 'virtualApi']);

self.onmessage = async (e) => {
  const { id, op, args } = e.data;
  if (op === 'abort') { cancelledIds.add(args.id); return; }
  const t0 = performance.now();
  try {
    if (!OPS[op]) throw new Error(`unknown op ${op}`);
    if (!NO_DATASET.has(op) && !ds) throw new Error('no dataset loaded');
    const result = await OPS[op](args ?? {}, id);
    const serverMs = performance.now() - t0;
    let bytes = 0;
    if (MEASURED.has(op)) {
      const info = result?.info;
      if (op === 'virtualApi') bytes = JSON.stringify(result.body).length;
      else if (info) {
        // Typed per-item arrays are for the page's styling, not part of the protocol payload.
        const { rowKind, colKind, rowM, colM, ...rest } = info;
        bytes = JSON.stringify({ ...result, info: rest }).length;
      } else bytes = JSON.stringify(result).length;
    }
    self.postMessage({ id, ok: true, result, serverMs, bytes });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message ?? err), serverMs: performance.now() - t0 });
  } finally {
    cancelledIds.delete(id);
  }
};
