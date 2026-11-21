import type { Axis } from './axis.js';

/**
 * Wraps any axis and lets single items be resized (sparse overrides, O(log k) offsets).
 * If the base axis maps visible <-> source indexes (collapsible trees, column subsets), sizes are
 * remembered by source index, so a resized column keeps its width when groups around it collapse or expand.
 */
export class ResizableAxis<A extends Axis = Axis> implements Axis {
  /** Source index -> px. */
  readonly overrides = new Map<number, number>();
  /** Visible index -> px. */
  visibleSizes = new Map<number, number>();
  /** Visible indexes with an override, ascending. */
  keys: number[] = [];
  /** deltaPrefix[k]: sum of (override - base size) over keys[0..k-1]. */
  deltaPrefix = new Float64Array(1);
  minSize = 0;
  total = 0;

  constructor(public base: A) {
    this.#rebuild();
  }

  get count(): number { return this.base.count; }

  sizeOf(i: number): number { return this.visibleSizes.get(i) ?? this.base.sizeOf(i); }

  setSize(i: number, px: number): void {
    const key = this.base.sourceOf ? this.base.sourceOf(i) : i;
    if (px === this.base.sizeOf(i)) this.overrides.delete(key);
    else this.overrides.set(key, px);
    this.#rebuild();
  }

  /** Sizes for source items, all at once (e.g. widths from column descriptions). */
  setSourceSizes(entries: readonly [number, number][]): void {
    for (const [src, px] of entries) this.overrides.set(src, px);
    this.#rebuild();
  }

    /** Call after the base axis changed its layout (collapse / expand, or a new base). */
  refresh(): void {
    this.#rebuild();
  }

  offsetOf(i: number): number { return this.base.offsetOf(i) + this.deltaPrefix[this.#before(i)]; }

  indexAt(px: number): number {
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

  /** Number of overridden items before visible index i. */
  #before(i: number): number {
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

  #rebuild(): void {
    const base = this.base;
    const toVisible = base.fromSource ? (src: number) => base.fromSource!(src) : (src: number) => src;
    this.visibleSizes = new Map();
    for (const [src, px] of this.overrides) {
      const i = toVisible(src);
      if (i >= 0) this.visibleSizes.set(i, px);
    }
    this.keys = [...this.visibleSizes.keys()].sort((a, b) => a - b);
    this.deltaPrefix = new Float64Array(this.keys.length + 1);
    let min = base.minSize;
    for (let k = 0; k < this.keys.length; k++) {
      const i = this.keys[k];
      const s = this.visibleSizes.get(i)!;
      this.deltaPrefix[k + 1] = this.deltaPrefix[k] + s - base.sizeOf(i);
      min = Math.min(min, s);
    }
    this.minSize = min;
    this.total = base.total + this.deltaPrefix[this.keys.length];
  }
}
