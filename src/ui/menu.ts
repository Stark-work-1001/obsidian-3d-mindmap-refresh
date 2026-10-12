// Accessible popup menus (WAI-ARIA menu pattern).
//
// Keyboard: Up/Down (roving focus), Home/End, Enter/Space (activate),
// Right/Left (open/close submenu), Escape (close one level and return focus),
// Tab (close all), printable keys (type-ahead). Mouse: hover opens
// submenus, outside pointerdown or window blur closes everything.
// Placement stays inside the view; long menus scroll; hints wrap below their
// label. In narrow panels submenus expand inline instead of flying out.
import { setIcon } from 'obsidian';
import { el, uniqueId } from './dom';

export type MenuItem =
  | { kind: 'action'; label: string; hint?: string; shortcut?: string; icon?: string; disabled?: boolean; danger?: boolean; run: () => void }
  | { kind: 'toggle'; label: string; hint?: string; checked: boolean; disabled?: boolean; run: (checked: boolean) => void }
  | { kind: 'radio'; label: string; hint?: string; checked: boolean; disabled?: boolean; run: () => void }
  | { kind: 'submenu'; label: string; hint?: string; icon?: string; disabled?: boolean; items: () => MenuItem[] }
  | { kind: 'slider'; label: string; min: number; max: number; step: number; value: number; format?: (v: number) => string; onInput: (v: number) => void; onCommit?: (v: number) => void }
  | { kind: 'heading'; label: string }
  | { kind: 'separator' }
  | { kind: 'note'; text: string };

const NARROW = 480;

export class Menu {
  private static root: Menu | null = null;
  readonly el: HTMLDivElement;
  private readonly focusables: HTMLElement[] = [];
  private child: Menu | null = null;
  private hoverTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly cleanup: (() => void)[] = [];
  private closed = false;

  /** Open a root menu below `anchor`; any other root menu closes. */
  static open(anchor: HTMLElement, items: MenuItem[], container: HTMLElement, label: string, onClose?: () => void): Menu | null {
    const wasOpenForAnchor = Menu.root?.anchor === anchor;
    Menu.closeAll(false);
    if (wasOpenForAnchor) return null; // a second click on the same button closes it
    const menu = new Menu(anchor, items, container, label, null, onClose);
    Menu.root = menu;
    return menu;
  }

  static closeAll(restoreFocus = true): void {
    const root = Menu.root;
    Menu.root = null;
    root?.close(restoreFocus);
  }

  static get isOpen(): boolean { return !!Menu.root; }

  private constructor(
    private readonly anchor: HTMLElement,
    items: MenuItem[],
    private readonly container: HTMLElement,
    label: string,
    private readonly parent: Menu | null,
    private readonly onClose?: () => void,
  ) {
    this.el = el('div', 'om3d-menu');
    this.el.id = uniqueId('om3d-menu');
    this.el.setAttribute('role', 'menu');
    this.el.setAttribute('aria-label', label);
    this.el.tabIndex = -1;
    this.render(items, this.el);
    container.appendChild(this.el);
    this.place();
    anchor.setAttribute('aria-expanded', 'true');
    anchor.setAttribute('aria-controls', this.el.id);
    anchor.classList.add('is-open');
    this.el.addEventListener('keydown', this.onKeyDown);
    this.el.addEventListener('pointerdown', e => e.stopPropagation());
    this.el.addEventListener('wheel', e => e.stopPropagation(), { passive: true });
    if (!parent) {
      const outside = (e: PointerEvent) => { if (!this.contains(e.target as Node)) Menu.closeAll(false); };
      const blur = () => Menu.closeAll(false);
      document.addEventListener('pointerdown', outside, true);
      window.addEventListener('blur', blur);
      this.cleanup.push(() => document.removeEventListener('pointerdown', outside, true), () => window.removeEventListener('blur', blur));
    }
    requestAnimationFrame(() => this.focusAt(0));
  }

  private contains(node: Node | null): boolean {
    return !!node && (this.el.contains(node) || this.anchor.contains(node) || (this.child?.contains(node) ?? false));
  }

  private get narrow(): boolean { return this.container.getBoundingClientRect().width < NARROW; }

  private render(items: MenuItem[], into: HTMLElement): void {
    for (const item of items) {
      switch (item.kind) {
        case 'separator': el('div', 'om3d-menu-sep', into).setAttribute('role', 'separator'); break;
        case 'heading': { const h = el('div', 'om3d-menu-heading', into, item.label); h.setAttribute('role', 'presentation'); break; }
        case 'note': { const n = el('div', 'om3d-menu-note', into, item.text); n.setAttribute('role', 'presentation'); break; }
        case 'slider': this.renderSlider(item, into); break;
        default: this.renderItem(item, into);
      }
    }
  }

