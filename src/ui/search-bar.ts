// Find nodes by text. Hits are emphasised and everything else is faded;
// Enter / Shift+Enter step through hits, Escape closes.
import { t } from '../i18n';
import { el, iconButton, isolatePointer } from './dom';

export class SearchBar {
  readonly el: HTMLDivElement;
  private readonly input: HTMLInputElement;
  private readonly count: HTMLSpanElement;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(host: HTMLElement, private readonly cb: { query(text: string): void; step(delta: 1 | -1): void; close(): void }) {
    this.el = el('div', 'om3d-search', host);
    this.el.hidden = true;
    this.el.setAttribute('role', 'search');
    isolatePointer(this.el);
    this.input = el('input', 'om3d-search-input', this.el);
    this.input.type = 'search';
    this.input.placeholder = t('search.placeholder');
    this.input.setAttribute('aria-label', t('search.label'));
    this.count = el('span', 'om3d-search-count', this.el);
    this.count.setAttribute('aria-live', 'polite');
    iconButton(this.el, { label: t('search.previous'), icon: 'chevron-up', onClick: () => this.cb.step(-1) });
    iconButton(this.el, { label: t('search.next'), icon: 'chevron-down', onClick: () => this.cb.step(1) });
    iconButton(this.el, { label: t('common.close'), icon: 'x', onClick: () => this.close() });
    this.input.addEventListener('input', () => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => { this.timer = null; this.cb.query(this.input.value.trim()); }, 120);
    });
    this.input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); this.cb.step(e.shiftKey ? -1 : 1); }
      if (e.key === 'Escape') { e.preventDefault(); this.close(); }
    });
  }

  get isOpen(): boolean { return !this.el.hidden; }
  get query(): string { return this.isOpen ? this.input.value.trim() : ''; }

  open(): void {
    this.el.hidden = false;
    // Synchronous focus: characters typed right after Ctrl+F must land in the field.
    this.input.focus({ preventScroll: true });
    this.input.select();
  }

  close(): void {
    if (this.el.hidden) return;
    this.el.hidden = true;
    this.input.value = '';
    this.count.textContent = '';
    this.cb.query('');
    this.cb.close();
  }

  setCount(index: number, total: number): void {
    this.count.textContent = total ? t('search.count', { index: index + 1, total }) : this.input.value.trim() ? t('search.none') : '';
  }

  dispose(): void { if (this.timer) clearTimeout(this.timer); this.el.remove(); }
}
