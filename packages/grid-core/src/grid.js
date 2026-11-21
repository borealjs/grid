// Server-backed DOM virtual grid.
//
// - One native scroll container. Its content box is sized to the virtual table (capped at
//   MAX_SCROLL_PX); a sticky viewport inside it holds everything that is drawn.
// - Body rows and cells live in fixed pools recycled as a ring buffer (slot = index % poolSize), so a
//   scroll step only rewrites rows/columns that entered the window. Rows may have different heights.
// - Row and column headers are span layers: keyed segments that can cover many items and several
//   header bands (multi-level pivot headers, subtotal labels). Their labels stay in view while the span scrolls.
// - Positions are relative to a rebasing anchor, so CSS pixel values stay small at any index.
// - Above MAX_SCROLL_PX the scrollbar maps proportionally (dragging is coarse), while wheel and
//   keyboard input move by exact pixel deltas in virtual space.
// - Cells and labels arrive in blocks through a prioritized, deduplicated, abortable LRU cache.
//
// What is drawn comes from a model: { rows, cols, rowBands, colTiers, rowKind, colKind, rowSegments, colSegments }.
// See models.js for a flat table and a pivot table.

import { MergeIndex, mergePieces } from './merges.js';
import { EMPTY_QUERY, sortToPublic, filterToPublic, columnFilterToPublic, defaultFormat } from './query.js';

/** Texts the grid shows; pass `messages` to translate or reword any of them. */
export const DEFAULT_MESSAGES = {
  noRows: 'No rows match the filter',
  noData: 'No rows',
  filterTitle: (name) => `Filter: ${name}`,
  min: 'Min',
  max: 'Max',
  from: 'From',
  to: 'To',
  contains: 'Contains',
  containsPlaceholder: 'Text to look for',
  find: 'Find',
  searchValues: (total) => (total === undefined ? 'Search values' : `Search ${total.toLocaleString()} values`),
  all: 'All',
  none: 'None',
  loadingValues: 'Loading values…',
  noValues: 'No values match',
  refineSearch: (shown, matches) => `Showing the first ${shown.toLocaleString()} of ${matches.toLocaleString()} — refine the search to see more`,
  valuesFailed: (reason) => `Could not load values: ${reason}`,
  clear: 'Clear',
  apply: 'Apply',
  selectAll: 'Select all',
  columns: 'Columns',
  applying: 'Applying…',
  filterLimit: (limit, total) => `Filtering isn't available here: the data source filters at most ${limit.toLocaleString()} rows (this table has ${total.toLocaleString()})`,
  sortLimit: (limit, total) => `Sorting by several columns isn't available here: the data source sorts at most ${limit.toLocaleString()} rows that way (this table has ${total.toLocaleString()})`,
  failed: (what, reason) => `${what === 'sort' ? 'Sorting' : 'Filtering'} failed: ${reason}`,
};

const MAX_SCROLL_PX = 10_000_000; // below every browser's max element size (Firefox ~17.8M, Chrome ~33.5M)
const REBASE_PX = 200_000;
const JUMP_FETCH_DELAY_MS = 70;
const RETRY_DELAY_MS = 1000;
export const LABEL_BLOCK = 500;
// Shortest run of consecutive source items that is worth a whole block (shorter runs use strips).
const RUN_MIN_ROWS = 8;
const RUN_MIN_COLS = 4;
// The fetch window is widened to multiples of these, so requests go out per chunk crossed, not per step.
const CHUNK_ROWS = 32;
const CHUNK_COLS = 16;
const alignDown = (i, n) => Math.floor(i / n) * n;
const alignUp = (i, n) => Math.floor(i / n) * n + n - 1;

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// Shortcuts use the platform's primary modifier: ⌘ on Apple platforms, Ctrl elsewhere. (On a Mac,
// Ctrl+click is the context menu and Ctrl+arrows switch desktops, so Ctrl must not double as ⌘.)
const IS_MAC = typeof navigator !== 'undefined'
  && /Mac|iPhone|iPad|iPod/i.test(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || '');
const MAX_COPY_CELLS = 100_000;
const COPY_CACHE_MAX = 200_000;

// ------------------------------------------------------------------ axes

/** Every item the same size. */
export class UniformAxis {
  constructor(count, size) {
    this.count = count;
    this.size = size;
    this.total = count * size;
    this.minSize = size;
  }
  offsetOf(i) { return i * this.size; }
  sizeOf() { return this.size; }
  indexAt(px) {
    if (this.count === 0 || px <= 0) return 0;
    return Math.min(Math.floor(px / this.size), this.count - 1);
  }
}

/**
 * Wraps any axis and lets single items be resized (sparse overrides, O(log k) offsets).
 * If the base axis maps visible <-> source indexes (collapsible trees), sizes are remembered by source
 * index, so a resized column keeps its width when groups around it collapse or expand.
 */
export class ResizableAxis {
  constructor(base) {
    this.base = base;
    this.overrides = new Map(); // source index -> px
    this.visibleSizes = new Map(); // visible index -> px
    this.#rebuild();
  }

  get count() { return this.base.count; }

  sizeOf(i) { return this.visibleSizes.get(i) ?? this.base.sizeOf(i); }

  setSize(i, px) {
    const key = typeof this.base.sourceOf === 'function' ? this.base.sourceOf(i) : i;
    if (px === this.base.sizeOf(i)) this.overrides.delete(key);
    else this.overrides.set(key, px);
    this.#rebuild();
  }

  /** Call after the base axis changed its layout (collapse/expand). */
  refresh() {
    this.#rebuild();
  }

  offsetOf(i) { return this.base.offsetOf(i) + this.deltaPrefix[this.#before(i)]; }

  indexAt(px) {
    if (this.keys.length === 0) return this.base.indexAt(px);
    if (this.count === 0 || px <= 0) return 0;
    if (px >= this.total) return this.count - 1;
    let lo = 0;
    let hi = this.count - 1;
    while (lo < hi) {
      const mid = lo + Math.ceil((hi - lo) / 2);
      if (this.offsetOf(mid) <= px) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  #before(i) {
    const { keys } = this;
    let lo = 0;
    let hi = keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (keys[mid] < i) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  #rebuild() {
    const toVisible = typeof this.base.fromSource === 'function' ? (src) => this.base.fromSource(src) : (src) => src;
    this.visibleSizes = new Map();
    for (const [src, px] of this.overrides) {
      const i = toVisible(src);
      if (i >= 0) this.visibleSizes.set(i, px);
    }
    this.keys = [...this.visibleSizes.keys()].sort((a, b) => a - b);
    this.deltaPrefix = new Float64Array(this.keys.length + 1);
    let min = this.base.minSize;
    for (let k = 0; k < this.keys.length; k++) {
      const i = this.keys[k];
      const s = this.visibleSizes.get(i);
      this.deltaPrefix[k + 1] = this.deltaPrefix[k] + s - this.base.sizeOf(i);
      min = Math.min(min, s);
    }
    this.minSize = min;
    this.total = this.base.total + this.deltaPrefix[this.keys.length];
  }
}

// ------------------------------------------------------------------ data cache

/**
 * Keyed async cache: deduplicates requests, limits concurrent HTTP requests, aborts unwanted ones, and
 * evicts least recently used entries once a cell budget is exceeded.
 *
 * Wish-list items either carry their own `load(signal)` (one request each, e.g. a dense block) or a
 * `rect: [r0, c0, nr, nc]` (a gather unit: a strip or a single cell). Queued gather units are batched
 * into one `gather(rects, signal)` call. A batch is aborted only when none of its units is wanted.
 */
export class BlockCache {
  constructor({ maxCells = 2_000_000, maxEntries = 50_000, concurrency = 6, maxGatherRects = 400, maxGatherCells = 20_000, gather, onLoad, onError }) {
    this.maxCells = maxCells;
    this.maxEntries = maxEntries;
    this.concurrency = concurrency;
    this.maxGatherRects = maxGatherRects;
    this.maxGatherCells = maxGatherCells;
    this.gather = gather;
    this.onLoad = onLoad;
    this.onError = onError;
    this.entries = new Map(); // insertion order = LRU order
    this.cellCount = 0;
    this.inflight = new Map(); // key -> flight
    this.flights = new Set();
    this.queue = [];
    this.wanted = new Set();
    this.stats = { requests: 0, gatherRequests: 0, gatherUnits: 0, cellsFetched: 0, aborted: 0, errors: 0, lastMs: 0 };
  }

  get(key) {
    const value = this.entries.get(key);
    if (value !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  /** Replace the wish list: [{ key, load(signal) } | { key, rect }] in priority order. */
  request(list) {
    this.wanted = new Set(list.map((item) => item.key));
    for (const [key, flight] of this.inflight) {
      if (this.wanted.has(key)) continue;
      this.inflight.delete(key);
      flight.keys.delete(key);
      if (flight.keys.size === 0) {
        flight.controller.abort();
        this.flights.delete(flight);
        this.stats.aborted++;
      }
    }
    this.queue = list.filter((item) => !this.entries.has(item.key) && !this.inflight.has(item.key));
    this.#pump();
  }

  abortAll() {
    for (const flight of this.flights) flight.controller.abort();
    this.flights.clear();
    this.inflight.clear();
    this.queue = [];
  }

  #pump() {
    while (this.flights.size < this.concurrency && this.queue.length > 0) {
      const first = this.queue.shift();
      const batch = [first];
      if (first.rect) {
        // Pull every other queued gather unit into the same request, up to the size limits.
        let cells = first.rect[2] * first.rect[3];
        for (let i = 0; i < this.queue.length && batch.length < this.maxGatherRects; ) {
          const item = this.queue[i];
          const n = item.rect ? item.rect[2] * item.rect[3] : Infinity;
          if (cells + n <= this.maxGatherCells) {
            batch.push(item);
            cells += n;
            this.queue.splice(i, 1);
          } else {
            i++;
          }
        }
      }
      const controller = new AbortController();
      const flight = { controller, keys: new Set(batch.map((item) => item.key)) };
      this.flights.add(flight);
      for (const item of batch) this.inflight.set(item.key, flight);
      this.stats.requests++;
      if (first.rect) {
        this.stats.gatherRequests++;
        this.stats.gatherUnits += batch.length;
      }
      const started = performance.now();
      const work = first.rect
        ? this.gather(batch.map((item) => item.rect), controller.signal).then((arrays) =>
            batch.map((item, i) => {
              const [r0, c0, nr, nc] = item.rect;
              return [item.key, { r0, c0, nr, nc, cells: arrays[i] }];
            }))
        : first.load(controller.signal).then((value) => [[first.key, value]]);
      work
        .then(
          (results) => {
            this.flights.delete(flight);
            for (const [key, value] of results) {
              if (this.inflight.get(key) === flight) this.inflight.delete(key);
              this.#store(key, value); // keep units that went out of view meanwhile too: already paid for
            }
            this.stats.lastMs = performance.now() - started;
            this.onLoad?.();
          },
          (err) => {
            this.flights.delete(flight);
            for (const key of flight.keys) if (this.inflight.get(key) === flight) this.inflight.delete(key);
            if (err?.name === 'AbortError') return;
            this.stats.errors++;
            console.warn(`Request for ${[...flight.keys].slice(0, 3).join(', ')}${flight.keys.size > 3 ? '…' : ''} failed:`, err);
            this.onError?.(err);
          },
        )
        .finally(() => this.#pump());
    }
  }

  #store(key, value) {
    const old = this.entries.get(key);
    if (old !== undefined) {
      this.cellCount -= sizeOfEntry(old);
      this.entries.delete(key);
    }
    this.entries.set(key, value);
    const n = sizeOfEntry(value);
    this.cellCount += n;
    this.stats.cellsFetched += n;
    while ((this.cellCount > this.maxCells || this.entries.size > this.maxEntries) && this.entries.size > 1) {
      const [oldestKey, oldest] = this.entries.entries().next().value;
      this.entries.delete(oldestKey);
      this.cellCount -= sizeOfEntry(oldest);
    }
  }
}

const sizeOfEntry = (value) => value?.cells?.length ?? value?.names?.length ?? 1;

// ------------------------------------------------------------------ header span layer

/**
 * Draws header segments: { key, a, b (item range), t0, t1 (band range), label, cls, resizable }.
 * Elements are keyed, so a segment that stays on screen keeps its node; others reuse hidden ones.
 * Segments are clipped to the drawn window, so a group spanning a billion rows stays a small box.
 */
class SpanLayer {
  constructor(layer, vertical, withGrip, withSort = false, axisName = '') {
    this.axisName = axisName;
    this.renderHeader = null;
    this.hasRenderer = () => false;
    this.withSort = withSort;
    this.layer = layer;
    this.vertical = vertical;
    this.withGrip = withGrip;
    this.live = new Map();
    this.free = [];
  }

  #create() {
    const el = document.createElement('div');
    el.setAttribute('role', this.vertical ? 'rowheader' : 'columnheader');
    const label = document.createElement('span');
    label.className = 'vg-sl';
    const text = label.appendChild(document.createTextNode(''));
    el.appendChild(label);
    let sortBtn = null;
    let filterBtn = null;
    if (this.withSort) {
      filterBtn = makeFilterButton();
      el.appendChild(filterBtn);
      sortBtn = makeSortButton();
      el.appendChild(sortBtn);
    }
    if (this.withGrip) {
      const grip = document.createElement('div');
      grip.className = 'vg-grip';
      el.appendChild(grip);
    }
    this.layer.appendChild(el);
    return { el, label, text, box: null, cleanup: undefined, rsig: '', sortBtn, filterBtn, sort: '', filter: '', pos: NaN, cpos: NaN, size: NaN, csize: NaN, lh: NaN, shift: 0, cls: '', str: null, item: '', toggle: '', range: '', hidden: false };
  }

  render(segments, ctx) {
    const { axis, anchorPx, viewStart, lo, hi, bandOff, labelExtent } = ctx;
    const v = this.vertical;
    const next = new Map();
    for (const seg of segments) {
      const a = Math.max(seg.a, lo);
      const b = Math.min(seg.b, hi);
      if (a > b) continue;
      let e = this.live.get(seg.key);
      if (e !== undefined) this.live.delete(seg.key);
      else e = this.free.pop() ?? this.#create();
      next.set(seg.key, e);
      if (e.hidden) {
        e.el.style.display = '';
        e.hidden = false;
      }

      const p0 = axis.offsetOf(a);
      const pos = p0 - anchorPx;
      const size = axis.offsetOf(b + 1) - p0;
      const cpos = bandOff[seg.t0];
      const csize = bandOff[seg.t1 + 1] - cpos;
      if (pos !== e.pos || cpos !== e.cpos) {
        e.el.style.transform = v ? `translate3d(${cpos}px,${pos}px,0)` : `translate3d(${pos}px,${cpos}px,0)`;
        e.pos = pos;
        e.cpos = cpos;
      }
      if (size !== e.size || csize !== e.csize) {
        e.el.style.width = `${v ? csize : size}px`;
        e.el.style.height = `${v ? size : csize}px`;
        e.size = size;
        e.csize = csize;
      }
      // Label line box: a single row centers in its row; a tall span keeps a one-row label at its top.
      const lh = v ? (seg.a === seg.b ? size : Math.min(size, labelExtent)) : csize;
      if (lh !== e.lh) {
        e.label.style.lineHeight = `${lh}px`;
        e.lh = lh;
      }
      // Keep the label inside the visible part of a span that started off screen.
      const extent = v ? lh : labelExtent;
      const shift = size > extent ? clamp(viewStart - pos, 0, size - extent) : 0;
      if (shift !== e.shift) {
        e.label.style.transform = v ? `translate3d(0,${shift}px,0)` : `translate3d(${shift}px,0,0)`;
        e.shift = shift;
      }
      const pending = seg.label === undefined;
      const cls = `vg-seg${seg.cls ? ` ${seg.cls}` : ''}${pending ? ' vg-ph' : ''}${seg.selected ? ' vg-sel' : ''}${this.withSort && seg.sort ? ' vg-sortable' : ''}${this.withSort && seg.filter ? ' vg-filterable' : ''}`;
      if (cls !== e.cls) {
        e.el.className = cls;
        e.cls = cls;
      }
      // Item range this header covers (unclipped), for selecting whole rows/columns by clicking it.
      const range = `${seg.a}:${seg.b}`;
      if (range !== e.range) {
        e.el.dataset.range = range;
        e.range = range;
      }
      const str = pending ? '' : seg.label;
      // A header renderer (the segment's own, else the grid's) draws the label once it is loaded.
      const render = pending ? null : seg.render ?? (this.hasRenderer() ? this.renderHeader : null);
      if (render) {
        const st = seg.sortState;
        const rsig = `${seg.key}|${str}|${st ? st.dir + st.priority : ''}|${seg.filterOn ? 1 : 0}|${seg.selected ? 1 : 0}`;
        if (rsig !== e.rsig) {
          this.#clearCustom(e);
          e.rsig = rsig;
          if (!e.box) {
            e.box = document.createElement('span');
            e.box.className = 'vg-hbox';
            e.label.appendChild(e.box);
          }
          e.box.hidden = false;
          e.text.data = '';
          e.str = null;
          const out = render(e.box, {
            axis: this.axisName,
            label: str,
            level: seg.t0,
            start: seg.a,
            end: seg.b,
            column: seg.column,
            source: seg.source,
            kind: seg.cls ?? '',
            sorted: st ? (st.dir === 'a' ? 'asc' : 'desc') : null,
            sortPriority: st ? st.priority : 0,
            filtered: !!seg.filterOn,
          });
          e.cleanup = typeof out === 'function' ? out : null;
        }
      } else {
        if (e.rsig) {
          this.#clearCustom(e);
          e.rsig = '';
          if (e.box) e.box.hidden = true;
        }
        if (str !== e.str) {
          e.text.data = str;
          e.str = str;
        }
      }
      // Expand/collapse target: "axis:level:group", plus aria-expanded for assistive tech.
      const toggle = seg.toggle ? `${seg.toggle.axis}:${seg.toggle.level}:${seg.toggle.group}` : '';
      const expanded = seg.toggle ? String(!seg.toggle.collapsed) : '';
      if (toggle + expanded !== e.toggle) {
        if (toggle) {
          e.el.dataset.toggle = toggle;
          e.el.setAttribute('aria-expanded', expanded);
        } else {
          delete e.el.dataset.toggle;
          e.el.removeAttribute('aria-expanded');
        }
        e.toggle = toggle + expanded;
      }
      if (this.withSort) {
        // Filter control: key id and whether a filter is set on it.
        const filter = seg.filter ? `${sortKeyId(seg.filter)}|${seg.filterOn ? 1 : 0}` : '';
        if (filter !== e.filter) {
          e.filter = filter;
          if (seg.filter) e.filterBtn.dataset.filterKey = sortKeyId(seg.filter);
          else delete e.filterBtn.dataset.filterKey;
          paintFilterButton(e.filterBtn, seg.filter ? !!seg.filterOn : undefined);
        }
        // Sort control: key id (c<col> / d<dim>), direction and priority, plus aria-sort for the primary key.
        const st = seg.sortState;
        const sort = seg.sort ? `${sortKeyId(seg.sort)}|${st ? st.dir + st.priority : ''}` : '';
        if (sort !== e.sort) {
          e.sort = sort;
          if (seg.sort) e.sortBtn.dataset.sortKey = sortKeyId(seg.sort);
          else delete e.sortBtn.dataset.sortKey;
          paintSortButton(e.sortBtn, seg.sort ? st : undefined);
          if (st && st.priority <= 1) e.el.setAttribute('aria-sort', st.dir === 'a' ? 'ascending' : 'descending');
          else e.el.removeAttribute('aria-sort');
        }
      }
      if (this.withGrip) {
        const item = seg.resizable && seg.a === seg.b ? String(seg.a) : '';
        if (item !== e.item) {
          if (item) e.el.dataset.item = item;
          else delete e.el.dataset.item;
          e.item = item;
        }
      }
    }
    for (const e of this.live.values()) {
      if (!e.hidden) {
        e.el.style.display = 'none';
        e.hidden = true;
      }
      if (e.rsig) {
        this.#clearCustom(e);
        e.rsig = '';
        if (e.box) e.box.hidden = true;
      }
      this.free.push(e);
    }
    this.live = next;
  }

  #clearCustom(e) {
    if (e.cleanup) e.cleanup();
    else if (e.cleanup === null && e.box) e.box.textContent = '';
    e.cleanup = undefined;
  }

  /** Forget what custom renderers drew, so every segment is drawn again. */
  resetCustom() {
    // Mark custom content stale; the next frame replaces it in one step (clearing it now would leave
    // headers blank while nothing is drawn, e.g. while the grid has no rows).
    for (const e of this.live.values()) {
      if (e.rsig) e.rsig = '~';
      e.str = null;
    }
  }

  destroy() {
    for (const e of [...this.live.values(), ...this.free]) this.#clearCustom(e);
  }
}

/**
 * Draws merged-cell pieces over the body cells: { key, vr0, vr1, vc0, vc1, text }.
 * Keyed like SpanLayer; the label stays in the visible part of a piece taller or wider than the view.
 */
class MergeLayer {
  constructor(layer) {
    this.layer = layer;
    this.live = new Map();
    this.free = [];
  }

  #create() {
    const el = document.createElement('div');
    el.setAttribute('role', 'gridcell');
    const label = document.createElement('span');
    label.className = 'vg-ml';
    const text = label.appendChild(document.createTextNode(''));
    el.appendChild(label);
    this.layer.appendChild(el);
    return { el, label, text, x: NaN, y: NaN, w: NaN, h: NaN, lh: NaN, sx: 0, sy: 0, cls: '', str: null, hidden: false };
  }

  render(pieces, { rows, cols, anchorRowPx, anchorColPx, ox, oy }) {
    const next = new Map();
    for (const p of pieces) {
      let e = this.live.get(p.key);
      if (e !== undefined) this.live.delete(p.key);
      else e = this.free.pop() ?? this.#create();
      next.set(p.key, e);
      if (e.hidden) {
        e.el.style.display = '';
        e.hidden = false;
      }
      const top = rows.offsetOf(p.vr0);
      const left = cols.offsetOf(p.vc0);
      const y = top - anchorRowPx;
      const x = left - anchorColPx;
      const h = rows.offsetOf(p.vr1 + 1) - top;
      const w = cols.offsetOf(p.vc1 + 1) - left;
      if (x !== e.x || y !== e.y) {
        e.el.style.transform = `translate3d(${x}px,${y}px,0)`;
        e.x = x;
        e.y = y;
      }
      if (w !== e.w || h !== e.h) {
        e.el.style.width = `${w}px`;
        e.el.style.height = `${h}px`;
        e.w = w;
        e.h = h;
      }
      const lh = p.vr0 === p.vr1 ? h : Math.min(h, rows.sizeOf(p.vr0));
      if (lh !== e.lh) {
        e.label.style.lineHeight = `${lh}px`;
        e.lh = lh;
      }
      const sx = w > 160 ? clamp(ox - x, 0, w - 160) : 0;
      const sy = h > lh ? clamp(oy - y, 0, h - lh) : 0;
      if (sx !== e.sx || sy !== e.sy) {
        e.label.style.transform = `translate3d(${sx}px,${sy}px,0)`;
        e.sx = sx;
        e.sy = sy;
      }
      const pending = p.text === undefined;
      const cls = `vg-merge${p.merge.code ? ' vg-merge-code' : ''}${pending ? ' vg-ph' : ''}`;
      if (cls !== e.cls) {
        e.el.className = cls;
        e.cls = cls;
      }
      const str = pending ? '' : p.text;
      if (str !== e.str) {
        e.text.data = str;
        e.str = str;
      }
    }
    for (const e of this.live.values()) {
      if (!e.hidden) {
        e.el.style.display = 'none';
        e.hidden = true;
      }
      this.free.push(e);
    }
    this.live = next;
  }
}

/**
 * Draws the selection over the body: one translucent box per range (clipped to the drawn window, with
 * no border on clipped sides) and an outline around the active cell (or the merged cell it is in).
 */
class SelectionLayer {
  constructor(layer) {
    this.layer = layer;
    this.boxes = [];
    this.active = this.#make('vg-active');
    this.activeState = '';
  }

