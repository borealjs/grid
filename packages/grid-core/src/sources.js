// Ready-made data sources.
//
//   createArraySource(rows, { columns })   in-memory rows (objects or arrays): sorting, filtering and
//                                          value lists done in the browser
//   createHttpSource({ baseUrl })          the reference HTTP protocol (see server.mjs in the repo):
//                                          GET meta / block / labels / values, POST gather
//
// A data source is any object with getCells (required) and optionally getLayout, getLabels and
// getFilterValues; see index.d.ts for the exact shapes.

import { filterFromPublic, columnFilterFromPublic } from './query.js';

// ------------------------------------------------------------------ in-memory

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

const isoDay = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

/** Compares two cell values: numbers and dates by value, text naturally ("Item 2" < "Item 10"), empty last. */
export function compareValues(a, b) {
  const ea = a === null || a === undefined || a === '';
  const eb = b === null || b === undefined || b === '';
  if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b ? 0 : a ? 1 : -1;
  return collator.compare(String(a), String(b));
}

/**
 * Rows held in memory. `columns` maps column indexes to values: column definitions (`value(row)` or
 * `key`), or plain keys / indexes. Without it, the keys of the first row (objects) or the positions
 * (arrays) are used. `filterFns` adds custom filter operators: { [op]: (cellValue, conditionValue, row) => boolean }.
 * Call setRows(newRows) and then grid.refresh() when the data changes.
 */
