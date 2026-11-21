import { div } from './dom.js';

/**
 * Short messages at the bottom of the grid: a notice for refused or failed sorts, filters and copies,
 * and a "working" line with a Cancel button while a slow sort or filter runs.
 */
export class Notices {
  #noticeEl: HTMLDivElement | null = null;
  #noticeTimer: ReturnType<typeof setTimeout> | undefined;
  #workEl: HTMLDivElement | null = null;
  #workText: HTMLSpanElement | null = null;

  constructor(
    private readonly host: HTMLElement,
    /** Whether notices are shown at all (the `notices` option). */
    private readonly enabled: () => boolean,
    private readonly cancelLabel: string,
    private readonly onCancel: () => void,
  ) {}

  /** Show `text` for a few seconds (longer for errors). */
  notify(text: string, isError = false): void {
    if (!this.enabled()) return;
    if (!this.#noticeEl) {
      this.#noticeEl = div('vg-notice', this.host);
      this.#noticeEl.setAttribute('role', 'status');
      this.#noticeEl.setAttribute('aria-live', 'polite');
    }
    const el = this.#noticeEl;
    el.textContent = text;
    el.classList.toggle('vg-notice-error', isError);
    el.classList.add('vg-notice-show');
    clearTimeout(this.#noticeTimer);
    this.#noticeTimer = setTimeout(() => el.classList.remove('vg-notice-show'), isError ? 5000 : 2500);
  }

  /** Show (or update) the working line. */
  showWork(text: string): void {
    if (!this.enabled()) return;
    if (!this.#workEl) {
      this.#workEl = div('vg-notice vg-work', this.host);
      this.#workEl.setAttribute('role', 'status');
      this.#workText = this.#workEl.appendChild(document.createElement('span'));
      const stop = this.#workEl.appendChild(document.createElement('button'));
      stop.type = 'button';
      stop.textContent = this.cancelLabel;
      stop.addEventListener('click', () => this.onCancel());
    }
    this.#workText!.textContent = text;
    this.#workEl.classList.add('vg-notice-show');
  }

  hideWork(): void {
    this.#workEl?.classList.remove('vg-notice-show');
  }

  destroy(): void {
    clearTimeout(this.#noticeTimer);
  }
}
