import type { Axis } from '../axes/axis.js';
import { clamp } from '../util.js';
import type { MergePiece } from './merges.js';

interface MergeEntry {
  el: HTMLDivElement;
  label: HTMLSpanElement;
  text: Text;
  x: number;
  y: number;
  w: number;
  h: number;
  lh: number;
  sx: number;
  sy: number;
  cls: string;
  str: string | null;
  hidden: boolean;
}

export interface MergeRenderContext {
  rows: Axis;
  cols: Axis;
  anchorRowPx: number;
  anchorColPx: number;
  /** Visible part's top-left, relative to the anchors. */
  ox: number;
  oy: number;
}

/**
 * Draws merged-cell pieces over the body cells: { key, vr0, vr1, vc0, vc1, text }.
 * Keyed like SpanLayer; the label stays in the visible part of a piece taller or wider than the view.
 */
export class MergeLayer {
  live = new Map<string, MergeEntry>();
  free: MergeEntry[] = [];

  constructor(readonly layer: HTMLElement) {}

  #create(): MergeEntry {
    const el = document.createElement('div');
    el.setAttribute('role', 'gridcell');
    const label = document.createElement('span');
    label.className = 'vg-ml';
    const text = label.appendChild(document.createTextNode(''));
    el.appendChild(label);
    this.layer.appendChild(el);
    return { el, label, text, x: NaN, y: NaN, w: NaN, h: NaN, lh: NaN, sx: 0, sy: 0, cls: '', str: null, hidden: false };
  }

  render(pieces: readonly MergePiece[], { rows, cols, anchorRowPx, anchorColPx, ox, oy }: MergeRenderContext): void {
    const next = new Map<string, MergeEntry>();
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
      const str = pending ? '' : (p.text as string);
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
