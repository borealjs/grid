import type { Axis } from '../axes/axis.js';

/**
 * The visible columns of a table: all source columns, or a sorted subset (hidden columns, column
 * filters). Widths are per source column (or one default), kept as prefix sums over the visible ones.
 */
export class ColumnsAxis implements Axis {
  readonly count: number;
  total = 0;
  minSize = 100;
  /** Prefix sums of widths (null when every column has `width`). */
  offsets: Float64Array | null = null;
  width = 100;

  constructor(
    readonly sourceCount: number,
    widthOf: ((src: number) => number) | null,
    /** Source indexes of the visible columns, in display order; null = every column. */
    readonly visible: Int32Array | null,
  ) {
    this.count = visible ? visible.length : sourceCount;
    if (visible) {
      for (let i = 1; i < visible.length; i++) {
        if (visible[i] <= visible[i - 1]) {
          // Reordered: binary search no longer works, keep a source -> visible map.
          this.#reverse = new Int32Array(sourceCount).fill(-1);
          for (let k = 0; k < visible.length; k++) this.#reverse[visible[k]] = k;
          break;
        }
      }
    }
    if (widthOf) {
      const offsets = new Float64Array(this.count + 1);
      let min = Infinity;
      for (let i = 0; i < this.count; i++) {
        const w = widthOf(this.sourceOf(i));
        offsets[i + 1] = offsets[i] + w;
        if (w < min) min = w;
      }
      this.offsets = offsets;
      this.total = offsets[this.count];
      this.minSize = Number.isFinite(min) ? min : 100;
    }
  }

  static uniform(sourceCount: number, width: number, visible: Int32Array | null): ColumnsAxis {
    const axis = new ColumnsAxis(sourceCount, null, visible);
    axis.width = width;
    axis.total = axis.count * width;
    axis.minSize = width;
    return axis;
  }

  #reverse: Int32Array | null = null;

  sourceOf(i: number): number { return this.visible ? this.visible[i] : i; }

  fromSource(src: number): number {
    if (!this.visible) return src >= 0 && src < this.sourceCount ? src : -1;
    if (this.#reverse) return src >= 0 && src < this.sourceCount ? this.#reverse[src] : -1;
    let lo = 0;
    let hi = this.visible.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const v = this.visible[mid];
      if (v === src) return mid;
      if (v < src) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  offsetOf(i: number): number { return this.offsets ? this.offsets[i] : i * this.width; }

  sizeOf(i: number): number { return this.offsets ? this.offsets[i + 1] - this.offsets[i] : this.width; }

  indexAt(px: number): number {
    if (this.count === 0 || px <= 0) return 0;
    if (!this.offsets) return Math.min(Math.floor(px / this.width), this.count - 1);
    let lo = 0;
    let hi = this.count - 1;
    while (lo < hi) {
      const mid = lo + Math.ceil((hi - lo) / 2);
      if (this.offsets[mid] <= px) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
}
