// Rows from a backend that speaks offset / limit: the grid asks for pages of whole rows (objects or
// arrays) and reads cells from them by column key, so the server never sees column indexes. Pages are
// cached per sort + filter, which also gives cell renderers and events the row record (ctx.row).

import type { ColumnDef, DataSource, FilterValuesRequest, FilterValuesResult, GetRowsRequest, Progress, Query, RowId, RowsResult, TableLayout } from '../types.js';

type MaybePromise<T> = T | Promise<T>;

export interface RowSourceOptions<Row = any> {
  /** Rows `offset` … `offset + limit - 1` of the sorted / filtered result, and how many rows match. */
  getRows(request: GetRowsRequest): MaybePromise<RowsResult<Row>>;
  /**
   * How each column reads a row: column definitions (`value(row)` or `key`), or plain keys / indexes.
   * The grid fills this in from its own columns when you pass `{ getRows }` as the data source.
   */
  columns?: (ColumnDef<any, Row> | string | number)[];
  /** Distinct values for value-list filters. */
  getFilterValues?(request: FilterValuesRequest): MaybePromise<FilterValuesResult>;
  /**
   * Position of a row in the sorted / filtered result (-1 if it is not there). Lets the selection follow
   * a row after a sort, filter or refresh even when that row is not loaded. Optional.
   */
  indexOfRow?(id: RowId, query: Query, signal?: AbortSignal): MaybePromise<number | null>;
  /** Rows per request (default 100). */
  pageSize?: number;
  /** Pages kept in memory (default 300). */
  maxPages?: number;
}

interface Page<Row> {
  rows: Row[];
  total: number;
}

interface Pending<Row> {
  promise: Promise<Page<Row>>;
  ctrl: AbortController;
  waiters: number;
}

const accessorOf = <Row>(d: ColumnDef<any, Row> | string | number | undefined, i: number): ((row: Row) => unknown) => {
  if (typeof d === 'string' || typeof d === 'number') return (row) => (row as Record<string | number, unknown> | undefined)?.[d];
  if (typeof d?.value === 'function') return d.value;
  if (d?.key !== undefined) {
    const key = d.key;
    return (row) => (row as Record<string, unknown> | undefined)?.[key];
  }
  return (row) => (Array.isArray(row) ? row[i] : undefined);
};

/** A data source that loads whole rows by offset / limit (REST, GraphQL, SQL). */
type ColumnSpec<Row> = ColumnDef<any, Row> | string | number;

export type RowSource = DataSource & {
  /** Columns to read rows with (the grid sets them when the source has none of its own). */
  setColumns(columns: ColumnSpec<any>[] | ((index: number) => ColumnSpec<any>)): void;
  readonly hasColumns: boolean;
  /** The grid loads the first page of a new sort through getLayout (progress, Cancel). */
  readonly layoutOnSort: boolean;
};