  #make(cls) {
    const el = document.createElement('div');
    el.className = cls;
    el.setAttribute('aria-hidden', 'true');
    this.layer.appendChild(el);
    return el;
  }

  /** rects: { x, y, w, h, edges } where edges is a 4-char mask (top, right, bottom, left; 1 = drawn). */
  render(rects, activeRect) {
    while (this.boxes.length < rects.length) this.boxes.push({ el: this.#make('vg-selbox'), state: '' });
    this.boxes.forEach((box, i) => {
      const r = rects[i];
      const state = r ? `${r.x},${r.y},${r.w},${r.h},${r.edges}` : 'hidden';
      if (state === box.state) return;
      box.state = state;
      if (!r) {
        box.el.style.display = 'none';
        return;
      }
      box.el.style.display = '';
      box.el.style.transform = `translate3d(${r.x}px,${r.y}px,0)`;
      box.el.style.width = `${r.w}px`;
      box.el.style.height = `${r.h}px`;
      box.el.style.borderWidth = [...r.edges].map((on) => (on === '1' ? '1px' : '0')).join(' ');
    });
    const state = activeRect ? `${activeRect.x},${activeRect.y},${activeRect.w},${activeRect.h}` : 'hidden';
    if (state !== this.activeState) {
      this.activeState = state;
      if (!activeRect) {
        this.active.style.display = 'none';
      } else {
        this.active.style.display = '';
        this.active.style.transform = `translate3d(${activeRect.x}px,${activeRect.y}px,0)`;
        this.active.style.width = `${activeRect.w}px`;
        this.active.style.height = `${activeRect.h}px`;
      }
    }
  }
}

// ------------------------------------------------------------------ grid

export class VirtualGrid {
  #raf = 0;
  #fetchTimer = 0;
  #retryTimer = 0;
  #expectTop = null;
  #expectLeft = null;
  #lastWantSig = '';
  #lastFirstRow = 0;
  #lastFirstCol = 0;
  #win = null;
  #labelNeeds = new Set();
  #ro;
  #xs = new Float64Array(0);
  #ws = new Float64Array(0);
  #colSrc = new Float64Array(0);
  #colExact = new Uint8Array(0);
  #rowSrc = new Float64Array(0);
  #rowExact = new Uint8Array(0);
  #cover = new Uint8Array(0);
  #mergeAnchors = new Set();
  #pieces = [];
  #views = new Map(); // view signature -> { cache, copyCache } (LRU)
  #colLabelCaches = new Map(); // server column filter -> BlockCache of column labels
  #view = null;
  #sortSeq = 0;
  #filterPop = null;
  #emptyShown = false;
  #emptySig = '';
  #cornerSort = [];
  #idSeq = 0;
  #uid = `vg${Math.random().toString(36).slice(2, 8)}`;
  #activeId = '';
  #kinds = [];
  #infos = [];
  #defaultInfo = null;

  /**
   * @param {HTMLElement} host
   * @param {object} options
   * @param {object} options.model see models.js
   * @param {(q: {r0:number,c0:number,nr:number,nc:number,signal:AbortSignal}) => Promise<string[]>} options.fetchBlock row-major cell text
   * @param {(q: {axis:string,level:number,from:number,n:number,signal:AbortSignal}) => Promise<string[]>} options.fetchLabels header labels
   */
  constructor(host, options) {
    const o = (this.o = {
      blockRows: 100,
      blockCols: 20,
      overscanRows: 6,
      overscanCols: 2,
      minColWidth: 48,
      sortable: true,
      filterable: true,
      resizable: true,
      multiSort: true,
      expandable: true,
      selection: 'multi', // 'multi' | 'single' | 'none'
      copy: true,
      keyboard: true,
      theme: 'auto', // 'auto' | 'light' | 'dark'
      ...options,
    });
    if (!o.model || typeof o.fetchBlock !== 'function' || typeof o.fetchLabels !== 'function') {
      throw new TypeError('VirtualGrid needs a model plus fetchBlock and fetchLabels functions');
    }
    this.msg = { ...DEFAULT_MESSAGES, ...o.messages };
    this.model = o.model;
    this.rows = o.model.rows;
    this.cols = o.model.cols;
    // Data is addressed by source index (position in the fully expanded data), which does not change
    // when groups collapse, so cached blocks stay valid. Flat models use the identity.
    this.rowSource = o.model.rowSource ?? ((r) => r);
    this.colSource = o.model.colSource ?? ((c) => c);
    this.rowBandOff = prefixSums(o.model.rowBands.map((b) => b.width));
    this.tierOff = prefixSums(o.model.colTiers.map((t) => t.height));
    this.rowHeaderWidth = this.rowBandOff[this.rowBandOff.length - 1];
    this.headerHeight = this.tierOff[this.tierOff.length - 1];
    this.vx = 0;
    this.vy = 0;
    this.dirX = 0;
    this.dirY = 0;
    this.rendered = { vx: NaN, vy: NaN };
    this.anchorRow = null;
    this.anchorRowPx = 0;
    this.anchorCol = null;
    this.anchorColPx = 0;
    this.rowSlots = [];
    this.N = 0;
    this.M = 0;
    this.stats = { renders: 0, renderMsEma: 0, renderMsMax: 0, rowWrites: 0, cellWrites: 0 };
    this.isMac = o.isMac ?? IS_MAC;
    this.canGather = typeof o.fetchGather === 'function';
    // Merged body cells: set from code with setMerges(), or delivered by the server with the data.
    this.merges = new MergeIndex();
    // Sorting: [{ key: { col } | { dim }, dir: 'a' | 'd' }], highest priority first. Each sort order is
    // its own "view" of the data with its own cache, so switching back to an earlier order is instant.
    this.sortSpec = [];
    this.sortParam = '';
    // Filtering: server-format conditions, one per column: { c | dim, op: 'range'|'in'|'contains', … }.
    this.filterSpec = [];
    this.filterParam = '';
    // Column filtering: conditions on column dimensions { dim: level, op: 'in'|'contains', v }. A pivot sends
    // them to the server (columns and their totals change); a flat model hides columns itself.
    this.colFilterSpec = [];
    this.colFilterParam = '';
    // Initial view (already reflected in the model by whoever built it).
    if (o.initial) {
      this.sortSpec = o.initial.sort ?? [];
      this.filterSpec = o.initial.filter ?? [];
      this.colFilterSpec = o.initial.columnFilter ?? [];
      this.sortParam = sortParamOf(this.sortSpec);
      this.filterParam = filterParamOf(this.filterSpec);
      this.colFilterParam = filterParamOf(this.colFilterSpec);
    }
    this.query = this.#publicQuery();
    // Column header labels do not depend on how rows are sorted or filtered, so they live in a cache shared
    // by all row views (row labels can: pivot groups are reordered, so they stay per view). A server-side
    // column filter does change them, so there is one such cache per column filter.
    this.#useColLabels();
    this.#useView();

    // Selection, in visible coordinates. `anchor` is where a range started, `focus` the corner being
    // moved (Shift+arrows / drag), `active` the cell with the outline (stays at the anchor while extending).
    const origin = { r: 0, c: 0 };
    this.sel = { active: origin, anchor: origin, focus: origin, ranges: [{ r0: 0, c0: 0, r1: 0, c1: 0 }] };

    this.#buildDom(host);
    this.#ro = new ResizeObserver(() => this.#measure());
    this.#ro.observe(this.scroller);
    this.#measure();
  }

  // ---------------------------------------------------------------- public API

  /** Scroll so that the given virtual pixel offsets are at the top-left of the body. */
  scrollToVirtual(x, y) {
    this.vx = clamp(x, 0, this.maxVX);
    this.vy = clamp(y, 0, this.maxVY);
    const sl = this.vx / this.ratioX;
    const st = this.vy / this.ratioY;
    this.#expectLeft = sl;
    this.#expectTop = st;
    if (Math.abs(this.scroller.scrollLeft - sl) >= 0.5) this.scroller.scrollLeft = sl;
    if (Math.abs(this.scroller.scrollTop - st) >= 0.5) this.scroller.scrollTop = st;
    this.#render();
  }

  scrollToCell(row, col) {
    const r = clamp(Math.floor(row), 0, Math.max(0, this.rows.count - 1));
    const c = clamp(Math.floor(col), 0, Math.max(0, this.cols.count - 1));
    this.scrollToVirtual(this.cols.offsetOf(c), this.rows.offsetOf(r));
  }

  setColumnWidth(col, width) {
    if (typeof this.cols.setSize !== 'function') return;
    const w = Math.max(this.o.minColWidth, Math.round(width));
    if (w === this.cols.sizeOf(col)) return;
    this.cols.setSize(col, w);
    this.#updateContentSize();
    this.#ensurePools();
    this.anchorCol = null; // reposition every cell
    this.rendered.vx = NaN;
    this.scrollToVirtual(this.vx, this.vy);
  }

  /**
   * Replace the merges set from code. Each is { r0, c0, nr, nc, label? } (or [r0, c0, nr, nc, label?])
   * in source coordinates (for a flat table: row/column indexes). Shows the top-left cell's value
   * unless `label` is given. Code merges win over server merges where they overlap.
   */
  setMerges(list) {
    this.merges.setCode(list);
    this.invalidate();
  }

  /**
   * Expand or collapse one group. The group's header stays where it is on screen; if the viewport
   * started inside the group, the group's first item lands at the top.
   */
  toggleGroup(axis, level, group) {
    if (typeof this.model.toggleGroup !== 'function') return;
    const isRows = axis === 'rows';
    const ax = isRows ? this.rows : this.cols;
    const start = this.model.groupStart(axis, level, group);
    if (start < 0) return;
    const keep = (isRows ? this.vy : this.vx) - ax.offsetOf(start);
    const snap = this.#captureSelection();
    this.model.toggleGroup(axis, level, group);
    this.#structureChanged();
    this.#restoreSelection(snap);
    const target = ax.offsetOf(this.model.groupStart(axis, level, group)) + Math.min(keep, 0);
    if (isRows) this.scrollToVirtual(this.vx, target);
    else this.scrollToVirtual(target, this.vy);
  }

  /**
   * Run a structural change on one axis (for example "show rows down to Country") and keep the item at
   * the top-left of the viewport in place; if it got folded into a collapsed group, show that group.
   */
  restructure(axis, mutate) {
    const isRows = axis === 'rows';
    const ax = isRows ? this.rows : this.cols;
    const first = this.#win ? (isRows ? this.#win.firstRow : this.#win.firstCol) : 0;
    const src = this.model.anchorOf ? this.model.anchorOf(axis, first) : (isRows ? this.rowSource : this.colSource)(first);
    const within = (isRows ? this.vy : this.vx) - ax.offsetOf(first);
    const snap = this.#captureSelection();
    mutate();
    this.#structureChanged();
    this.#restoreSelection(snap);
    const [idx, exact] = this.model.visibleOf(axis, src);
    const target = ax.offsetOf(idx) + (exact ? within : 0);
    if (isRows) this.scrollToVirtual(this.vx, target);
    else this.scrollToVirtual(target, this.vy);
  }

  // ---------------------------------------------------------------- query and events

  #keyOf = (col) => this.model.keyOf?.(col);

  #publicQuery(sortList = this.sortSpec, filterList = this.filterSpec, colFilterList = this.colFilterSpec) {
    return {
      sort: sortToPublic(sortList, this.#keyOf),
      filter: filterToPublic(filterList, this.#keyOf),
      columnFilter: columnFilterToPublic(colFilterList),
    };
  }

  /** Sort / filter / column filter in the public format. */
  getQuery() {
    return this.#publicQuery();
  }

  #emit(kind, list) {
    if (kind === 'sort') this.o.onSortChange?.(sortToPublic(list, this.#keyOf));
    else if (kind === 'filter') this.o.onFilterChange?.(filterToPublic(list, this.#keyOf));
    else this.o.onColumnFilterChange?.(columnFilterToPublic(list));
  }

  /**
   * A change the user asked for (header click, filter dialog, shortcut). Controlled state only reports
   * it (the owner applies it with setSort / setFilter / setColumnDimFilter); otherwise it is applied
   * and reported once it worked.
   */
  #userChange(kind, list) {
    if (this.o.controlled?.[kind]) {
      this.#emit(kind, list);
      return Promise.resolve(false);
    }
    const run = kind === 'sort' ? this.setSort(list) : kind === 'filter' ? this.setFilter(list) : this.setColumnDimFilter(list);
    return run.then((ok) => {
      if (ok) this.#emit(kind, kind === 'sort' ? this.sortSpec : kind === 'filter' ? this.filterSpec : this.colFilterSpec);
      return ok;
    });
  }

  /** Drop every cached cell and label and load what is on screen again (the data changed). */
  async refresh() {
    for (const v of this.#views.values()) v.cache.abortAll();
    for (const c of this.#colLabelCaches.values()) c.abortAll();
    this.#views.clear();
    this.#colLabelCaches.clear();
    this.#view = null;
    if (this.model.reload) {
      try {
        await this.model.reload({ query: this.query, sort: this.sortParam, filter: this.filterParam, colfilter: this.#serverColFilter });
      } catch (err) {
        this.o.onError?.(err, { kind: 'layout' });
      }
      this.rows = this.model.rows;
      this.cols = this.model.cols;
    }
    this.colLabels = null;
    this.#useColLabels();
    this.#useView();
    this.#structureChanged();
    this.sel = {
      active: this.#clampCell(this.sel.active),
      anchor: this.#clampCell(this.sel.anchor),
      focus: this.#clampCell(this.sel.focus),
      ranges: this.sel.ranges.map((g) => this.#clampRange(g)),
    };
    this.repaint();
  }

  /** Redraw every cell and header (after format / render functions changed). The data stays. */
  repaint() {
    for (const slot of this.rowSlots) for (const cell of slot.cells) cell.c = -1;
    this.colSpans.resetCustom();
    this.rowSpans.resetCustom();
    this.anchorCol = null;
    this.rendered.vx = NaN;
    this.invalidate();
  }

  // ---------------------------------------------------------------- sorting

  /**
   * Sort by the given keys (highest priority first): [{ key: { col: sourceColumn } | { dim: level }, dir: 'a'|'d' }].
   * The server does the sorting; the grid switches to that order's cache and keeps the scroll position
   * and the selection's position. Resolves to true when the sort was applied.
   */
  setSort(spec) {
    const list = (spec ?? []).slice(0, 4).map((x) => ({ key: { ...x.key }, dir: x.dir === 'd' ? 'd' : 'a' }));
    return this.#applyView(list, this.filterSpec, 'sort');
  }

  /**
   * Filter rows (conditions are ANDed; one per column): [{ c: sourceColumn | dim: level, op, min?, max?, v? }]
   * with op 'range' (min/max: numbers or YYYY-MM-DD), 'in' (v: list of texts) or 'contains' (v: text).
   */
  setFilter(conditions) {
    const list = (conditions ?? []).map((c) => ({ ...c }));
    return this.#applyView(this.sortSpec, list, 'filter');
  }

  /**
   * Filter the columns by their dimensions: [{ dim: columnLevel, op: 'in' | 'contains', v }] (a pivot's
   * Measure/Year/Quarter/Month; a flat table's column types).
   */
  setColumnDimFilter(conditions) {
    const list = (conditions ?? []).map((c) => ({ ...c }));
    return this.#applyView(this.sortSpec, this.filterSpec, 'columns', list);
  }

  /** Set (or with null, clear) the condition for one column / row dimension / column dimension. */
  setColumnFilter(key, condition) {
    if (key.cdim !== undefined) {
      const rest = this.colFilterSpec.filter((f) => f.dim !== key.cdim);
      return this.#userChange('columnFilter', condition ? [...rest, { ...condition, dim: key.cdim }] : rest);
    }
    const rest = this.filterSpec.filter((f) => !sameFilterKey(f, key));
    return this.#userChange('filter', condition ? [...rest, { ...condition, ...filterKeyFields(key) }] : rest);
  }

  /** Whether a filter is set on a key (column, row dimension or column dimension). */
  #hasFilter(key) {
    if (key.cdim !== undefined) return this.colFilterSpec.some((f) => f.dim === key.cdim);
    return this.filterSpec.some((f) => sameFilterKey(f, key));
  }

  /**
   * Opens the filter dialog for a column / row dimension, under `anchor` (a header button) or at the
   * top of the grid. The model describes the filter: { kind: 'number'|'date'|'text'|'values', values?, name }.
   */
  async openFilter(key, anchor) {
    this.closeFilter();
    let desc;
    try {
      desc = await this.model.filterOptions(key, (axis, level, idx) => this.#labelFromCache(axis, level, idx));
    } catch (err) {
      this.o.onViewChange?.({ ok: false, what: 'filter', reason: `Could not load filter options: ${err.message}` });
      return;
    }
    if (!desc) return;
    const current = key.cdim !== undefined ? this.colFilterSpec.find((f) => f.dim === key.cdim) : this.filterSpec.find((f) => sameFilterKey(f, key));
    const el = (tag, cls, parent, text) => {
      const node = document.createElement(tag);
      if (cls) node.className = cls;
      if (text !== undefined) node.textContent = text;
      parent?.appendChild(node);
      return node;
    };
    const pop = el('div', 'vg-filter-pop');
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', `Filter ${desc.name}`);
    el('div', 'vg-filter-title', pop, this.msg.filterTitle(desc.name));
    const body = el('div', 'vg-filter-body', pop);
    const field = (labelText, type, value) => {
      const label = el('label', 'vg-filter-field', body);
      el('span', '', label, labelText);
      const input = el('input', '', label);
      input.type = type;
      if (type === 'number') input.step = 'any';
      if (value !== undefined) input.value = String(value);
      return input;
    };
    let read; // () => condition | null (no filter)
    let onClose = null;
    const m = this.msg;
    if (desc.kind === 'custom') {
      // A filter the column brings itself: render(el, api) draws it; Apply sends { op, v: value }.
      const box = el('div', 'vg-filter-custom', body);
      let value = current?.v;
      const api = {
        value,
        condition: current ? filterToPublic([current], this.#keyOf)[0] : null,
        column: desc.column,
        title: desc.name,
        setValue: (v) => { value = v; },
        apply: (v) => finish(v === undefined ? (value === undefined || value === null ? null : { op: desc.op, v: value }) : v === null ? null : { op: desc.op, v }),
        clear: () => finish(null),
        close: () => {
          this.closeFilter();
          this.scroller.focus({ preventScroll: true });
        },
      };
      const cleanup = desc.render(box, api);
      read = () => (value === undefined || value === null ? null : { op: desc.op, v: value });
      onClose = () => {
        if (typeof cleanup === 'function') cleanup();
      };
    } else if (desc.kind === 'number' || desc.kind === 'date') {
      const type = desc.kind === 'number' ? 'number' : 'date';
      const lo = field(desc.kind === 'number' ? m.min : m.from, type, current?.min);
      const hi = field(desc.kind === 'number' ? m.max : m.to, type, current?.max);
      read = () => {
        const parse = (input) => (input.value === '' ? undefined : type === 'number' ? Number(input.value) : input.value);
        const min = parse(lo);
        const max = parse(hi);
        return min === undefined && max === undefined ? null : { op: 'range', min, max };
      };
    } else if (desc.kind === 'text') {
      const input = field(m.contains, 'search', current?.v);
      input.placeholder = m.containsPlaceholder;
      read = () => (input.value.trim() ? { op: 'contains', v: input.value.trim() } : null);
    } else {
      // Lists can be huge (100k years, millions of cities), so the dialog never holds them all: it shows
      // at most FILTER_LIST_LIMIT names matching the search (from the server, or from desc.values) and
      // remembers the choice as "all except …" or "only …", which become 'notin' / 'in' conditions.
      const search = field(m.find, 'search');
      search.placeholder = m.searchValues();
      const tools = el('div', 'vg-filter-tools', body);
      const all = el('button', '', tools, m.all);
      const none = el('button', '', tools, m.none);
      all.type = 'button';
      none.type = 'button';
      const list = el('div', 'vg-filter-list', body);
      list.setAttribute('role', 'group');
      list.setAttribute('aria-label', `${desc.name} values`);
      const note = el('div', 'vg-filter-note', body);
      note.setAttribute('role', 'status');
      const lookup = desc.search ?? (async (q) => {
        const needle = q.trim().toLowerCase();
        const matching = needle ? desc.values.filter((v) => v.toLowerCase().includes(needle)) : desc.values;
        return { total: desc.values.length, matches: matching.length, values: matching.slice(0, FILTER_LIST_LIMIT) };
      });
      let only = current?.op === 'in'; // false: "all except set"
      const set = new Set(current?.op === 'in' || current?.op === 'notin' ? current.v : []);
      const isChecked = (v) => (only ? set.has(v) : !set.has(v));
      const setChecked = (v, on) => {
        if (only === on) set.add(v);
        else set.delete(v);
      };
      let shown = []; // { value, box }
      let fullList = null; // every value, when one unsearched response held them all
      const renderList = (res) => {
        list.textContent = '';
        shown = res.values.map((value) => {
          const row = el('label', 'vg-filter-option', list);
          const box = el('input', '', row);
          box.type = 'checkbox';
          box.checked = isChecked(value);
          box.addEventListener('change', () => setChecked(value, box.checked));
          el('span', '', row, value);
          return { value, box };
        });
        const total = res.total ?? res.values.length;
        const matches = res.matches ?? res.values.length;
        search.placeholder = m.searchValues(total);
        note.textContent = matches === 0 ? m.noValues : matches > res.values.length ? m.refineSearch(res.values.length, matches) : '';
      };
      let ctrl = null;
      let timer = 0;
      const load = async (q) => {
        ctrl?.abort();
        const mine = (ctrl = new AbortController());
        note.textContent = m.loadingValues;
        try {
          const res = await lookup(q, mine.signal);
          if (mine.signal.aborted) return;
          if (!q.trim() && (res.matches ?? res.values.length) === res.values.length) fullList = res.values;
          renderList(res);
        } catch (err) {
          if (!mine.signal.aborted) note.textContent = m.valuesFailed(err.message);
        }
      };
      search.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => load(search.value), desc.search ? 200 : 0);
      });
      onClose = () => {
        clearTimeout(timer);
        ctrl?.abort();
      };
      // All / None: with no search, every value (also the ones not listed); with a search, the listed ones.
      const mark = (on) => {
        if (!search.value.trim()) {
          only = !on;
          set.clear();
        } else {
          for (const b of shown) setChecked(b.value, on);
        }
        for (const b of shown) b.box.checked = isChecked(b.value);
      };
      all.addEventListener('click', () => mark(true));
      none.addEventListener('click', () => mark(false));
      read = () => {
        if (fullList) {
          // Whole list known: send the shorter of "only these" / "all but these".
          const picked = fullList.filter(isChecked);
          if (picked.length === fullList.length) return null;
          return picked.length <= fullList.length - picked.length ? { op: 'in', v: picked } : { op: 'notin', v: fullList.filter((v) => !isChecked(v)) };
        }
        if (!only && set.size === 0) return null;
        return { op: only ? 'in' : 'notin', v: [...set] };
      };
      load('');
    }
    // Status line: why filtering is not available, progress, or what went wrong.
    const status = el('div', 'vg-filter-status', pop);
    status.setAttribute('role', 'status');
    const actions = el('div', 'vg-filter-actions', pop);
    const clear = el('button', '', actions, m.clear);
    const apply = el('button', 'vg-filter-apply', actions, m.apply);
    clear.type = 'button';
    apply.type = 'button';
    const blocked = key.cdim === undefined ? this.#limitReason(this.sortSpec, [{}]) : '';
    if (blocked) {
      status.textContent = blocked;
      status.classList.add('vg-filter-error');
      apply.disabled = true;
    }
    clear.disabled = !current;
    let busy = false;
    // The dialog stays open until the change is applied, so a refusal or an error shows where it was made.
    const finish = async (condition) => {
      if (busy || (condition && blocked)) return;
      if (this.o.controlled?.[key.cdim !== undefined ? 'columnFilter' : 'filter']) {
        this.closeFilter();
        this.scroller.focus({ preventScroll: true });
        this.setColumnFilter(key, condition);
        return;
      }
      busy = true;
      apply.disabled = clear.disabled = true;
      status.classList.remove('vg-filter-error');
      status.textContent = m.applying;
      const ok = await this.setColumnFilter(key, condition);
      if (this.#filterPop?.pop !== pop) return; // closed meanwhile
      if (ok || !this.lastRefusal) {
        this.closeFilter();
        this.scroller.focus({ preventScroll: true });
        return;
      }
      busy = false;
      apply.disabled = !!blocked;
      clear.disabled = !current;
      status.textContent = this.lastRefusal;
      status.classList.add('vg-filter-error');
    };
    clear.addEventListener('click', () => finish(null));
    apply.addEventListener('click', () => finish(read()));
    pop.addEventListener('keydown', (e) => {
      e.stopPropagation(); // keep grid shortcuts out of the dialog
      if (e.key === 'Escape') {
        e.preventDefault();
        this.closeFilter();
        this.scroller.focus({ preventScroll: true });
      } else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        finish(read());
      }
    });

    // Place under the anchor, inside the grid.
    if (getComputedStyle(this.host).position === 'static') this.host.style.position = 'relative';
    this.host.appendChild(pop);
    const hostRect = this.host.getBoundingClientRect();
    const a = anchor?.getBoundingClientRect() ?? { left: hostRect.left + this.rowHeaderWidth, bottom: hostRect.top + this.headerHeight };
    const left = clamp(a.left - hostRect.left - pop.offsetWidth + 24, 8, Math.max(8, hostRect.width - pop.offsetWidth - 8));
    pop.style.left = `${left}px`;
    pop.style.top = `${Math.min(a.bottom - hostRect.top + 4, Math.max(8, hostRect.height - pop.offsetHeight - 8))}px`;
    const onOutside = (e) => {
      if (!pop.contains(e.target) && !(e.target instanceof Element && e.target.closest('.vg-filterbtn'))) this.closeFilter();
    };
    document.addEventListener('pointerdown', onOutside, true);
    this.#filterPop = { pop, onOutside, onClose };
    pop.querySelector('input')?.focus();
  }

  closeFilter() {
    if (!this.#filterPop) return;
    document.removeEventListener('pointerdown', this.#filterPop.onOutside, true);
    this.#filterPop.onClose?.();
    this.#filterPop.pop.remove();
    this.#filterPop = null;
  }

  /** "City 1: Lisbon, Oslo; Amount 1 ≥ 20000" (uses header labels already loaded). */
  filterSummary() {
    const label = (axis, level, idx) => this.#labelFromCache(axis, level, idx);
    const describe = (f, key, fallback) => `${this.model.sortKeyName?.(key, label) ?? fallback} ${describeCondition(f)}`;
    return [
      ...this.colFilterSpec.map((f) => describe(f, { cdim: f.dim }, `Column level ${f.dim + 1}`)),
      ...this.filterSpec.map((f) => describe(f, f.dim !== undefined ? { dim: f.dim } : { col: f.c }, f.dim !== undefined ? `Level ${f.dim + 1}` : `Column ${f.c + 1}`)),
    ].join('; ');
  }

  async #applyView(sortList, filterList, what, colFilterList = this.colFilterSpec) {
    const colFilterParam = filterParamOf(colFilterList);
    let dropped = 0;
    if (colFilterParam !== this.colFilterParam && this.model.serverColFilter) {
      // A server-side column filter renumbers the columns, so sorts on value columns no longer point at
      // the same column: drop them (row-dimension sorts stay).
      const kept = sortList.filter((x) => x.key.col === undefined);
      dropped = sortList.length - kept.length;
      sortList = kept;
    }
    const sortParam = sortParamOf(sortList);
    const filterParam = filterParamOf(filterList);
    if (sortParam === this.sortParam && filterParam === this.filterParam && colFilterParam === this.colFilterParam) return true;
    const refuse = (reason) => {
      this.lastRefusal = reason;
      this.o.onViewChange?.({ ok: false, what, reason });
      // The filter dialog shows its own errors; anything else gets a notice in the grid.
      if (!this.#filterPop) this.notify(reason, true);
      return false;
    };
    this.lastRefusal = '';
    const limitReason = this.#limitReason(sortList, filterList);
    if (limitReason) return refuse(limitReason);
    const token = ++this.#sortSeq;
    this.o.onViewChange?.({ pending: true, what });
    try {
      // The model fetches what changes: the row count (filter) and, for a pivot, the reordered layout.
      if (this.model.applyView) await this.model.applyView({ sort: sortParam, filter: filterParam, colfilter: colFilterParam, query: this.#publicQuery(sortList, filterList, colFilterList) });
    } catch (err) {
      if (token === this.#sortSeq) refuse(this.msg.failed(what === 'sort' ? 'sort' : 'filter', err.message));
      return false;
    }
    if (token !== this.#sortSeq) return false; // a newer request won
    this.sortSpec = sortList;
    this.sortParam = sortParam;
    this.filterSpec = filterList;
    this.filterParam = filterParam;
    this.colFilterSpec = colFilterList;
    this.colFilterParam = colFilterParam;
    this.query = this.#publicQuery();
    if (dropped) this.#emit('sort', sortList);
    this.rows = this.model.rows;
    this.cols = this.model.cols;
    this.#useColLabels();
    this.#useView();
    this.#structureChanged();
    this.sel = {
      active: this.#clampCell(this.sel.active),
      anchor: this.#clampCell(this.sel.anchor),
      focus: this.#clampCell(this.sel.focus),
      ranges: this.sel.ranges.map((g) => this.#clampRange(g)),
    };
    this.#renderCornerSort();
    this.scrollToVirtual(this.vx, this.vy);
    this.o.onViewChange?.({ ok: true, what, rows: this.rows.count, cols: this.cols.count, totalRows: this.model.totalRows, sort: this.sortSummary(), filter: this.filterSummary(), droppedSorts: dropped });
    return true;
  }

  /** Why the data source cannot take this sort / filter (its row limits), or ''. */
  #limitReason(sortList, filterList) {
    const total = this.model.totalRows ?? this.rows.count;
    if (sortList.length > 1 && this.model.sortLimit && total > this.model.sortLimit) return this.msg.sortLimit(this.model.sortLimit, total);
    if (filterList.length && this.model.filterLimit && total > this.model.filterLimit) return this.msg.filterLimit(this.model.filterLimit, total);
    return '';
  }

  /** A short message at the bottom of the grid (refused or failed sorts and filters). notices: false turns it off. */
  notify(text, isError = false) {
    if (this.o.notices === false || !this.host) return;
    if (!this.noticeEl) {
      this.noticeEl = document.createElement('div');
      this.noticeEl.className = 'vg-notice';
      this.noticeEl.setAttribute('role', 'status');
      this.noticeEl.setAttribute('aria-live', 'polite');
      this.host.appendChild(this.noticeEl);
    }
    this.noticeEl.textContent = text;
    this.noticeEl.classList.toggle('vg-notice-error', isError);
    this.noticeEl.classList.add('vg-notice-show');
    clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => this.noticeEl?.classList.remove('vg-notice-show'), isError ? 5000 : 2500);
  }

  /**
   * Click on a sort control. Plain: sort by this key alone, cycling ascending → descending → none.
   * Additive (Shift): add the key as the lowest priority, or cycle it in place (→ removed after descending).
   */
  toggleSort(key, additive = false) {
    if (!this.o.sortable || !key) return Promise.resolve(false);
    if (!this.o.multiSort) additive = false;
    const same = (k) => k.col === key.col && k.dim === key.dim;
    const i = this.sortSpec.findIndex((s) => same(s.key));
    const nextDir = (dir) => (dir === 'a' ? 'd' : dir === 'd' ? null : 'a');
    let spec;
    if (additive) {
      if (i < 0) spec = [...this.sortSpec, { key, dir: 'a' }];
      else {
        const dir = nextDir(this.sortSpec[i].dir);
        spec = dir ? this.sortSpec.map((s, j) => (j === i ? { key, dir } : s)) : this.sortSpec.filter((_, j) => j !== i);
      }
    } else {
      const dir = nextDir(i >= 0 ? this.sortSpec[i].dir : null);
      spec = dir ? [{ key, dir }] : [];
    }
    return this.#userChange('sort', spec.slice(0, 4));
  }

  /** "Amount 1 ▼, Status 1 ▲" (uses header labels already loaded). */
  sortSummary() {
    return this.sortSpec
      .map((s) => `${this.model.sortKeyName?.(s.key, (axis, level, idx) => this.#labelFromCache(axis, level, idx)) ?? (s.key.dim !== undefined ? `Level ${s.key.dim + 1}` : `Column ${s.key.col + 1}`)} ${s.dir === 'a' ? '▲' : '▼'}`)
      .join(', ');
  }

  #labelFromCache(axis, level, idx) {
    const key = `L:${axis}:${level}:${Math.floor(idx / LABEL_BLOCK)}`;
    const b = axis === 'cols' ? this.colLabels.get(key) : this.cache.get(key);
    return b ? b.names[idx - b.from] : undefined;
  }

  /** Sort state of a key for display: { dir, priority (1-based, only when several keys) } or null. */
  #sortStateOf(key) {
    const i = this.sortSpec.findIndex((s) => s.key.col === key.col && s.key.dim === key.dim);
    if (i < 0) return null;
    return { dir: this.sortSpec[i].dir, priority: this.sortSpec.length > 1 ? i + 1 : 0 };
  }

  #renderCornerSort() {
    for (const { btn, cell, key, filterBtn, fkey } of this.#cornerSort) {
      if (filterBtn) paintFilterButton(filterBtn, this.#hasFilter(fkey));
      if (!btn) continue;
      const state = this.#sortStateOf(key);
      paintSortButton(btn, state);
      if (state && state.priority <= 1) cell.setAttribute('aria-sort', state.dir === 'a' ? 'ascending' : 'descending');
      else cell.removeAttribute('aria-sort');
    }
  }

  /** Switch to the cache of the current sort + filter (created on first use; at most 4 kept). */
  /** The server-side column filter (empty for models that filter columns themselves). */
  get #serverColFilter() {
    return this.model.serverColFilter ? this.colFilterParam : '';
  }

  #useColLabels() {
    const sig = this.#serverColFilter;
    let cache = this.#colLabelCaches.get(sig);
    if (!cache) {
      cache = new BlockCache({
        maxEntries: 2000,
        onLoad: () => this.invalidate(),
        onError: () => {
          clearTimeout(this.#retryTimer);
          this.#retryTimer = setTimeout(() => {
            this.#lastWantSig = '';
            this.invalidate();
          }, RETRY_DELAY_MS);
        },
      });
      this.#colLabelCaches.set(sig, cache);
      while (this.#colLabelCaches.size > 4) this.#colLabelCaches.delete(this.#colLabelCaches.keys().next().value);
    }
    if (this.colLabels && this.colLabels !== cache) this.colLabels.abortAll();
    cache.onError = (err) => {
      this.o.onError?.(err, { kind: 'labels' });
      clearTimeout(this.#retryTimer);
      this.#retryTimer = setTimeout(() => {
        this.#lastWantSig = '';
        this.invalidate();
      }, RETRY_DELAY_MS);
    };
    this.colLabels = cache;
  }

  #useView() {
    const sig = `${this.sortParam}#${this.filterParam}#${this.#serverColFilter}`;
    if (this.#view && this.#view.sig !== sig) this.#view.cache.abortAll(); // stop fetching for the old view
    let v = this.#views.get(sig);
    if (v) this.#views.delete(sig);
    else v = { sig, cache: this.#makeCache(this.sortParam, this.filterParam, this.#serverColFilter, this.query), copyCache: new Map() };
    this.#views.set(sig, v);
    while (this.#views.size > 4) {
      const [k, old] = this.#views.entries().next().value;
      old.cache.abortAll();
      this.#views.delete(k);
    }
    this.#view = v;
    this.cache = v.cache;
    this.#lastWantSig = '';
  }

  #makeCache(sort, filter, colfilter, query) {
    const o = this.o;
    return new BlockCache({
      maxGatherRects: o.maxGatherRects ?? 400,
      maxGatherCells: o.maxGatherCells ?? 20_000,
      gather: this.canGather
        ? (rects, signal) => o.fetchGather({ rects, signal, query, sort, filter, colfilter }).then((res) => {
          if (Array.isArray(res)) return res;
          if (!sort && !filter) this.merges.addServer(res.merges);
          return res.cells;
        })
        : undefined,
      onLoad: () => this.invalidate(),
      onError: (err) => {
        this.o.onError?.(err, { kind: 'cells' });
        clearTimeout(this.#retryTimer);
        this.#retryTimer = setTimeout(() => {
          this.#lastWantSig = '';
          this.invalidate();
        }, RETRY_DELAY_MS);
      },
    });
  }

  #structureChanged() {
    this.scroller.setAttribute('aria-rowcount', String(this.rows.count + this.model.colTiers.length));
    this.scroller.setAttribute('aria-colcount', String(this.cols.count + this.model.rowBands.length));
    this.#updateContentSize();
    this.#ensurePools();
    // Visible indexes shifted: reposition and refill everything (data comes from the cache).
    this.anchorRow = null;
    this.anchorCol = null;
    this.rendered.vx = NaN;
    this.#lastWantSig = '';
  }

  /** Re-render on the next frame (for example after data arrived). */
  invalidate() {
    if (this.#raf) return;
    this.#raf = requestAnimationFrame(() => {
      this.#raf = 0;
      this.#render(true);
    });
  }

  get view() {
    return this.#win;
  }

  takeStats() {
    const s = { ...this.stats, cache: { ...this.cache.stats, cached: this.cache.entries.size, inflight: this.cache.inflight.size, queued: this.cache.queue.length } };
    this.stats.renderMsMax = 0;
    return s;
  }

  destroy() {
    for (const slot of this.rowSlots) for (const cell of slot.cells) if (cell.cleanup !== undefined) this.#runCleanup(cell);
    this.colSpans.destroy();
    this.rowSpans.destroy();
    this.emptyCleanup?.();
    this.#ro.disconnect();
    cancelAnimationFrame(this.#raf);
    clearTimeout(this.#fetchTimer);
    clearTimeout(this.#retryTimer);
    this.cache.abortAll();
    this.colLabels.abortAll();
    this.closeFilter();
    this.scroller.removeEventListener('scroll', this.#onScroll);
    this.scroller.removeEventListener('wheel', this.#onWheel);
    this.scroller.removeEventListener('keydown', this.#onKeyDown);
    this.colHead.removeEventListener('pointerdown', this.#onHeadPointerDown);
    this.colHead.removeEventListener('click', this.#onHeadClick);
    this.rowHead.removeEventListener('click', this.#onHeadClick);
    this.body.removeEventListener('pointerdown', this.#onBodyPointerDown);
    this.corner.removeEventListener('click', this.#onCornerClick);
    this.host.textContent = '';
    this.host.classList.remove('vg', 'vg-auto', 'vg-light', 'vg-dark', 'vg-nosel', 'vg-pivot', 'vg-table');
  }

  // ---------------------------------------------------------------- DOM and layout

  #buildDom(host) {
    const div = (cls, parent) => {
      const el = document.createElement('div');
      el.className = cls;
      parent?.appendChild(el);
      return el;
    };
    const { model } = this;
    this.host = host;
    host.textContent = '';
    host.classList.add('vg', `vg-${this.o.theme}`);
    if (model.hostClass) host.classList.add(model.hostClass);
    if (this.o.selection === 'none') host.classList.add('vg-nosel');
    host.style.setProperty('--vg-head-h', `${this.headerHeight}px`);
    host.style.setProperty('--vg-rh-w', `${this.rowHeaderWidth}px`);

    this.scroller = div('vg-scroller', host);
    this.scroller.tabIndex = 0;
    this.scroller.setAttribute('role', 'grid');
    if (this.o.ariaLabel) this.scroller.setAttribute('aria-label', this.o.ariaLabel);
    this.scroller.setAttribute('aria-rowcount', String(this.rows.count + model.colTiers.length));
    this.scroller.setAttribute('aria-colcount', String(this.cols.count + model.rowBands.length));
    this.content = div('vg-content', this.scroller);
    this.viewport = div('vg-viewport', this.content);
    this.body = div('vg-body', this.viewport);
    this.bodyLayer = div('vg-layer', this.body);
    this.mergeLayerEl = div('vg-layer vg-merges', this.body);
    this.mergeLayer = new MergeLayer(this.mergeLayerEl);
    this.selLayerEl = div('vg-layer vg-sel-layer', this.body);
    this.selLayer = new SelectionLayer(this.selLayerEl);
    this.rowHead = div('vg-rowhead', this.viewport);
    this.rowHeadLayer = div('vg-layer', this.rowHead);
    this.colHead = div('vg-colhead', this.viewport);
    this.colHeadLayer = div('vg-layer', this.colHead);
    this.corner = div('vg-corner', this.viewport);
    this.emptyEl = div('vg-empty', this.viewport);
    this.emptyEl.hidden = true;
    this.emptyEl.setAttribute('role', 'status');
    this.#emptySig = '';
    this.rowSpans = new SpanLayer(this.rowHeadLayer, true, false, false, 'rows');
    this.colSpans = new SpanLayer(this.colHeadLayer, false, true, true, 'cols');
    this.rowSpans.renderHeader = (el, ctx) => this.o.renderHeader?.(el, ctx);
    this.colSpans.renderHeader = (el, ctx) => this.o.renderHeader?.(el, ctx);
    this.rowSpans.hasRenderer = this.colSpans.hasRenderer = () => typeof this.o.renderHeader === 'function';

    // Corner: column dimension names on the upper tiers, row dimension names on the last tier.
    const { colTiers, rowBands } = model;
    const T = colTiers.length;
    for (let t = 0; t < T - 1; t++) {
      const d = div('vg-cn vg-cn-tier', this.corner);
      d.style.top = `${this.tierOff[t]}px`;
      d.style.height = `${colTiers[t].height}px`;
      d.style.lineHeight = `${colTiers[t].height}px`;
      d.textContent = colTiers[t].name ?? '';
      const tierKey = this.o.filterable ? model.colTierFilter?.(t) : null;
      if (tierKey) {
        d.classList.add('vg-filterable');
        const filterBtn = makeFilterButton();
        filterBtn.dataset.filterKey = sortKeyId(tierKey);
        d.appendChild(filterBtn);
        this.#cornerSort.push({ btn: null, cell: d, key: null, filterBtn, fkey: tierKey });
      }
    }
    rowBands.forEach((band, b) => {
      const d = div('vg-cn', this.corner);
      d.style.top = `${this.tierOff[T - 1]}px`;
      d.style.left = `${this.rowBandOff[b]}px`;
      d.style.width = `${band.width}px`;
      d.style.height = `${colTiers[T - 1].height}px`;
      d.style.lineHeight = `${colTiers[T - 1].height}px`;
      d.textContent = band.name ?? '';
      const key = this.o.sortable ? model.rowBandSort?.(b) : null;
      const fkey = this.o.filterable ? model.rowBandFilter?.(b) : null;
      let filterBtn = null;
      if (fkey) {
        d.classList.add('vg-filterable');
        filterBtn = makeFilterButton();
        filterBtn.dataset.filterKey = sortKeyId(fkey);
        d.appendChild(filterBtn);
      }
      if (key) {
        d.classList.add('vg-sortable');
        d.setAttribute('role', 'columnheader');
        const btn = makeSortButton();
        btn.dataset.sortKey = sortKeyId(key);
        d.appendChild(btn);
        this.#cornerSort.push({ btn, cell: d, key, filterBtn, fkey });
      } else if (filterBtn) {
        // Filterable but not sortable (e.g. a flat table's "#": choose column types).
        this.#cornerSort.push({ btn: null, cell: d, key: null, filterBtn, fkey });
      }
    });
    this.#renderCornerSort();

    this.scroller.addEventListener('scroll', this.#onScroll, { passive: true });
    this.scroller.addEventListener('wheel', this.#onWheel, { passive: false });
    this.scroller.addEventListener('keydown', this.#onKeyDown);
    this.colHead.addEventListener('pointerdown', this.#onHeadPointerDown);
    this.colHead.addEventListener('click', this.#onHeadClick);
    this.rowHead.addEventListener('click', this.#onHeadClick);
    this.body.addEventListener('pointerdown', this.#onBodyPointerDown);
    this.corner.addEventListener('click', this.#onCornerClick);
    this.corner.title = this.msg.selectAll;
  }

  #measure() {
    this.clientW = this.scroller.clientWidth;
    this.clientH = this.scroller.clientHeight;
    this.bodyW = Math.max(0, this.clientW - this.rowHeaderWidth);
    this.bodyH = Math.max(0, this.clientH - this.headerHeight);
    this.viewport.style.width = `${this.clientW}px`;
    this.viewport.style.height = `${this.clientH}px`;
    this.#updateContentSize();
    this.#ensurePools();
    this.rendered.vx = NaN;
    this.scrollToVirtual(this.vx, this.vy);
  }

  #updateContentSize() {
    const totalW = this.cols.total;
    const totalH = this.rows.total;
    const fullW = this.rowHeaderWidth + totalW;
    const fullH = this.headerHeight + totalH;
    const contentW = Math.max(Math.min(fullW, MAX_SCROLL_PX), this.clientW);
    const contentH = Math.max(Math.min(fullH, MAX_SCROLL_PX), this.clientH);
    this.content.style.width = `${contentW}px`;
    this.content.style.height = `${contentH}px`;
    this.maxVX = Math.max(0, totalW - this.bodyW);
    this.maxVY = Math.max(0, totalH - this.bodyH);
    const maxSL = contentW - this.clientW;
    const maxST = contentH - this.clientH;
    this.ratioX = maxSL > 0 && fullW > MAX_SCROLL_PX ? this.maxVX / maxSL : 1;
    this.ratioY = maxST > 0 && fullH > MAX_SCROLL_PX ? this.maxVY / maxST : 1;
  }

  #ensurePools() {
    const { overscanRows, overscanCols } = this.o;
    // Pools are sized for the smallest item, so they always cover the viewport whatever sizes scroll in.
    const N = Math.min(this.rows.count, Math.ceil(this.bodyH / Math.max(1, this.rows.minSize)) + 1 + 2 * overscanRows);
    const M = Math.min(this.cols.count, Math.ceil(this.bodyW / Math.max(1, this.cols.minSize)) + 1 + 2 * overscanCols);
    if (N === this.N && M === this.M) return;
    this.N = N;
    this.M = M;
    this.#xs = new Float64Array(M);
    this.#ws = new Float64Array(M);
    this.#colSrc = new Float64Array(M);
    this.#colExact = new Uint8Array(M);
    this.#rowSrc = new Float64Array(N);
    this.#rowExact = new Uint8Array(N);
    this.#cover = new Uint8Array(N * M);
    this.#kinds = new Array(M).fill('');
    this.#infos = new Array(M).fill(null);
    for (const slot of this.rowSlots) for (const cell of slot.cells) if (cell.cleanup !== undefined) this.#clearCustom(cell);

    // Every cell owns one Text node for its whole life; updates set `.data`, so scrolling never
    // creates or removes nodes.
    const frag = document.createDocumentFragment();
    this.rowSlots = [];
    for (let i = 0; i < N; i++) {
      const el = document.createElement('div');
      el.className = 'vg-row';
      el.setAttribute('role', 'row');
      const cells = [];
      for (let j = 0; j < M; j++) {
        const cellEl = document.createElement('div');
        cellEl.className = 'vg-cell';
        cellEl.setAttribute('role', 'gridcell');
        el.appendChild(cellEl);
        cells.push({ el: cellEl, text: cellEl.appendChild(document.createTextNode('')), box: null, cleanup: undefined, extra: '', c: -1, base: 'vg-cell', cls: 'vg-cell', filled: false, ph: false, covered: 0 });
      }
      frag.appendChild(el);
      this.rowSlots.push({ el, cells, r: -1, h: NaN, cls: 'vg-row' });
    }
    this.bodyLayer.replaceChildren(frag);
    this.anchorRow = null;
    this.anchorCol = null;
    this.rendered.vx = NaN;
  }

  // ---------------------------------------------------------------- input

  #onScroll = () => {
    const st = this.scroller.scrollTop;
    const sl = this.scroller.scrollLeft;
    // Unscaled axes map 1:1. Scaled axes keep the exact virtual offset we set ourselves (wheel/keys)
    // and only fall back to proportional mapping when the scrollbar moved for another reason (drag, touch).
    if (this.ratioY === 1 || this.#expectTop === null || Math.abs(st - this.#expectTop) > 1.5) {
      this.vy = clamp(st * this.ratioY, 0, this.maxVY);
    }
    if (this.ratioX === 1 || this.#expectLeft === null || Math.abs(sl - this.#expectLeft) > 1.5) {
      this.vx = clamp(sl * this.ratioX, 0, this.maxVX);
    }
    this.#expectTop = null;
    this.#expectLeft = null;
    this.#render();
  };

  #onWheel = (e) => {
    if ((this.ratioX === 1 && this.ratioY === 1) || e.ctrlKey) return; // native scrolling is exact here
    let dx = e.deltaX;
    let dy = e.deltaY;
    if (e.deltaMode === 1) {
      dx *= this.rows.minSize;
      dy *= this.rows.minSize;
    } else if (e.deltaMode === 2) {
      dx *= this.bodyW;
      dy *= this.bodyH;
    }
    if (e.shiftKey && dx === 0) {
      dx = dy;
      dy = 0;
    }
    e.preventDefault();
    this.scrollToVirtual(this.vx + dx, this.vy + dy);
  };

  /** The platform's primary modifier is held: ⌘ on Apple platforms, Ctrl elsewhere. */
  #isMod(e) {
    return this.isMac ? e.metaKey : e.ctrlKey;
  }

  // Keyboard model (the grid is one tab stop; Tab moves focus out, as in the WAI-ARIA grid pattern).
  // "Mod" is ⌘ on Apple platforms and Ctrl elsewhere.
  //   arrows               move the active cell (a merged cell counts as one cell)
  //   Shift+arrows         extend the selection          Mod+arrows  jump to the first/last row/column
  //   Home / End           first / last column           Mod+Home/End  first / last cell
  //   PageUp / PageDown    move by one screen (Shift extends)
  //   Enter / Shift+Enter  next / previous cell; inside a multi-cell selection it cycles within it
  //   Mod+A                select all                    Escape  reduce the selection to the active cell
  //   Mod+C                copy the selection (tab-separated text + HTML table)
  //   Alt+S / Alt+Shift+S  sort by the active cell's column / add it as another sort key (cycles ▲ ▼ off)
  //   Alt+F                filter the active cell's column (opens the filter dialog)
  //   Alt+Shift+← / →      collapse / expand the row group at the active cell
  //   Alt+Shift+↑ / ↓      collapse / expand the column group at the active cell
  #onKeyDown = (e) => {
    if (!this.o.keyboard) return;
    if (e.target !== this.scroller && isEditable(e.target)) return; // typing in an input inside a cell
    const mod = this.#isMod(e);
    const shift = e.shiftKey;
    if (mod && !e.altKey && (e.key === 'c' || e.key === 'C')) {
      if (!this.o.copy || this.o.selection === 'none') return;
      e.preventDefault();
      this.copySelection();
      return;
    }
    const arrow = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key];
    if (arrow && e.altKey && shift) {
      e.preventDefault();
      if (this.o.expandable) this.#toggleGroupAtActive(arrow[1] !== 0 ? 'rows' : 'cols', e.key === 'ArrowRight' || e.key === 'ArrowDown');
      return;
    }
    if (e.altKey && e.code === 'KeyF') {
      e.preventDefault();
      const key = this.o.filterable ? this.model.colFilterKey?.(this.sel.active.c) : null;
      if (key) this.openFilter(key);
      return;
    }
    if (e.altKey && e.code === 'KeyS') {
      e.preventDefault();
      const c = this.sel.active.c;
      if (this.o.sortable) this.toggleSort(this.model.colSortKey ? this.model.colSortKey(c) : { col: this.colSource(c) }, shift);
      return;
    }
    if (e.altKey) return;
    const last = { r: this.rows.count - 1, c: this.cols.count - 1 };
    const from = shift ? this.sel.focus : this.sel.active;
    switch (e.key) {
      case 'ArrowUp':
      case 'ArrowDown':
      case 'ArrowLeft':
      case 'ArrowRight':
        this.#move(arrow[0], arrow[1], shift, mod);
        break;
      case 'PageDown':
      case 'PageUp':
        this.#page(e.key === 'PageDown' ? 1 : -1, shift);
        break;
      case 'Home':
        this.#goTo(mod ? { r: 0, c: 0 } : { r: from.r, c: 0 }, shift);
        break;
      case 'End':
        this.#goTo(mod ? last : { r: from.r, c: last.c }, shift);
        break;
      case 'Enter':
        this.#cycle(shift ? -1 : 1);
        break;
      case 'Escape':
        this.#select(this.sel.active, 'set');
        break;
      case 'a':
      case 'A':
        if (!mod || this.o.selection !== 'multi') return;
        this.selectAll();
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  // ---------------------------------------------------------------- selection

  /** Current selection in visible coordinates. */
  getSelection() {
    return { active: { ...this.sel.active }, ranges: this.sel.ranges.map((g) => ({ ...g })) };
  }

  /** Set the selection (visible coordinates); the first range's top-left becomes active unless given. */
  setSelection({ active, ranges }) {
    const list = (ranges ?? []).map((g) => this.#clampRange(g));
    const a = this.#clampCell(active ?? (list[0] ? { r: list[0].r0, c: list[0].c0 } : { r: 0, c: 0 }));
    this.sel = { active: a, anchor: a, focus: a, ranges: list.length ? list : [this.#cellRange(a)] };
    this.#selectionChanged();
  }

  selectAll() {
    if (this.o.selection !== 'multi') return;
    const last = { r: this.rows.count - 1, c: this.cols.count - 1 };
    this.sel = { active: this.sel.active, anchor: { r: 0, c: 0 }, focus: last, ranges: [{ r0: 0, c0: 0, r1: last.r, c1: last.c }] };
    this.#selectionChanged();
  }

  /**
   * Copy the selection to the clipboard as tab-separated text plus an HTML table (merged cells keep
   * their rowspan/colspan in the HTML; in the text they show in their top-left cell, blanks elsewhere).
   * Several ranges are copied one after another, separated by a blank line.
   * Cells that are not loaded are fetched first (batched gather requests). Reports through
   * `options.onCopy(info)` and resolves with the same info: { ok, cells, rows, cols, fetched, ms, text?, reason? }.
   */
  copySelection() {
    const started = performance.now();
    const ranges = this.sel.ranges.map((g) => ({ ...g }));
    const last = ranges[ranges.length - 1];
    const base = { cells: 0, ranges: ranges.length, rows: last.r1 - last.r0 + 1, cols: last.c1 - last.c0 + 1, fetched: 0 };
    for (const g of ranges) base.cells += (g.r1 - g.r0 + 1) * (g.c1 - g.c0 + 1);
    const report = (info) => {
      const out = { ...base, ms: Math.round(performance.now() - started), ...info };
      this.o.onCopy?.(out);
      return out;
    };
    if (base.cells > MAX_COPY_CELLS) {
      return Promise.resolve(report({ ok: false, reason: `Selection too large to copy: ${base.cells.toLocaleString('en-US')} cells (limit ${MAX_COPY_CELLS.toLocaleString('en-US')})` }));
    }

    const plans = ranges.map((g) => this.#planCopy(g));
    const missing = new Map(); // row source -> Set of column sources not loaded
    const need = (rs, cs) => {
      if (rs < 0 || cs < 0 || this.#copyValue(rs, cs) !== undefined) return;
      let set = missing.get(rs);
      if (!set) missing.set(rs, (set = new Set()));
      set.add(cs);
    };
    for (const p of plans) {
      for (let i = 0; i < p.nr; i++) {
        for (let j = 0; j < p.nc; j++) {
          const k = i * p.nc + j;
          const piece = p.anchorAt.get(k);
          if (piece) {
            if (piece.merge.label === undefined) need(piece.merge.r0, piece.merge.c0);
          } else if (!p.cover[k]) {
            need(p.rowSrc[i], p.colSrc[j]);
          }
        }
      }
    }

    if (missing.size === 0) {
      const out = this.#buildCopy(plans);
      const ok = writeClipboardNow(out.text, out.html);
      return Promise.resolve(report(ok ? { ok: true, text: out.text } : { ok: false, reason: 'The browser refused clipboard access', text: out.text }));
    }

    // Some cells must be loaded first. Hand the clipboard a promise now, while the key press still
    // counts as a user action (Safari requires that; Chromium accepts it), and fill it when the data is in.
    let fetchedCells = 0;
    const pending = this.#fetchForCopy(missing).then((n) => {
      fetchedCells = n;
      return this.#buildCopy(plans);
    });
    let write;
    try {
      write = navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': pending.then((o) => new Blob([o.text], { type: 'text/plain' })),
          'text/html': pending.then((o) => new Blob([o.html], { type: 'text/html' })),
        }),
      ]);
    } catch (err) {
      write = Promise.reject(err);
    }
    return write.then(
      () => pending.then((o) => report({ ok: true, text: o.text, fetched: fetchedCells })),
      async (err) => {
        let out;
        try {
          out = await pending;
        } catch (loadErr) {
          return report({ ok: false, reason: `Could not load the cells: ${loadErr.message}` });
        }
        // Fallback: plain text only (may still be refused once the key press is too long ago). The
        // values stay in the copy cache, so pressing the shortcut again copies instantly.
        try {
          await navigator.clipboard.writeText(out.text);
          return report({ ok: true, text: out.text, fetched: fetchedCells, plainOnly: true });
        } catch {
          return report({ ok: false, retry: true, fetched: fetchedCells, reason: `Loaded ${fetchedCells.toLocaleString('en-US')} cells; press ${this.isMac ? '⌘C' : 'Ctrl+C'} again to copy`, cause: String(err?.message ?? err) });
        }
      },
    );
  }

  /** Visible rows/columns of a range, their sources, and the merged-cell pieces inside it. */
  #planCopy(g) {
    const { model } = this;
    const nr = g.r1 - g.r0 + 1;
    const nc = g.c1 - g.c0 + 1;
    const rowSrc = new Float64Array(nr);
    const rowExact = new Uint8Array(nr);
    for (let i = 0; i < nr; i++) {
      rowSrc[i] = this.rowSource(g.r0 + i);
      rowExact[i] = model.rowExact ? (model.rowExact(g.r0 + i) ? 1 : 0) : 1;
    }
    const colSrc = new Float64Array(nc);
    const colExact = new Uint8Array(nc);
    for (let j = 0; j < nc; j++) {
      colSrc[j] = this.colSource(g.c0 + j);
      colExact[j] = model.colExact ? (model.colExact(g.c0 + j) ? 1 : 0) : 1;
    }
    const cover = new Uint8Array(nr * nc);
    const pieces = this.sortParam || this.filterParam ? [] : mergePieces(this.merges, g.r0, rowSrc, rowExact, g.c0, colSrc, colExact, cover);
    const anchorAt = new Map(); // top-left cell of each piece (index within the range) -> piece
    for (const p of pieces) anchorAt.set((p.vr0 - g.r0) * nc + (p.vc0 - g.c0), p);
    return { g, nr, nc, rowSrc, colSrc, cover, anchorAt };
  }

  #copyValue(rs, cs) {
    return this.#valueBySource(rs, cs) ?? this.#view.copyCache.get(`${rs}:${cs}`);
  }

  /** Loads the missing cells with batched gather requests (or blocks without gather). Resolves with the count. */
  async #fetchForCopy(missing) {
    const store = (rs, cs, text) => {
      const cc = this.#view.copyCache;
      if (cc.size >= COPY_CACHE_MAX) cc.delete(cc.keys().next().value);
      cc.set(`${rs}:${cs}`, text);
    };
    // Rectangles: each row's missing columns as runs, then stack consecutive rows with the same runs.
    const rects = [];
    const open = new Map(); // "c0:nc" -> rect still growing downward
    for (const rs of [...missing.keys()].sort((a, b) => a - b)) {
      const cols = [...missing.get(rs)].sort((a, b) => a - b);
      for (let i = 0; i < cols.length; ) {
        let j = i;
        while (j + 1 < cols.length && cols[j + 1] === cols[j] + 1) j++;
        const key = `${cols[i]}:${j - i + 1}`;
        const prev = open.get(key);
        if (prev && prev[0] + prev[2] === rs && (prev[2] + 1) * prev[3] <= 20_000) prev[2]++;
        else {
          const rect = [rs, cols[i], 1, j - i + 1];
          rects.push(rect);
          open.set(key, rect);
        }
        i = j + 1;
      }
    }
    let count = 0;
    const take = (r0, c0, nr, nc, cells) => {
      for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) store(r0 + i, c0 + j, cells[i * nc + j]);
      count += nr * nc;
    };
    if (this.canGather) {
      // Batches within the server limits (500 rectangles, 20,000 cells), at most 3 in flight.
      const batches = [];
      let batch = [];
      let cells = 0;
      for (const rect of rects) {
        const n = rect[2] * rect[3];
        if (batch.length && (batch.length >= 400 || cells + n > 20_000)) {
          batches.push(batch);
          batch = [];
          cells = 0;
        }
        batch.push(rect);
        cells += n;
      }
      if (batch.length) batches.push(batch);
      let next = 0;
      const worker = async () => {
        while (next < batches.length) {
          const b = batches[next++];
          const res = await this.o.fetchGather({ rects: b, query: this.query, sort: this.sortParam, filter: this.filterParam, colfilter: this.#serverColFilter });
          const arrays = Array.isArray(res) ? res : res.cells;
          if (!Array.isArray(res) && !this.sortParam && !this.filterParam) this.merges.addServer(res.merges);
          b.forEach((rect, i) => take(rect[0], rect[1], rect[2], rect[3], arrays[i]));
        }
      };
      await Promise.all([worker(), worker(), worker()]);
    } else {
      const { blockRows: BR, blockCols: BC } = this.o;
      const blocks = new Set();
      for (const [rs, cols] of missing) for (const cs of cols) blocks.add(`${Math.floor(rs / BR)}:${Math.floor(cs / BC)}`);
      const rowCount = this.model.rowSourceCount ?? this.rows.count;
      const colCount = this.model.colSourceCount ?? this.cols.count;
      for (const key of blocks) {
        const [br, bc] = key.split(':').map(Number);
        const r0 = br * BR;
        const c0 = bc * BC;
        const nr = Math.min(BR, rowCount - r0);
        const nc = Math.min(BC, colCount - c0);
        const res = await this.o.fetchBlock({ r0, c0, nr, nc, query: this.query, sort: this.sortParam, filter: this.filterParam, colfilter: this.#serverColFilter });
        take(r0, c0, nr, nc, Array.isArray(res) ? res : res.cells);
      }
    }
    return count;
  }

  /** Tab-separated text and an HTML table for the planned ranges. */
  #buildCopy(plans) {
    const texts = [];
    const tables = [];
    for (const p of plans) {
      const lines = [];
      const rowsHtml = [];
      for (let i = 0; i < p.nr; i++) {
        const fields = [];
        let tds = '';
        for (let j = 0; j < p.nc; j++) {
          const k = i * p.nc + j;
          const piece = p.anchorAt.get(k);
          let text;
          if (piece) {
            const m = piece.merge;
            text = m.label ?? this.#textOf(this.#copyValue(m.r0, m.c0), m.r0, m.c0) ?? '';
            const rs = piece.vr1 - piece.vr0 + 1;
            const cs = piece.vc1 - piece.vc0 + 1;
            tds += `<td${rs > 1 ? ` rowspan="${rs}"` : ''}${cs > 1 ? ` colspan="${cs}"` : ''}>${escapeHtml(text)}</td>`;
          } else if (p.cover[k]) {
            text = ''; // under a merged cell: blank in text, no cell in HTML
          } else {
            const rsrc = p.rowSrc[i];
            const csrc = p.colSrc[j];
            text = rsrc < 0 || csrc < 0 ? '' : this.#textOf(this.#copyValue(rsrc, csrc), rsrc, csrc) ?? '';
            tds += `<td>${escapeHtml(text)}</td>`;
          }
          fields.push(tsvField(text));
        }
        lines.push(fields.join('\t'));
        rowsHtml.push(`<tr>${tds}</tr>`);
      }
      texts.push(lines.join('\n'));
      tables.push(`<table><tbody>${rowsHtml.join('')}</tbody></table>`);
    }
    return { text: texts.join('\n\n'), html: `<meta charset="utf-8">${tables.join('<br>')}` };
  }

  /** Active cell, its text (if loaded), and the selection size. */
  selectionInfo() {
    const { active, ranges } = this.sel;
    let cells = 0;
    for (const g of ranges) cells += (g.r1 - g.r0 + 1) * (g.c1 - g.c0 + 1);
    const g = ranges[ranges.length - 1];
    return { active: { ...active }, text: this.cellText(active.r, active.c), ranges: ranges.length, rows: g.r1 - g.r0 + 1, cols: g.c1 - g.c0 + 1, cells };
  }

  /** Text shown in a visible cell (a merged cell shows its own value), or undefined if not loaded. */
  cellText(r, c) {
    const p = this.#pieceAt(r, c);
    if (p) return p.merge.label ?? this.#textOf(this.#valueBySource(p.merge.r0, p.merge.c0), p.merge.r0, p.merge.c0);
    const rs = this.rowSource(r);
    const cs = this.colSource(c);
    return rs < 0 || cs < 0 ? '' : this.#textOf(this.#valueBySource(rs, cs), rs, cs);
  }

  /** The raw value of a visible cell (undefined while not loaded). */
  cellValue(r, c) {
    const p = this.#pieceAt(r, c);
    if (p) return p.merge.label ?? this.#valueBySource(p.merge.r0, p.merge.c0);
    const rs = this.rowSource(r);
    const cs = this.colSource(c);
    return rs < 0 || cs < 0 ? null : this.#valueBySource(rs, cs);
  }

  #valueBySource(rs, cs) {
    const { blockRows: BR, blockCols: BC } = this.o;
    const br = Math.floor(rs / BR);
    const bc = Math.floor(cs / BC);
    const c = this.cache;
    const b = c.get(`${br}:${bc}`) ?? c.get(`R${rs}:${bc}`) ?? c.get(`C${br}:${cs}`) ?? c.get(`X${rs}:${cs}`);
    return b ? b.cells[(rs - b.r0) * b.nc + (cs - b.c0)] : undefined;
  }

  #clampCell({ r, c }) {
    return { r: clamp(Math.floor(r), 0, Math.max(0, this.rows.count - 1)), c: clamp(Math.floor(c), 0, Math.max(0, this.cols.count - 1)) };
  }

  #clampRange(g) {
    const a = this.#clampCell({ r: Math.min(g.r0, g.r1), c: Math.min(g.c0, g.c1) });
    const b = this.#clampCell({ r: Math.max(g.r0, g.r1), c: Math.max(g.c0, g.c1) });
    return { r0: a.r, c0: a.c, r1: b.r, c1: b.c };
  }

  /** The merged-cell piece on screen that covers (r, c), if any. */
  #pieceAt(r, c) {
    for (const p of this.#pieces) if (r >= p.vr0 && r <= p.vr1 && c >= p.vc0 && c <= p.vc1) return p;
    return null;
  }

  #cellRange({ r, c }) {
    const p = this.#pieceAt(r, c);
    return p ? { r0: p.vr0, c0: p.vc0, r1: p.vr1, c1: p.vc1 } : { r0: r, c0: c, r1: r, c1: c };
  }

  /** Range spanned by two cells, grown to fully include every merged cell on screen it touches. */
  #spanRange(a, b) {
    const g = { r0: Math.min(a.r, b.r), c0: Math.min(a.c, b.c), r1: Math.max(a.r, b.r), c1: Math.max(a.c, b.c) };
    for (let pass = 0; pass < 8; pass++) {
      let grown = false;
      for (const p of this.#pieces) {
        if (p.vr0 > g.r1 || p.vr1 < g.r0 || p.vc0 > g.c1 || p.vc1 < g.c0) continue;
        if (p.vr0 < g.r0) { g.r0 = p.vr0; grown = true; }
        if (p.vr1 > g.r1) { g.r1 = p.vr1; grown = true; }
        if (p.vc0 < g.c0) { g.c0 = p.vc0; grown = true; }
        if (p.vc1 > g.c1) { g.c1 = p.vc1; grown = true; }
      }
      if (!grown) break;
    }
    return g;
  }

  /** mode: 'set' (new selection), 'add' (extra range), 'extend' (move the focus corner of the last range). */
  #select(cell, mode) {
    if (this.o.selection !== 'multi') mode = 'set';
    const target = this.#clampCell(cell);
    if (mode === 'extend') {
      this.sel.focus = target;
      this.sel.ranges[this.sel.ranges.length - 1] = this.#spanRange(this.sel.anchor, target);
    } else {
      const p = this.#pieceAt(target.r, target.c);
      const a = p ? { r: p.vr0, c: p.vc0 } : target;
      this.sel.active = a;
      this.sel.anchor = a;
      this.sel.focus = a;
      const range = this.#cellRange(a);
      if (mode === 'add') this.sel.ranges.push(range);
      else this.sel.ranges = [range];
    }
    this.#selectionChanged();
  }

  #selectionChanged() {
    this.#render(true);
    this.o.onSelectionChange?.(this.selectionInfo());
  }

  /** Scroll the least amount needed to show a cell (or the merged cell it is in). */
  #reveal({ r, c }) {
    const p = this.#pieceAt(r, c);
    const top = this.rows.offsetOf(p ? p.vr0 : r);
    const bottom = this.rows.offsetOf((p ? p.vr1 : r) + 1);
    const left = this.cols.offsetOf(p ? p.vc0 : c);
    const right = this.cols.offsetOf((p ? p.vc1 : c) + 1);
    let y = this.vy;
    let x = this.vx;
    if (top < y || bottom - top > this.bodyH) y = top;
    else if (bottom > y + this.bodyH) y = bottom - this.bodyH;
    if (left < x || right - left > this.bodyW) x = left;
    else if (right > x + this.bodyW) x = right - this.bodyW;
    if (x !== this.vx || y !== this.vy) this.scrollToVirtual(x, y);
  }

  #move(dr, dc, extend, jump) {
    const from = extend ? this.sel.focus : this.sel.active;
    const p = this.#pieceAt(from.r, from.c);
    let { r, c } = from;
    if (jump) {
      if (dr) r = dr < 0 ? 0 : this.rows.count - 1;
      if (dc) c = dc < 0 ? 0 : this.cols.count - 1;
    } else {
      // Step off the far edge of a merged cell, not just to the next cell inside it.
      if (dr > 0) r = (p ? p.vr1 : r) + 1;
      else if (dr < 0) r = (p ? p.vr0 : r) - 1;
      if (dc > 0) c = (p ? p.vc1 : c) + 1;
      else if (dc < 0) c = (p ? p.vc0 : c) - 1;
    }
    this.#goTo({ r, c }, extend);
  }

  #goTo(cell, extend) {
    const target = this.#clampCell(cell);
    this.#reveal(target); // draws the area first, so merged cells there are known
    this.#select(target, extend ? 'extend' : 'set');
    this.#reveal(extend ? this.sel.focus : this.sel.active);
  }

  #page(dir, extend) {
    const from = extend ? this.sel.focus : this.sel.active;
    const y0 = this.rows.offsetOf(from.r);
    const r = this.rows.indexAt(clamp(y0 + dir * this.bodyH, 0, Math.max(0, this.rows.total - 1)));
    this.scrollToVirtual(this.vx, this.vy + (this.rows.offsetOf(r) - y0)); // keep the cell at the same height on screen
    this.#select({ r, c: from.c }, extend ? 'extend' : 'set');
    this.#reveal(extend ? this.sel.focus : this.sel.active);
  }

  /** Enter: inside a multi-cell selection, move the active cell through it (down, then next column). */
  #cycle(dir) {
    const { ranges } = this.sel;
    const g = ranges[ranges.length - 1];
    const own = this.#cellRange(this.sel.active);
    const justActive = g.r0 === own.r0 && g.r1 === own.r1 && g.c0 === own.c0 && g.c1 === own.c1;
    if (ranges.length !== 1 || justActive) {
      this.#move(dir, 0, false, false);
      return;
    }
    let { r, c } = this.sel.active;
    for (let guard = 0; guard < 10_000; guard++) {
      const p = this.#pieceAt(r, c);
      r = dir > 0 ? (p ? p.vr1 : r) + 1 : (p ? p.vr0 : r) - 1;
      if (r > g.r1) { r = g.r0; c = c + 1 > g.c1 ? g.c0 : c + 1; }
      if (r < g.r0) { r = g.r1; c = c - 1 < g.c0 ? g.c1 : c - 1; }
      const q = this.#pieceAt(r, c);
      if (!q || (q.vr0 === r && q.vc0 === c)) break; // skip cells hidden under a merged cell
    }
    this.sel.active = { r, c };
    this.#reveal(this.sel.active);
    this.#selectionChanged();
  }

  #toggleGroupAtActive(axis, expand) {
    const fn = expand ? this.model.expandTarget : this.model.collapseTarget;
    if (typeof fn !== 'function') return;
    const t = fn(axis, axis === 'rows' ? this.sel.active.r : this.sel.active.c);
    if (!t) return;
    this.toggleGroup(axis, t.level, t.group);
    this.#reveal(this.sel.active);
  }

  /** Whole rows (axis 'rows') or columns a..b. */
  #selectLines(axis, a, b, mode) {
    const last = { r: this.rows.count - 1, c: this.cols.count - 1 };
    const win = this.#win ?? { firstRow: 0, firstCol: 0 };
    if (mode === 'extend') {
      const from = axis === 'rows' ? this.sel.anchor.r : this.sel.anchor.c;
      const lo = Math.min(from, a);
      const hi = Math.max(from, b);
      this.sel.focus = axis === 'rows' ? { r: hi, c: last.c } : { r: last.r, c: hi };
      this.sel.ranges[this.sel.ranges.length - 1] = axis === 'rows' ? { r0: lo, c0: 0, r1: hi, c1: last.c } : { r0: 0, c0: lo, r1: last.r, c1: hi };
    } else {
      // The active cell goes to the first visible cell of the line, so the view does not jump.
      const active = axis === 'rows' ? { r: a, c: win.firstCol } : { r: win.firstRow, c: a };
      const range = axis === 'rows' ? { r0: a, c0: 0, r1: b, c1: last.c } : { r0: 0, c0: a, r1: last.r, c1: b };
      this.sel.active = active;
      this.sel.anchor = active;
      this.sel.focus = active;
      if (mode === 'add') this.sel.ranges.push(range);
      else this.sel.ranges = [range];
    }
    this.#selectionChanged();
  }

  /** Selection as source coordinates, so it survives collapse/expand (see #restoreSelection). */
  #captureSelection() {
    const anchorOf = (axis, i) => (this.model.anchorOf ? this.model.anchorOf(axis, i) : i);
    const pt = ({ r, c }) => [anchorOf('rows', r), anchorOf('cols', c)];
    const { active, anchor, focus, ranges } = this.sel;
    return {
      active: pt(active),
      anchor: pt(anchor),
      focus: pt(focus),
      ranges: ranges.map((g) => [anchorOf('rows', g.r0), anchorOf('cols', g.c0), this.rowSource(g.r1), this.colSource(g.c1)]),
    };
  }

