// Live databases for the playground's table view: the public ClickHouse playground (SQL over HTTP) and
// NYC Open Data (Socrata's SoQL API). Both are called straight from the browser (they allow it with CORS)
// and only read public data. Each provider turns the grid's requests into its own query language:
//   getRows({ offset, limit, sort, filter })  ->  ORDER BY / WHERE / LIMIT / OFFSET
//   getFilterValues({ key, search })          ->  the column's distinct values
// `track(kind, detail, run, signal)` is the page's network wrapper: it adds simulated latency and records
// metrics; `run(signal)` resolves with { result, serverMs, bytes, query }.

const VALUES_LIMIT = 1000;

// No client-side timeout: a query runs until the grid cancels it or the database gives up (and says why).
async function fetchText(url, init) {
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    if (init?.signal?.aborted) throw err;
    throw new Error(`Could not reach ${new URL(url).host}: ${err.message}`);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(errorText(text) || `HTTP ${res.status}`);
  return text;
}

function errorText(text) {
  try {
    const j = JSON.parse(text);
    return j.message || j.error?.message || (typeof j.error === 'string' ? j.error : '');
  } catch {
    // ClickHouse errors are plain text: "Code: 159. DB::Exception: Timeout exceeded: …"
    return text.replace(/\s*\(version [^)]*\)\s*$/, '').slice(0, 300);
  }
}

// ================================================================== ClickHouse playground

const CH_URL = 'https://play.clickhouse.com/?user=explorer';

export const CLICKHOUSE_TABLES = [
  { table: 'uk_price_paid', label: 'UK property sales', note: '31M rows', pivot: { rows: ['county', 'district'], cols: ['date · year'], values: [['price', 'sum'], ['price', 'count']] } },
  { table: 'opensky', label: 'OpenSky flights', note: '66M rows' },
  { table: 'hits', label: 'Web analytics hits', note: '100M rows · 100+ columns' },
  { table: 'ontime', label: 'US flight delays', note: '205M rows · 100+ columns', pivot: { rows: ['Reporting_Airline'], cols: ['Year'], values: [['DepDelay', 'avg'], ['DepDelay', 'count']] } },
  { table: 'pypi', label: 'PyPI package files', note: '1B rows · deep jumps slow' },
  { table: 'trips', label: 'NYC taxi trips', note: '3.5B rows · deep jumps slow', pivot: { rows: ['cab_type'], cols: ['pickup_date · year'], values: [['total_amount', 'sum'], ['trip_distance', 'avg']] } },
  { table: 'github_events', label: 'GitHub events', note: '11B rows · deep jumps slow' },
];

export const chId = (name) => `\`${String(name).replace(/\\/g, '\\\\').replace(/`/g, '\\`')}\``;
export const chStr = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const chNum = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`not a number: ${v}`);
  return String(n);
};

/** One ClickHouse query over HTTP: { json, serverMs (the database's own time), bytes }. */
export async function chQuery(sql, signal) {
  const t0 = performance.now();
  // The playground's user is read-only: it may pick the output format but change no other setting
  // (its own limits apply: 60 s per query, 1M result rows).
  const url = `${CH_URL}&default_format=JSONCompact`;
  const text = await fetchText(url, { method: 'POST', body: sql, signal });
  const json = JSON.parse(text);
  const serverMs = json.statistics?.elapsed != null ? json.statistics.elapsed * 1000 : performance.now() - t0;
  return { json, serverMs, bytes: text.length };
}

/** What the grid needs to know about a ClickHouse type. */
function chKind(type) {
  const t = type.replace(/^Nullable\((.*)\)$/, '$1').replace(/^LowCardinality\((.*)\)$/, '$1');
  if (/^(U?Int\d+|Float\d+|Decimal)/.test(t)) return { kind: 'number' };
  if (/^Date(Time)?(64)?/.test(t)) return { kind: 'date' };
  if (/^Enum(8|16)\(/.test(t)) {
    const values = [...t.matchAll(/'((?:[^'\\]|\\.)*)'\s*=\s*-?\d+/g)].map((m) => m[1].replace(/\\'/g, "'"));
    return { kind: 'values', values };
  }
  if (/^Bool/.test(type)) return { kind: 'values', values: ['true', 'false'] };
  if (/^(Array|Map|Tuple|Nested|JSON|Object|IPv|UUID|Point|Ring|Polygon|MultiPolygon)/.test(t)) return { kind: 'complex' };
  if (/^LowCardinality/.test(type.replace(/^Nullable\(/, ''))) return { kind: 'values' };
  return { kind: 'text', lists: true };
}

