// The display order of a table's columns as runs of consecutive source columns: [0…4], 9, [5…8], [10…n).
// Moving a column splits at most two runs, so a table with a million (or a trillion) columns keeps its
// order in a few entries, and lookups are binary searches over the runs.

/** A column order in its compact public form: single source indexes and inclusive [first, last] runs. */
export type CompactOrder = (number | [number, number])[];

interface Run {
  s: number;
  len: number;
}

export class RunOrder {
  #runs: Run[];
  /** Display position where each run starts (one more entry: the total). */
  #starts = new Float64Array(1);
  /** Run indexes sorted by their first source index, for source -> position. */
  #bySource: number[] = [];

  constructor(readonly count: number, runs?: Run[]) {
    this.#runs = runs ?? (count > 0 ? [{ s: 0, len: count }] : []);
    this.#index();
  }

  /** An order from a list of source indexes (missing ones follow in their natural order). */
  static fromList(count: number, list: readonly number[]): RunOrder {
    const seen = new Set<number>();
    const runs: Run[] = [];
    const add = (s: number) => {
      const last = runs[runs.length - 1];
      if (last && last.s + last.len === s) last.len++;
      else runs.push({ s, len: 1 });
    };
    for (const s of list) if (Number.isInteger(s) && s >= 0 && s < count && !seen.has(s)) { seen.add(s); add(s); }
    if (seen.size < count) RunOrder.#appendMissing(count, runs, (s) => seen.has(s));
    return new RunOrder(count, runs);
  }

  /** An order from its compact form; invalid or overlapping entries are dropped, missing columns appended. */
  static fromCompact(count: number, compact: CompactOrder): RunOrder {
    const runs: Run[] = [];
    const taken: [number, number][] = [];
    const overlaps = (a: number, b: number) => taken.some(([x, y]) => a <= y && b >= x);
    for (const item of compact) {
      const [a, b] = Array.isArray(item) ? item : [item, item];
      if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < a || b >= count || overlaps(a, b)) continue;
      taken.push([a, b]);
      const last = runs[runs.length - 1];
      if (last && last.s + last.len === a) last.len += b - a + 1;
      else runs.push({ s: a, len: b - a + 1 });
    }
    taken.sort((p, q) => p[0] - q[0]);
    let next = 0;
    for (const [a, b] of taken) {
      if (a > next) runs.push({ s: next, len: a - next });
      next = b + 1;
    }
    if (next < count) runs.push({ s: next, len: count - next });
    return new RunOrder(count, RunOrder.#merge(runs));
  }

  static #appendMissing(count: number, runs: Run[], has: (s: number) => boolean): void {
    for (let s = 0; s < count; s++) {
      if (has(s)) continue;
      const last = runs[runs.length - 1];
      if (last && last.s + last.len === s) last.len++;
      else runs.push({ s, len: 1 });
    }
  }

  static #merge(runs: Run[]): Run[] {
    const out: Run[] = [];
    for (const r of runs) {
      if (r.len <= 0) continue;
      const last = out[out.length - 1];
      if (last && last.s + last.len === r.s) last.len += r.len;
      else out.push({ ...r });
    }
    return out;
  }

  #index(): void {
    const runs = this.#runs;
    this.#starts = new Float64Array(runs.length + 1);
    for (let k = 0; k < runs.length; k++) this.#starts[k + 1] = this.#starts[k] + runs[k].len;
    this.#bySource = runs.map((_, k) => k).sort((a, b) => runs[a].s - runs[b].s);
  }

  get identity(): boolean {
    return this.#runs.length <= 1;
  }

  #runAt(i: number): number {
    const st = this.#starts;
    let lo = 0;
    let hi = this.#runs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (st[mid] <= i) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  sourceOf(i: number): number {
    if (i < 0 || i >= this.count) return -1;
    const k = this.#runAt(i);
    return this.#runs[k].s + (i - this.#starts[k]);
  }

  fromSource(src: number): number {
    const ids = this.#bySource;
    let lo = 0;
    let hi = ids.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = this.#runs[ids[mid]];
      if (src < r.s) hi = mid - 1;
      else if (src >= r.s + r.len) lo = mid + 1;
      else return this.#starts[ids[mid]] + (src - r.s);
    }
    return -1;
  }

  /** Move the column at display position `from` so it ends up at position `to`. */
  move(from: number, to: number): void {
    if (from === to || from < 0 || to < 0 || from >= this.count || to >= this.count) return;
    const src = this.sourceOf(from);
    const runs: Run[] = [];
    // Remove `src`: split its run around it.
    for (const r of this.#runs) {
      if (src >= r.s && src < r.s + r.len) {
        runs.push({ s: r.s, len: src - r.s }, { s: src + 1, len: r.s + r.len - src - 1 });
      } else runs.push({ ...r });
    }
    const without = RunOrder.#merge(runs);
    // Insert it before what is now at position `to` (or at the end).
    const out: Run[] = [];
    let pos = 0;
    let placed = false;
    for (const r of without) {
      if (!placed && to < pos + r.len) {
        const cut = to - pos;
        out.push({ s: r.s, len: cut }, { s: src, len: 1 }, { s: r.s + cut, len: r.len - cut });
        placed = true;
      } else out.push(r);
      pos += r.len;
    }
    if (!placed) out.push({ s: src, len: 1 });
    this.#runs = RunOrder.#merge(out);
    this.#index();
  }

  /** Every source index in display order (O(columns): only for tables with a column list). */
  forEach(fn: (src: number, position: number) => void): void {
    let p = 0;
    for (const r of this.#runs) for (let j = 0; j < r.len; j++) fn(r.s + j, p++);
  }

  toCompact(): CompactOrder {
    return this.#runs.map((r) => (r.len === 1 ? r.s : [r.s, r.s + r.len - 1]));
  }
}