export function createArraySource(rows, { columns, filterFns = {}, compare = compareValues } = {}) {
  let data = rows;
  let accessors = [];
  let comparers = [];
  const setColumns = () => {
    const list = columns ?? (data.length && !Array.isArray(data[0]) ? Object.keys(data[0]) : Array.from({ length: data[0]?.length ?? 0 }, (_, i) => i));
    accessors = list.map((d, i) => {
      if (typeof d === 'string' || typeof d === 'number') return (row) => row?.[d];
      if (typeof d?.value === 'function') return d.value;
      if (d?.key !== undefined) return (row) => row?.[d.key];
      return (row) => (Array.isArray(row) ? row[i] : undefined);
    });
    comparers = list.map((d) => (typeof d?.compare === 'function' ? d.compare : compare));
  };
  setColumns();
  const views = new Map(); // query signature -> Uint32Array of row indexes (null = all rows in order)
  const distinct = new Map(); // column -> sorted distinct texts

  function test(cond) {
    const get = accessors[cond.c];
    if (!get) throw new Error(`filter: no column ${cond.c}`);
    if (cond.op === 'range') {
      const dates = typeof (cond.min ?? cond.max) === 'string';
      const lo = cond.min;
      const hi = cond.max;
      return (row) => {
        let v = get(row);
        if (v === null || v === undefined || v === '') return false;
        if (dates) v = isoDay(v);
        return (lo === undefined || v >= lo) && (hi === undefined || v <= hi);
      };
    }
    if (cond.op === 'in' || cond.op === 'notin') {
      const set = new Set(cond.v);
      const want = cond.op === 'in';
      return (row) => set.has(String(get(row) ?? '')) === want;
    }
    if (cond.op === 'contains') {
      const needle = String(cond.v).toLowerCase();
      return (row) => String(get(row) ?? '').toLowerCase().includes(needle);
    }
    const fn = filterFns[cond.op];
    if (!fn) throw new Error(`filter: no filter function for op "${cond.op}" (pass it in filterFns)`);
    return (row) => fn(get(row), cond.v, row);
  }

  function view(query) {
    const sort = query?.sort ?? [];
    const filter = query?.filter ?? [];
    if (!sort.length && !filter.length) return null;
    const sig = JSON.stringify([sort, filter]);
    let idx = views.get(sig);
    if (idx) {
      views.delete(sig);
      views.set(sig, idx);
      return idx;
    }
    const conds = filterFromPublic(filter).filter((f) => f.c !== undefined);
    const tests = conds.map(test);
    let out = new Uint32Array(data.length);
    let n = 0;
    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      if (tests.every((t) => t(row))) out[n++] = i;
    }
    out = out.slice(0, n);
    const keys = sort.filter((s) => s.column !== undefined && accessors[s.column]);
    if (keys.length) {
      // Extract each key column once, then sort the row indexes (stable: ties keep row order).
      const cols = keys.map((s) => {
        const get = accessors[s.column];
        const values = new Array(data.length);
        for (const i of out) values[i] = get(data[i]);
        return { values, cmp: comparers[s.column], desc: s.direction === 'desc' };
      });
      const arr = Array.from(out);
      const empty = (v) => v === null || v === undefined || v === '';
      arr.sort((a, b) => {
        for (const { values, cmp, desc } of cols) {
          const va = values[a];
          const vb = values[b];
          // Empty values stay last in both directions.
          const ea = empty(va);
          const eb = empty(vb);
          if (ea || eb) {
            if (ea !== eb) return ea ? 1 : -1;
            continue;
          }
          const d = cmp(va, vb);
          if (d !== 0) return desc ? -d : d;
        }
        return a - b;
      });
      out = Uint32Array.from(arr);
    }
    views.set(sig, out);
    while (views.size > 4) views.delete(views.keys().next().value);
    return out;
  }

  return {
    maxRectsPerRequest: 1000,
    maxCellsPerRequest: 200_000,
    get rows() { return data; },
    setRows(next) {
      data = next;
      if (!columns) setColumns();
      views.clear();
      distinct.clear();
    },
    /** The row object at a position of the sorted / filtered view (synchronous; for cell renderers). */
    rowAt(position, query) {
      const idx = view(query);
      return data[idx ? idx[position] : position];
    },
    async getLayout({ query }) {
      const idx = view(query);
      return { rowCount: idx ? idx.length : data.length, totalRowCount: data.length, columnCount: accessors.length };
    },
    async getCells({ rects, query }) {
      const idx = view(query);
      return rects.map(({ row, col, rowCount, colCount }) => {
        const out = new Array(rowCount);
        for (let i = 0; i < rowCount; i++) {
          const r = idx ? idx[row + i] : row + i;
          const item = data[r];
          const line = new Array(colCount);
          for (let j = 0; j < colCount; j++) line[j] = item === undefined ? null : accessors[col + j]?.(item) ?? null;
          out[i] = line;
        }
        return out;
      });
    },
    async getFilterValues({ column, search = '', limit = 1000 }) {
      let all = distinct.get(column);
      if (!all) {
        const get = accessors[column];
        const set = new Set();
        for (const row of data) {
          const v = get?.(row);
          if (v !== null && v !== undefined && v !== '') set.add(String(v));
        }
        all = [...set].sort(collator.compare);
        distinct.set(column, all);
      }
      const needle = search.trim().toLowerCase();
      const matching = needle ? all.filter((v) => v.toLowerCase().includes(needle)) : all;
      return { total: all.length, matches: matching.length, values: matching.slice(0, limit) };
    },
  };
}

// ------------------------------------------------------------------ HTTP (reference protocol)

const sortParam = (sort) => sort.map((s) => `${s.level !== undefined ? `L${s.level}` : s.column}:${s.direction === 'desc' ? 'd' : 'a'}`).join(',');

const filterParam = (list) => {
  if (!list.length) return '';
  const conds = filterFromPublic(list);
  return JSON.stringify(conds.sort((a, b) => (a.dim ?? -1) - (b.dim ?? -1) || (a.c ?? -1) - (b.c ?? -1)));
};

const columnFilterParam = (list) => (list.length ? JSON.stringify(columnFilterFromPublic(list).sort((a, b) => a.dim - b.dim)) : '');

