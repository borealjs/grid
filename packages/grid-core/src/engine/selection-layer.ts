/** A box in layer coordinates; `edges` is a 4-char mask (top, right, bottom, left; '1' = border drawn). */
export interface SelectionBox {
  x: number;
  y: number;
  w: number;
  h: number;
  edges: string;
}

/**
 * Draws the selection over the body: one translucent box per range (clipped to the drawn window, with
 * no border on clipped sides) and an outline around the active cell (or the merged cell it is in).
 */
export class SelectionLayer {
  readonly boxes: { el: HTMLDivElement; state: string }[] = [];
  readonly active: HTMLDivElement;
  activeState = '';

  constructor(readonly layer: HTMLElement) {
    this.active = this.#make('vg-active');
  }

  #make(cls: string): HTMLDivElement {
    const el = document.createElement('div');
    el.className = cls;
    el.setAttribute('aria-hidden', 'true');
    this.layer.appendChild(el);
    return el;
  }

  render(rects: readonly (SelectionBox | null)[], activeRect: SelectionBox | null): void {
    while (this.boxes.length < rects.length) this.boxes.push({ el: this.#make('vg-selbox'), state: '' });
    this.boxes.forEach((box, i) => {
      const r = rects[i];
      const state = r ? `${r.x},${r.y},${r.w},${r.h},${r.edges}` : 'hidden';
      if (state === box.state) return;
      box.state = state;
      if (!r) {
        box.el.style.display = 'none';
        return;
      }
      box.el.style.display = '';
      box.el.style.transform = `translate3d(${r.x}px,${r.y}px,0)`;
      box.el.style.width = `${r.w}px`;
      box.el.style.height = `${r.h}px`;
      box.el.style.borderWidth = [...r.edges].map((on) => (on === '1' ? '1px' : '0')).join(' ');
    });
    const state = activeRect ? `${activeRect.x},${activeRect.y},${activeRect.w},${activeRect.h}` : 'hidden';
    if (state !== this.activeState) {
      this.activeState = state;
      if (!activeRect) {
        this.active.style.display = 'none';
      } else {
        this.active.style.display = '';
        this.active.style.transform = `translate3d(${activeRect.x}px,${activeRect.y}px,0)`;
        this.active.style.width = `${activeRect.w}px`;
        this.active.style.height = `${activeRect.h}px`;
      }
    }
  }
}
