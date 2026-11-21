// In-memory rows (objects or arrays): sorting, filtering and value lists done in the browser.

import { filterFromPublic, type Condition } from '../query.js';
import type { ColumnDef, DataSource, FilterValuesResult, Query, SortItem, TableLayout } from '../types.js';

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

const isoDay = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const isEmpty = (v: unknown) => v === null || v === undefined || v === '';

/** Sorted / filtered views kept (switching back to one is instant). */
const MAX_VIEWS = 4;

/** Compares two cell values: numbers and dates by value, text naturally ("Item 2" < "Item 10"), empty last. */
export function compareValues(a: unknown, b: unknown): number {
  const ea = isEmpty(a);
  const eb = isEmpty(b);
  if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b ? 0 : a ? 1 : -1;
  return collator.compare(String(a), String(b));
}

/** A custom filter operator: (cell value, the condition's value, the row) => keep the row. */
export type FilterFn<R = any> = (value: any, conditionValue: any, row: R) => boolean;

export interface ArraySourceOptions<R = any> {
  /**
   * What each column index reads: column definitions (`value(row)` or `key`), or plain keys / indexes.
   * Default: the keys of the first row (objects) or its positions (arrays).
   */
  columns?: (ColumnDef<any, R> | string | number)[];
  /** Custom filter operators: { [op]: (cellValue, conditionValue, row) => boolean }. */
  filterFns?: Record<string, FilterFn<R>>;
  /** Default comparator for sorting (columns can bring their own `compare`). */
  compare?(a: unknown, b: unknown): number;
}

export interface ArraySource<R = any> extends DataSource {
  readonly rows: R[];
  /** Replace the rows; then call grid.refresh(). */
  setRows(rows: R[]): void;
  /** The row at a position of the sorted / filtered view (synchronous; for cell renderers). */
  rowAt(position: number, query: Query): R | undefined;
}

type Accessor<R> = (row: R) => unknown;

/**
 * Rows held in memory. `columns` maps column indexes to values: column definitions (`value(row)` or
 * `key`), or plain keys / indexes. Without it, the keys of the first row (objects) or the positions
 * (arrays) are used. Call setRows(newRows) and then grid.refresh() when the data changes.
 */
