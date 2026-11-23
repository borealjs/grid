import { useRef, useState } from 'react';
import type { DataSource } from '@borealjs/grid-core';

const SOURCE_METHODS = ['getRows', 'getCells', 'getLayout', 'getLabels', 'getColumns', 'getFilterValues', 'rowAt', 'rowIdAt', 'indexOfRow', 'clearCache'] as const satisfies readonly (keyof DataSource)[];
const SOURCE_LIMITS = ['maxRectsPerRequest', 'maxCellsPerRequest', 'pageSize', 'maxPages'] as const satisfies readonly (keyof DataSource)[];

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
