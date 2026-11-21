// The reference HTTP protocol (see server.mjs and demo-backend.mjs in the repository):
//   GET  {baseUrl}/meta?sort&filter&colfilter                 -> table: { rows, totalRows, cols, … }
//                                                               pivot: { mode: 'pivot', rows, cols, rowMaps?, colMaps? }
//   GET  {baseUrl}/block?r0&c0&nr&nc&sort&filter&colfilter    -> { cells (row-major), merges }
//   POST {baseUrl}/gather?sort&filter&colfilter  { rects }     -> { cells: [row-major per rect], merges }
//   GET  {baseUrl}/labels?axis&level&from&n&…                 -> { names }
//   GET  {baseUrl}/values?axis&level&q&limit                  -> { total, matches, values }
//   GET  {baseUrl}/progress?sort&filter&colfilter (optional)  -> { active, phase, done, total } while /meta works

import { columnFilterFromPublic, filterFromPublic } from '../query.js';
import type { ColumnFilterItem, DataSource, FilterItem, Layout, Merge, Query, SortItem } from '../types.js';

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
        maxSortRows: meta.sort?.multiMaxRows,
        maxFilterRows: meta.filter?.maxRows,
        meta,
      };
    },
    async getCells({ rects, query, signal }) {
      if (rects.length === 1) {
        const { row, col, rowCount, colCount } = rects[0];
        const res = await getJson<{ cells: string[]; merges?: Merge[] }>(url('block', { r0: row, c0: col, nr: rowCount, nc: colCount }, query), { signal });
        return { cells: [res.cells], merges: res.merges };
      }
      const res = await getJson<{ cells: string[][]; merges?: Merge[] }>(url('gather', {}, query), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rects: rects.map((r) => [r.row, r.col, r.rowCount, r.colCount]) }),
        signal,
      });
      return { cells: res.cells, merges: res.merges };
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