export function createClickHouse({ table, track }) {
  let schema = null;
  const counts = new Map();

  const query = chQuery;

  function whereOf(filter) {
    const parts = [];
    for (const f of filter ?? []) {
      const col = schema.byKey.get(f.key);
      if (!col) continue;
      const id = chId(col.name);
      if (f.op === 'range') {
        if (col.kind === 'date') {
          if (f.min != null && f.min !== '') parts.push(`toDate(${id}) >= toDate(${chStr(f.min)})`);
          if (f.max != null && f.max !== '') parts.push(`toDate(${id}) <= toDate(${chStr(f.max)})`);
        } else {
          if (f.min != null && f.min !== '') parts.push(`${id} >= ${chNum(f.min)}`);
          if (f.max != null && f.max !== '') parts.push(`${id} <= ${chNum(f.max)}`);
        }
      } else if (f.op === 'in' || f.op === 'notin') {
        const list = (f.values ?? []).map((v) => chStr(v)).join(', ') || "''";
        parts.push(`toString(${id}) ${f.op === 'in' ? 'IN' : 'NOT IN'} (${list})`);
      } else if (f.op === 'contains') {
        parts.push(`positionCaseInsensitiveUTF8(toString(${id}), ${chStr(f.text ?? '')}) > 0`);
      } else if (f.op === 'atLeast') {
        parts.push(`${id} >= ${chNum(f.value)}`); // the playground's custom filter
      }
    }
    return parts.length ? ` WHERE ${parts.join(' AND ')}` : '';
  }

  function orderOf(sort) {
    // The table's sorting key goes last so every page comes from the same order (ClickHouse reads parts
    // in parallel: without a full ORDER BY, OFFSET pages could overlap or skip rows).
    const items = (sort ?? []).map((s) => schema.byKey.get(s.key)).filter(Boolean)
      .map((col, i) => `${chId(col.name)} ${sort[i].direction === 'desc' ? 'DESC' : 'ASC'}`);
    const used = new Set((sort ?? []).map((s) => schema.byKey.get(s.key)?.name));
    for (const k of schema.sortingKey) if (!used.has(k)) items.push(chId(k));
    return items.length ? ` ORDER BY ${items.join(', ')}` : '';
  }

  return {
    provider: 'ClickHouse',
    host: 'play.clickhouse.com',
    async load() {
      const sql = `SELECT name, type, position FROM system.columns WHERE database = 'default' AND table = ${chStr(table)} ORDER BY position`;
      const meta = await track('schema', table, async (signal) => {
        const a = await query(sql, signal);
        const b = await query(`SELECT total_rows, sorting_key FROM system.tables WHERE database = 'default' AND name = ${chStr(table)}`, signal);
        return { result: { cols: a.json.data, info: b.json.data[0] }, serverMs: a.serverMs + b.serverMs, bytes: a.bytes + b.bytes, query: sql };
      });
      if (!meta.cols.length) throw new Error(`Table ${table} was not found on the ClickHouse playground`);
      const columns = meta.cols.map(([name, type], i) => ({ key: `c${i}`, name, type, ...chKind(type) }));
      schema = {
        columns,
        byKey: new Map(columns.map((c) => [c.key, c])),
        sortingKey: String(meta.info?.[1] ?? '').split(',').map((s) => s.trim()).filter((s) => /^\w+$/.test(s)),
        total: Number(meta.info?.[0] ?? 0),
      };
      counts.set('', schema.total);
      return schema;
    },
    async getRows({ offset, limit, sort, filter, signal, onProgress }) {
      const where = whereOf(filter);
      const select = schema.columns.map((c) => chId(c.name)).join(', ');
      const sql = `SELECT ${select} FROM ${chId(table)}${where}${orderOf(sort)} LIMIT ${limit} OFFSET ${offset}`;
      let total = counts.get(where);
      const countPromise = total === undefined
        ? (onProgress?.({ phase: 'Counting matching rows' }),
          track('count', where ? 'with filter' : 'all rows', async (s) => {
            const csql = `SELECT count() FROM ${chId(table)}${where}`;
            const r = await query(csql, s);
            return { result: Number(r.json.data[0][0]), serverMs: r.serverMs, bytes: r.bytes, query: csql };
          }, signal))
        : null;
      const page = await track('rows', `rows ${offset.toLocaleString('en-US')}–${(offset + limit - 1).toLocaleString('en-US')}`, async (s) => {
        const r = await query(sql, s);
        const rows = r.json.data.map((vals, i) => {
          const row = { __id: offset + i };
          schema.columns.forEach((c, j) => { row[c.key] = cleanValue(vals[j]); });
          return row;
        });
        return { result: rows, serverMs: r.serverMs, bytes: r.bytes, query: sql };
      }, signal, limit * schema.columns.length);
      if (countPromise) { total = await countPromise; counts.set(where, total); }
      return { rows: page, total, totalUnfiltered: schema.total };
    },
    async getFilterValues({ key, search, limit = VALUES_LIMIT, signal }) {
      const col = schema.byKey.get(key);
      if (col.values) {
        const q = (search ?? '').toLowerCase();
        const values = col.values.filter((v) => v.toLowerCase().includes(q));
        return { values: values.slice(0, limit), total: col.values.length, matches: values.length };
      }
      const id = chId(col.name);
      const cond = search ? ` WHERE positionCaseInsensitiveUTF8(toString(${id}), ${chStr(search)}) > 0` : '';
      const sql = `SELECT DISTINCT toString(${id}) AS v FROM ${chId(table)}${cond} ORDER BY v LIMIT ${limit + 1}`;
      return track('values', `${col.name}${search ? ` "${search}"` : ''}`, async (s) => {
        const r = await query(sql, s);
        const all = r.json.data.map((d) => d[0]);
        const values = all.slice(0, limit);
        return { result: { values, matches: all.length > limit ? limit + 1 : values.length }, serverMs: r.serverMs, bytes: r.bytes, query: sql };
      }, signal);
    },
  };
}

