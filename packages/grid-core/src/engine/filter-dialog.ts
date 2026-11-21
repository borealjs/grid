// The filter dialog: a small popover under a header's filter button. Its body depends on the filter
// kind (range, text, value list, or a column's own custom filter); Apply / Clear hand a condition (or
// null) to the engine, and the dialog stays open until the change is applied, so a refusal or an error
// shows where it was made.

import type { Condition } from '../query.js';
import type { FilterItem, FilterValuesResult, Messages } from '../types.js';
import { clamp, errorMessage } from '../util.js';
import type { FilterDescription } from '../model/types.js';
import { element } from './dom.js';

/** Names listed at once (data sources send no more; the user refines the search beyond that). */
export const FILTER_LIST_LIMIT = 1000;

/** A condition without its column / dimension (the engine adds that). */
export type BareCondition = Omit<Condition, 'c' | 'dim'>;

export interface FilterDialogOptions {
  host: HTMLElement;
  messages: Messages;
  description: FilterDescription;
  /** The condition currently set on this key. */
  current: Condition | undefined;
  /** The same in the public format (for custom filters). */
  currentPublic: FilterItem | null;
  /** Why this filter cannot be applied ('' when it can). */
  blocked: string;
  /** The owner applies filter changes (the dialog only reports them). */
  controlled: boolean;
  /** Element to open under (a header's filter button); otherwise the top-left of the body. */
  anchor?: Element | null;
  fallbackAnchor: { left: number; bottom: number };
  /** Set or clear the condition; resolves true when applied. */
  apply(condition: BareCondition | null): Promise<boolean>;
  /** Why the last apply did not happen. */
  outcome(): { refusal: string; cancelled: boolean };
  /** Stop the sort / filter being applied. */
  cancel(): void;
  /** Close the dialog and give the focus back to the grid. */
  close(): void;
  /** Close without moving the focus (a click outside). */
  dismiss(): void;
}

interface Body {
  /** The condition the inputs describe, or null for "no filter". */
  read(): BareCondition | null;
  onClose?: () => void;
}

type Field = (labelText: string, type: string, value?: unknown) => HTMLInputElement;

export class FilterDialog {
  readonly el: HTMLDivElement;
  /** While a change is being applied: where the engine writes progress. */
  workStatus: HTMLElement | null = null;
  #closed = false;
  #busy = false;
  #onClose: (() => void) | undefined;
  readonly #onOutside: (e: PointerEvent) => void;

