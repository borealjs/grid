import type { CacheStats } from '../types.js';
import { isAbortError } from '../util.js';
import type { CellBlock, LabelBlock, Rect } from './blocks.js';

export type CacheEntry = CellBlock | LabelBlock;

/** A wish-list item: its own request (`load`, e.g. a dense block), or a gather unit (`rect`) batched with others. */
export type WishItem<V> =
  | { key: string; dist?: number; load(signal: AbortSignal): Promise<V>; rect?: undefined }
  | { key: string; dist?: number; rect: Rect; load?: undefined };

export interface BlockCacheOptions {
  maxCells?: number;
  maxEntries?: number;
  /** Requests in flight at once. */
  concurrency?: number;
  maxGatherRects?: number;
  maxGatherCells?: number;
  /** Loads several rects in one request: one row-major array per rect. */
  gather?: (rects: Rect[], signal: AbortSignal) => Promise<unknown[][]>;
  onLoad?: () => void;
  onError?: (err: unknown) => void;
}

interface Flight {
  controller: AbortController;
  keys: Set<string>;
}

const sizeOfEntry = (value: unknown): number => {
  const v = value as { cells?: unknown[]; names?: unknown[] } | undefined;
  return v?.cells?.length ?? v?.names?.length ?? 1;
};

/**
 * Keyed async cache: deduplicates requests, limits concurrent requests, aborts unwanted ones, and
 * evicts least recently used entries once a cell budget is exceeded.
 *
 * Wish-list items either carry their own `load(signal)` (one request each, e.g. a dense block) or a
 * `rect: [r0, c0, nr, nc]` (a gather unit: a strip or a single cell). Queued gather units are batched
 * into one `gather(rects, signal)` call. A batch is aborted only when none of its units is wanted.
 */
export class BlockCache<V extends CacheEntry = CacheEntry> {
  maxCells: number;
  maxEntries: number;
  concurrency: number;
  maxGatherRects: number;
  maxGatherCells: number;
  gather: BlockCacheOptions['gather'];
  onLoad: BlockCacheOptions['onLoad'];
  onError: BlockCacheOptions['onError'];
  /** Insertion order = LRU order. */
  readonly entries = new Map<string, V>();
  cellCount = 0;
  readonly inflight = new Map<string, Flight>();
  readonly flights = new Set<Flight>();
  queue: WishItem<V>[] = [];
  wanted = new Set<string>();
  readonly stats: CacheStats = { requests: 0, gatherRequests: 0, gatherUnits: 0, cellsFetched: 0, aborted: 0, errors: 0, lastMs: 0 };

  constructor({ maxCells = 2_000_000, maxEntries = 50_000, concurrency = 6, maxGatherRects = 400, maxGatherCells = 20_000, gather, onLoad, onError }: BlockCacheOptions = {}) {
    this.maxCells = maxCells;
    this.maxEntries = maxEntries;
    this.concurrency = concurrency;
    this.maxGatherRects = maxGatherRects;
    this.maxGatherCells = maxGatherCells;
    this.gather = gather;
    this.onLoad = onLoad;
    this.onError = onError;
  }

  get(key: string): V | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  /** Replace the wish list (priority order). Requests for keys no longer wanted are aborted. */
  request(list: WishItem<V>[]): void {
    this.wanted = new Set(list.map((item) => item.key));
    for (const [key, flight] of this.inflight) {
      if (this.wanted.has(key)) continue;
      this.inflight.delete(key);
      flight.keys.delete(key);
      if (flight.keys.size === 0) {
        flight.controller.abort();
        this.flights.delete(flight);
        this.stats.aborted++;
      }
    }
    this.queue = list.filter((item) => !this.entries.has(item.key) && !this.inflight.has(item.key));
    this.#pump();
  }

  abortAll(): void {
    for (const flight of this.flights) flight.controller.abort();
    this.flights.clear();
    this.inflight.clear();
    this.queue = [];
  }

  #pump(): void {
    while (this.flights.size < this.concurrency && this.queue.length > 0) {
      const first = this.queue.shift()!;
      const batch = [first];
      if (first.rect) {
        // Pull every other queued gather unit into the same request, up to the size limits.
        let cells = first.rect[2] * first.rect[3];
        for (let i = 0; i < this.queue.length && batch.length < this.maxGatherRects;) {
          const item = this.queue[i];
          const n = item.rect ? item.rect[2] * item.rect[3] : Infinity;
          if (cells + n <= this.maxGatherCells) {
            batch.push(item);
            cells += n;
            this.queue.splice(i, 1);
          } else {
            i++;
          }
        }
      }
      const controller = new AbortController();
      const flight: Flight = { controller, keys: new Set(batch.map((item) => item.key)) };
      this.flights.add(flight);
      for (const item of batch) this.inflight.set(item.key, flight);
      this.stats.requests++;
      if (first.rect) {
        this.stats.gatherRequests++;
        this.stats.gatherUnits += batch.length;
      }
      const started = performance.now();
      const work: Promise<[string, V][]> = first.rect
        ? this.gather!(batch.map((item) => item.rect!), controller.signal).then((arrays) =>
          batch.map((item, i): [string, V] => {
            const [r0, c0, nr, nc] = item.rect!;
            return [item.key, { r0, c0, nr, nc, cells: arrays[i] } as V];
          }))
        : first.load!(controller.signal).then((value): [string, V][] => [[first.key, value]]);
      work
        .then(
          (results) => {
            this.flights.delete(flight);
            for (const [key, value] of results) {
              if (this.inflight.get(key) === flight) this.inflight.delete(key);
              this.#store(key, value); // keep units that went out of view meanwhile too: already paid for
            }
            this.stats.lastMs = performance.now() - started;
            this.onLoad?.();
          },
          (err: unknown) => {
            this.flights.delete(flight);
            for (const key of flight.keys) if (this.inflight.get(key) === flight) this.inflight.delete(key);
            if (isAbortError(err)) return;
            this.stats.errors++;
            console.warn(`Request for ${[...flight.keys].slice(0, 3).join(', ')}${flight.keys.size > 3 ? '…' : ''} failed:`, err);
            this.onError?.(err);
          },
        )
        .finally(() => this.#pump());
    }
  }

  #store(key: string, value: V): void {
    const old = this.entries.get(key);
    if (old !== undefined) {
      this.cellCount -= sizeOfEntry(old);
      this.entries.delete(key);
    }
    this.entries.set(key, value);
    const n = sizeOfEntry(value);
    this.cellCount += n;
    this.stats.cellsFetched += n;
    while ((this.cellCount > this.maxCells || this.entries.size > this.maxEntries) && this.entries.size > 1) {
      const [oldestKey, oldest] = this.entries.entries().next().value as [string, V];
      this.entries.delete(oldestKey);
      this.cellCount -= sizeOfEntry(oldest);
    }
  }
}
