// Copying: which cells a selection range covers (with merged cells), loading plans for cells that are
// not cached, and the clipboard formats (tab-separated text + an HTML table).

import type { SelectionRange } from '../types.js';
import type { Rect } from './blocks.js';
import { mergePieces, type MergeIndex, type MergePiece } from './merges.js';

export const MAX_COPY_CELLS = 100_000;
/** Values kept per view for copies (cells loaded only for a copy, not drawn). */
export const COPY_CACHE_MAX = 200_000;

/** One selection range ready to copy: its visible rows/columns, their sources and merged-cell pieces. */
export interface CopyPlan {
  g: SelectionRange;
  nr: number;
  nc: number;
  rowSrc: Float64Array;
  colSrc: Float64Array;
  /** nr × nc, 1 where a cell is under a merged cell. */
  cover: Uint8Array;
  /** Index within the range of each piece's top-left cell -> piece. */
  anchorAt: Map<number, MergePiece>;
}

export interface PlanSources {
  rowSource(r: number): number;
  colSource(c: number): number;
  rowExact?(r: number): boolean;
  colExact?(c: number): boolean;
  /** Merged cells to honour (null while sorted or filtered: merges belong to the unsorted layout). */
  merges: MergeIndex | null;
}

export function planCopy(g: SelectionRange, s: PlanSources): CopyPlan {
  const nr = g.r1 - g.r0 + 1;
  const nc = g.c1 - g.c0 + 1;
  const rowSrc = new Float64Array(nr);
  const rowExact = new Uint8Array(nr);
  for (let i = 0; i < nr; i++) {
    rowSrc[i] = s.rowSource(g.r0 + i);
    rowExact[i] = s.rowExact ? (s.rowExact(g.r0 + i) ? 1 : 0) : 1;
  }
  const colSrc = new Float64Array(nc);
  const colExact = new Uint8Array(nc);
  for (let j = 0; j < nc; j++) {
    colSrc[j] = s.colSource(g.c0 + j);
    colExact[j] = s.colExact ? (s.colExact(g.c0 + j) ? 1 : 0) : 1;
  }
  const cover = new Uint8Array(nr * nc);
  const pieces = s.merges ? mergePieces(s.merges, g.r0, rowSrc, rowExact, g.c0, colSrc, colExact, cover) : [];
  const anchorAt = new Map<number, MergePiece>();
  for (const p of pieces) anchorAt.set((p.vr0 - g.r0) * nc + (p.vc0 - g.c0), p);
  return { g, nr, nc, rowSrc, colSrc, cover, anchorAt };
}

/** Calls need(rs, cs) for every source cell the plans show (merged cells: their top-left cell, unless labelled). */
export function forEachNeededCell(plans: readonly CopyPlan[], need: (rs: number, cs: number) => void): void {
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
}

/**
 * Rectangles covering missing cells (row source -> column sources): each row's columns as runs, then
 * consecutive rows with the same run stacked (up to `maxCells` per rect).
 */
export function coalesceRects(missing: ReadonlyMap<number, ReadonlySet<number>>, maxCells = 20_000): Rect[] {
  const rects: Rect[] = [];
  const open = new Map<string, Rect>(); // "c0:nc" -> rect still growing downward
  for (const rs of [...missing.keys()].sort((a, b) => a - b)) {
    const cols = [...missing.get(rs)!].sort((a, b) => a - b);
    for (let i = 0; i < cols.length;) {
      let j = i;
      while (j + 1 < cols.length && cols[j + 1] === cols[j] + 1) j++;
      const key = `${cols[i]}:${j - i + 1}`;
      const prev = open.get(key);
      if (prev && prev[0] + prev[2] === rs && (prev[2] + 1) * prev[3] <= maxCells) prev[2]++;
      else {
        const rect: Rect = [rs, cols[i], 1, j - i + 1];
        rects.push(rect);
        open.set(key, rect);
      }
      i = j + 1;
    }
  }
  return rects;
}

/** Splits rects into request batches within the limits (rects and cells per request). */
export function batchRects(rects: readonly Rect[], maxRects = 400, maxCells = 20_000): Rect[][] {
  const batches: Rect[][] = [];
  let batch: Rect[] = [];
  let cells = 0;
  for (const rect of rects) {
    const n = rect[2] * rect[3];
    if (batch.length && (batch.length >= maxRects || cells + n > maxCells)) {
      batches.push(batch);
      batch = [];
      cells = 0;
    }
    batch.push(rect);
    cells += n;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

/**
 * Tab-separated text and an HTML table for the planned ranges. Merged cells keep their rowspan/colspan
 * in the HTML; in the text they show in their top-left cell, blanks elsewhere. Several ranges are joined
 * by a blank line. `textAt(rs, cs)` is a source cell's text ('' or undefined when unknown).
 */
export function buildCopy(plans: readonly CopyPlan[], textAt: (rs: number, cs: number) => string | undefined): { text: string; html: string } {
  const texts: string[] = [];
  const tables: string[] = [];
  for (const p of plans) {
    const lines: string[] = [];
    const rowsHtml: string[] = [];
    for (let i = 0; i < p.nr; i++) {
      const fields: string[] = [];
      let tds = '';
      for (let j = 0; j < p.nc; j++) {
        const k = i * p.nc + j;
        const piece = p.anchorAt.get(k);
        let text: string;
        if (piece) {
          const m = piece.merge;
          text = m.label ?? textAt(m.r0, m.c0) ?? '';
          const rs = piece.vr1 - piece.vr0 + 1;
          const cs = piece.vc1 - piece.vc0 + 1;
          tds += `<td${rs > 1 ? ` rowspan="${rs}"` : ''}${cs > 1 ? ` colspan="${cs}"` : ''}>${escapeHtml(text)}</td>`;
        } else if (p.cover[k]) {
          text = ''; // under a merged cell: blank in text, no cell in HTML
        } else {
          const rsrc = p.rowSrc[i];
          const csrc = p.colSrc[j];
          text = rsrc < 0 || csrc < 0 ? '' : textAt(rsrc, csrc) ?? '';
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

/** A field for tab-separated text: quoted (with doubled quotes) when it contains a tab, newline or quote. */
export const tsvField = (s: string): string => (/[\t\n\r"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
export const escapeHtml = (s: string): string => s.replace(/[&<>"]/g, (ch) => HTML_ESCAPES[ch]);

/**
 * Writes text + HTML to the clipboard synchronously, inside the current key press: a one-off `copy`
 * event listener fills the clipboard while document.execCommand('copy') runs. Falls back to the async
 * Clipboard API (text only). Returns false when neither path is available.
 */
export function writeClipboardNow(text: string, html: string): boolean {
  let done = false;
  const onCopy = (e: ClipboardEvent) => {
    e.clipboardData?.setData('text/plain', text);
    e.clipboardData?.setData('text/html', html);
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
