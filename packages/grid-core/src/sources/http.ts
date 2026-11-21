// The reference HTTP protocol (see server.mjs and demo-backend.mjs in the repository):
//   GET  {baseUrl}/meta?sort&filter&colfilter                 -> table: { rows, totalRows, cols, … }
//                                                               pivot: { mode: 'pivot', rows, cols, rowMaps?, colMaps? }
//   GET  {baseUrl}/block?r0&c0&nr&nc&sort&filter&colfilter    -> { cells (row-major), merges }
//   POST {baseUrl}/gather?sort&filter&colfilter  { rects }     -> { cells: [row-major per rect], merges }
//   GET  {baseUrl}/labels?axis&level&from&n&…                 -> { names }
//   GET  {baseUrl}/values?axis&level&q&limit                  -> { total, matches, values }
//   GET  {baseUrl}/progress?sort&filter&colfilter (optional)  -> { active, phase, done, total } while /meta works
//   GET  {baseUrl}/find?ids&sort&filter (optional)            -> { positions } (row ids -> positions, -1 = not in view)
//   GET  {baseUrl}/columns?from&n&colfilter (optional)       -> { columns: ColumnDescription[] } (meta says columns: true)
//   GET  {baseUrl}/values?axis=cols&level=0&q&limit           -> column groups, for the column chooser of described tables
//   block / gather responses may carry rowIds (per rect for gather): the id of each row, for /find.

import { columnFilterFromPublic, filterFromPublic } from '../query.js';
import type { ColumnDescription, ColumnFilterItem, DataSource, FilterItem, Layout, Merge, Query, RowId, SortItem } from '../types.js';

export interface HttpSourceOptions {
  /** Default '/api'. */
  baseUrl?: string;
  /** Added to every request (e.g. { mode: 'pivot', latency: 40 }). */
  params?: Record<string, string | number | boolean | undefined | null>;
  /** Another fetch implementation (tests, auth wrappers, an in-browser backend). */
  fetch?: typeof fetch;
  headers?: Record<string, string>;
}

/** A /meta response. */
interface Meta {
  mode?: string;
  rows: number;
  totalRows?: number;
  cols: number;
  sort?: { multiMaxRows?: number };
  filter?: { maxRows?: number };
  [extra: string]: unknown;
}

const PROGRESS_FIRST_MS = 300;
const PROGRESS_EVERY_MS = 500;
/** Row ids remembered per sort + filter (positions on or near the screen). */
const MAX_IDS_PER_VIEW = 50_000;
const MAX_ID_VIEWS = 6;
const FIND_BATCH = 500;

const sortParam = (sort: readonly SortItem[]) =>
  sort.map((s) => {
    const loose = s as { level?: number; column?: number; direction: string };
    return `${loose.level !== undefined ? `L${loose.level}` : loose.column}:${loose.direction === 'desc' ? 'd' : 'a'}`;
  }).join(',');

const filterParam = (list: readonly FilterItem[]) => {
  if (!list.length) return '';
  const conds = filterFromPublic(list);
  return JSON.stringify(conds.sort((a, b) => (a.dim ?? -1) - (b.dim ?? -1) || (a.c ?? -1) - (b.c ?? -1)));
};

const columnFilterParam = (list: readonly ColumnFilterItem[]) =>
  (list.length ? JSON.stringify(columnFilterFromPublic(list).sort((a, b) => a.dim! - b.dim!)) : '');

