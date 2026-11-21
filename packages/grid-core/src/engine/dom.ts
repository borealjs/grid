// DOM helpers: element factories, header controls, and checks for content drawn by renderers.

import type { SortDir } from '../query.js';

export function div(cls: string, parent?: Element | null): HTMLDivElement {
  const el = document.createElement('div');
  el.className = cls;
  parent?.appendChild(el);
  return el;
}

export function element<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, parent?: Element | null, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  parent?.appendChild(node);
  return node;
}

/** Sort state shown on a sort control: direction, and priority (1-based, only when several keys; else 0). */
export interface SortState {
  dir: SortDir;
  priority: number;
}

const FUNNEL_SVG = '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="M1.5 2h13l-5 6.2V13l-3 1.5V8.2z" fill="currentColor"/></svg>';

export function makeFilterButton(): HTMLSpanElement {
  const btn = document.createElement('span');
  btn.className = 'vg-filterbtn';
  btn.hidden = true;
  btn.setAttribute('aria-hidden', 'true'); // keyboard: Alt+F on the active column opens the same dialog
  btn.innerHTML = FUNNEL_SVG;
  return btn;
}

/** state: undefined = not filterable (hidden), false = no filter, true = filtered. */
export function paintFilterButton(btn: HTMLElement, state: boolean | undefined): void {
  btn.hidden = state === undefined;
  btn.classList.toggle('vg-filter-on', state === true);
  btn.title = state ? 'Filtered: click to change' : 'Filter this column';
}

export function makeSortButton(): HTMLSpanElement {
  const btn = document.createElement('span');
  btn.className = 'vg-sortbtn';
  btn.hidden = true; // shown once a segment says it is sortable
  btn.setAttribute('aria-hidden', 'true'); // keyboard: Alt+S on the active column; screen readers get aria-sort
  return btn;
}

/** state: undefined = not sortable (hidden), null = sortable but unsorted, { dir, priority } = sorted. */
export function paintSortButton(btn: HTMLElement, state: SortState | null | undefined): void {
  btn.hidden = state === undefined;
  btn.classList.toggle('vg-sort-on', !!state);
  btn.textContent = state ? `${state.dir === 'a' ? '▲' : '▼'}${state.priority ? state.priority : ''}` : '⇅';
  btn.title = state ? 'Sorted: click to change, Shift+click to add another column' : 'Sort: click to sort, Shift+click to add to the sort';
}

/** aria-sort for the primary sort key, removed otherwise. */
export function paintAriaSort(el: Element, state: SortState | null | undefined): void {
  if (state && state.priority <= 1) el.setAttribute('aria-sort', state.dir === 'a' ? 'ascending' : 'descending');
  else el.removeAttribute('aria-sort');
}

/** Interactive content drawn by a renderer (cells or headers): the grid leaves its clicks alone. */
const INTERACTIVE = 'a[href], button, input, select, textarea, label, summary, [contenteditable=""], [contenteditable="true"], [data-vg-interactive]';

export function isInteractive(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const hit = target.closest(INTERACTIVE);
  return !!hit && !!hit.closest('.vg-cbox, .vg-hbox');
}

export const isEditable = (target: EventTarget | null): boolean =>
  target instanceof Element && !!target.closest('input, select, textarea, [contenteditable=""], [contenteditable="true"]');

/** The closest element matching `selector` from an event target (null for non-elements). */
export const closest = (target: EventTarget | null, selector: string): HTMLElement | null =>
  (target instanceof Element ? target.closest<HTMLElement>(selector) : null);