  #restoreSelection(snap) {
    const vis = (axis, src) => (this.model.visibleOf ? this.model.visibleOf(axis, src)[0] : src);
    const pt = ([rs, cs]) => this.#clampCell({ r: vis('rows', rs), c: vis('cols', cs) });
    this.sel = {
      active: pt(snap.active),
      anchor: pt(snap.anchor),
      focus: pt(snap.focus),
      ranges: snap.ranges.map(([a, b, c, d]) => this.#clampRange({ r0: vis('rows', a), c0: vis('cols', b), r1: vis('rows', c), c1: vis('cols', d) })),
    };
  }

  #renderSelection(r0, r1, c0, c1) {
    const { rows, cols } = this;
    const rect = (a0, a1, b0, b1) => {
      const ra = Math.max(a0, r0);
      const rb = Math.min(a1, r1);
      const ca = Math.max(b0, c0);
      const cb = Math.min(b1, c1);
      if (ra > rb || ca > cb) return null;
      const top = rows.offsetOf(ra);
      const left = cols.offsetOf(ca);
      const edges = `${ra === a0 ? 1 : 0}${cb === b1 ? 1 : 0}${rb === a1 ? 1 : 0}${ca === b0 ? 1 : 0}`;
      return { x: left - this.anchorColPx, y: top - this.anchorRowPx, w: cols.offsetOf(cb + 1) - left, h: rows.offsetOf(rb + 1) - top, edges };
    };
    // A selection made before a merged cell was known (initial state, a jump, merges arriving later):
    // snap the active cell to the merged cell's top-left and grow a bare one-cell range to all of it.
    const under = this.#pieceAt(this.sel.active.r, this.sel.active.c);
    if (under) {
      const g = this.sel.ranges[this.sel.ranges.length - 1];
      const bare = this.sel.ranges.length === 1 && g.r0 === g.r1 && g.c0 === g.c1;
      const topLeft = { r: under.vr0, c: under.vc0 };
      if (bare && (g.r0 !== under.vr0 || g.c0 !== under.vc0 || g.r1 !== under.vr1 || g.c1 !== under.vc1)) {
        this.sel = { active: topLeft, anchor: topLeft, focus: topLeft, ranges: [this.#cellRange(topLeft)] };
        this.invalidate(); // header highlight and aria-selected were computed from the old range this frame
      }
    }
    const { active, ranges } = this.sel;
    const activeRange = this.#cellRange(active);
    const single = ranges.length === 1 && ranges[0].r0 === activeRange.r0 && ranges[0].r1 === activeRange.r1 && ranges[0].c0 === activeRange.c0 && ranges[0].c1 === activeRange.c1;
    const boxes = single ? [] : ranges.map((g) => rect(g.r0, g.r1, g.c0, g.c1));
    const act = rect(activeRange.r0, activeRange.r1, activeRange.c0, activeRange.c1);
    this.selLayer.render(boxes, act);

    // Screen readers: point the grid at the element that shows the active cell.
    let el = null;
    if (act) {
      const p = this.#pieceAt(active.r, active.c);
      el = p ? this.mergeLayer.live.get(p.key)?.el : this.rowSlots[active.r % this.N]?.cells[active.c % this.M]?.el;
    }
    if (el && !el.id) el.id = `${this.#uid}-${++this.#idSeq}`;
    const id = el ? el.id : '';
    if (id !== this.#activeId) {
      if (id) this.scroller.setAttribute('aria-activedescendant', id);
      else this.scroller.removeAttribute('aria-activedescendant');
      this.#activeId = id;
    }
  }

  #cellAt(x, y, rect) {
    const px = clamp(x - rect.left, 0, Math.max(0, this.bodyW - 1)) + this.vx;
    const py = clamp(y - rect.top, 0, Math.max(0, this.bodyH - 1)) + this.vy;
    return { r: this.rows.indexAt(py), c: this.cols.indexAt(px) };
  }