export function createRowSource<Row = any>(options: RowSourceOptions<Row>): RowSource {
  const pageSize = Math.max(1, Math.floor(options.pageSize ?? 100));
  const maxPages = Math.max(8, options.maxPages ?? 300);
  let specAt: (i: number) => ColumnSpec<Row> | undefined = () => undefined;
  let columnCount = 0;
  let accessors: ((row: Row) => unknown)[] = [];
  const setColumns = (columns: ColumnSpec<Row>[] | ((index: number) => ColumnSpec<Row>)) => {
    accessors = [];
    if (typeof columns === 'function') {
      specAt = columns;
      columnCount = 0;
    } else {
      specAt = (i) => columns[i];
      columnCount = columns.length;
    }
  };
  if (options.columns) setColumns(options.columns);
  const read = (col: number): ((row: Row) => unknown) => (accessors[col] ??= accessorOf(specAt(col), col));
  const pages = new Map<string, Page<Row>>(); // "sig|page" -> rows (LRU)
  const pending = new Map<string, Pending<Row>>();
  const sigs = new WeakMap<Query, string>();
  let unfiltered: number | undefined;
  let generation = 0;

  const sigOf = (query: Query): string => {
    let s = sigs.get(query);
    if (s === undefined) {
      s = JSON.stringify([query.sort, query.filter]);
      sigs.set(query, s);
    }
    return s;
  };

  const remember = (key: string, page: Page<Row>) => {
    pages.delete(key);
    pages.set(key, page);
    while (pages.size > maxPages) pages.delete(pages.keys().next().value as string);
  };

  /** One page; concurrent callers share the request, which is aborted only when all of them gave up. */
  const loadPage = (query: Query, index: number, signal?: AbortSignal, onProgress?: (p: Progress) => void): Promise<Page<Row>> => {
    const key = `${sigOf(query)}|${index}`;
    const hit = pages.get(key);
    if (hit) {
      remember(key, hit);
      return Promise.resolve(hit);
    }
    let p = pending.get(key);
    if (!p) {
      const ctrl = new AbortController();
      const gen = generation;
      const offset = index * pageSize;
      const promise = Promise.resolve()
        .then(() => options.getRows({
          offset, limit: pageSize, start: offset, end: offset + pageSize, sort: query.sort, filter: query.filter, query, signal: ctrl.signal, ...(onProgress && { onProgress }),
        }))
        .then((res): Page<Row> => {
          if (!res || !Array.isArray(res.rows) || typeof res.total !== 'number') throw new TypeError('getRows must return { rows: [...], total: number }');
          const page = { rows: res.rows.slice(0, pageSize), total: res.total };
          if (gen === generation) {
            remember(key, page);
            if (!query.filter.length) unfiltered = res.total;
            else if (typeof res.totalUnfiltered === 'number') unfiltered = res.totalUnfiltered;
          }
          return page;
        })
        .finally(() => {
          if (pending.get(key) === entry) pending.delete(key);
        });
      const entry: Pending<Row> = { promise, ctrl, waiters: 0 };
      p = entry;
      pending.set(key, entry);
    }
    const entry = p;
    entry.waiters++;
    if (!signal) return entry.promise;
    return new Promise<Page<Row>>((resolve, reject) => {
      const onAbort = () => {
        if (--entry.waiters <= 0) entry.ctrl.abort();
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      entry.promise.then(
        (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
        (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
      );
    });
  };

  const cachedRow = (position: number, query: Query): Row | undefined => {
    const page = pages.get(`${sigOf(query)}|${Math.floor(position / pageSize)}`);
    return page?.rows[position % pageSize];
  };

  return {
    hasColumns: options.columns !== undefined,
    layoutOnSort: true,
    setColumns,
    maxRectsPerRequest: 1000,
    maxCellsPerRequest: 200_000,
    async getLayout({ query, signal, onProgress }): Promise<TableLayout> {
      const first = await loadPage(query, 0, signal, onProgress);
      return { rowCount: first.total, totalRowCount: unfiltered ?? first.total, columnCount };
    },
    async getCells({ rects, query, signal }) {
      const need = new Set<number>();
      for (const r of rects) {
        for (let p = Math.floor(r.row / pageSize); p <= Math.floor((r.row + r.rowCount - 1) / pageSize); p++) need.add(p);
      }
      const loaded = new Map<number, Page<Row>>();
      await Promise.all([...need].map((p) => loadPage(query, p, signal).then((page) => loaded.set(p, page))));
      return rects.map(({ row, col, rowCount, colCount }) => {
        const out = new Array<unknown>(rowCount * colCount);
        for (let i = 0; i < rowCount; i++) {
          const pos = row + i;
          const item = loaded.get(Math.floor(pos / pageSize))?.rows[pos % pageSize];
          for (let j = 0; j < colCount; j++) out[i * colCount + j] = item === undefined ? null : read(col + j)(item) ?? null;
        }
        return out;
      });
    },
    rowAt: cachedRow,
    async indexOfRow(id, query, getRowId) {
      // Loaded rows first (no request), then the backend if it can tell.
      const prefix = `${sigOf(query)}|`;
      for (const [key, page] of pages) {
        if (!key.startsWith(prefix)) continue;
        const i = page.rows.findIndex((row) => getRowId(row) === id);
        if (i >= 0) return Number(key.slice(prefix.length)) * pageSize + i;
      }
      if (options.indexOfRow) return options.indexOfRow(id, query);
      return null; // not among the loaded rows, and the backend cannot be asked
    },
    clearCache() {
      generation++;
      pages.clear();
      for (const p of pending.values()) p.ctrl.abort();
      pending.clear();
    },
    ...(options.getFilterValues && { getFilterValues: (req: FilterValuesRequest) => options.getFilterValues!(req) }),
  };
}
