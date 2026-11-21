// Item axis for a hierarchy (pivot rows or columns). Shared by the browser and the server.
//
// The axis is a flat sequence of items in depth-first order:
//   group 0 › group 0.0 › leaves…, [subtotal 0.0], group 0.1 › …, [subtotal 0], group 1 › …, [grand total]
//
// - `levels.length` group levels; leaves (all `leafSize`) sit under the deepest groups.
// - Each level can close its groups with a subtotal item of its own size.
// - An optional grand total item ends the axis.
// - Groups at levels with subtotals can be collapsed: the group then shows as one item that stands for
//   its subtotal, and everything inside it is hidden.
//
// Two index spaces:
// - visible index: position on screen with the current collapse state (what offsetOf/indexAt use)
// - source index:  position in the fully expanded tree (what the server stores and serves)
// sourceOf()/fromSource() convert between them, so data blocks are fetched and cached by source index
// and stay valid across expand/collapse.
//
// Only groups are stored (Float64Arrays per level), never leaves, so a few thousand groups can hold
// billions of leaves. Lookups descend the tree: O(depth · log fan-out). Changing the collapse state
// relayouts in O(groups).

/** Largest index in [lo, hi] whose value is <= v (assumes arr[lo] <= v). */
export function lastLE(arr, lo, hi, v) {
  while (lo < hi) {
    const mid = lo + Math.ceil((hi - lo) / 2);
    if (arr[mid] <= v) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export class TreeAxis {
  /**
   * @param {object} spec
   * @param {{name: string, subtotal?: boolean, subtotalSize?: number}[]} spec.levels group levels, outermost first
   * @param {number} spec.roots number of groups at level 0
   * @param {(number | number[])[]} spec.fanout per level: children per group (a number = same for every group);
   *   for the deepest level this is the number of leaves per group
   * @param {number} spec.leafSize pixel size of a leaf item
   * @param {boolean} [spec.grandTotal]
   * @param {number} [spec.grandSize]
   */
  constructor(spec) {
    const { levels, roots, fanout, leafSize, grandTotal = false, grandSize = leafSize } = spec;
    const D = levels.length;
    if (D < 1 || fanout.length !== D) throw new Error('TreeAxis: need one fanout entry per level');
    this.depth = D;
    this.levels = levels;
    this.leafSize = leafSize;
    this.sub = levels.map((l) => !!l.subtotal);
    this.subSize = levels.map((l) => (l.subtotal ? (l.subtotalSize ?? leafSize) : 0));
    this.grandTotal = !!grandTotal;
    this.grandSize = this.grandTotal ? grandSize : 0;

    // Group counts and child ranges per level.
    this.cnt = new Array(D);
    this.childStart = new Array(D);
    this.cnt[0] = roots;
    for (let L = 0; L < D; L++) {
      const n = this.cnt[L];
      const f = fanout[L];
      const cs = new Float64Array(n + 1);
      if (typeof f === 'number') {
        for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + f;
      } else {
        if (f.length !== n) throw new Error(`TreeAxis: level ${L} fanout has ${f.length} entries, expected ${n}`);
        for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + f[i];
      }
      this.childStart[L] = cs;
      if (L + 1 < D) this.cnt[L + 1] = cs[n];
    }
    this.leafCount = this.childStart[D - 1][this.cnt[D - 1]];

    this.collapsed = this.cnt.map((n) => new Uint8Array(n));
    this.hidden = this.cnt.map((n) => new Uint8Array(n));
    this.#layout();

    // The fully expanded layout is the source index space.
    this.fullItemStart = this.itemStart.map((a) => a.slice());
    this.fullItems = this.items.map((a) => a.slice());
    this.fullCount = this.count;
    this.fullGrandIndex = this.grandIndex;

    let min = leafSize;
    for (let L = 0; L < D; L++) if (this.sub[L]) min = Math.min(min, this.subSize[L]);
    if (this.grandTotal) min = Math.min(min, this.grandSize);
    this.minSize = min;
  }

  // ---------------------------------------------------------------- collapse state

  /** Only levels with subtotals can collapse: the collapsed item shows the subtotal's values. */
  canCollapse(level) {
    return level >= 0 && level < this.depth && this.sub[level];
  }

  isCollapsed(level, group) {
    return this.collapsed[level][group] === 1;
  }

  setCollapsed(level, group, value) {
    if (!this.canCollapse(level)) return;
    this.collapsed[level][group] = value ? 1 : 0;
    this.#layout();
  }

  toggle(level, group) {
    this.setCollapsed(level, group, !this.isCollapsed(level, group));
  }

  /** Expand everything above `level` and collapse every group at `level`. */
  showLevel(level) {
    for (const c of this.collapsed) c.fill(0);
    if (this.canCollapse(level)) this.collapsed[level].fill(1);
    this.#layout();
  }

  expandAll() {
    for (const c of this.collapsed) c.fill(0);
    this.#layout();
  }

  /** Collapse exactly the (collapsible) groups for which pred(level, group) is true, with one relayout. */
  setCollapsedWhere(pred) {
    for (let L = 0; L < this.depth; L++) {
      const can = this.canCollapse(L);
      const flags = this.collapsed[L];
      for (let g = 0; g < flags.length; g++) flags[g] = can && pred(L, g) ? 1 : 0;
    }
    this.#layout();
  }

  /** Visible index of a group's first item (its collapsed item when collapsed), or -1 if it is hidden. */
  groupStart(level, group) {
    return this.hidden[level][group] ? -1 : this.itemStart[level][group];
  }

  #layout() {
    const D = this.depth;
    const leafSize = this.leafSize;
    // Bottom-up: item count and pixel size of every group (including its subtotal).
    this.items = new Array(D);
    this.px = new Array(D);
    for (let L = D - 1; L >= 0; L--) {
      const n = this.cnt[L];
      const cs = this.childStart[L];
      const col = this.collapsed[L];
      const items = new Float64Array(n);
      const px = new Float64Array(n);
      const sub = this.sub[L] ? 1 : 0;
      const subPx = this.subSize[L];
      for (let i = 0; i < n; i++) {
        if (col[i]) {
          items[i] = 1;
          px[i] = subPx;
        } else if (L === D - 1) {
          const leaves = cs[i + 1] - cs[i];
          items[i] = leaves + sub;
          px[i] = leaves * leafSize + subPx;
        } else {
          const ci = this.items[L + 1];
          const cp = this.px[L + 1];
          let a = sub;
          let b = subPx;
          for (let j = cs[i]; j < cs[i + 1]; j++) {
            a += ci[j];
            b += cp[j];
          }
          items[i] = a;
          px[i] = b;
        }
      }
      this.items[L] = items;
      this.px[L] = px;
    }

    // Top-down: absolute first item index and pixel offset of every group. Groups inside a collapsed or
    // hidden group are hidden; they get their parent's start so each level stays sorted.
    this.itemStart = new Array(D);
    this.pxStart = new Array(D);
    let s = 0;
    let p = 0;
    this.itemStart[0] = new Float64Array(this.cnt[0]);
    this.pxStart[0] = new Float64Array(this.cnt[0]);
    for (let i = 0; i < this.cnt[0]; i++) {
      this.itemStart[0][i] = s;
      this.pxStart[0][i] = p;
      s += this.items[0][i];
      p += this.px[0][i];
    }
    const rootItems = s;
    const rootPx = p;
    for (let L = 0; L + 1 < D; L++) {
      const cs = this.childStart[L];
      const is = new Float64Array(this.cnt[L + 1]);
      const ps = new Float64Array(this.cnt[L + 1]);
      const hid = this.hidden[L + 1];
      for (let i = 0; i < this.cnt[L]; i++) {
        let a = this.itemStart[L][i];
        let b = this.pxStart[L][i];
        const gone = this.collapsed[L][i] || this.hidden[L][i] ? 1 : 0;
        for (let j = cs[i]; j < cs[i + 1]; j++) {
          is[j] = a;
          ps[j] = b;
          hid[j] = gone;
          if (!gone) {
            a += this.items[L + 1][j];
            b += this.px[L + 1][j];
          }
        }
      }
      this.itemStart[L + 1] = is;
      this.pxStart[L + 1] = ps;
    }

    this.grandIndex = this.grandTotal ? rootItems : -1;
    this.count = rootItems + (this.grandTotal ? 1 : 0);
    this.total = rootPx + this.grandSize;
  }

  // ---------------------------------------------------------------- lookups (visible index space)

  /**
   * What visible item `i` is: a leaf, a subtotal closing a group at `level`, a collapsed group at
   * `level`, or the grand total. `path` holds the group index at each level down to the item's group.
   */
  locate(i) {
    return this.#descend(i, this.itemStart, this.items, true);
  }

  #descend(i, starts, items, collapseAware) {
    if (this.grandTotal && i >= (collapseAware ? this.grandIndex : this.fullGrandIndex)) return { kind: 'grand', level: -1, path: [] };
    const D = this.depth;
    let n = lastLE(starts[0], 0, this.cnt[0] - 1, i);
    const path = [n];
    for (let L = 0; ; L++) {
      if (collapseAware && this.collapsed[L][n]) return { kind: 'collapsed', level: L, path };
      const start = starts[L][n];
      const end = start + items[L][n];
      if (this.sub[L] && i === end - 1) return { kind: 'subtotal', level: L, path };
      if (L === D - 1) {
        const k = i - start;
        return { kind: 'leaf', level: D, path, leafInGroup: k, leaf: this.childStart[L][n] + k };
      }
      n = lastLE(starts[L + 1], this.childStart[L][n], this.childStart[L][n + 1] - 1, i);
      path.push(n);
    }
  }

  offsetOf(i) {
    if (i >= this.count) return this.total;
    if (i <= 0) return 0;
    const loc = this.locate(i);
    if (loc.kind === 'grand') return this.total - this.grandSize;
    const n = loc.path[loc.path.length - 1];
    if (loc.kind === 'collapsed') return this.pxStart[loc.level][n];
    if (loc.kind === 'subtotal') return this.pxStart[loc.level][n] + this.px[loc.level][n] - this.subSize[loc.level];
    return this.pxStart[this.depth - 1][n] + loc.leafInGroup * this.leafSize;
  }

  sizeOf(i) {
    const loc = this.locate(i);
    if (loc.kind === 'grand') return this.grandSize;
    if (loc.kind === 'subtotal' || loc.kind === 'collapsed') return this.subSize[loc.level];
    return this.leafSize;
  }

  indexAt(px) {
    if (this.count === 0 || px <= 0) return 0;
    if (px >= this.total) return this.count - 1;
    if (this.grandTotal && px >= this.total - this.grandSize) return this.grandIndex;
    const D = this.depth;
    let n = lastLE(this.pxStart[0], 0, this.cnt[0] - 1, px);
    for (let L = 0; ; L++) {
      if (this.collapsed[L][n]) return this.itemStart[L][n];
      const ps = this.pxStart[L][n];
      const pe = ps + this.px[L][n];
      if (this.sub[L] && px >= pe - this.subSize[L]) return this.itemStart[L][n] + this.items[L][n] - 1;
      if (L === D - 1) {
        const leaves = this.childStart[L][n + 1] - this.childStart[L][n];
        const k = Math.min(Math.floor((px - ps) / this.leafSize), leaves - 1);
        return this.itemStart[L][n] + k;
      }
      n = lastLE(this.pxStart[L + 1], this.childStart[L][n], this.childStart[L][n + 1] - 1, px);
    }
  }

  /** Calls fn(group, firstItem, lastItem) for every visible group at `level` overlapping items [a, b]. */
  forEachGroup(level, a, b, fn) {
    const st = this.itemStart[level];
    const it = this.items[level];
    const hid = this.hidden[level];
    const n = this.cnt[level];
    if (n === 0) return;
    let g = st[0] <= a ? lastLE(st, 0, n - 1, a) : 0;
    // Hidden groups share their parent's start, so step back over any that tie with the visible one.
    while (g > 0 && st[g - 1] === st[g]) g--;
    for (; g < n && st[g] <= b; g++) {
      if (hid[g]) continue;
      const last = st[g] + it[g] - 1;
      if (last >= a) fn(g, st[g], last);
    }
  }

  // ---------------------------------------------------------------- visible <-> source

  /** Source (fully expanded) index of visible item `i`. A collapsed group maps to its subtotal. */
  sourceOf(i) {
    const loc = this.locate(i);
    if (loc.kind === 'grand') return this.fullGrandIndex;
    const n = loc.path[loc.path.length - 1];
    if (loc.kind === 'leaf') return this.fullItemStart[this.depth - 1][n] + loc.leafInGroup;
    return this.fullItemStart[loc.level][n] + this.fullItems[loc.level][n] - 1;
  }

  /**
   * Source index that marks where visible item `i` sits, for keeping the scroll position across a
   * collapse/expand: a collapsed group is anchored at its first source item (so expanding it keeps
   * the group's start in place), anything else at its own source item.
   */
  anchorSourceOf(i) {
    const loc = this.locate(i);
    if (loc.kind === 'collapsed') return this.fullItemStart[loc.level][loc.path[loc.path.length - 1]];
    return this.sourceOf(i);
  }

  /**
   * Visible index of source item `f`. When `f` is inside a collapsed group: returns that group's
   * collapsed item if `containing` is true; otherwise -1 (unless `f` is the group's own subtotal,
   * which the collapsed item stands for).
   */
  fromSource(f, containing = false) {
    const loc = this.#descend(f, this.fullItemStart, this.fullItems, false);
    if (loc.kind === 'grand') return this.grandIndex;
    const { path } = loc;
    for (let L = 0; L < path.length; L++) {
      if (this.collapsed[L][path[L]]) {
        if (containing || (loc.kind === 'subtotal' && loc.level === L)) return this.itemStart[L][path[L]];
        return -1;
      }
    }
    const n = path[path.length - 1];
    if (loc.kind === 'leaf') return this.itemStart[this.depth - 1][n] + loc.leafInGroup;
    return this.itemStart[loc.level][n] + this.items[loc.level][n] - 1;
  }
}