function cleanValue(v) {
  if (typeof v === 'string') return v.replace(/\u0000+$/, ''); // FixedString padding
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return v;
}

// ================================================================== NYC Open Data (Socrata)

const NYC = 'https://data.cityofnewyork.us';

export const NYC_DATASETS = [
  { table: 'h9gi-nx95', label: 'Motor vehicle collisions', note: '2.3M rows' },
  { table: 'qgea-i56i', label: 'NYPD complaints (historic)', note: '10M rows · slower' },
  { table: 'erm2-nwe9', label: '311 service requests', note: '23M rows · slow: seconds per page' },
];

const soqlStr = (s) => `'${String(s).replace(/'/g, "''")}'`;
const soqlId = (name) => (/^[a-z_][a-z0-9_]*$/i.test(name) ? name : `\`${name.replace(/`/g, '')}\``);

function nycKind(type) {
  if (type === 'number' || type === 'money' || type === 'percent') return { kind: 'number' };
  if (type === 'calendar_date' || type === 'date') return { kind: 'date' };
  if (type === 'checkbox') return { kind: 'values', values: ['true', 'false'] };
  if (type === 'text' || type === 'url') return { kind: 'text', lists: true };
  return { kind: 'complex' }; // location, point, polygon, …
}

export function createNycOpenData({ table, track }) {
  let schema = null;
  const counts = new Map();

  async function get(params, signal) {
    const t0 = performance.now();
    const qs = new URLSearchParams(params).toString();
    const url = `${NYC}/resource/${table}.json?${qs}`;
    const text = await fetchText(url, { signal });
    // Socrata sends no server timing: the whole round trip is the best measure.
    return { json: JSON.parse(text), ms: performance.now() - t0, bytes: text.length, query: decodeURIComponent(qs).replace(/&/g, '\n&') };
  }

  function whereOf(filter) {
    const parts = [];
    for (const f of filter ?? []) {
      const col = schema.byKey.get(f.key);
      if (!col) continue;
      const id = soqlId(col.name);
      if (f.op === 'range') {
        if (col.kind === 'date') {
          if (f.min) parts.push(`${id} >= ${soqlStr(`${f.min}T00:00:00`)}`);
          if (f.max) parts.push(`${id} <= ${soqlStr(`${f.max}T23:59:59`)}`);
        } else {
          if (f.min != null && f.min !== '' && Number.isFinite(Number(f.min))) parts.push(`${id} >= ${Number(f.min)}`);
          if (f.max != null && f.max !== '' && Number.isFinite(Number(f.max))) parts.push(`${id} <= ${Number(f.max)}`);
        }
      } else if (f.op === 'in' || f.op === 'notin') {
        const list = (f.values ?? []).map(soqlStr).join(', ') || "''";
        parts.push(`${id} ${f.op === 'in' ? 'in' : 'not in'} (${list})`);
      } else if (f.op === 'contains') {
        parts.push(`upper(${id}) like ${soqlStr(`%${String(f.text ?? '').toUpperCase()}%`)}`);
      } else if (f.op === 'atLeast' && Number.isFinite(Number(f.value))) {
        parts.push(`${id} >= ${Number(f.value)}`); // the playground's custom filter
      }
    }
    return parts.join(' AND ');
  }

  function orderOf(sort) {
    const items = (sort ?? []).map((s) => {
      const col = schema.byKey.get(s.key);
      // Empty values last in both directions, as the grid does with in-memory data.
      return col ? `${soqlId(col.name)} ${s.direction === 'desc' ? 'DESC' : 'ASC'} NULL LAST` : null;
    }).filter(Boolean);
    items.push(':id'); // a stable order, so pages never overlap
    return items.join(', ');
  }

  async function count(where, signal) {
    return track('count', where ? 'with filter' : 'all rows', async (s) => {
      const r = await get({ $select: 'count(*)', ...(where ? { $where: where } : {}) }, s);
      return { result: Number(r.json[0]?.count ?? Object.values(r.json[0] ?? {})[0] ?? 0), serverMs: null, bytes: r.bytes, query: r.query };
    }, signal);
  }

  return {
    provider: 'NYC Open Data',
    host: 'data.cityofnewyork.us',
    async load() {
      const meta = await track('schema', table, async (signal) => {
        const url = `${NYC}/api/views/${table}.json`;
        const text = await fetchText(url, { signal });
        return { result: JSON.parse(text), serverMs: null, bytes: text.length, query: `GET /api/views/${table}.json` };
      });
      const columns = meta.columns
        .filter((c) => !c.fieldName.startsWith(':'))
        .map((c, i) => ({ key: `c${i}`, name: c.fieldName, title: c.name, type: c.dataTypeName, ...nycKind(c.dataTypeName) }));
      // The metadata caches each column's null / non-null counts: the row count without a query.
      const cc = meta.columns.find((c) => !c.fieldName.startsWith(':'))?.cachedContents;
      let total = cc ? Number(cc.non_null ?? 0) + Number(cc.null ?? 0) : 0;
      schema = { columns, byKey: new Map(columns.map((c) => [c.key, c])), name: meta.name, total };
      if (!total) { total = await count('', undefined); schema.total = total; }
      counts.set('', total);
      return schema;
    },
    async getRows({ offset, limit, sort, filter, signal, onProgress }) {
      const where = whereOf(filter);
      let total = counts.get(where);
      const countPromise = total === undefined ? (onProgress?.({ phase: 'Counting matching rows' }), count(where, signal)) : null;
      const page = await track('rows', `rows ${offset.toLocaleString('en-US')}–${(offset + limit - 1).toLocaleString('en-US')}`, async (s) => {
        const params = { $select: schema.columns.map((c) => soqlId(c.name)).join(','), $order: orderOf(sort), $limit: String(limit), $offset: String(offset) };
        if (where) params.$where = where;
        const r = await get(params, s);
        const rows = r.json.map((obj, i) => {
          const row = { __id: offset + i };
          for (const c of schema.columns) {
            let v = obj[c.name];
            if (v === undefined) v = null;
            else if (c.kind === 'number') v = Number(v);
            else if (c.kind === 'date' && typeof v === 'string') v = v.replace(/T00:00:00\.000$/, '').replace(/\.000$/, '');
            else if (v !== null && typeof v === 'object') v = v.human_address ? JSON.parse(v.human_address).address || `${v.latitude}, ${v.longitude}` : JSON.stringify(v);
            row[c.key] = v;
          }
          return row;
        });
        return { result: rows, serverMs: null, bytes: r.bytes, query: r.query };
      }, signal, limit * schema.columns.length);
      if (countPromise) { total = await countPromise; counts.set(where, total); }
      return { rows: page, total, totalUnfiltered: schema.total };
    },
    async getFilterValues({ key, search, limit = VALUES_LIMIT, signal }) {
      const col = schema.byKey.get(key);
      if (col.values) return { values: col.values, total: col.values.length };
      const id = soqlId(col.name);
      return track('values', `${col.name}${search ? ` "${search}"` : ''}`, async (s) => {
        const params = { $select: id, $group: id, $order: id, $limit: String(limit + 1) };
        if (search) params.$where = `upper(${id}) like ${soqlStr(`%${search.toUpperCase()}%`)}`;
        const r = await get(params, s);
        const all = r.json.map((o) => o[col.name]).filter((v) => v != null).map(String);
        const values = all.slice(0, limit);
        return { result: { values, matches: all.length > limit ? limit + 1 : values.length }, serverMs: null, bytes: r.bytes, query: r.query };
      }, signal);
    },
  };
}