/**
 * The reference HTTP protocol. `params` are added to every request (e.g. { mode: 'pivot', latency: 40 });
 * `fetch` and `headers` let you add auth or use another fetch implementation.
 *   GET  {baseUrl}/meta?sort&filter&colfilter                 -> table: { rows, totalRows, cols, … }
 *                                                               pivot: { mode: 'pivot', rows, cols, rowMaps?, colMaps? }
 *   GET  {baseUrl}/block?r0&c0&nr&nc&sort&filter&colfilter    -> { cells (row-major), merges }
 *   POST {baseUrl}/gather?sort&filter&colfilter  { rects }     -> { cells: [row-major per rect], merges }
 *   GET  {baseUrl}/labels?axis&level&from&n&…                 -> { names }
 *   GET  {baseUrl}/values?axis&level&q&limit                  -> { total, matches, values }
 *   GET  {baseUrl}/progress?sort&filter&colfilter (optional)  -> { active, phase, done, total } while /meta works
 */
export function createHttpSource({ baseUrl = '/api', params = {}, fetch: fetchImpl = globalThis.fetch.bind(globalThis), headers = {} } = {}) {
  const base = baseUrl.replace(/\/$/, '');
  let progressSupported = true;
  const url = (path, query, view) => {
    const qs = new URLSearchParams(query);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) qs.set(k, String(v));
    if (view) {
      const s = sortParam(view.sort ?? []);
      const f = filterParam(view.filter ?? []);
      const cf = columnFilterParam(view.columnFilter ?? []);
      if (s) qs.set('sort', s);
      if (f) qs.set('filter', f);
      if (cf) qs.set('colfilter', cf);
    }
    return `${base}/${path}?${qs}`;
  };
  const getJson = async (href, init) => {
    const res = await fetchImpl(href, { ...init, headers: { ...headers, ...init?.headers } });
    if (!res.ok) {
      let reason = `HTTP ${res.status}`;
      try {
        reason = (await res.json()).error ?? reason;
      } catch {
        // keep the status text
      }
      throw new Error(reason);
    }
    return res.json();
  };
  return {
    maxRectsPerRequest: 400,
    maxCellsPerRequest: 20_000,
    async getLayout({ query, signal, onProgress }) {
      // While the server sorts or filters, ask it how far it is ({base}/progress, same parameters).
      // A server without that endpoint answers 404 once and is not asked again.
      let done = false;
      let timer = 0;
      const poll = async () => {
        try {
          const res = await fetchImpl(url('progress', {}, query), { signal, headers });
          if (res.status === 404) progressSupported = false;
          else if (res.ok) {
            const p = await res.json();
            if (p.active && !done) onProgress({ phase: p.phase, done: p.done, total: p.total });
          }
        } catch {
          // progress is optional
        }
        if (!done && progressSupported && !signal?.aborted) timer = setTimeout(poll, 500);
      };
      if (onProgress && progressSupported) timer = setTimeout(poll, 300);
      let meta;
      try {
        meta = await getJson(url('meta', {}, query), { signal });
      } finally {
        done = true;
        clearTimeout(timer);
      }
      if (meta.mode === 'pivot') return { type: 'pivot', ...meta };
      return {
        type: 'table',
        rowCount: meta.rows,
        totalRowCount: meta.totalRows ?? meta.rows,
        columnCount: meta.cols,
        maxSortRows: meta.sort?.multiMaxRows,
        maxFilterRows: meta.filter?.maxRows,
        meta,
      };
    },
    async getCells({ rects, query, signal }) {
      if (rects.length === 1) {
        const { row, col, rowCount, colCount } = rects[0];
        const res = await getJson(url('block', { r0: row, c0: col, nr: rowCount, nc: colCount }, query), { signal });
        return { cells: [res.cells], merges: res.merges };
      }
      const res = await getJson(url('gather', {}, query), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rects: rects.map((r) => [r.row, r.col, r.rowCount, r.colCount]) }),
        signal,
      });
      return { cells: res.cells, merges: res.merges };
    },
    async getLabels({ axis, level, start, count, query, signal }) {
      const res = await getJson(url('labels', { axis, level, from: start, n: count }, query), { signal });
      return res.names;
    },
    async getFilterValues({ axis, level, search, limit, signal }) {
      if (axis === undefined) throw new Error('this server lists values for pivot dimensions only');
      return getJson(url('values', { axis, level, q: search ?? '', limit: limit ?? 1000 }), { signal });
    },
  };
}