  #onBodyPointerDown = (e) => {
    if (e.button !== 0 || this.rows.count === 0 || this.cols.count === 0) return;
    if (isInteractive(e.target)) return; // a link, button or input drawn by a cell renderer handles it
    e.preventDefault(); // no text selection; focus the grid ourselves without scrolling the page
    this.scroller.focus({ preventScroll: true });
    const rect = this.body.getBoundingClientRect();
    this.#select(this.#cellAt(e.clientX, e.clientY, rect), e.shiftKey ? 'extend' : this.#isMod(e) ? 'add' : 'set');
    const drag = { x: e.clientX, y: e.clientY, raf: 0 };
    const extend = () => {
      const cell = this.#cellAt(drag.x, drag.y, rect);
      const f = this.sel.focus;
      if (cell.r !== f.r || cell.c !== f.c) this.#select(cell, 'extend');
    };
    // While the pointer is outside the body, keep scrolling toward it (faster the further out it is).
    const tick = () => {
      const dx = drag.x < rect.left ? drag.x - rect.left : drag.x > rect.right ? drag.x - rect.right : 0;
      const dy = drag.y < rect.top ? drag.y - rect.top : drag.y > rect.bottom ? drag.y - rect.bottom : 0;
      if (!dx && !dy) {
        drag.raf = 0;
        return;
      }
      this.scrollToVirtual(this.vx + dx * 0.6, this.vy + dy * 0.6);
      extend();
      drag.raf = requestAnimationFrame(tick);
    };
    const move = (ev) => {
      drag.x = ev.clientX;
      drag.y = ev.clientY;
      extend();
      if (!drag.raf) drag.raf = requestAnimationFrame(tick);
    };
    const up = () => {
      cancelAnimationFrame(drag.raf);
      this.body.removeEventListener('pointermove', move);
      this.body.removeEventListener('pointerup', up);
      this.body.removeEventListener('pointercancel', up);
    };
    this.body.setPointerCapture(e.pointerId);
    this.body.addEventListener('pointermove', move);
    this.body.addEventListener('pointerup', up);
    this.body.addEventListener('pointercancel', up);
  };

  #onCornerClick = (e) => {
    const fbtn = e.target instanceof Element ? e.target.closest('.vg-filterbtn') : null;
    if (fbtn?.dataset.filterKey) {
      this.openFilter(parseSortKeyId(fbtn.dataset.filterKey), fbtn);
      return;
    }
    const btn = e.target instanceof Element ? e.target.closest('.vg-sortbtn') : null;
    if (btn?.dataset.sortKey) {
      this.toggleSort(parseSortKeyId(btn.dataset.sortKey), e.shiftKey);
      return;
    }
    this.scroller.focus({ preventScroll: true });
    this.selectAll();
  };

  // Header click: a group label toggles its group; any other header selects its rows/columns.
  // With Shift (extend) or Ctrl/Cmd (add), group labels select their rows/columns too.
  #onHeadClick = (e) => {
    if (!(e.target instanceof Element) || e.target.closest('.vg-grip') || isInteractive(e.target)) return;
    const filterBtn = e.target.closest('.vg-filterbtn');
    if (filterBtn?.dataset.filterKey) {
      this.openFilter(parseSortKeyId(filterBtn.dataset.filterKey), filterBtn);
      return;
    }
    const sortBtn = e.target.closest('.vg-sortbtn');
    if (sortBtn?.dataset.sortKey) {
      this.toggleSort(parseSortKeyId(sortBtn.dataset.sortKey), e.shiftKey);
      return;
    }
    const extend = e.shiftKey;
    const add = this.#isMod(e);
    const toggle = e.target.closest('[data-toggle]');
    if (toggle && !extend && !add && this.o.expandable) {
      const [axis, level, group] = toggle.dataset.toggle.split(':');
      this.toggleGroup(axis, Number(level), Number(group));
      return;
    }
    const seg = e.target.closest('.vg-seg');
    if (!seg?.dataset.range) return;
    const [a, b] = seg.dataset.range.split(':').map(Number);
    this.scroller.focus({ preventScroll: true });
    this.#selectLines(e.currentTarget === this.rowHead ? 'rows' : 'cols', a, b, extend ? 'extend' : add ? 'add' : 'set');
  };

  #onHeadPointerDown = (e) => {
    const grip = e.target instanceof Element ? e.target.closest('.vg-grip') : null;
    const col = grip ? Number(grip.parentElement?.dataset.item) : NaN;
    if (!Number.isFinite(col)) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = this.cols.sizeOf(col);
    grip.setPointerCapture(e.pointerId);
    const move = (ev) => this.setColumnWidth(col, startW + ev.clientX - startX);
    const up = () => {
      const width = this.cols.sizeOf(col);
      if (width !== startW) {
        const source = this.colSource(col);
        this.o.onColumnResize?.({ column: source, key: this.model.keyOf?.(source), width });
      }
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  };

  // ---------------------------------------------------------------- rendering

  #render(force = false) {
    const { N, M, rows, cols, model } = this;
    // Nothing to draw (e.g. a filter matched no rows): show a message instead of stale rows.
    const empty = N === 0 || M === 0;
    // Empty state: "No rows match the filter" / "No rows", or what renderEmpty draws.
    const emptySig = empty ? (this.filterParam || this.colFilterParam ? 'filtered' : 'empty') : '';
    if (emptySig !== this.#emptySig) {
      this.#emptySig = emptySig;
      // A renderer that returned a cleanup owns what it drew (React removes its own nodes); otherwise clear it here.
      if (this.emptyCleanup) this.emptyCleanup();
      else this.emptyEl.textContent = '';
      this.emptyCleanup = null;
      if (emptySig) {
        const filtered = emptySig === 'filtered';
        if (this.o.renderEmpty) {
          const out = this.o.renderEmpty(this.emptyEl, { filtered });
          this.emptyCleanup = typeof out === 'function' ? out : null;
        } else {
          this.emptyEl.textContent = filtered ? this.msg.noRows : this.msg.noData;
        }
      }
      this.emptyEl.hidden = !emptySig;
    }
    if (empty !== this.#emptyShown) {
      this.#emptyShown = empty;
      for (const layer of [this.bodyLayer, this.mergeLayerEl, this.selLayerEl, this.rowHeadLayer]) layer.style.visibility = empty ? 'hidden' : '';
    }
    // No rows but some columns: still draw the column headers (the body layers stay hidden).
    if (M === 0) return;
    const { vx, vy } = this;
    if (!force && vx === this.rendered.vx && vy === this.rendered.vy) return;
    const t0 = performance.now();
    const { overscanRows, overscanCols, blockRows: BR, blockCols: BC } = this.o;

    if (!Number.isNaN(this.rendered.vy) && vy !== this.rendered.vy) this.dirY = Math.sign(vy - this.rendered.vy);
    if (!Number.isNaN(this.rendered.vx) && vx !== this.rendered.vx) this.dirX = Math.sign(vx - this.rendered.vx);

    // Window of rows/columns to draw: exactly N rows and M columns, biased toward the scroll direction.
    const firstRow = rows.indexAt(vy);
    const lastRow = Math.max(firstRow, rows.indexAt(vy + this.bodyH - 1));
    let r0 = this.dirY > 0 ? firstRow - 1 : this.dirY < 0 ? lastRow + 2 - N : firstRow - overscanRows;
    r0 = clamp(r0, 0, rows.count - N);
    const r1 = r0 + N - 1;

    const firstCol = cols.indexAt(vx);
    const lastCol = Math.max(firstCol, cols.indexAt(vx + this.bodyW - 1));
    let c0 = this.dirX > 0 ? firstCol - 1 : this.dirX < 0 ? lastCol + 2 - M : firstCol - overscanCols;
    c0 = clamp(c0, 0, cols.count - M);
    const c1 = c0 + M - 1;

    // Rebase anchors so element offsets stay small, then move whole layers with one transform each.
    const r0px = rows.offsetOf(r0);
    if (this.anchorRow === null || Math.abs(r0px - this.anchorRowPx) > REBASE_PX) {
      this.anchorRow = r0;
      this.anchorRowPx = r0px;
      for (const slot of this.rowSlots) slot.r = -1;
    }
    const c0px = cols.offsetOf(c0);
    if (this.anchorCol === null || Math.abs(c0px - this.anchorColPx) > REBASE_PX) {
      this.anchorCol = c0;
      this.anchorColPx = c0px;
      for (const slot of this.rowSlots) for (const cell of slot.cells) cell.c = -1;
    }
    const ox = vx - this.anchorColPx;
    const oy = vy - this.anchorRowPx;
    // Cells, merged cells and the selection overlay share one coordinate space, so all three move together.
    const bodyShift = `translate3d(${-ox}px,${-oy}px,0)`;
    this.bodyLayer.style.transform = bodyShift;
    this.mergeLayerEl.style.transform = bodyShift;
    this.selLayerEl.style.transform = bodyShift;
    this.colHeadLayer.style.transform = `translate3d(${-ox}px,0,0)`;
    this.rowHeadLayer.style.transform = `translate3d(0,${-oy}px,0)`;

    const xs = this.#xs;
    const ws = this.#ws;
    const colSrc = this.#colSrc;
    const kinds = this.#kinds;
    const infos = this.#infos;
    let x = c0px - this.anchorColPx;
    for (let k = 0; k < M; k++) {
      const w = cols.sizeOf(c0 + k);
      xs[k] = x;
      ws[k] = w;
      colSrc[k] = this.colSource(c0 + k);
      this.#colExact[k] = model.colExact ? (model.colExact(c0 + k) ? 1 : 0) : 1;
      const info = this.#infoOf(colSrc[k]);
      infos[k] = info;
      kinds[k] = model.colKind(c0 + k) + info.cls;
      x += w;
    }
    const rowSrc = this.#rowSrc;
    for (let r = r0; r <= r1; r++) {
      rowSrc[r - r0] = this.rowSource(r);
      this.#rowExact[r - r0] = model.rowExact ? (model.rowExact(r) ? 1 : 0) : 1;
    }

    const frameBlocks = new Map();
    const block = (key) => {
      let b = frameBlocks.get(key);
      if (b === undefined) {
        b = this.cache.get(key) ?? null;
        frameBlocks.set(key, b);
      }
      return b;
    };
    // A cell's value may sit in a dense block, a row strip, a column strip or a single-cell unit.
    const valueAt = (rs, cs) => {
      const br = Math.floor(rs / BR);
      const bc = Math.floor(cs / BC);
      const b = block(`${br}:${bc}`) ?? block(`R${rs}:${bc}`) ?? block(`C${br}:${cs}`) ?? block(`X${rs}:${cs}`);
      return b ? b.cells[(rs - b.r0) * b.nc + (cs - b.c0)] : undefined;
    };
    const needs = new Set();
    const label = (axis, level, idx) => {
      const key = `L:${axis}:${level}:${Math.floor(idx / LABEL_BLOCK)}`;
      const b = axis === 'cols' ? this.colLabels.get(key) ?? null : block(key);
      if (b) return b.names[idx - b.from];
      needs.add(key);
      return undefined;
    };

    // Headers.
    // Header items (single row/column segments) that intersect the selection are highlighted.
    const selRanges = this.sel.ranges;
    const colSegs = model.colSegments(c0, c1, label);
    const { sortable, filterable, resizable, expandable } = this.o;
    const noSel = this.o.selection === 'none';
    for (const s of colSegs) {
      if (!sortable) s.sort = undefined;
      if (!filterable) s.filter = undefined;
      if (!resizable) s.resizable = false;
      if (!expandable) s.toggle = undefined;
      s.selected = !noSel && s.a === s.b && selRanges.some((g) => g.c0 <= s.b && g.c1 >= s.a);
      if (s.sort) s.sortState = this.#sortStateOf(s.sort);
      if (s.filter) s.filterOn = this.#hasFilter(s.filter);
    }
    const rowSegs = model.rowSegments(r0, r1, label);
    for (const s of rowSegs) {
      if (!expandable) s.toggle = undefined;
      s.selected = !noSel && s.a === s.b && selRanges.some((g) => g.r0 <= s.b && g.r1 >= s.a);
    }
    this.colSpans.render(colSegs, {
      axis: cols, anchorPx: this.anchorColPx, viewStart: ox, lo: c0, hi: c1, bandOff: this.tierOff, labelExtent: 110,
    });
    this.rowSpans.render(rowSegs, {
      axis: rows, anchorPx: this.anchorRowPx, viewStart: oy, lo: r0, hi: r1, bandOff: this.rowBandOff, labelExtent: rows.minSize,
    });

    // Merged cells: split into visible pieces (a collapsed group ends a piece), drawn over the cells
    // they cover. A piece shows its merge's label or the value of the merge's top-left source cell.
    const cover = this.#cover;
    // Merged cells belong to the unsorted layout; while sorted they would join unrelated rows, so they are hidden.
    const transformed = this.sortParam || this.filterParam;
    if (transformed) cover.fill(0);
    const pieces = transformed ? [] : mergePieces(this.merges, r0, rowSrc, this.#rowExact, c0, colSrc, this.#colExact, cover);
    const anchors = new Set();
    for (const p of pieces) {
      const m = p.merge;
      if (m.label !== undefined) p.text = m.label;
      else {
        const value = valueAt(m.r0, m.c0);
        p.text = value === undefined ? undefined : this.#textOf(value, m.r0, m.c0);
      }
      if (p.text === undefined) anchors.add(`${m.r0}:${m.c0}`);
    }
    this.mergeLayer.render(pieces, { rows, cols, anchorRowPx: this.anchorRowPx, anchorColPx: this.anchorColPx, ox, oy });
    this.#mergeAnchors = anchors;
    this.#pieces = pieces;
    const bands = model.rowBands.length;

    // Body rows: only rows whose slot changed are repositioned; only unfilled cells are written.
    const tiers = model.colTiers.length;
    let rowWrites = 0;
    let cellWrites = 0;
    for (let r = r0; r <= r1; r++) {
      const slot = this.rowSlots[r % N];
      if (slot.r !== r) {
        slot.r = r;
        slot.el.style.transform = `translate3d(0,${rows.offsetOf(r) - this.anchorRowPx}px,0)`;
        const h = rows.sizeOf(r);
        if (h !== slot.h) {
          slot.el.style.height = `${h}px`;
          slot.el.style.lineHeight = `${h}px`;
          slot.h = h;
        }
        const cls = `vg-row${model.rowKind(r)}`;
        if (cls !== slot.cls) {
          slot.el.className = cls;
          slot.cls = cls;
        }
        slot.el.setAttribute('aria-rowindex', String(r + 1 + tiers));
        for (const cell of slot.cells) cell.filled = false;
        rowWrites++;
      }
      const rs = rowSrc[r - r0];
      const coverRow = (r - r0) * M;
      for (let c = c0; c <= c1; c++) {
        const cell = slot.cells[c % M];
        const k = c - c0;
        const covered = cover[coverRow + k];
        if (covered !== cell.covered) {
          cell.el.style.visibility = covered ? 'hidden' : '';
          cell.covered = covered;
        }
        const selected = inRanges(selRanges, r, c);
        if (selected !== cell.selected) {
          cell.el.setAttribute('aria-selected', selected ? 'true' : 'false');
          cell.selected = selected;
        }
        let clsDirty = false;
        if (cell.c !== c) {
          cell.c = c;
          cell.el.setAttribute('aria-colindex', String(c + 1 + bands));
          cell.el.style.transform = `translate3d(${xs[k]}px,0,0)`;
          cell.el.style.width = `${ws[k]}px`;
          cell.base = `vg-cell${kinds[k]}`;
          cell.filled = false;
          clsDirty = true;
        }
        if (!cell.filled) {
          const cs = colSrc[k];
          const value = rs < 0 || cs < 0 ? null : valueAt(rs, cs);
          if (value !== undefined) {
            const info = infos[k];
            let extra = '';
            if (rs < 0 || cs < 0) {
              if (cell.cleanup !== undefined) this.#clearCustom(cell);
              cell.text.data = '';
            } else {
              const ctx = info.hooks ? this.#cellCtx(r, c, rs, cs, value, info.column) : null;
              const text = info.format ? String(info.format(value, ctx) ?? '') : defaultFormat(value);
              if (info.renderCell) {
                ctx.text = text;
                this.#renderCustom(cell, info.renderCell, ctx);
              } else {
                if (cell.cleanup !== undefined) this.#clearCustom(cell);
                cell.text.data = text;
              }
              if (info.cellClass) {
                const add = info.cellClass(value, ctx);
                if (add) extra = ` ${add}`;
              }
            }
            if (extra !== cell.extra) { cell.extra = extra; clsDirty = true; }
            cell.filled = true;
            cellWrites++;
            if (cell.ph) { cell.ph = false; clsDirty = true; }
          } else if (!cell.ph) {
            if (cell.cleanup !== undefined) this.#clearCustom(cell);
            cell.text.data = '';
            cell.ph = true;
            if (cell.extra) cell.extra = '';
            clsDirty = true;
          }
        }
        if (clsDirty) {
          const cls = cell.ph ? `${cell.base} vg-ph` : cell.base + cell.extra;
          if (cls !== cell.cls) {
            cell.el.className = cls;
            cell.cls = cls;
          }
        }
      }
    }

    this.#renderSelection(r0, r1, c0, c1);

    this.rendered.vx = vx;
    this.rendered.vy = vy;
    this.#win = { r0, r1, c0, c1, firstRow, lastRow, firstCol, lastCol };
    this.#labelNeeds = needs;
    this.#scheduleFetch(firstRow, firstCol);

    const ms = performance.now() - t0;
    const s = this.stats;
    s.renders++;
    s.rowWrites += rowWrites;
    s.cellWrites += cellWrites;
    s.renderMsEma = s.renderMsEma === 0 ? ms : s.renderMsEma * 0.9 + ms * 0.1;
    s.renderMsMax = Math.max(s.renderMsMax, ms);
  }

  // ---------------------------------------------------------------- cell content

  /** Format / class / renderer for a source column (from the model, else the grid-wide options). */
  #infoOf(cs) {
    const info = this.model.columnInfo?.(cs);
    if (info) {
      if (info.hooks === undefined) info.hooks = !!(info.format || info.cellClass || info.renderCell);
      return info;
    }
    if (!this.#defaultInfo) {
      const o = this.o;
      this.#defaultInfo = { column: undefined, format: o.format, cellClass: o.cellClass, renderCell: o.renderCell, cls: '' };
      this.#defaultInfo.hooks = !!(o.format || o.cellClass || o.renderCell);
    }
    return this.#defaultInfo;
  }

  /** The text of a value as shown in its column (copy, merged cells, selectionInfo). */
  #textOf(value, rs, cs) {
    if (value === undefined) return undefined;
    const info = this.#infoOf(cs);
    if (!info.format) return defaultFormat(value);
    return String(info.format(value, this.#cellCtx(-1, -1, rs, cs, value, info.column)) ?? '');
  }

  /** What format / cellClass / renderCell get. `row` is the data record when the data source can tell (rowAt). */
  #cellCtx(r, c, rs, cs, value, column) {
    const rowAt = this.o.rowAt;
    let row;
    let rowLoaded = false;
    return {
      rowIndex: r,
      colIndex: c,
      rowSource: rs,
      colSource: cs,
      value,
      text: '',
      column,
      grid: this.o.api,
      get row() {
        if (!rowLoaded) {
          row = rowAt ? rowAt(rs) : undefined;
          rowLoaded = true;
        }
        return row;
      },
    };
  }

  /**
   * A cell drawn by a renderer: render(el, ctx) draws into the cell's own box and may return a cleanup.
   * The cleanup runs before the box is drawn again or goes back to plain text; without one the box is
   * emptied by the grid.
   */
  #renderCustom(cell, render, ctx) {
    if (cell.cleanup !== undefined) this.#runCleanup(cell);
    if (!cell.box) {
      cell.box = document.createElement('div');
      cell.box.className = 'vg-cbox';
      cell.el.appendChild(cell.box);
    }
    cell.box.hidden = false;
    cell.text.data = '';
    const cleanup = render(cell.box, ctx);
    cell.cleanup = typeof cleanup === 'function' ? cleanup : null;
  }

  #runCleanup(cell) {
    if (cell.cleanup) cell.cleanup();
    else if (cell.box) cell.box.textContent = '';
    cell.cleanup = undefined;
  }

  #clearCustom(cell) {
    this.#runCleanup(cell);
    if (cell.box) cell.box.hidden = true;
  }

  // ---------------------------------------------------------------- data

  #scheduleFetch(firstRow, firstCol) {
    // A jump past the whole pool (scrollbar drag, go-to) waits for the position to settle, so a drag
    // across a billion rows does not request every block it passes over.
    const jumped = Math.abs(firstRow - this.#lastFirstRow) > this.N || Math.abs(firstCol - this.#lastFirstCol) > this.M;
    this.#lastFirstRow = firstRow;
    this.#lastFirstCol = firstCol;
    clearTimeout(this.#fetchTimer);
    if (jumped) {
      this.#fetchTimer = setTimeout(() => {
        this.#fetchTimer = 0;
        this.#requestData();
      }, JUMP_FETCH_DELAY_MS);
    } else {
      this.#fetchTimer = 0;
      this.#requestData();
    }
  }

  #requestData() {
    const win = this.#win;
    if (!win) return;
    const { blockRows: BR, blockCols: BC, fetchBlock, fetchLabels } = this.o;
    const query = this.query;
    const labelQuery = this.#serverColFilter ? { ...EMPTY_QUERY, columnFilter: query.columnFilter } : EMPTY_QUERY;
    const sort = this.sortParam; // requests are for the current sort + filter (and land in its cache)
    const filter = this.filterParam;
    const colfilter = this.#serverColFilter;
    const rowCount = this.rows.count;
    const colCount = this.cols.count;
    // Prefetch half a block ahead in the direction of travel, then widen to chunk boundaries so the wish
    // list (and with it the requests) only changes when the window crosses a chunk, not on every step.
    const ra = clamp(alignDown(win.r0 - (this.dirY < 0 ? BR >> 1 : 0), CHUNK_ROWS), 0, rowCount - 1);
    const rb = clamp(alignUp(win.r1 + (this.dirY > 0 ? BR >> 1 : 0), CHUNK_ROWS), 0, rowCount - 1);
    const ca = clamp(alignDown(win.c0 - (this.dirX < 0 ? BC >> 1 : 0), CHUNK_COLS), 0, colCount - 1);
    const cb = clamp(alignUp(win.c1 + (this.dirX > 0 ? BC >> 1 : 0), CHUNK_COLS), 0, colCount - 1);
    const midR = (win.firstRow + win.lastRow) / 2;
    const midC = (win.firstCol + win.lastCol) / 2;

    const list = [];
    const colLabelList = [];
    for (const key of this.#labelNeeds) {
      const [, axis, level, blk] = key.split(':');
      const from = Number(blk) * LABEL_BLOCK;
      // Column labels are the same in every sort order: shared cache, requested without the sort.
      const shared = axis === 'cols';
      (shared ? colLabelList : list).push({
        key,
        dist: -1,
        load: (signal) => fetchLabels({ axis, level: Number(level), from, n: LABEL_BLOCK, signal, query: shared ? labelQuery : query, sort: shared ? '' : sort, filter: shared ? '' : filter, colfilter }).then((names) => ({ from, names })),
      });
    }
    // Data units live in source space (the fully expanded data). Visible items whose sources form a run
    // (expanded data) use dense blocks. Scattered items (collapsed groups) use thin strips, or single
    // cells where a scattered row meets a scattered column; these are batched into one gather request,
    // so a collapsed view does not pull whole blocks to show a few cells.
    // Each unit gets its distance from the middle of the viewport (in blocks) as its priority.
    const split = (from, to, source, size, mid, runMin) => {
      const dense = new Map(); // block index -> distance
      const sparse = new Map(); // source index -> distance
      const { src, isDense } = classifyRuns(from, to, source, this.canGather ? runMin : 0);
      for (let k = 0; k < src.length; k++) {
        const s = src[k];
        if (s < 0) continue;
        const d = Math.abs(from + k - mid) / size;
        const map = isDense[k] ? dense : sparse;
        const id = isDense[k] ? Math.floor(s / size) : s;
        if (!(map.get(id) <= d)) map.set(id, d);
      }
      return { dense, sparse };
    };
    const R = split(ra, rb, this.rowSource, BR, midR, RUN_MIN_ROWS);
    const C = split(ca, cb, this.colSource, BC, midC, RUN_MIN_COLS);
    const rowSrcCount = this.model.rowSourceCount ?? rowCount;
    const colSrcCount = this.model.colSourceCount ?? colCount;
    const rowSpan = (br) => [br * BR, Math.min(BR, rowSrcCount - br * BR)];
    const colSpan = (bc) => [bc * BC, Math.min(BC, colSrcCount - bc * BC)];
    const blockItem = (br, bc, dist) => {
      const [r0, nr] = rowSpan(br);
      const [c0, nc] = colSpan(bc);
      return {
        key: `${br}:${bc}`,
        dist,
        load: (signal) => fetchBlock({ r0, c0, nr, nc, signal, query, sort, filter, colfilter }).then((res) => {
          if (Array.isArray(res)) return { r0, c0, nr, nc, cells: res };
          if (!sort && !filter) this.merges.addServer(res.merges); // merged cells the server reports for this block
          return { r0, c0, nr, nc, cells: res.cells };
        }),
      };
    };
    for (const [br, dr] of R.dense) {
      const [r0, nr] = rowSpan(br);
      for (const [bc, dc] of C.dense) list.push(blockItem(br, bc, dr + dc));
      for (const [cs, dc] of C.sparse) list.push({ key: `C${br}:${cs}`, dist: dr + dc, rect: [r0, cs, nr, 1] });
    }
    for (const [rs, dr] of R.sparse) {
      for (const [bc, dc] of C.dense) {
        const [c0, nc] = colSpan(bc);
        list.push({ key: `R${rs}:${bc}`, dist: dr + dc, rect: [rs, c0, 1, nc] });
      }
      for (const [cs, dc] of C.sparse) list.push({ key: `X${rs}:${cs}`, dist: dr + dc, rect: [rs, cs, 1, 1] });
    }
    // Top-left cells of merges whose start is off screen (their value is shown in every visible piece).
    const keys = new Set(list.map((item) => item.key));
    for (const anchor of this.#mergeAnchors) {
      const [r, c] = anchor.split(':').map(Number);
      const br = Math.floor(r / BR);
      const bc = Math.floor(c / BC);
      if (keys.has(`${br}:${bc}`)) continue;
      const item = this.canGather ? { key: `X${r}:${c}`, dist: 0, rect: [r, c, 1, 1] } : blockItem(br, bc, 0);
      if (keys.has(item.key)) continue;
      keys.add(item.key);
      list.push(item);
    }
    list.sort((a, b) => a.dist - b.dist);
    const sig = `${colLabelList.map((item) => item.key).join('|')}#${list.map((item) => item.key).join('|')}`;
    if (sig === this.#lastWantSig) return;
    this.#lastWantSig = sig;
    this.colLabels.request(colLabelList);
    this.cache.request(list);
  }
}