export function createArraySource<R = any>(rows: R[], { columns, filterFns = {}, compare = compareValues }: ArraySourceOptions<R> = {}): ArraySource<R> {
  let data = rows;
  let accessors: Accessor<R>[] = [];
  let comparers: ((a: any, b: any) => number)[] = [];
  const setColumns = () => {
    const first = data[0] as unknown;
    const list = columns ?? (data.length && !Array.isArray(first) ? Object.keys(first as object) : Array.from({ length: (first as unknown[] | undefined)?.length ?? 0 }, (_, i) => i));
    accessors = list.map((d, i): Accessor<R> => {
      if (typeof d === 'string' || typeof d === 'number') return (row) => (row as Record<string | number, unknown> | undefined)?.[d];
      if (typeof d?.value === 'function') return d.value;
      if (d?.key !== undefined) {
        const key = d.key;
        return (row) => (row as Record<string, unknown> | undefined)?.[key];
      }
      return (row) => (Array.isArray(row) ? row[i] : undefined);
    });
    comparers = list.map((d) => (typeof d === 'object' && typeof d?.compare === 'function' ? d.compare : compare));
  };
  setColumns();
  const views = new Map<string, Uint32Array>(); // query signature -> row indexes in view order
  const distinct = new Map<number, string[]>(); // column -> sorted distinct texts
  const positions = new Map<string, { getRowId: (row: any) => unknown; map: Map<unknown, number> }>(); // view -> id -> position

  function test(cond: Condition): (row: R) => boolean {
    const get = accessors[cond.c!];
    if (!get) throw new Error(`filter: no column ${cond.c}`);
    if (cond.op === 'range') {
      const dates = typeof (cond.min ?? cond.max) === 'string';
      const lo = cond.min;
      const hi = cond.max;
      return (row) => {
        let v = get(row) as number | string;
        if (isEmpty(v)) return false;
        if (dates) v = isoDay(v);
        return (lo === undefined || v >= lo) && (hi === undefined || v <= hi);
      };
    }
    if (cond.op === 'in' || cond.op === 'notin') {
      const set = new Set(cond.v as string[]);
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

  /** Row indexes of the query's view, or null when it is all rows in order. Cached (LRU). */
  function view(query: Query | undefined): Uint32Array | null {
    const sort = query?.sort ?? [];
    const filter = query?.filter ?? [];
    if (!sort.length && !filter.length) return null;
    const sig = JSON.stringify([sort, filter]);
    const hit = views.get(sig);
    if (hit) {
      views.delete(sig);
      views.set(sig, hit);
      return hit;
    }
    const tests = filterFromPublic(filter).filter((f) => f.c !== undefined).map(test);
    let out: Uint32Array = new Uint32Array(data.length);
    let n = 0;
    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      if (tests.every((t) => t(row))) out[n++] = i;
    }
    out = out.slice(0, n);
    const keys = sort.filter((s): s is SortItem & { column: number } => (s as { column?: number }).column !== undefined && !!accessors[(s as { column: number }).column]);
    if (keys.length) out = sortIndexes(out, keys.map((s) => ({ get: accessors[s.column], cmp: comparers[s.column], desc: s.direction === 'desc' })));
    views.set(sig, out);
    while (views.size > MAX_VIEWS) views.delete(views.keys().next().value as string);
    return out;
  }

  /** Stable multi-key sort of row indexes; each key column is read once. Empty values stay last in both directions. */
  function sortIndexes(idx: Uint32Array, keys: { get: Accessor<R>; cmp: (a: any, b: any) => number; desc: boolean }[]): Uint32Array {
    const cols = keys.map(({ get, cmp, desc }) => {
      const values = new Array<unknown>(data.length);
      for (const i of idx) values[i] = get(data[i]);
      return { values, cmp, desc };
    });
    const arr = Array.from(idx);
    arr.sort((a, b) => {
      for (const { values, cmp, desc } of cols) {
        const va = values[a];
        const vb = values[b];
        const ea = isEmpty(va);
        const eb = isEmpty(vb);
        if (ea || eb) {
          if (ea !== eb) return ea ? 1 : -1;
          continue;
        }
        const d = cmp(va, vb);
        if (d !== 0) return desc ? -d : d;
      }
      return a - b;
    });
    return Uint32Array.from(arr);
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
      positions.clear();
    },
    rowAt(position, query) {
      const idx = view(query);
      return data[idx ? idx[position] : position];
    },
    indexOfRow(id, query, getRowId) {
      // One id -> position index per sort + filter, built on the first lookup (O(rows) once, then O(1)).
      const sig = JSON.stringify([query?.sort ?? [], query?.filter ?? []]);
      let hit = positions.get(sig);
      if (!hit || hit.getRowId !== getRowId) {
        const idx = view(query);
        const n = idx ? idx.length : data.length;
        const map = new Map<unknown, number>();
        for (let i = 0; i < n; i++) map.set(getRowId(data[idx ? idx[i] : i]), i);
        hit = { getRowId, map };
        positions.set(sig, hit);
        while (positions.size > MAX_VIEWS) positions.delete(positions.keys().next().value as string);
      }
      return hit.map.get(id) ?? -1;
    },
    async getLayout({ query }): Promise<TableLayout> {
      const idx = view(query);
      return { rowCount: idx ? idx.length : data.length, totalRowCount: data.length, columnCount: accessors.length };
    },
    async getCells({ rects, query }) {
      const idx = view(query);
      return rects.map(({ row, col, rowCount, colCount }) => {
        const out = new Array<unknown[]>(rowCount);
        for (let i = 0; i < rowCount; i++) {
          const r = idx ? idx[row + i] : row + i;
          const item = data[r];
          const line = new Array<unknown>(colCount);
          for (let j = 0; j < colCount; j++) line[j] = item === undefined ? null : accessors[col + j]?.(item) ?? null;
          out[i] = line;
        }
        return out;
      });
    },
    async getFilterValues({ column, search = '', limit = 1000 }): Promise<FilterValuesResult> {
      const c = column ?? -1;
      let all = distinct.get(c);
      if (!all) {
        const get = accessors[c];
        const set = new Set<string>();
        for (const row of data) {
          const v = get?.(row);
          if (!isEmpty(v)) set.add(String(v));
        }
        all = [...set].sort(collator.compare);
        distinct.set(c, all);
      }
      const needle = search.trim().toLowerCase();
      const matching = needle ? all.filter((v) => v.toLowerCase().includes(needle)) : all;
      return { total: all.length, matches: matching.length, values: matching.slice(0, limit) };
    },
  };
}