  private renderItem(item: Exclude<MenuItem, { kind: 'separator' | 'heading' | 'slider' | 'note' }>, into: HTMLElement): void {
    const row = el('div', 'om3d-menu-item', into);
    row.tabIndex = -1;
    const role = item.kind === 'toggle' ? 'menuitemcheckbox' : item.kind === 'radio' ? 'menuitemradio' : 'menuitem';
    row.setAttribute('role', role);
    if (item.kind === 'toggle' || item.kind === 'radio') row.setAttribute('aria-checked', String(item.checked));
    if (item.disabled) row.setAttribute('aria-disabled', 'true');
    if (item.kind === 'action' && item.danger) row.classList.add('is-danger');
    const mark = el('span', 'om3d-menu-check', row);
    mark.setAttribute('aria-hidden', 'true');
    if ((item.kind === 'action' || item.kind === 'submenu') && item.icon) setIcon(mark, item.icon);
    const body = el('span', 'om3d-menu-body', row);
    el('span', 'om3d-menu-label', body, item.label);
    if (item.hint) el('span', 'om3d-menu-hint', body, item.hint);
    if (item.kind === 'action' && item.shortcut) el('kbd', 'om3d-menu-shortcut', row, item.shortcut);
    if (item.kind === 'submenu') {
      row.setAttribute('aria-haspopup', 'menu');
      row.setAttribute('aria-expanded', 'false');
      const chevron = el('span', 'om3d-menu-chevron', row);
      setIcon(chevron, 'chevron-right');
      chevron.setAttribute('aria-hidden', 'true');
    }
    const activate = () => {
      if (item.disabled) return;
      if (item.kind === 'submenu') { this.openSubmenu(row, item); return; }
      if (item.kind === 'toggle') {
        item.checked = !item.checked;
        row.setAttribute('aria-checked', String(item.checked));
        item.run(item.checked);
        return; // checkbox items keep the menu open
      }
      Menu.closeAll(true);
      item.run();
    };
    row.addEventListener('click', e => { e.stopPropagation(); activate(); });
    row.addEventListener('pointerenter', () => {
      this.focusables.indexOf(row) >= 0 && row.focus({ preventScroll: true });
      if (this.hoverTimer) clearTimeout(this.hoverTimer);
      if (item.kind === 'submenu' && !item.disabled && !this.narrow) this.hoverTimer = setTimeout(() => this.openSubmenu(row, item, false), 160);
      else if (this.child && !this.narrow) this.hoverTimer = setTimeout(() => this.closeChild(false), 260);
    });
    (row as HTMLElement & { om3dActivate?: () => void }).om3dActivate = activate;
    this.focusables.push(row);
  }