// ------------------------------------------------------------------ sort helpers

/** Sort order as the request parameter: `3:d,L1:a` (a value column, or a row dimension's names). */
export const sortParamOf = (spec) => spec.map((s) => `${s.key.dim !== undefined ? `L${s.key.dim}` : s.key.col}:${s.dir}`).join(',');

const sortKeyId = (key) => (key.cdim !== undefined ? `x${key.cdim}` : key.dim !== undefined ? `d${key.dim}` : `c${key.col}`);

// ------------------------------------------------------------------ filter helpers

const sameFilterKey = (f, key) => (key.dim !== undefined ? f.dim === key.dim : f.c === key.col);
const filterKeyFields = (key) => (key.dim !== undefined ? { dim: key.dim } : { c: key.col });

/** Filter as the request parameter: JSON, conditions ordered by column so equal filters compare equal. */
export const filterParamOf = (list) => (list.length
  ? JSON.stringify([...list].sort((a, b) => (a.dim ?? -1) - (b.dim ?? -1) || (a.c ?? -1) - (b.c ?? -1)))
  : '');

function describeCondition(f) {
  if (f.op === 'range') {
    if (f.min !== undefined && f.max !== undefined) return `${f.min} – ${f.max}`;
    return f.min !== undefined ? `≥ ${f.min}` : `≤ ${f.max}`;
  }
  if (f.op === 'in') return f.v.length <= 3 ? `is ${f.v.join(', ') || '(nothing)'}` : `is one of ${f.v.length}`;
  if (f.op === 'notin') return f.v.length <= 3 ? `is not ${f.v.join(', ')}` : `excludes ${f.v.length}`;
  return `contains "${f.v}"`;
}

