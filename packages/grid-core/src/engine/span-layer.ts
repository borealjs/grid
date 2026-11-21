import type { Axis } from '../axes/axis.js';
import { viewKeyId } from '../query.js';
import type { HeaderContext, Renderer } from '../types.js';
import { clamp } from '../util.js';
import type { AxisName, Segment } from '../model/types.js';
import { makeFilterButton, makeSortButton, paintAriaSort, paintFilterButton, paintSortButton } from './dom.js';

/** One header element and the last values written to it (writes are skipped when nothing changed). */
interface SpanEntry {
  el: HTMLDivElement;
  label: HTMLSpanElement;
  text: Text;
  /** Box a header renderer draws into (created on first use). */
  box: HTMLSpanElement | null;
  /** The renderer's cleanup; null = renderer returned none (the box is emptied); undefined = nothing drawn. */
  cleanup: (() => void) | null | undefined;
  /** What the renderer last drew ('' = no renderer, '~' = stale). */
  rsig: string;
  sortBtn: HTMLSpanElement | null;
  filterBtn: HTMLSpanElement | null;
  sort: string;
  filter: string;
  pos: number;
  cpos: number;
  size: number;
  csize: number;
  lh: number;
  shift: number;
  cls: string;
  str: string | null;
  item: string;
  toggle: string;
  range: string;
  hidden: boolean;
  /** Row checkbox (rowSelection), created on first use. */
  check: HTMLInputElement | null;
  chk: string;
  movable: boolean;
}

export interface SpanRenderContext {
  axis: Axis;
  /** Pixel offset the layer is positioned from (see the engine's rebasing anchors). */
  anchorPx: number;
  /** Where the visible part starts, relative to anchorPx. */
  viewStart: number;
  /** Drawn item window. */
  lo: number;
  hi: number;
  /** Offsets of the header bands (rows) or tiers (columns). */
  bandOff: Float64Array;
  /** Length of a label that is kept in view while its span scrolls. */
  labelExtent: number;
}

/**
 * Draws header segments: { key, a, b (item range), t0, t1 (band range), label, cls, resizable }.
 * Elements are keyed, so a segment that stays on screen keeps its node; others reuse hidden ones.
 * Segments are clipped to the drawn window, so a group spanning a billion rows stays a small box.
 */
export class SpanLayer {
  /** The grid-wide header renderer, used when `hasRenderer()` and a segment has none of its own. */
  renderHeader: Renderer<HeaderContext> | null = null;
  hasRenderer: () => boolean = () => false;
  /** Accessible name of row checkboxes. */
  checkLabel = 'Select row';
  live = new Map<string | number, SpanEntry>();
  free: SpanEntry[] = [];

  constructor(
    readonly layer: HTMLElement,
    /** Row headers (true) or column headers. */
    readonly vertical: boolean,
    readonly withGrip: boolean,
    readonly withSort = false,
    readonly axisName: AxisName = 'cols',
  ) {}

