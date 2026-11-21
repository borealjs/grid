// The query in two formats, and conversions between them.
//
// Public (what data sources and event handlers see; see types.ts):
//   sort:          [{ column, key?, direction: 'asc' | 'desc' }]           a value column (source index)
//                  [{ level, direction }]                                 a pivot row dimension's names
//   filter:        [{ column, key?, op: 'range', min?, max? }]             numbers or 'YYYY-MM-DD'
//                  [{ column, key?, op: 'in' | 'notin', values: [...] }]   value lists
//                  [{ column, key?, op: 'contains', text }]                case-insensitive substring
//                  [{ column, key?, op: <custom>, value }]                 custom filters (any JSON value)
//                  (pivot row dimensions use `level` instead of `column`)
//   columnFilter:  [{ level, op, values? | text? | value? }]               which columns are shown
//
// Internal (compact; also what the reference HTTP protocol sends):
//   sort       [{ key: { col } | { dim }, dir: 'a' | 'd' }]
//   condition  { c | dim, op, v?, min?, max? }

import type { ColumnFilterItem, FilterItem, Query, SortItem } from './types.js';

export const EMPTY_QUERY: Readonly<Query> = Object.freeze({
  sort: Object.freeze([]) as unknown as SortItem[],
  filter: Object.freeze([]) as unknown as FilterItem[],
  columnFilter: Object.freeze([]) as unknown as ColumnFilterItem[],
});

// ------------------------------------------------------------------ internal format

/**
 * What a sort control, filter dialog or header addresses: a source column (`col`), a pivot row
 * dimension (`dim`), or a column dimension (`cdim`; a table's column chooser is cdim 0).
 * Exactly one field is set.
 */
export interface ViewKey {
  col?: number;
  dim?: number;
  cdim?: number;
}

export type SortDir = 'a' | 'd';

export interface SortSpec {
  key: ViewKey;
  dir: SortDir;
}

/** A filter condition: on a source column (`c`) or a dimension (`dim`). */
export interface Condition {
  c?: number;
  dim?: number;
  op: string;
  /** 'in' / 'notin': string[]; 'contains': string; custom ops: any JSON value. */
  v?: any;
  min?: number | string;
  max?: number | string;
}

type KeyOf = (col: number) => string | undefined;
type ColOfKey = (key: string | undefined) => number;

const noKey: KeyOf = () => undefined;
const noCol: ColOfKey = () => -1;

const withKey = <T extends object>(out: T, key: string | undefined): T => (key === undefined ? out : { ...out, key });

/** Loosely typed public condition, as users may hand it in (also accepts the internal `v`). */
type PublicConditionInput = { op?: unknown; min?: unknown; max?: unknown; values?: unknown; text?: unknown; value?: unknown; v?: unknown };

function conditionToPublic(f: Condition): Record<string, unknown> & { op: string } {
  const out: Record<string, unknown> & { op: string } = { op: f.op };
  if (f.op === 'range') {
    if (f.min !== undefined) out.min = f.min;
    if (f.max !== undefined) out.max = f.max;
  } else if (f.op === 'in' || f.op === 'notin') out.values = f.v;
  else if (f.op === 'contains') out.text = f.v;
  else if (f.v !== undefined) out.value = f.v;
  return out;
}

const blank = (x: unknown) => x === undefined || x === null || x === '';

/** A public condition (without its column) as the internal { op, v | min/max }. */
export function conditionFromPublic(f: PublicConditionInput | null | undefined): Condition {
  if (!f || typeof f.op !== 'string') throw new TypeError('a filter condition needs an `op`');
  if (f.op === 'range') {
    const out: Condition = { op: 'range' };
    if (!blank(f.min)) out.min = f.min as number | string;
    if (!blank(f.max)) out.max = f.max as number | string;
    return out;
  }
  if (f.op === 'in' || f.op === 'notin') return { op: f.op, v: [...((f.values ?? f.v ?? []) as Iterable<unknown>)].map(String) };
  if (f.op === 'contains') return { op: 'contains', v: String(f.text ?? f.v ?? '') };
  return f.value === undefined ? { op: f.op } : { op: f.op, v: f.value };
}

export function sortToPublic(list: readonly SortSpec[], keyOf: KeyOf = noKey): SortItem[] {
  return list.map((s) => {
    const direction = s.dir === 'd' ? 'desc' : 'asc';
    return s.key.dim !== undefined ? { level: s.key.dim, direction } : withKey({ column: s.key.col as number, direction }, keyOf(s.key.col as number));
  });
}

export function sortFromPublic(list: readonly SortItem[] | null | undefined, colOfKey: ColOfKey = noCol): SortSpec[] {
  return (list ?? []).map((s) => {
    const loose = s as { level?: number; column?: number; key?: string; direction?: string; desc?: boolean };
    const dir: SortDir = loose.direction === 'desc' || loose.desc === true ? 'd' : 'a';
    if (loose.level !== undefined) return { key: { dim: loose.level }, dir };
    const col = loose.column ?? colOfKey(loose.key);
    if (!Number.isInteger(col) || col < 0) throw new TypeError(`sort: unknown column ${JSON.stringify(loose.key ?? loose.column)}`);
    return { key: { col }, dir };
  });
}

