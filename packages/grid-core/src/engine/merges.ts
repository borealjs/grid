// Merged body cells.
//
// A merge is a rectangle in SOURCE coordinates (the fully expanded data): { r0, c0, nr, nc, label? }.
// It shows the value of its top-left source cell, or `label` when given. Merges come from two places:
// - code:   grid.setMerges([...]) replaces the code set; it is kept until replaced.
// - server: data responses carry the merges overlapping them; they accumulate (capped, oldest dropped).
// When two merges overlap, code merges win over server merges, then the one starting higher/further left.
//
// On screen a merge is drawn per visible piece. Visible items are grouped into runs: consecutive
// visible items that each show exactly one source item, with consecutive sources. A collapsed group
// (which stands for many source items) ends a run, so a merge that crosses a collapsed group is
// split into a piece before it and a piece after it, and the collapsed row/column keeps its own value.

import type { Merge } from '../types.js';

const BUCKET = 1024; // rows per index bucket
const LONG = 1024; // merges taller than this are kept in a separate list

/** A merge as given: an object, or a tuple [r0, c0, nr, nc, label?] (the reference protocol). */
export type RawMerge = Merge | [number, number, number, number, (string | null)?];

/** A validated merge with its far edges and identity. */
export interface MergeRecord {
  r0: number;
  c0: number;
  nr: number;
  nc: number;
  r1: number;
  c1: number;
  label: string | undefined;
  key: string;
  /** Set from code (wins over server merges). */
  code: boolean;
}

/** A merge's visible part between two collapsed items, in visible coordinates. */
export interface MergePiece {
  key: string;
  merge: MergeRecord;
  vr0: number;
  vr1: number;
  vc0: number;
  vc1: number;
  /** Text to show (undefined while the top-left cell is loading); filled in by the renderer. */
  text?: string;
}

interface Run {
  v0: number;
  v1: number;
  s0: number;
  s1: number;
}

/** Validates a merge; returns null for invalid or 1×1 merges. */
export function normalizeMerge(raw: unknown, fromCode: boolean): MergeRecord | null {
  const m = raw as Partial<Merge> | null | undefined;
  const [r0, c0, nr, nc, label] = (Array.isArray(raw) ? raw : [m?.r0, m?.c0, m?.nr, m?.nc, m?.label]) as unknown[];
  if (![r0, c0, nr, nc].every(Number.isSafeInteger)) return null;
  const [R0, C0, NR, NC] = [r0, c0, nr, nc] as number[];
  if (R0 < 0 || C0 < 0 || NR < 1 || NC < 1 || NR * NC < 2) return null;
  return {
    r0: R0,
    c0: C0,
    nr: NR,
    nc: NC,
    r1: R0 + NR - 1,
    c1: C0 + NC - 1,
    label: label === undefined || label === null ? undefined : String(label),
    key: `${R0}:${C0}:${NR}:${NC}`,
    code: fromCode,
  };
}

/** Merges by source row range. Bucketed by start row; very tall merges live in a short separate list. */
export class MergeIndex {
  readonly maxServer: number;
  readonly code = new Map<string, MergeRecord>();
  /** Insertion order = age. */
  readonly server = new Map<string, MergeRecord>();
  readonly buckets = new Map<number, MergeRecord[]>();
  readonly long = new Set<MergeRecord>();
  version = 0;

  constructor({ maxServer = 200_000 }: { maxServer?: number } = {}) {
    this.maxServer = maxServer;
  }

  get size(): number {
    return this.code.size + this.server.size;
  }

  setCode(list: readonly unknown[] | null | undefined): void {
    for (const m of this.code.values()) this.#unindex(m);
    this.code.clear();
    for (const raw of list ?? []) {
      const m = normalizeMerge(raw, true);
      if (!m || this.code.has(m.key)) continue;
      this.code.set(m.key, m);
      this.#index(m);
    }
    this.version++;
  }

  addServer(list: readonly unknown[] | null | undefined): boolean {
    let added = false;
    for (const raw of list ?? []) {
      const m = normalizeMerge(raw, false);
      if (!m || this.server.has(m.key)) continue;
      this.server.set(m.key, m);
      this.#index(m);
      added = true;
    }
    while (this.server.size > this.maxServer) {
      const [key, m] = this.server.entries().next().value as [string, MergeRecord];
      this.server.delete(key);
      this.#unindex(m);
    }
    if (added) this.version++;
    return added;
  }

