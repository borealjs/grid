// Selection geometry, in visible coordinates. A merged cell counts as one cell for the active cell and
// for arrow keys, but ranges stay the rectangle the user drew: they never grow to cover a merged cell
// they only touch (a merge can span thousands of rows).

import type { CellPosition, SelectionRange } from '../types.js';
import type { MergePiece } from './merges.js';

/** `anchor` is where a range started, `focus` the corner being moved, `active` the outlined cell. */
export interface SelectionState {
  active: CellPosition;
  anchor: CellPosition;
  focus: CellPosition;
  ranges: SelectionRange[];
}

export const inRanges = (ranges: readonly SelectionRange[], r: number, c: number): boolean => {
  for (const g of ranges) if (r >= g.r0 && r <= g.r1 && c >= g.c0 && c <= g.c1) return true;
  return false;
};

export const sameRange = (a: SelectionRange, b: SelectionRange): boolean => a.r0 === b.r0 && a.r1 === b.r1 && a.c0 === b.c0 && a.c1 === b.c1;

export const cellCount = (ranges: readonly SelectionRange[]): number => {
  let n = 0;
  for (const g of ranges) n += (g.r1 - g.r0 + 1) * (g.c1 - g.c0 + 1);
  return n;
};

/** The merged-cell piece that covers (r, c), if any. */
export function pieceAt(pieces: readonly MergePiece[], r: number, c: number): MergePiece | null {
  for (const p of pieces) if (r >= p.vr0 && r <= p.vr1 && c >= p.vc0 && c <= p.vc1) return p;
  return null;
}

/** The range a single cell occupies: the merged cell around it, or the cell itself. */
export function cellRange(pieces: readonly MergePiece[], { r, c }: CellPosition): SelectionRange {
  const p = pieceAt(pieces, r, c);
  return p ? { r0: p.vr0, c0: p.vc0, r1: p.vr1, c1: p.vc1 } : { r0: r, c0: c, r1: r, c1: c };
}

/** The rectangle between two cells. */
export const rangeOf = (a: CellPosition, b: CellPosition): SelectionRange => ({
  r0: Math.min(a.r, b.r),
  c0: Math.min(a.c, b.c),
  r1: Math.max(a.r, b.r),
  c1: Math.max(a.c, b.c),
});

/** True when the range is just the active cell: that cell alone, or the whole merged cell it is in. */
export function isActiveOnly(pieces: readonly MergePiece[], g: SelectionRange, active: CellPosition): boolean {
  if (g.r0 === g.r1 && g.c0 === g.c1 && g.r0 === active.r && g.c0 === active.c) return true;
  return sameRange(g, cellRange(pieces, active));
}
