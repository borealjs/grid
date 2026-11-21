// Small helpers shared across modules.

export const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/** Largest index in [lo, hi] whose value is <= v (assumes arr[lo] <= v). */
export function lastLE(arr: ArrayLike<number>, lo: number, hi: number, v: number): number {
  while (lo < hi) {
    const mid = lo + Math.ceil((hi - lo) / 2);
    if (arr[mid] <= v) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** [0, s0, s0+s1, …]: offsets of items with the given sizes, plus the total at the end. */
export function prefixSums(sizes: readonly number[]): Float64Array {
  const out = new Float64Array(sizes.length + 1);
  for (let i = 0; i < sizes.length; i++) out[i + 1] = out[i] + sizes[i];
  return out;
}

/** Deletes the oldest entries (insertion order) until the map holds at most `max`. */
export function trimOldest<K, V>(map: Map<K, V>, max: number, onDrop?: (value: V) => void): void {
  while (map.size > max) {
    const [key, value] = map.entries().next().value as [K, V];
    map.delete(key);
    onDrop?.(value);
  }
}

export const isAbortError = (err: unknown): boolean => (err as { name?: unknown } | null)?.name === 'AbortError';

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** i rounded down / up to the edges of its n-sized chunk. */
export const alignDown = (i: number, n: number): number => Math.floor(i / n) * n;
export const alignUp = (i: number, n: number): number => Math.floor(i / n) * n + n - 1;
