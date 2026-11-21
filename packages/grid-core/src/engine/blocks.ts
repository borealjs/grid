// How cells and labels are cached: the unit shapes and their cache keys.
//
// Cells are cached in source coordinates (the fully expanded data) in one of four unit shapes:
//   `${br}:${bc}`   a dense block of blockRows × blockCols cells
//   `R${rs}:${bc}`  one row, a block's columns       (scattered rows, e.g. collapsed pivot groups)
//   `C${br}:${cs}`  a block's rows, one column       (scattered columns)
//   `X${rs}:${cs}`  one cell                         (a scattered row meets a scattered column)
// Header labels are cached in runs of LABEL_BLOCK: `L:${axis}:${level}:${block}`.

/** [r0, c0, nr, nc] in source coordinates. */
export type Rect = [number, number, number, number];

/** Cells of a rect, row-major. */
export interface CellBlock {
  r0: number;
  c0: number;
  nr: number;
  nc: number;
  cells: unknown[];
}

/** Header labels from index `from` on. */
export interface LabelBlock {
  from: number;
  names: string[];
}

export const LABEL_BLOCK = 500;

export const blockKey = (br: number, bc: number): string => `${br}:${bc}`;
export const rowStripKey = (rs: number, bc: number): string => `R${rs}:${bc}`;
export const colStripKey = (br: number, cs: number): string => `C${br}:${cs}`;
export const cellKey = (rs: number, cs: number): string => `X${rs}:${cs}`;

export const labelKey = (axis: string, level: number, index: number): string => `L:${axis}:${level}:${Math.floor(index / LABEL_BLOCK)}`;

export function parseLabelKey(key: string): { axis: 'rows' | 'cols'; level: number; from: number } {
  const [, axis, level, blk] = key.split(':');
  return { axis: axis as 'rows' | 'cols', level: Number(level), from: Number(blk) * LABEL_BLOCK };
}

/** The value of source cell (rs, cs) from whichever unit holds it, or undefined when none is loaded. */
export function lookupCell(get: (key: string) => CellBlock | null | undefined, rs: number, cs: number, blockRows: number, blockCols: number): unknown {
  const br = Math.floor(rs / blockRows);
  const bc = Math.floor(cs / blockCols);
  const b = get(blockKey(br, bc)) ?? get(rowStripKey(rs, bc)) ?? get(colStripKey(br, cs)) ?? get(cellKey(rs, cs));
  return b ? b.cells[(rs - b.r0) * b.nc + (cs - b.c0)] : undefined;
}

/**
 * Source index of each item in [from, to], and whether it sits in a run of at least `runMin` items with
 * consecutive sources (dense: fetch whole blocks) or not (sparse: fetch strips). runMin 0 = all dense.
 */
export function classifyRuns(from: number, to: number, source: (i: number) => number, runMin: number): { src: Float64Array; isDense: Uint8Array } {
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