  constructor(private readonly o: FilterDialogOptions) {
    const { messages: m, description: desc, current, host } = o;
    const pop = (this.el = element('div', 'vg-filter-pop'));
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', `Filter ${desc.name}`);
    element('div', 'vg-filter-title', pop, m.filterTitle(desc.name));
    const body = element('div', 'vg-filter-body', pop);
    const field: Field = (labelText, type, value) => {
      const label = element('label', 'vg-filter-field', body);
      element('span', '', label, labelText);
      const input = element('input', '', label);
      input.type = type;
      if (type === 'number') input.step = 'any';
      if (value !== undefined) input.value = String(value);
      return input;
    };

    let content: Body;
    if (desc.kind === 'custom') content = this.#customBody(body, desc);
    else if (desc.kind === 'number' || desc.kind === 'date') content = rangeBody(field, m, desc.kind, current);
    else if (desc.kind === 'text') content = textBody(field, m, current);
    else content = valuesBody(body, field, m, desc, current);
    this.#onClose = content.onClose;

    // Status line: why filtering is not available, progress, or what went wrong.
    const status = element('div', 'vg-filter-status', pop);
    status.setAttribute('role', 'status');
    const actions = element('div', 'vg-filter-actions', pop);
    const cancel = element('button', 'vg-filter-cancel', actions, m.cancel);
    const clear = element('button', '', actions, m.clear);
    const apply = element('button', 'vg-filter-apply', actions, m.apply);
    cancel.type = 'button';
    clear.type = 'button';
    apply.type = 'button';
    cancel.hidden = true;
    cancel.addEventListener('click', () => o.cancel());
    if (o.blocked) {
      status.textContent = o.blocked;
      status.classList.add('vg-filter-error');
      apply.disabled = true;
    }
    clear.disabled = !current;

    this.#finish = async (condition) => {
      if (this.#busy || (condition && o.blocked)) return;
      if (o.controlled) {
        o.close();
        void o.apply(condition);
        return;
      }
      this.#busy = true;
      apply.disabled = clear.disabled = true;
      status.classList.remove('vg-filter-error');
      status.textContent = m.applying;
      cancel.hidden = false;
      this.workStatus = status;
      const ok = await o.apply(condition);
      if (this.#closed) return;
      this.workStatus = null;
      cancel.hidden = true;
      const { refusal, cancelled } = o.outcome();
      if (ok || (!refusal && !cancelled)) {
        o.close();
        return;
      }
      this.#busy = false;
      apply.disabled = !!o.blocked;
      clear.disabled = !current;
      status.textContent = refusal;
      status.classList.toggle('vg-filter-error', !!refusal);
      // The Cancel button that may have had the focus is hidden now: keep the focus in the dialog (Escape, Enter).
      pop.querySelector('input')?.focus();
    };
    clear.addEventListener('click', () => this.#finish(null));
    apply.addEventListener('click', () => this.#finish(content.read()));
    pop.addEventListener('keydown', (e) => {
      e.stopPropagation(); // keep grid shortcuts out of the dialog
      if (e.key === 'Escape') {
        e.preventDefault();
        o.close();
      } else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        this.#finish(content.read());
      }
    });

    // Place under the anchor, inside the grid.
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    host.appendChild(pop);
    const hostRect = host.getBoundingClientRect();
    const a = o.anchor?.getBoundingClientRect() ?? { left: hostRect.left + o.fallbackAnchor.left, bottom: hostRect.top + o.fallbackAnchor.bottom };
    const left = clamp(a.left - hostRect.left - pop.offsetWidth + 24, 8, Math.max(8, hostRect.width - pop.offsetWidth - 8));
    pop.style.left = `${left}px`;
    pop.style.top = `${Math.min(a.bottom - hostRect.top + 4, Math.max(8, hostRect.height - pop.offsetHeight - 8))}px`;
    this.#onOutside = (e) => {
      if (!pop.contains(e.target as Node) && !(e.target instanceof Element && e.target.closest('.vg-filterbtn'))) o.dismiss();
    };
    document.addEventListener('pointerdown', this.#onOutside, true);
    pop.querySelector('input')?.focus();
  }

  #finish: (condition: BareCondition | null) => Promise<void>;

  /** Removes the dialog (idempotent). */
  destroy(): void {
    if (this.#closed) return;
    this.#closed = true;
    document.removeEventListener('pointerdown', this.#onOutside, true);
    this.#onClose?.();
    this.el.remove();
  }

  /** A filter the column brings itself: render(el, api) draws it; Apply sends { op, v: value }. */
  #customBody(body: HTMLElement, desc: Extract<FilterDescription, { kind: 'custom' }>): Body {
    const box = element('div', 'vg-filter-custom', body);
    let value: unknown = this.o.current?.v;
    const read = (): BareCondition | null => (value === undefined || value === null ? null : { op: desc.op, v: value });
    const cleanup = desc.render(box, {
      value,
      condition: this.o.currentPublic,
      column: desc.column,
      title: desc.name,
      setValue: (v) => { value = v; },
      apply: (v) => this.#finish(v === undefined ? read() : v === null ? null : { op: desc.op, v }),
      clear: () => this.#finish(null),
      close: () => this.o.close(),
    });
    return { read, onClose: typeof cleanup === 'function' ? cleanup : undefined };
  }
}

function rangeBody(field: Field, m: Messages, kind: 'number' | 'date', current: Condition | undefined): Body {
  const type = kind === 'number' ? 'number' : 'date';
  const lo = field(kind === 'number' ? m.min : m.from, type, current?.min);
  const hi = field(kind === 'number' ? m.max : m.to, type, current?.max);
  const parse = (input: HTMLInputElement) => (input.value === '' ? undefined : type === 'number' ? Number(input.value) : input.value);
  return {
    read: () => {
      const min = parse(lo);
      const max = parse(hi);
      return min === undefined && max === undefined ? null : { op: 'range', min, max };
    },
  };
}

function textBody(field: Field, m: Messages, current: Condition | undefined): Body {
  const input = field(m.contains, 'search', current?.v);
  input.placeholder = m.containsPlaceholder;
  return { read: () => (input.value.trim() ? { op: 'contains', v: input.value.trim() } : null) };
}

/**
 * Lists can be huge (100k years, millions of cities), so the dialog never holds them all: it shows at
 * most FILTER_LIST_LIMIT names matching the search (from the data source, or from `values`) and
 * remembers the choice as "all except …" or "only …", which become 'notin' / 'in' conditions.
 */
function valuesBody(body: HTMLElement, field: Field, m: Messages, desc: Extract<FilterDescription, { kind: 'values' }>, current: Condition | undefined): Body {
  const search = field(m.find, 'search');
  search.placeholder = m.searchValues();
  const tools = element('div', 'vg-filter-tools', body);
  const all = element('button', '', tools, m.all);
  const none = element('button', '', tools, m.none);
  all.type = 'button';
  none.type = 'button';
  const list = element('div', 'vg-filter-list', body);
  list.setAttribute('role', 'group');
  list.setAttribute('aria-label', `${desc.name} values`);
  const note = element('div', 'vg-filter-note', body);
  note.setAttribute('role', 'status');
  const lookup = desc.search ?? ((q: string): FilterValuesResult => {
    const values = desc.values ?? [];
    const needle = q.trim().toLowerCase();
    const matching = needle ? values.filter((v) => v.toLowerCase().includes(needle)) : values;
    return { total: values.length, matches: matching.length, values: matching.slice(0, FILTER_LIST_LIMIT) };
  });
  let only = current?.op === 'in'; // false: "all except set"
  const set = new Set<string>(current?.op === 'in' || current?.op === 'notin' ? current.v : []);
  const isChecked = (v: string) => (only ? set.has(v) : !set.has(v));
  const setChecked = (v: string, on: boolean) => {
    if (only === on) set.add(v);
    else set.delete(v);
  };
  let shown: { value: string; box: HTMLInputElement }[] = [];
  let fullList: string[] | null = null; // every value, when one unsearched response held them all
  const renderList = (res: FilterValuesResult) => {
    list.textContent = '';
    shown = res.values.map((value) => {
      const row = element('label', 'vg-filter-option', list);
      const box = element('input', '', row);
      box.type = 'checkbox';
      box.checked = isChecked(value);
      box.addEventListener('change', () => setChecked(value, box.checked));
      element('span', '', row, value);
      return { value, box };
    });
    const total = res.total ?? res.values.length;
    const matches = res.matches ?? res.values.length;
    search.placeholder = m.searchValues(total);
    note.textContent = matches === 0 ? m.noValues : matches > res.values.length ? m.refineSearch(res.values.length, matches) : '';
  };
  let ctrl: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const load = async (q: string) => {
    ctrl?.abort();
    const mine = (ctrl = new AbortController());
    note.textContent = m.loadingValues;
    try {
      const res = await lookup(q, mine.signal);
      if (mine.signal.aborted) return;
      if (!q.trim() && (res.matches ?? res.values.length) === res.values.length) fullList = res.values;
      renderList(res);
    } catch (err) {
      if (!mine.signal.aborted) note.textContent = m.valuesFailed(errorMessage(err));
    }
  };
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => load(search.value), desc.search ? 200 : 0);
  });
  // All / None: with no search, every value (also the ones not listed); with a search, the listed ones.
  const mark = (on: boolean) => {
    if (!search.value.trim()) {
      only = !on;
      set.clear();
    } else {
      for (const b of shown) setChecked(b.value, on);
    }
    for (const b of shown) b.box.checked = isChecked(b.value);
  };
  all.addEventListener('click', () => mark(true));
  none.addEventListener('click', () => mark(false));
  void load('');
  return {
    read: () => {
      if (fullList) {
        // Whole list known: send the shorter of "only these" / "all but these".
        const picked = fullList.filter(isChecked);
        if (picked.length === fullList.length) return null;
        return picked.length <= fullList.length - picked.length ? { op: 'in', v: picked } : { op: 'notin', v: fullList.filter((v) => !isChecked(v)) };
      }
      if (!only && set.size === 0) return null;
      return { op: only ? 'in' : 'notin', v: [...set] };
    },
    onClose: () => {
      clearTimeout(timer);
      ctrl?.abort();
    },
  };
}