const FILTER_LIST_LIMIT = 1000; // names listed in the filter dialog at once (the server sends no more)

const FUNNEL_SVG = '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="M1.5 2h13l-5 6.2V13l-3 1.5V8.2z" fill="currentColor"/></svg>';

function makeFilterButton() {
  const btn = document.createElement('span');
  btn.className = 'vg-filterbtn';
  btn.hidden = true;
  btn.setAttribute('aria-hidden', 'true'); // keyboard: Alt+F on the active column opens the same dialog
  btn.innerHTML = FUNNEL_SVG;
  return btn;
}

/** state: undefined = not filterable (hidden), false = no filter, true = filtered. */
function paintFilterButton(btn, state) {
  btn.hidden = state === undefined;
  btn.classList.toggle('vg-filter-on', state === true);
  btn.title = state ? 'Filtered: click to change' : 'Filter this column';
}

const parseSortKeyId = (id) => (id[0] === 'x' ? { cdim: Number(id.slice(1)) } : id[0] === 'd' ? { dim: Number(id.slice(1)) } : { col: Number(id.slice(1)) });

function makeSortButton() {
  const btn = document.createElement('span');
  btn.className = 'vg-sortbtn';
  btn.hidden = true; // shown once a segment says it is sortable
  btn.setAttribute('aria-hidden', 'true'); // keyboard: Alt+S on the active column; screen readers get aria-sort
  return btn;
}

