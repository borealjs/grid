// A pivot over a live ClickHouse table, fetched block by block. The grid's pivot protocol has three calls,
// and each becomes small queries; nothing is fetched in bulk and no values are kept here (the grid caches
// the cells it loaded):
//
//   getLayout   the row and column trees: for every level above the leaves, its groups and how many
//               children each has (one GROUP BY per level, run in parallel). Leaves are only counted.
//   getLabels   header names; leaf names come a page at a time (GROUP BY … ORDER BY … LIMIT … OFFSET).
//   getCells    the values of the rectangles on screen: one UNION ALL query per request, one SELECT per
//               kind of cell in it (leaf × leaf, subtotal × leaf, …), restricted with IN to the groups in
//               the rectangle, so subtotals and grand totals come from the database too.
//
// Sorting by a column's values uses conditional aggregates (sumIf(price, toYear(date) = 2024)); filters
// become WHERE, so every total covers only the filtered rows. Nothing is capped here: a layout with a
// million groups above the leaves is sent as is, and if the database refuses, its error is shown.

import { TreeAxis } from '../../packages/grid-core/dist/index.js';
import { chQuery, chId, chStr } from './live-sources.js';

const SIGMA = -1; // the Σ Values level (measure names)
const SYN_ROOT = -2; // "All" level for axes with fewer than two dimensions
const SYN_LEAF = -3; // single "Total" leaf for an axis with no dimensions
const PAGE = 200; // leaf names per labels query
const AGG = { sum: 'Sum', avg: 'Avg', min: 'Min', max: 'Max', count: 'Count' };
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const SEP = '\u0001';

/** Pivot fields for a live table: its columns, plus year and month of each date column. */
export function liveFields(columns) {
  const out = [];
  for (const c of columns) {
    if (c.kind === 'complex') continue;
    const id = chId(c.name);
    out.push({ index: out.length, key: c.key, name: c.name, kind: c.kind === 'number' ? 'num' : 'dim', expr: id });
    if (c.kind === 'date') {
      out.push({ index: out.length, key: `${c.key}_y`, name: `${c.name} · year`, kind: 'dim', expr: `toYear(${id})` });
      out.push({ index: out.length, key: `${c.key}_m`, name: `${c.name} · month`, kind: 'dim', expr: `formatDateTime(toStartOfMonth(${id}), '%Y-%m')` });
    }
  }
  return out;
}

function axisShape(dims) {
  const k = dims.length;
  if (k === 0) return { levels: [SYN_ROOT], leaf: SYN_LEAF };
  if (k === 1) return { levels: [SYN_ROOT], leaf: dims[0] };
  return { levels: dims.slice(0, -1), leaf: dims[k - 1] };
}
const entryAt = (shape, level) => (level < shape.levels.length ? shape.levels[level] : level === shape.levels.length ? shape.leaf : undefined);

const compareRaw = (a, b) => {
  if (a == null) return b == null ? 0 : 1;
  if (b == null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return collator.compare(String(a), String(b));
};
const compareNum = (a, b, dir) => {
  const x = a == null || Number.isNaN(a) ? null : a;
  const y = b == null || Number.isNaN(b) ? null : b;
  if (x === null) return y === null ? 0 : 1; // empty values last in both directions
  if (y === null) return -1;
  return (x - y) * dir;
};

/** Largest i with arr[i] <= v. */
function lastLE(arr, v) {
  let lo = 0, hi = arr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (arr[mid] <= v) lo = mid; else hi = mid - 1;
  }
  return lo;
}