/** A data source speaking the reference HTTP protocol. `fetch` and `headers` let you add auth. */
export function createHttpSource({ baseUrl = '/api', params = {}, fetch: fetchImpl = globalThis.fetch.bind(globalThis), headers = {} }: HttpSourceOptions = {}): DataSource<string> {
  const base = baseUrl.replace(/\/$/, '');
  let progressSupported = true;
  let findSupported = true;
  // Row ids the server sent with the cells: "sort|filter" -> position -> id (LRU, bounded).
  const ids = new Map<string, Map<number, RowId>>();
  const sigOf = (q: Query) => `${sortParam(q.sort)}|${filterParam(q.filter)}`;
  const rememberIds = (query: Query, r0: number, list: unknown) => {
    if (!Array.isArray(list)) return;
    const sig = sigOf(query);
    let m = ids.get(sig);
    if (m) ids.delete(sig);
    else m = new Map();
    ids.set(sig, m);
    while (ids.size > MAX_ID_VIEWS) ids.delete(ids.keys().next().value as string);
    for (let i = 0; i < list.length; i++) {
      m.delete(r0 + i);
      m.set(r0 + i, list[i] as RowId);
    }
    while (m.size > MAX_IDS_PER_VIEW) m.delete(m.keys().next().value as number);
  };
  // Lookups asked for in the same tick go out as one /find request per sort + filter.
  const finds = new Map<string, { query: Query; waiting: Map<RowId, ((p: number | null) => void)[]> }>();
  const flushFinds = async (sig: string) => {
    const batch = finds.get(sig);
    finds.delete(sig);
    if (!batch) return;
    const list = [...batch.waiting.keys()];
    for (let i = 0; i < list.length; i += FIND_BATCH) {
      const part = list.slice(i, i + FIND_BATCH);
      let positions: (number | null)[] = part.map(() => null);
      if (findSupported) {
        try {
          const res = await fetchImpl(url('find', { ids: part.join(',') }, batch.query), { headers });
          if (res.status === 404) findSupported = false;
          else if (res.ok) positions = ((await res.json()) as { positions: number[] }).positions;
        } catch {
          // cannot tell
        }
      }
      part.forEach((id, k) => { for (const done of batch.waiting.get(id) ?? []) done(typeof positions[k] === 'number' ? positions[k] : null); });
    }
  };
  const url = (path: string, query: Record<string, string | number>, view?: Partial<Query>) => {
    const qs = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]));
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
  const getJson = async <T>(href: string, init?: RequestInit): Promise<T> => {
    const res = await fetchImpl(href, { ...init, headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) } });
    if (!res.ok) {
      let reason = `HTTP ${res.status}`;
      try {
        reason = ((await res.json()) as { error?: string }).error ?? reason;
      } catch {
        // keep the status text
      }
      throw new Error(reason);
    }
    return res.json() as Promise<T>;
  };
  return {
    maxRectsPerRequest: 400,
    maxCellsPerRequest: 20_000,
    async getLayout({ query, signal, onProgress }): Promise<Layout> {
      // While the server sorts or filters, ask it how far it is ({base}/progress, same parameters).
      // A server without that endpoint answers 404 once and is not asked again.
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const poll = async () => {
        try {
          const res = await fetchImpl(url('progress', {}, query), { signal, headers });
          if (res.status === 404) progressSupported = false;
          else if (res.ok) {
            const p = (await res.json()) as { active?: boolean; phase?: string; done?: number; total?: number };
            if (p.active && !done) onProgress!({ phase: p.phase, done: p.done, total: p.total });
          }
        } catch {
          // progress is optional
        }
        if (!done && progressSupported && !signal?.aborted) timer = setTimeout(poll, PROGRESS_EVERY_MS);
      };
      if (onProgress && progressSupported) timer = setTimeout(poll, PROGRESS_FIRST_MS);
      let meta: Meta;
      try {
        meta = await getJson<Meta>(url('meta', {}, query), { signal });
      } finally {
        done = true;
        clearTimeout(timer);
      }
      if (meta.mode === 'pivot') return { type: 'pivot', ...meta } as unknown as Layout;
      return {
        type: 'table',
        rowCount: meta.rows,
        totalRowCount: meta.totalRows ?? meta.rows,
        columnCount: meta.cols,
        describedColumns: meta.columns === true, // the server describes columns on demand (/columns)
        maxSortRows: meta.sort?.multiMaxRows,
        maxFilterRows: meta.filter?.maxRows,
        meta,
      };
    },
    async getCells({ rects, query, signal }) {
      if (rects.length === 1) {
        const { row, col, rowCount, colCount } = rects[0];
        const res = await getJson<{ cells: string[]; merges?: Merge[]; rowIds?: RowId[] }>(url('block', { r0: row, c0: col, nr: rowCount, nc: colCount }, query), { signal });
        rememberIds(query, row, res.rowIds);
        return { cells: [res.cells], merges: res.merges };
      }
      const res = await getJson<{ cells: string[][]; merges?: Merge[]; rowIds?: RowId[][] }>(url('gather', {}, query), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rects: rects.map((r) => [r.row, r.col, r.rowCount, r.colCount]) }),
        signal,
      });
      res.rowIds?.forEach((list, i) => rememberIds(query, rects[i].row, list));
      return { cells: res.cells, merges: res.merges };
    },
    async getColumns({ start, count, query, signal }) {
      const res = await getJson<{ columns: ColumnDescription[] }>(url('columns', { from: start, n: count }, { columnFilter: query.columnFilter }), { signal });
      return res.columns;
    },
    rowIdAt(position, query) {
      return ids.get(sigOf(query))?.get(position);
    },
    indexOfRow(id, query) {
      if (!findSupported) return null;
      const sig = sigOf(query);
      let batch = finds.get(sig);
      if (!batch) {
        batch = { query, waiting: new Map() };
        finds.set(sig, batch);
        queueMicrotask(() => void flushFinds(sig));
      }
      const waiting = batch.waiting;
      return new Promise<number | null>((resolve) => {
        const list = waiting.get(id) ?? [];
        list.push(resolve);
        waiting.set(id, list);
      });
    },
    clearCache() {
      ids.clear();
    },
    async getLabels({ axis, level, start, count, query, signal }) {
      const res = await getJson<{ names: string[] }>(url('labels', { axis, level, from: start, n: count }, query), { signal });
      return res.names;
    },
    async getFilterValues({ axis, level, search, limit, signal }) {
      if (axis === undefined) throw new Error('this server lists values for pivot dimensions only');
      return getJson(url('values', { axis, level: level ?? 0, q: search ?? '', limit: limit ?? 1000 }), { signal });
    },
  };
}