export function filterToPublic(list: readonly Condition[], keyOf: KeyOf = noKey): FilterItem[] {
  return list.map((f) => (f.dim !== undefined
    ? { level: f.dim, ...conditionToPublic(f) }
    : withKey({ column: f.c as number, ...conditionToPublic(f) }, keyOf(f.c as number)))) as FilterItem[];
}

export function filterFromPublic(list: readonly FilterItem[] | null | undefined, colOfKey: ColOfKey = noCol): Condition[] {
  return (list ?? []).map((f) => {
    const loose = f as PublicConditionInput & { level?: number; column?: number; key?: string };
    if (loose.level !== undefined) return { dim: loose.level, ...conditionFromPublic(loose) };
    const c = loose.column ?? colOfKey(loose.key);
    if (!Number.isInteger(c) || c < 0) throw new TypeError(`filter: unknown column ${JSON.stringify(loose.key ?? loose.column)}`);
    return { c, ...conditionFromPublic(loose) };
  });
}

export const columnFilterToPublic = (list: readonly Condition[]): ColumnFilterItem[] =>
  list.map((f) => ({ level: f.dim as number, ...conditionToPublic(f) })) as ColumnFilterItem[];

export const columnFilterFromPublic = (list: readonly ColumnFilterItem[] | null | undefined): Condition[] =>
  (list ?? []).map((f) => ({ dim: (f as { level?: number }).level ?? 0, ...conditionFromPublic(f as PublicConditionInput) }));

/** Tests a text against an internal or public 'in' / 'notin' / 'contains' condition. */
export function matchesName(f: { op: string; v?: unknown; values?: unknown; text?: unknown }, name: unknown): boolean {
  const s = String(name);
  if (f.op === 'in') return ((f.values ?? f.v) as string[]).includes(s);
  if (f.op === 'notin') return !((f.values ?? f.v) as string[]).includes(s);
  if (f.op === 'contains') return s.toLowerCase().includes(String(f.text ?? f.v).toLowerCase());
  return true;
}

// ------------------------------------------------------------------ signatures (request parameters, cache keys)

/** Sort order as the request parameter: `3:d,L1:a` (a value column, or a row dimension's names). */
export const sortParamOf = (spec: readonly SortSpec[]): string =>
  spec.map((s) => `${s.key.dim !== undefined ? `L${s.key.dim}` : s.key.col}:${s.dir}`).join(',');

/** Filter as the request parameter: JSON, conditions ordered by column so equal filters compare equal. */
export const filterParamOf = (list: readonly Condition[]): string => (list.length
  ? JSON.stringify([...list].sort((a, b) => (a.dim ?? -1) - (b.dim ?? -1) || (a.c ?? -1) - (b.c ?? -1)))
  : '');

// ------------------------------------------------------------------ view keys

/** A key as a short id for data attributes: `c<col>`, `d<dim>` or `x<cdim>`. */
export const viewKeyId = (key: ViewKey): string => (key.cdim !== undefined ? `x${key.cdim}` : key.dim !== undefined ? `d${key.dim}` : `c${key.col}`);

export const parseViewKeyId = (id: string): ViewKey =>
  (id[0] === 'x' ? { cdim: Number(id.slice(1)) } : id[0] === 'd' ? { dim: Number(id.slice(1)) } : { col: Number(id.slice(1)) });

export const sameSortKey = (a: ViewKey, b: ViewKey): boolean => a.col === b.col && a.dim === b.dim;

/** Whether a row condition is the one for `key` (a column or a row dimension). */
export const sameFilterKey = (f: Condition, key: ViewKey): boolean => (key.dim !== undefined ? f.dim === key.dim : f.c === key.col);

/** The condition fields that address `key`. */
export const filterKeyFields = (key: ViewKey): Pick<Condition, 'c' | 'dim'> => (key.dim !== undefined ? { dim: key.dim } : { c: key.col });

/** "≥ 20000", "is Lisbon, Oslo", "contains "x"" (for summaries). */
export function describeCondition(f: Condition): string {
  if (f.op === 'range') {
    if (f.min !== undefined && f.max !== undefined) return `${f.min} – ${f.max}`;
    return f.min !== undefined ? `≥ ${f.min}` : `≤ ${f.max}`;
  }
  if (f.op === 'in') return f.v.length <= 3 ? `is ${f.v.join(', ') || '(nothing)'}` : `is one of ${f.v.length}`;
  if (f.op === 'notin') return f.v.length <= 3 ? `is not ${f.v.join(', ')}` : `excludes ${f.v.length}`;
  return `contains "${f.v}"`;
}