  private renderSlider(item: Extract<MenuItem, { kind: 'slider' }>, into: HTMLElement): void {
    const row = el('div', 'om3d-menu-slider', into);
    const labelId = uniqueId('om3d-slider');
    const head = el('div', 'om3d-menu-slider-head', row);
    const label = el('span', 'om3d-menu-slider-label', head, item.label);
    label.id = labelId;
    const format = item.format ?? (v => String(v));
    const value = el('output', 'om3d-menu-slider-value', head, format(item.value));
    const input = el('input', 'om3d-menu-range', row);
    input.type = 'range';
    input.min = String(item.min); input.max = String(item.max); input.step = String(item.step); input.value = String(item.value);
    input.tabIndex = -1;
    input.setAttribute('aria-labelledby', labelId);
    input.setAttribute('aria-valuetext', format(item.value));
    // Coalesce input to one call per frame so dragging stays responsive.
    let pending: number | null = null, frame = 0;
    input.addEventListener('input', () => {
      const v = Number(input.value);
      value.textContent = format(v);
      input.setAttribute('aria-valuetext', format(v));
      pending = v;
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; if (pending !== null) item.onInput(pending); pending = null; });
    });
    input.addEventListener('change', () => item.onCommit?.(Number(input.value)));
    this.focusables.push(input);
  }

  private openSubmenu(row: HTMLElement, item: Extract<MenuItem, { kind: 'submenu' }>, focus = true): void {
    if (this.narrow) {
      // Inline accordion for narrow panels.
      const next = row.nextElementSibling;
      if (next?.classList.contains('om3d-menu-inline')) {
        next.remove();
        row.setAttribute('aria-expanded', 'false');
        this.refreshFocusables();
        return;
      }
      const inline = el('div', 'om3d-menu-inline');
      inline.setAttribute('role', 'group');
      inline.setAttribute('aria-label', item.label);
      row.after(inline);
      this.render(item.items(), inline);
      row.setAttribute('aria-expanded', 'true');
      this.refreshFocusables();
      if (focus) this.focusAt(this.focusables.indexOf(row) + 1);
      return;
    }
    if (this.child && this.child.anchor === row) { if (focus) this.child.focusAt(0); return; }
    this.closeChild(false);
    this.child = new Menu(row, item.items(), this.container, item.label, this);
    this.child.el.classList.add('is-submenu');
    if (!focus) this.child.el.dataset.mouse = '1';
  }

  private refreshFocusables(): void {
    this.focusables.length = 0;
    for (const node of Array.from(this.el.querySelectorAll<HTMLElement>('.om3d-menu-item, .om3d-menu-range'))) this.focusables.push(node);
  }

  private closeChild(restoreFocus: boolean): void {
    if (!this.child) return;
    const anchor = this.child.anchor;
    this.child.close(false);
    this.child = null;
    if (restoreFocus) anchor.focus();
  }

  private place(): void {
    const c = this.container.getBoundingClientRect();
    const a = this.anchor.getBoundingClientRect();
    const m = this.el;
    m.style.maxHeight = `${Math.max(160, c.height - 16)}px`;
    m.style.maxWidth = `${Math.max(200, Math.min(380, c.width - 16))}px`;
    const w = m.offsetWidth, h = m.offsetHeight;
    let left: number, top: number;
    if (this.parent) {
      left = a.right - c.left - 2;
      if (left + w > c.width - 8) left = a.left - c.left - w + 2; // flip to the left
      top = a.top - c.top - 6;
    } else {
      left = a.left - c.left;
      top = a.bottom - c.top + 4;
      if (top + h > c.height - 8 && a.top - c.top - h - 4 >= 8) top = a.top - c.top - h - 4; // open upwards
    }
    m.style.left = `${Math.round(Math.min(Math.max(8, left), Math.max(8, c.width - w - 8)))}px`;
    m.style.top = `${Math.round(Math.min(Math.max(8, top), Math.max(8, c.height - h - 8)))}px`;
  }

  private focusAt(index: number): void {
    const list = this.focusables.filter(f => f.getAttribute('aria-disabled') !== 'true');
    if (!list.length) { this.el.focus(); return; }
    const target = this.focusables[index] && this.focusables[index].getAttribute('aria-disabled') !== 'true' ? this.focusables[index] : list[0];
    target.focus({ preventScroll: false });
  }

  private readonly onKeyDown = (event: KeyboardEvent) => {
    const active = document.activeElement as HTMLElement | null;
    const enabled = this.focusables.filter(f => f.getAttribute('aria-disabled') !== 'true');
    const index = active ? enabled.indexOf(active) : -1;
    const isRange = active?.classList.contains('om3d-menu-range');
    const move = (to: number) => { event.preventDefault(); event.stopPropagation(); enabled[(to + enabled.length) % enabled.length]?.focus(); };
    switch (event.key) {
      case 'ArrowDown': move(index + 1); return;
      case 'ArrowUp': move(index - 1); return;
      case 'Home': move(0); return;
      case 'End': move(enabled.length - 1); return;
      case 'ArrowRight':
        if (isRange) return;
        if (active?.getAttribute('aria-haspopup') === 'menu') { event.preventDefault(); event.stopPropagation(); (active as HTMLElement & { om3dActivate?: () => void }).om3dActivate?.(); }
        return;
      case 'ArrowLeft':
        if (isRange) return;
        if (this.parent) { event.preventDefault(); event.stopPropagation(); this.parent.closeChild(true); }
        return;
      case 'Escape':
        event.preventDefault(); event.stopPropagation();
        if (this.parent) this.parent.closeChild(true); else Menu.closeAll(true);
        return;
      case 'Tab': Menu.closeAll(false); return;
      case 'Enter': case ' ':
        if (isRange) { if (event.key === 'Enter') { event.preventDefault(); Menu.closeAll(true); } return; }
        event.preventDefault(); event.stopPropagation();
        (active as HTMLElement & { om3dActivate?: () => void } | null)?.om3dActivate?.();
        return;
      default:
        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          const key = event.key.toLowerCase();
          for (let k = 1; k <= enabled.length; k++) {
            const candidate = enabled[(index + k) % enabled.length];
            if ((candidate.textContent ?? '').trim().toLowerCase().startsWith(key)) { event.preventDefault(); candidate.focus(); return; }
          }
        }
    }
  };

  private close(restoreFocus: boolean): void {
    if (this.closed) return;
    this.closed = true;
    this.child?.close(false);
    this.child = null;
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    for (const fn of this.cleanup) fn();
    const hadFocus = this.el.contains(document.activeElement);
    this.el.remove();
    this.anchor.setAttribute('aria-expanded', 'false');
    this.anchor.classList.remove('is-open');
    if (restoreFocus || hadFocus) this.anchor.focus({ preventScroll: true });
    this.onClose?.();
  }
}
