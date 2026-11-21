// Public query format <-> the grid's internal format.
//
// Public (what data sources and event handlers see):
//   sort:          [{ column, key?, direction: 'asc' | 'desc' }]           a value column (source index)
//                  [{ level, direction }]                                 a pivot row dimension's names
//   filter:        [{ column, key?, op: 'range', min?, max? }]             numbers or 'YYYY-MM-DD'
//                  [{ column, key?, op: 'in' | 'notin', values: [...] }]   value lists
//                  [{ column, key?, op: 'contains', text }]                case-insensitive substring
//                  [{ column, key?, op: <custom>, value }]                 custom filters (any JSON value)
//                  (pivot row dimensions use `level` instead of `column`)
//   columnFilter:  [{ level, op, values? | text? | value? }]               which columns are shown
//
// Internal: sort [{ key: { col } | { dim }, dir: 'a' | 'd' }], conditions { c | dim, op, v?, min?, max? }.

export const EMPTY_QUERY = Object.freeze({ sort: Object.freeze([]), filter: Object.freeze([]), columnFilter: Object.freeze([]) });

const withKey = (out, key) => (key === undefined ? out : { ...out, key });

function conditionToPublic(f) {
  const out = { op: f.op };
  if (f.op === 'range') {
    if (f.min !== undefined) out.min = f.min;
    if (f.max !== undefined) out.max = f.max;
  } else if (f.op === 'in' || f.op === 'notin') out.values = f.v;
  else if (f.op === 'contains') out.text = f.v;
  else if (f.v !== undefined) out.value = f.v;
  return out;
}

/** A public condition (without its column) as the internal { op, v | min/max }. */
export function conditionFromPublic(f) {
  if (!f || typeof f.op !== 'string') throw new TypeError('a filter condition needs an `op`');
  if (f.op === 'range') {
    const out = { op: 'range' };
    if (f.min !== undefined && f.min !== null && f.min !== '') out.min = f.min;
    if (f.max !== undefined && f.max !== null && f.max !== '') out.max = f.max;
    return out;
  }
  if (f.op === 'in' || f.op === 'notin') return { op: f.op, v: [...(f.values ?? f.v ?? [])].map(String) };
  if (f.op === 'contains') return { op: 'contains', v: String(f.text ?? f.v ?? '') };
  return f.value === undefined ? { op: f.op } : { op: f.op, v: f.value };
}

export function sortToPublic(list, keyOf = () => undefined) {
  return list.map((s) => {
    const direction = s.dir === 'd' ? 'desc' : 'asc';
    return s.key.dim !== undefined ? { level: s.key.dim, direction } : withKey({ column: s.key.col, direction }, keyOf(s.key.col));
  });
}

export function sortFromPublic(list, colOfKey = () => -1) {
  return (list ?? []).map((s) => {
    const dir = s.direction === 'desc' || s.desc === true ? 'd' : 'a';
    if (s.level !== undefined) return { key: { dim: s.level }, dir };
    const col = s.column ?? colOfKey(s.key);
    if (!Number.isInteger(col) || col < 0) throw new TypeError(`sort: unknown column ${JSON.stringify(s.key ?? s.column)}`);
    return { key: { col }, dir };
  });
}

export function filterToPublic(list, keyOf = () => undefined) {
  return list.map((f) => (f.dim !== undefined
    ? { level: f.dim, ...conditionToPublic(f) }
    : withKey({ column: f.c, ...conditionToPublic(f) }, keyOf(f.c))));
}

export function filterFromPublic(list, colOfKey = () => -1) {
  return (list ?? []).map((f) => {
    if (f.level !== undefined) return { dim: f.level, ...conditionFromPublic(f) };
    const c = f.column ?? colOfKey(f.key);
    if (!Number.isInteger(c) || c < 0) throw new TypeError(`filter: unknown column ${JSON.stringify(f.key ?? f.column)}`);
    return { c, ...conditionFromPublic(f) };
  });
}

export const columnFilterToPublic = (list) => list.map((f) => ({ level: f.dim, ...conditionToPublic(f) }));

export const columnFilterFromPublic = (list) => (list ?? []).map((f) => ({ dim: f.level ?? 0, ...conditionFromPublic(f) }));

/** Tests a text against an internal or public 'in' / 'notin' / 'contains' condition. */
export function matchesName(f, name) {
  const s = String(name);
  if (f.op === 'in') return (f.values ?? f.v).includes(s);
  if (f.op === 'notin') return !(f.values ?? f.v).includes(s);
  if (f.op === 'contains') return s.toLowerCase().includes(String(f.text ?? f.v).toLowerCase());
  return true;
}

const defaultNumberFormat = new Intl.NumberFormat();

/** Default text for a value: '' for null/undefined, locale formatting for numbers, String() otherwise. */
export function defaultFormat(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? defaultNumberFormat.format(value) : String(value);
  if (value instanceof Date) return value.toLocaleDateString();
  return String(value);
}
