// Axes map item indexes (rows or columns) to pixel offsets and back.

/** One dimension of the grid: `count` items with pixel sizes, `total` pixels long. */
export interface Axis {
  readonly count: number;
  readonly total: number;
  /** Smallest item size (pools of row / cell elements are sized for it). */
  readonly minSize: number;
  offsetOf(i: number): number;
  sizeOf(i: number): number;
  /** Item at a pixel offset (clamped to the axis). */
  indexAt(px: number): number;
  /** Visible -> source index, for axes that show a subset or a collapsible tree of their source items. */
  sourceOf?(i: number): number;
  /** Source -> visible index (-1 when not visible). */
  fromSource?(src: number): number;
}

/** Every item the same size. */
export class UniformAxis implements Axis {
  readonly total: number;
  readonly minSize: number;

  constructor(readonly count: number, readonly size: number) {
    this.total = count * size;
    this.minSize = size;
  }

  offsetOf(i: number): number { return i * this.size; }

  sizeOf(): number { return this.size; }

  indexAt(px: number): number {
    if (this.count === 0 || px <= 0) return 0;
    return Math.min(Math.floor(px / this.size), this.count - 1);
  }
}
