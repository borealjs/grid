import { useMemo, useRef, useState } from 'react';
import { createArraySource, type ArraySource, type DataSource } from '@borealjs/grid-core';
import type { ColumnDef, FilterFns } from './types.js';

const SOURCE_METHODS = ['getRows', 'getCells', 'getLayout', 'getLabels', 'getFilterValues', 'rowAt', 'indexOfRow', 'clearCache'] as const satisfies readonly (keyof DataSource)[];
const SOURCE_LIMITS = ['maxRectsPerRequest', 'maxCellsPerRequest'] as const satisfies readonly (keyof DataSource)[];

/** A data source made by useDataSource: `version` moves when its dependencies change. */
export type ReactDataSource = DataSource & { version: number };

/**
 * A data source from callbacks that may close over props and state. It stays the same object (the grid
 * is not rebuilt); when `deps` change, the grid reloads what is visible, keeping scroll, sort and filter.
 *
 *   const source = useDataSource({
 *     getRows: async ({ offset, limit, sort, filter, signal }) => {
 *       const res = await fetch(`/api/orders?offset=${offset}&limit=${limit}&q=${search}`, { signal });
 *       return res.json(); // { rows: [...], total: 1234 }
 *     },
 *   }, [search]);
 */
export function useDataSource(spec: DataSource, deps: readonly unknown[] = []): ReactDataSource {
  const ref = useRef(spec);
  ref.current = spec;
  const [source] = useState(() => {
    const s: Record<string, unknown> = { version: 0 };
    for (const name of SOURCE_METHODS) {
      if (typeof spec[name] === 'function') s[name] = (...args: unknown[]) => (ref.current[name] as (...a: unknown[]) => unknown)(...args);
    }
    for (const name of SOURCE_LIMITS) if (spec[name] !== undefined) s[name] = spec[name];
    return s as unknown as ReactDataSource;
  });
  const prevDeps = useRef(deps);
  if (deps.length !== prevDeps.current.length || deps.some((d, i) => !Object.is(d, prevDeps.current[i]))) {
    prevDeps.current = deps;
    source.version++;
  }
  return source;
}

export interface UseArraySourceOptions<Row> {
  columns?: (ColumnDef<Row> | string | number)[];
  filterFns?: FilterFns<Row>;
  compare?(a: unknown, b: unknown): number;
}

/** An in-memory data source that stays the same object while `rows` and the options do. */
export function useArraySource<Row = any>(rows: Row[], options?: UseArraySourceOptions<Row>): ArraySource<Row> {
  const { columns, filterFns, compare } = options ?? {};
  return useMemo(() => createArraySource(rows, { columns: columns as never, filterFns, compare }), [rows, columns, filterFns, compare]);
}
