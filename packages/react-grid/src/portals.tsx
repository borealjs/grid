import { useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

type Entry = [el: HTMLElement, node: ReactNode, key: string];

/**
 * Elements the grid asked React to fill: element -> React node. The grid calls set() when a cell or
 * header changes and the returned cleanup when it goes back to text or is reused; updates are batched
 * into one React render per frame (a microtask after the grid's own frame, before paint).
 */
export interface PortalStore {
  set(el: HTMLElement, node: ReactNode): () => void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): Entry[];
}

export function createPortalStore(): PortalStore {
  const nodes = new Map<HTMLElement, ReactNode>();
  const ids = new WeakMap<HTMLElement, string>();
  const listeners = new Set<() => void>();
  let seq = 0;
  let snapshot: Entry[] = [];
  let queued = false;
  const flush = () => {
    queued = false;
    snapshot = Array.from(nodes, ([el, node]): Entry => [el, node, ids.get(el)!]);
    for (const l of listeners) l();
  };
  const schedule = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(flush);
  };
  return {
    set(el, node) {
      if (!ids.has(el)) ids.set(el, `p${seq++}`);
      nodes.set(el, node);
      schedule();
      return () => {
        if (nodes.get(el) === node) {
          nodes.delete(el);
          schedule();
        }
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
  };
}

const EMPTY: Entry[] = [];
const emptySnapshot = () => EMPTY;

/** Renders every node the grid asked for into its element. */
export function Portals({ store }: { store: PortalStore }) {
  const entries = useSyncExternalStore(store.subscribe, store.getSnapshot, emptySnapshot);
  return <>{entries.map(([el, node, key]) => createPortal(node, el, key))}</>;
}