  /** Adds every merge whose rows intersect source rows [sa, sb] to `out` (key -> merge). */
  query(sa: number, sb: number, out: Map<string, MergeRecord>): Map<string, MergeRecord> {
    const first = Math.floor((sa - LONG + 1) / BUCKET);
    const last = Math.floor(sb / BUCKET);
    for (let b = first; b <= last; b++) {
      const list = this.buckets.get(b);
      if (!list) continue;
      for (const m of list) if (m.r0 <= sb && m.r1 >= sa) out.set(m.key, m);
    }
    for (const m of this.long) if (m.r0 <= sb && m.r1 >= sa) out.set(m.key, m);
    return out;
  }

  #index(m: MergeRecord): void {
    if (m.nr > LONG) {
      this.long.add(m);
      return;
    }
    const b = Math.floor(m.r0 / BUCKET);
    let list = this.buckets.get(b);
    if (!list) this.buckets.set(b, (list = []));
    list.push(m);
  }

  #unindex(m: MergeRecord): void {
    if (this.long.delete(m)) return;
    const b = Math.floor(m.r0 / BUCKET);
    const list = this.buckets.get(b);
    if (!list) return;
    const i = list.indexOf(m);
    if (i >= 0) list.splice(i, 1);
    if (list.length === 0) this.buckets.delete(b);
  }
}

/**
 * Runs of visible items starting at visible index `from`: each run is consecutive visible items that
 * show exactly one source item (exact[k] = 1) and whose sources are consecutive.
 */
export function exactRuns(from: number, src: ArrayLike<number>, exact: ArrayLike<number>): Run[] {
  const runs: Run[] = [];
  const n = src.length;
  let k = 0;
  while (k < n) {
    if (!exact[k] || src[k] < 0) {
      k++;
      continue;
    }
    let e = k;
    while (e + 1 < n && exact[e + 1] && src[e + 1] === src[e] + 1) e++;
    runs.push({ v0: from + k, v1: from + e, s0: src[k], s1: src[e] });
    k = e + 1;
  }
  return runs;
}

/** Visible pieces of source range [a, b] along one axis: one per run it intersects. */
export function axisPieces(runs: readonly Run[], a: number, b: number): { v0: number; v1: number; s0: number }[] {
  const out: { v0: number; v1: number; s0: number }[] = [];
  for (const run of runs) {
    const s0 = Math.max(run.s0, a);
    const s1 = Math.min(run.s1, b);
    if (s0 <= s1) out.push({ v0: run.v0 + (s0 - run.s0), v1: run.v0 + (s1 - run.s0), s0 });
  }
  return out;
}

/**
 * Visible pieces of all merges that touch the drawn window, plus a coverage bitmap of the window.
 * Pieces are taken in priority order; a piece overlapping cells already covered is dropped.
 *
 * @param r0 first visible row of the window; rowSrc/rowExact describe rows r0.. (length N)
 * @param c0 first visible column of the window; colSrc/colExact describe columns c0.. (length M)
 * @param cover N×M output, 1 where a cell is under a merge piece
 */
export function mergePieces(
  index: MergeIndex,
  r0: number,
  rowSrc: ArrayLike<number>,
  rowExact: ArrayLike<number>,
  c0: number,
  colSrc: ArrayLike<number>,
  colExact: ArrayLike<number>,
  cover: Uint8Array,
): MergePiece[] {
  cover.fill(0);
  const pieces: MergePiece[] = [];
  if (index.size === 0) return pieces;
  const M = colSrc.length;
  const rowRuns = exactRuns(r0, rowSrc, rowExact);
  const colRuns = exactRuns(c0, colSrc, colExact);
  if (rowRuns.length === 0 || colRuns.length === 0) return pieces;
  const found = new Map<string, MergeRecord>();
  for (const run of rowRuns) index.query(run.s0, run.s1, found);
  const merges = [...found.values()].sort((a, b) => (Number(b.code) - Number(a.code)) || a.r0 - b.r0 || a.c0 - b.c0);
  for (const m of merges) {
    const rp = axisPieces(rowRuns, m.r0, m.r1);
    if (rp.length === 0) continue;
    const cp = axisPieces(colRuns, m.c0, m.c1);
    if (cp.length === 0) continue;
    for (const pr of rp) {
      for (const pc of cp) {
        let free = true;
        for (let r = pr.v0; r <= pr.v1 && free; r++) {
          const base = (r - r0) * M - c0;
          for (let c = pc.v0; c <= pc.v1; c++) {
            if (cover[base + c]) {
              free = false;
              break;
            }
          }
        }
        if (!free) continue;
        for (let r = pr.v0; r <= pr.v1; r++) cover.fill(1, (r - r0) * M + pc.v0 - c0, (r - r0) * M + pc.v1 - c0 + 1);
        pieces.push({ key: `${m.key}|${pr.s0}|${pc.s0}`, merge: m, vr0: pr.v0, vr1: pr.v1, vc0: pc.v0, vc1: pc.v1 });
      }
    }
  }
  return pieces;
}
