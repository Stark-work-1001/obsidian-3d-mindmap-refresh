// Small DOM helpers (no framework). Icons use Obsidian's bundled Lucide set.
import { setIcon } from 'obsidian';

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, parent?: HTMLElement, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  parent?.appendChild(node);
  return node;
}

let uid = 0;
export function uniqueId(prefix: string): string { return `${prefix}-${++uid}`; }

export interface ButtonOptions {
  label: string;
  icon?: string;
  /** Show the label next to the icon (hidden in narrow toolbars via CSS). */
  showLabel?: boolean;
  tooltip?: string;
  cls?: string;
  onClick?: (event: MouseEvent) => void;
}

export function iconButton(parent: HTMLElement | null, options: ButtonOptions): HTMLButtonElement {
  const button = el('button', `om3d-btn ${options.cls ?? ''}`.trim(), parent ?? undefined);
  button.type = 'button';
  if (options.icon) {
    const icon = el('span', 'om3d-btn-icon', button);
    setIcon(icon, options.icon);
    icon.setAttribute('aria-hidden', 'true');
  }
  const text = el('span', 'om3d-btn-label', button, options.label);
  if (!options.showLabel && options.icon) text.classList.add('is-optional');
  button.setAttribute('aria-label', options.label);
  if (options.tooltip) button.title = options.tooltip;
  if (options.onClick) button.addEventListener('click', event => { event.stopPropagation(); options.onClick!(event); });
  return button;
}

export function setButtonLabel(button: HTMLButtonElement, label: string, tooltip?: string): void {
  const text = button.querySelector('.om3d-btn-label');
  if (text) text.textContent = label;
  button.setAttribute('aria-label', label);
  if (tooltip !== undefined) button.title = tooltip;
}

/** Stop pointer/wheel events from reaching the 3D canvas underneath. */
export function isolatePointer(node: HTMLElement): void {
  for (const type of ['pointerdown', 'wheel', 'dblclick', 'contextmenu']) {
    node.addEventListener(type, event => event.stopPropagation(), type === 'wheel' ? { passive: true } : undefined);
  }
}