  #create(): SpanEntry {
    const el = document.createElement('div');
    el.setAttribute('role', this.vertical ? 'rowheader' : 'columnheader');
    const label = document.createElement('span');
    label.className = 'vg-sl';
    const text = label.appendChild(document.createTextNode(''));
    el.appendChild(label);
    let sortBtn: HTMLSpanElement | null = null;
    let filterBtn: HTMLSpanElement | null = null;
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
    return {
      el, label, text, box: null, cleanup: undefined, rsig: '', sortBtn, filterBtn, sort: '', filter: '',
      pos: NaN, cpos: NaN, size: NaN, csize: NaN, lh: NaN, shift: 0, cls: '', str: null, item: '', toggle: '', range: '', hidden: false,
      check: null, chk: '', movable: false,
    };
  }

  render(segments: readonly Segment[], ctx: SpanRenderContext): void {
    const { axis, anchorPx, viewStart, lo, hi, bandOff, labelExtent } = ctx;
    const v = this.vertical;
    const next = new Map<string | number, SpanEntry>();
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
      const cls = `vg-seg${seg.cls ? ` ${seg.cls}` : ''}${pending ? ' vg-ph' : ''}${seg.selected ? ' vg-sel' : ''}${this.withSort && seg.sort ? ' vg-sortable' : ''}${this.withSort && seg.filter ? ' vg-filterable' : ''}${seg.check !== undefined ? ' vg-has-check' : ''}${seg.check ? ' vg-checked' : ''}`;
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
      const str = pending ? '' : (seg.label as string);
      // A header renderer (the segment's own, else the grid's) draws the label once it is loaded.
      const render = pending ? null : seg.render ?? (this.hasRenderer() ? this.renderHeader : null);
      if (render) this.#drawCustom(e, seg, str, render);
      else {
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
      const chk = seg.check === undefined ? '' : seg.check ? '1' : '0';
      if (chk !== e.chk) {
        if (chk && !e.check) {
          const box = document.createElement('input');
          box.type = 'checkbox';
          box.className = 'vg-check';
          box.tabIndex = -1;
          box.setAttribute('aria-label', this.checkLabel);
          e.el.insertBefore(box, e.el.firstChild);
          e.check = box;
        }
        if (e.check) {
          e.check.hidden = !chk;
          e.check.checked = chk === '1';
        }
        e.chk = chk;
      }
      // A click toggles the box natively; keep it equal to the grid's state.
      if (e.check && chk && e.check.checked !== (chk === '1')) e.check.checked = chk === '1';
      const movable = !!seg.movable && seg.a === seg.b;
      if (movable !== e.movable) {
        if (movable) e.el.dataset.move = '1';
        else delete e.el.dataset.move;
        e.movable = movable;
      }
      if (this.withSort) this.#paintControls(e, seg);
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

  #drawCustom(e: SpanEntry, seg: Segment, str: string, render: Renderer<HeaderContext>): void {
    const st = seg.sortState;
    const rsig = `${seg.key}|${str}|${st ? st.dir + st.priority : ''}|${seg.filterOn ? 1 : 0}|${seg.selected ? 1 : 0}`;
    if (rsig === e.rsig) return;
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

  /** Sort and filter controls: key id, state, and aria-sort for the primary sort key. */
  #paintControls(e: SpanEntry, seg: Segment): void {
    const filter = seg.filter ? `${viewKeyId(seg.filter)}|${seg.filterOn ? 1 : 0}` : '';
    if (filter !== e.filter && e.filterBtn) {
      e.filter = filter;
      if (seg.filter) e.filterBtn.dataset.filterKey = viewKeyId(seg.filter);
      else delete e.filterBtn.dataset.filterKey;
      paintFilterButton(e.filterBtn, seg.filter ? !!seg.filterOn : undefined);
    }
    const st = seg.sortState;
    const sort = seg.sort ? `${viewKeyId(seg.sort)}|${st ? st.dir + st.priority : ''}` : '';
    if (sort !== e.sort && e.sortBtn) {
      e.sort = sort;
      if (seg.sort) e.sortBtn.dataset.sortKey = viewKeyId(seg.sort);
      else delete e.sortBtn.dataset.sortKey;
      paintSortButton(e.sortBtn, seg.sort ? st : undefined);
      paintAriaSort(e.el, st);
    }
  }

  #clearCustom(e: SpanEntry): void {
    if (e.cleanup) e.cleanup();
    else if (e.cleanup === null && e.box) e.box.textContent = '';
    e.cleanup = undefined;
  }

  /** Forget what custom renderers drew, so every segment is drawn again. */
  resetCustom(): void {
    // Mark custom content stale; the next frame replaces it in one step (clearing it now would leave
    // headers blank while nothing is drawn, e.g. while the grid has no rows).
    for (const e of this.live.values()) {
      if (e.rsig) e.rsig = '~';
      e.str = null;
    }
  }

  destroy(): void {
    for (const e of [...this.live.values(), ...this.free]) this.#clearCustom(e);
  }
}