/** state: undefined = not sortable (hidden), null = sortable but unsorted, { dir, priority } = sorted. */
function paintSortButton(btn, state) {
  btn.hidden = state === undefined;
  btn.classList.toggle('vg-sort-on', !!state);
  btn.textContent = state ? `${state.dir === 'a' ? '▲' : '▼'}${state.priority ? state.priority : ''}` : '⇅';
  btn.title = state ? 'Sorted: click to change, Shift+click to add another column' : 'Sort: click to sort, Shift+click to add to the sort';
}

/** A field for tab-separated text: quoted (with doubled quotes) when it contains a tab, newline or quote. */
const tsvField = (s) => (/[\t\n\r"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

const escapeHtml = (s) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

/**
 * Writes text + HTML to the clipboard synchronously, inside the current key press: a one-off `copy`
 * event listener fills the clipboard while document.execCommand('copy') runs. Falls back to the async
 * Clipboard API (text only). Returns false when neither path is available.
 */
function writeClipboardNow(text, html) {
  let done = false;
  const onCopy = (e) => {
    e.clipboardData.setData('text/plain', text);
    e.clipboardData.setData('text/html', html);
    e.preventDefault();
    done = true;
  };
  document.addEventListener('copy', onCopy, true);
  try {
    document.execCommand('copy');
  } catch {
    // ignored: falls through to the Clipboard API
  } finally {
    document.removeEventListener('copy', onCopy, true);
  }
  if (done) return true;
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => {});
    return true;
  }
  return false;
}