export function createClickHousePivot({ table, fields, cfg, track }) {
  const T = chId(table);
  const M = cfg.values.length ? cfg.values : [{ field: -1, agg: 'count' }];
  const sigmaAny = cfg.rows.includes(SIGMA) || cfg.cols.includes(SIGMA);
  const rootM = sigmaAny ? -1 : 0;
  const S = (f) => `toString(${fields[f].expr})`; // the string form used for keys and conditions
  const R = (f) => fields[f].expr; // the raw form used for grouping and ordering
  const mLabel = (i) => {
    const m = M[i];
    return m.field < 0 ? 'Count' : `${AGG[m.agg] ?? m.agg} of ${fields[m.field].name}`;
  };
  /** A measure as SQL, optionally only over rows matching `cond` (ClickHouse's -If combinator). */
  const mSql = (i, cond) => {
    const m = M[i];
    if (m.field < 0 || m.agg === 'count' || fields[m.field].kind !== 'num') return cond ? `toFloat64(countIf(${cond}))` : 'toFloat64(count())';
    const fn = { sum: 'sum', avg: 'avg', min: 'min', max: 'max' }[m.agg] ?? 'sum';
    return cond ? `toFloat64(${fn}If(${R(m.field)}, ${cond}))` : `toFloat64(${fn}(${R(m.field)}))`;
  };
  const tupleEq = (dims, keys) => keys.map((k, i) => `${S(dims[i])} = ${chStr(k)}`).join(' AND ');
  const tupleIn = (dims, tuples) => (dims.length === 1
    ? `${S(dims[0])} IN (${tuples.map((t) => chStr(t[0])).join(', ')})`
    : `(${dims.map(S).join(', ')}) IN (${tuples.map((t) => `(${t.map(chStr).join(', ')})`).join(', ')})`);
  const where = (parts) => (parts.length ? ` WHERE ${parts.join(' AND ')}` : '');

  async function run(kind, detail, sql, signal, cells = 0) {
    return track(kind, detail, async (s) => {
      const r = await chQuery(sql, s);
      return { result: r.json.data, serverMs: r.serverMs, bytes: r.bytes, query: sql };
    }, signal, cells);
  }

  /** Filters on pivot levels: WHERE parts for real dimensions, a keep-set for the Σ level. */
  function compileFilters(list, dims) {
    const shape = axisShape(dims);
    const parts = [];
    let keepM = null;
    for (const f of list ?? []) {
      const e = entryAt(shape, f.level);
      if (e === undefined || e < SIGMA) continue;
      if (e === SIGMA) {
        const labels = M.map((_, i) => mLabel(i));
        const ok = new Set(labels.map((l, i) => [l, i]).filter(([l]) => (f.op === 'in' ? f.values.includes(l) : f.op === 'notin' ? !f.values.includes(l) : l.toLowerCase().includes(String(f.text ?? '').toLowerCase()))).map(([, i]) => i));
        keepM = keepM ? new Set([...keepM].filter((i) => ok.has(i))) : ok;
        continue;
      }
      if (f.op === 'in' || f.op === 'notin') parts.push(`${S(e)} ${f.op === 'in' ? 'IN' : 'NOT IN'} (${(f.values ?? []).map(chStr).join(', ') || "''"})`);
      else if (f.op === 'contains') parts.push(`positionCaseInsensitiveUTF8(${S(e)}, ${chStr(f.text ?? '')}) > 0`);
    }
    return { parts, keepM };
  }

  // ---------------------------------------------------------------- axis structure

  /**
   * One axis: groups per level (each { keys: strings of its real dimensions, m: measure or -1, name }),
   * child counts, and a TreeAxis to turn source positions into groups and leaves.
   * `valueKeys` sort row siblings by a column's values: [{ dir, cond, cm }].
   */
  async function buildAxis(axis, dims, whereParts, keepM, sortKeys, valueKeys, signal) {
    const shape = axisShape(dims);
    const D = shape.levels.length;
    const entries = [...shape.levels, shape.leaf];
    const realDims = dims.filter((d) => d >= 0);
    const realUpTo = (L) => entries.slice(0, L + 1).filter((e) => e >= 0);
    const sigmaPos = dims.indexOf(SIGMA);
    const mList = M.map((_, i) => i).filter((i) => !keepM || keepM.has(i));
    const w = where(whereParts);

    // Sort values: per value key, one column per measure a group could show.
    const candM = (k) => (k.cm >= 0 ? [k.cm] : mList);
    const sortCols = valueKeys.flatMap((k, ki) => candM(k).map((m) => ({ ki, m, sql: mSql(m, k.cond) })));
    const sortSelect = sortCols.map((c) => `, ${c.sql}`).join('');

    // Listing queries: the groups of every real level above the leaves (all in parallel).
    const listings = new Map();
    const jobs = [];
    for (let L = 0; L < D; L++) {
      const e = entries[L];
      if (e < 0) continue;
      const P = realUpTo(L);
      const sql = `SELECT ${P.map(S).join(', ')}, ${R(e)} AS raw${sortSelect} FROM ${T}${w} GROUP BY ${P.map(S).join(', ')}, raw`;
      jobs.push(run('layout', `${axis} · ${fields[e].name} groups`, sql, signal).then((rows) => listings.set(L, rows)));
    }
    // Leaf counts per deepest group (leaves themselves are fetched page by page later).
    let leafCounts = null;
    if (shape.leaf >= 0) {
      const P = realUpTo(D - 1);
      const sql = P.length
        ? `SELECT ${P.map(S).join(', ')}, uniqExact(${R(shape.leaf)}) FROM ${T}${w} GROUP BY ${P.map(S).join(', ')}`
        : `SELECT uniqExact(${R(shape.leaf)}) FROM ${T}${w}`;
      jobs.push(run('layout', `${axis} · ${fields[shape.leaf].name} count`, sql, signal).then((rows) => {
        leafCounts = new Map(rows.map((r) => [r.slice(0, P.length).join(SEP), Number(r[P.length])]));
      }));
    }
    await Promise.all(jobs);

    const nameOf = (e, g) => (e === SYN_ROOT ? 'All' : e === SIGMA ? mLabel(g.m) : g.keys[g.keys.length - 1]);
    const comparatorFor = (L, e, m) => {
      const chain = [];
      for (const k of sortKeys) {
        if (k.level !== undefined) {
          if (k.level !== L) continue;
          chain.push(e === SIGMA ? (a, b) => (a.m - b.m) * k.dir : (a, b) => compareRaw(a.raw, b.raw) * k.dir);
        } else if (e !== SIGMA) {
          const col = sortCols.findIndex((c) => c.ki === k.ki && c.m === (k.cm >= 0 ? k.cm : m));
          if (col >= 0) chain.push((a, b) => compareNum(a.sv[col], b.sv[col], k.dir));
        }
      }
      chain.push(e === SIGMA ? (a, b) => a.m - b.m : (a, b) => compareRaw(a.raw, b.raw));
      return (a, b) => { for (const c of chain) { const r = c(a, b); if (r) return r; } return 0; };
    };

    // Arrange groups level by level, children under their parent, sorted among siblings.
    const groups = [];
    const fanout = [];
    // Index each level's groups by their parent, so arranging a million groups stays linear.
    const byParent = new Map();
    for (const [L, rows] of listings) {
      const P = realUpTo(L).length;
      const idx = new Map();
      for (const r of rows) {
        const k = r.slice(0, P - 1).map(String).join(SEP);
        let list = idx.get(k);
        if (!list) idx.set(k, (list = []));
        list.push(r);
      }
      byParent.set(L, { idx, P });
    }
    const childrenIndexed = (parent, L) => {
      const e = entries[L];
      if (e === SIGMA) return mList.map((m) => ({ keys: parent.keys, m, raw: m }));
      const { idx, P } = byParent.get(L);
      const rows = idx.get(parent.keys.join(SEP)) ?? [];
      const kids = rows.map((r) => ({ keys: r.slice(0, P).map(String), m: parent.m, raw: r[P], sv: r.slice(P + 1) }));
      kids.sort(comparatorFor(L, e, parent.m));
      return kids;
    };
    const root = { keys: [], m: rootM, raw: null };
    groups[0] = entries[0] === SYN_ROOT ? [root] : childrenIndexed(root, 0);
    for (let L = 1; L < D; L++) {
      const next = [];
      fanout[L - 1] = groups[L - 1].map((g) => {
        const kids = childrenIndexed(g, L);
        for (const k of kids) next.push(k);
        return kids.length;
      });
      groups[L] = next;
    }
    const leafEntry = shape.leaf;
    fanout[D - 1] = groups[D - 1].map((g) => (leafEntry === SIGMA ? mList.length : leafEntry === SYN_LEAF ? 1 : leafCounts.get(g.keys.join(SEP)) ?? 0));
    groups.forEach((list, L) => list.forEach((g) => { g.name = nameOf(entries[L], g); }));

    const sub = shape.levels.map((e, L) => {
      if (e === SYN_ROOT) return cfg.grandTotals && leafEntry !== SYN_LEAF && sigmaPos < 0;
      return cfg.subtotals && (sigmaPos < 0 || sigmaPos <= L);
    });
    const grand = shape.levels[0] !== SYN_ROOT && cfg.grandTotals && sigmaPos < 0;
    const entryName = (e) => (e === SYN_ROOT ? 'All' : e === SYN_LEAF ? ' ' : e === SIGMA ? 'Values' : fields[e].name);
    const spec = {
      levels: shape.levels.map((e, L) => ({ name: entryName(e), subtotal: sub[L] })),
      leafName: entryName(leafEntry),
      leafSize: axis === 'rows' ? cfg.rowHeight : cfg.colWidth,
      roots: groups[0].length,
      fanout,
      grandTotal: grand,
    };
    const tree = new TreeAxis(spec);
    const ids = stableIds(axis);
    const maps = groups.map((list) => list.map((g) => ids(`${g.keys.join(SEP)}|${g.m}`)));

    // Leaf names, a page at a time per deepest group, in the same order as the sort. Pages asked for in
    // the same moment (one screen touches many groups) go out as one query: ClickHouse's LIMIT … BY pages
    // every group at once.
    const pages = new Map();
    const batches = new Map();
    const batchedPage = (g, chunk, order) => new Promise((resolve, reject) => {
      const bk = `${chunk}|${order}`;
      let b = batches.get(bk);
      if (!b) {
        batches.set(bk, (b = { list: [] }));
        setTimeout(() => flushBatch(bk, chunk, order), 0);
      }
      b.list.push({ g, resolve, reject });
    });
    const flushBatch = async (bk, chunk, order) => {
      const { list } = batches.get(bk);
      batches.delete(bk);
      const P = realUpTo(D - 1);
      const aliases = P.map((_, i) => `p${i}`).join(', ');
      const sql = `SELECT ${P.map((d, i) => `${S(d)} AS p${i}`).join(', ')}, ${S(leafEntry)} AS k, ${R(leafEntry)} AS raw FROM ${T}`
        + `${where([...whereParts, tupleIn(P, list.map((x) => x.g.keys))])} GROUP BY ${aliases}, raw`
        + ` ORDER BY ${aliases}, ${order} LIMIT ${PAGE} OFFSET ${chunk * PAGE} BY ${aliases}`;
      try {
        // No signal: one screen's names serve every block that asked, so one cancelled block can't drop them.
        const rows = await run('labels', `${axis} leaves · ${list.length} group${list.length > 1 ? 's' : ''} · ${chunk * PAGE}+${PAGE}`, sql);
        const byGroup = new Map();
        for (const r of rows) {
          const gk = r.slice(0, P.length).map(String).join(SEP);
          let arr = byGroup.get(gk);
          if (!arr) byGroup.set(gk, (arr = []));
          arr.push(String(r[P.length]));
        }
        for (const { g, resolve } of list) resolve((byGroup.get(g.keys.join(SEP)) ?? []).map((k) => ({ key: k, name: k })));
      } catch (err) {
        for (const { reject } of list) reject(err);
      }
    };
    const leafOrder = (g) => {
      const order = [];
      for (const k of sortKeys) {
        if (k.level === D) order.push(`raw ${k.dir < 0 ? 'DESC' : 'ASC'}`);
        else if (k.level === undefined) {
          const m = k.cm >= 0 ? k.cm : g.m;
          if (m >= 0) order.push(`${mSql(m, k.cond)} ${k.dir < 0 ? 'DESC' : 'ASC'} NULLS LAST`);
        }
      }
      order.push('raw ASC');
      return order.join(', ');
    };
    const leafPage = (gi, chunk, sig) => {
      const g = groups[D - 1][gi];
      if (leafEntry === SIGMA) return Promise.resolve(mList.map((m) => ({ key: null, m, name: mLabel(m) })).slice(chunk * PAGE, (chunk + 1) * PAGE));
      if (leafEntry === SYN_LEAF) return Promise.resolve([{ key: null, m: g.m, name: 'Total' }]);
      // Groups with the same keys and order (the same years under each measure) share their pages.
      const order = leafOrder(g);
      const key = `${g.keys.join(SEP)}|${order}|${chunk}`;
      let p = pages.get(key);
      if (p) return p;
      const P = realUpTo(D - 1);
      if (!P.length) {
        const sql = `SELECT ${S(leafEntry)} AS k, ${R(leafEntry)} AS raw FROM ${T}${where(whereParts)} GROUP BY raw ORDER BY ${order} LIMIT ${PAGE} OFFSET ${chunk * PAGE}`;
        p = run('labels', `${axis} leaves · ${chunk * PAGE}+${PAGE}`, sql, sig).then((rows) => rows.map((r) => ({ key: String(r[0]), name: String(r[0]) })));
      } else {
        p = batchedPage(g, chunk, order);
      }
      p.catch(() => pages.delete(key)); // a failed or cancelled page is asked again next time
      pages.set(key, p);
      return p;
    };

    /** What a source position stands for: its real keys and its measure. Loads leaf pages as needed. */
    async function items(srcList, sig) {
      const locs = srcList.map((i) => tree.locate(i));
      const need = new Map();
      for (const loc of locs) if (loc.kind === 'leaf') need.set(`${loc.path[D - 1]}:${Math.floor(loc.leafInGroup / PAGE)}`, [loc.path[D - 1], Math.floor(loc.leafInGroup / PAGE)]);
      const loaded = new Map();
      await Promise.all([...need].map(async ([k, [gi, ch]]) => loaded.set(k, await leafPage(gi, ch, sig))));
      return locs.map((loc) => {
        if (loc.kind === 'grand') return { keys: [], m: rootM };
        if (loc.kind !== 'leaf') { const g = groups[loc.level][loc.path[loc.level]]; return { keys: g.keys, m: g.m }; }
        const gi = loc.path[D - 1];
        const g = groups[D - 1][gi];
        const leaf = loaded.get(`${gi}:${Math.floor(loc.leafInGroup / PAGE)}`)?.[loc.leafInGroup % PAGE];
        if (!leaf) return null;
        return leaf.key === null ? { keys: g.keys, m: leaf.m } : { keys: [...g.keys, leaf.key], m: g.m };
      });
    }

    async function labels(level, start, count, sig) {
      if (level < D) return groups[level].slice(start, start + count).map((g) => g.name);
      const cs = tree.childStart[D - 1];
      const spots = [];
      for (let i = start; i < start + count && i < tree.leafCount; i++) {
        const gi = lastLE(cs, i);
        const inGroup = i - cs[gi];
        spots.push([gi, Math.floor(inGroup / PAGE), inGroup % PAGE]);
      }
      // Ask for every page first, so they batch into one query, then read them.
      const need = new Map(spots.map(([gi, ch]) => [`${gi}:${ch}`, [gi, ch]]));
      const loaded = new Map(await Promise.all([...need].map(async ([k, [gi, ch]]) => [k, await leafPage(gi, ch, sig)])));
      return spots.map(([gi, ch, at]) => loaded.get(`${gi}:${ch}`)?.[at]?.name ?? '');
    }

    return { spec, maps, tree, groups, realDims, items, labels, D, leafCount: tree.leafCount };
  }

  const idMaps = new Map();
  function stableIds(axis) {
    let map = idMaps.get(axis);
    if (!map) idMaps.set(axis, (map = new Map()));
    return (k) => { let v = map.get(k); if (v === undefined) map.set(k, (v = map.size)); return v; };
  }

  // ---------------------------------------------------------------- views per query

  const colViews = new Map();
  const views = new Map();
  const sigOf = (q) => JSON.stringify([q.sort ?? [], q.filter ?? [], q.columnFilter ?? []]);

  function colView(query, signal) {
    const key = JSON.stringify(query.columnFilter ?? []);
    let v = colViews.get(key);
    if (!v) {
      const cf = compileFilters(query.columnFilter, cfg.cols);
      // Column structure ignores row filters, so columns stay put while rows are filtered.
      v = buildAxis('cols', cfg.cols, cf.parts, cf.keepM, [], [], signal);
      v.catch(() => colViews.delete(key));
      colViews.set(key, v);
    }
    return v;
  }

  function view(query, signal) {
    const key = sigOf(query);
    let v = views.get(key);
    if (!v) {
      v = (async () => {
        const cols = await colView(query, signal);
        const rf = compileFilters(query.filter, cfg.rows);
        const cf = compileFilters(query.columnFilter, cfg.cols);
        const whereParts = [...rf.parts, ...cf.parts];
        const sortKeys = [];
        const valueKeys = [];
        for (const s of query.sort ?? []) {
          const dir = s.direction === 'desc' ? -1 : 1;
          if (s.level !== undefined) { sortKeys.push({ level: s.level, dir }); continue; }
          if (s.column === undefined) continue;
          const [item] = await cols.items([s.column], signal);
          if (!item) continue;
          const cond = item.keys.length ? tupleEq(cols.realDims, item.keys) : '1';
          const vk = { dir, cond, cm: item.m, ki: valueKeys.length };
          valueKeys.push(vk);
          sortKeys.push(vk);
        }
        const rows = await buildAxis('rows', cfg.rows, whereParts, rf.keepM, sortKeys, valueKeys, signal);
        return { rows, cols, whereParts };
      })();
      v.catch(() => views.delete(key));
      views.set(key, v);
      while (views.size > 6) views.delete(views.keys().next().value);
    }
    return v;
  }

  // ---------------------------------------------------------------- data source

  return {
    maxRectsPerRequest: 50,
    maxCellsPerRequest: cfg.maxCells ?? 20000,
    async getLayout({ query, signal, onProgress }) {
      onProgress?.({ phase: 'Grouping in ClickHouse' });
      const v = await view(query, signal);
      return { type: 'pivot', rows: v.rows.spec, cols: v.cols.spec, rowMaps: v.rows.maps, colMaps: v.cols.maps };
    },

    async getLabels({ axis, level, start, count, query, signal }) {
      const v = await view(query, signal);
      return (axis === 'rows' ? v.rows : v.cols).labels(level, start, count, signal);
    },

    async getFilterValues({ axis, level, search, limit = 1000, signal }) {
      const shape = axisShape(axis === 'rows' ? cfg.rows : cfg.cols);
      const e = entryAt(shape, level);
      if (e === undefined || e < SIGMA) return { values: [] };
      if (e === SIGMA) {
        const labels = M.map((_, i) => mLabel(i)).filter((l) => l.toLowerCase().includes((search ?? '').toLowerCase()));
        return { values: labels, total: M.length, matches: labels.length };
      }
      const cond = search ? ` WHERE positionCaseInsensitiveUTF8(${S(e)}, ${chStr(search)}) > 0` : '';
      const rows = await run('values', `${fields[e].name}${search ? ` "${search}"` : ''}`, `SELECT ${S(e)} AS k, ${R(e)} AS raw FROM ${T}${cond} GROUP BY raw ORDER BY raw LIMIT ${limit + 1}`, signal);
      const values = rows.slice(0, limit).map((r) => String(r[0]));
      return { values, matches: rows.length > limit ? limit + 1 : values.length };
    },

    async getCells({ rects, query, signal }) {
      const v = await view(query, signal);
      const rowSrc = [...new Set(rects.flatMap((r) => Array.from({ length: r.rowCount }, (_, i) => r.row + i)))];
      const colSrc = [...new Set(rects.flatMap((r) => Array.from({ length: r.colCount }, (_, i) => r.col + i)))];
      const [rowItems, colItems] = await Promise.all([v.rows.items(rowSrc, signal), v.cols.items(colSrc, signal)]);
      const rowOf = new Map(rowSrc.map((s, i) => [s, rowItems[i]]));
      const colOf = new Map(colSrc.map((s, i) => [s, colItems[i]]));

      // One SELECT per (row depth, column depth) present: its IN lists name only the groups on screen.
      const combos = new Map();
      for (const r of rects) {
        for (let i = 0; i < r.rowCount; i++) {
          const ri = rowOf.get(r.row + i);
          if (!ri) continue;
          for (let j = 0; j < r.colCount; j++) {
            const ci = colOf.get(r.col + j);
            if (!ci || (ri.m < 0 && ci.m < 0)) continue;
            const tag = `${ri.keys.length}:${ci.keys.length}`;
            let c = combos.get(tag);
            if (!c) combos.set(tag, (c = { a: ri.keys.length, b: ci.keys.length, rows: new Map(), cols: new Map() }));
            c.rows.set(ri.keys.join(SEP), ri.keys);
            c.cols.set(ci.keys.join(SEP), ci.keys);
          }
        }
      }
      const Rd = v.rows.realDims, Cd = v.cols.realDims;
      const nullStr = 'CAST(NULL AS Nullable(String))';
      const selects = [...combos.values()].map((c) => {
        const cols = [
          `'${c.a}:${c.b}' AS tag`,
          ...Rd.map((d, i) => (i < c.a ? `toNullable(${S(d)})` : nullStr)),
          ...Cd.map((d, i) => (i < c.b ? `toNullable(${S(d)})` : nullStr)),
          ...M.map((_, i) => mSql(i)),
        ];
        const conds = [...v.whereParts];
        if (c.a) conds.push(tupleIn(Rd.slice(0, c.a), [...c.rows.values()]));
        if (c.b) conds.push(tupleIn(Cd.slice(0, c.b), [...c.cols.values()]));
        const group = [...Rd.slice(0, c.a).map(S), ...Cd.slice(0, c.b).map(S)];
        return `SELECT ${cols.join(', ')} FROM ${T}${where(conds)}${group.length ? ` GROUP BY ${group.join(', ')}` : ''}`;
      });
      const totalCells = rects.reduce((a, r) => a + r.rowCount * r.colCount, 0);
      const data = selects.length
        ? await run('cells', `${rects.length} rect${rects.length > 1 ? 's' : ''} · ${totalCells.toLocaleString('en-US')} cells · ${selects.length} select${selects.length > 1 ? 's' : ''}`, selects.join('\nUNION ALL\n'), signal, totalCells)
        : [];
      const found = new Map();
      for (const row of data) {
        const [a, b] = String(row[0]).split(':').map(Number);
        const rk = row.slice(1, 1 + a).join(SEP);
        const ck = row.slice(1 + Rd.length, 1 + Rd.length + b).join(SEP);
        found.set(`${row[0]}|${rk}|${ck}`, row.slice(1 + Rd.length + Cd.length));
      }
      return rects.map((r) => {
        const out = new Array(r.rowCount * r.colCount).fill(null);
        for (let i = 0; i < r.rowCount; i++) {
          const ri = rowOf.get(r.row + i);
          if (!ri) continue;
          for (let j = 0; j < r.colCount; j++) {
            const ci = colOf.get(r.col + j);
            if (!ci) continue;
            const m = ri.m >= 0 ? ri.m : ci.m;
            if (m < 0) continue;
            const vals = found.get(`${ri.keys.length}:${ci.keys.length}|${ri.keys.join(SEP)}|${ci.keys.join(SEP)}`);
            const val = vals?.[m];
            out[i * r.colCount + j] = val == null || Number.isNaN(val) ? null : val;
          }
        }
        return out;
      });
    },
  };
}