/** Interactive content drawn by a renderer (cells or headers): the grid leaves its clicks alone. */
const INTERACTIVE = 'a[href], button, input, select, textarea, label, summary, [contenteditable=""], [contenteditable="true"], [data-vg-interactive]';
function isInteractive(target) {
  if (!(target instanceof Element)) return false;
  const hit = target.closest(INTERACTIVE);
  return !!hit && !!hit.closest('.vg-cbox, .vg-hbox');
}

const isEditable = (target) => target instanceof Element && !!target.closest('input, select, textarea, [contenteditable=""], [contenteditable="true"]');

const inRanges = (ranges, r, c) => {
  for (const g of ranges) if (r >= g.r0 && r <= g.r1 && c >= g.c0 && c <= g.c1) return true;
  return false;
};

/**
 * Source index of each item in [from, to], and whether it sits in a run of at least `runMin` items with
 * consecutive sources (dense: fetch whole blocks) or not (sparse: fetch strips). runMin 0 = all dense.
 */
function classifyRuns(from, to, source, runMin) {
  const n = Math.max(0, to - from + 1);
  const src = new Float64Array(n);
  const isDense = new Uint8Array(n);
  for (let k = 0; k < n; k++) src[k] = source(from + k);
  let start = 0;
  for (let k = 1; k <= n; k++) {
    if (k < n && src[k - 1] >= 0 && src[k] === src[k - 1] + 1) continue;
    if (k - start >= runMin) isDense.fill(1, start, k);
    start = k;
  }
  return { src, isDense };
}

function prefixSums(sizes) {
  const out = new Float64Array(sizes.length + 1);
  for (let i = 0; i < sizes.length; i++) out[i + 1] = out[i] + sizes[i];
  return out;
}
