// Read-only outline of the note beside the map. Selecting a row locates the
// node (expanding collapsed ancestors); the selected node is highlighted.
// Rows are rendered lazily: only the open part of the tree is in the DOM.
import { t } from '../i18n';
import type { OutlineNode } from '../model/types';
import { displayText } from '../model/tree-utils';
import { el, isolatePointer } from './dom';

export class OutlinePanel {
  readonly el: HTMLElement;
  private readonly body: HTMLElement;
  private root: OutlineNode | null = null;
  private selected: string | null = null;
  private open = false;
  private stale = true;

  constructor(host: HTMLElement, private readonly onPick: (id: string) => void) {
    this.el = el('aside', 'om3d-outline is-hidden', host);
    this.el.setAttribute('aria-label', t('outline.label'));
    isolatePointer(this.el);
    el('div', 'om3d-panel-title', this.el, t('outline.title'));
    this.body = el('div', 'om3d-outline-body', this.el);
    this.body.setAttribute('role', 'tree');
    this.body.addEventListener('keydown', e => {
      const rows = Array.from(this.body.querySelectorAll<HTMLElement>('[role="treeitem"]'));
      const i = rows.indexOf(document.activeElement as HTMLElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); rows[Math.min(rows.length - 1, i + 1)]?.focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); rows[Math.max(0, i - 1)]?.focus(); }
      e.stopPropagation();
    });
  }

  get isOpen(): boolean { return this.open; }

  setOpen(open: boolean): void {
    this.open = open;
    this.el.classList.toggle('is-hidden', !open);
    if (open && this.stale) this.render();
  }

  update(root: OutlineNode | null, selected: string | null): void {
    this.root = root;
    this.selected = selected;
    this.stale = true;
    if (this.open) this.render();
  }

  select(id: string | null): void {
    this.selected = id;
    if (!this.open) return;
    for (const row of Array.from(this.body.querySelectorAll<HTMLElement>('.om3d-outline-row'))) {
      const active = row.dataset.id === id;
      row.classList.toggle('is-active', active);
      row.setAttribute('aria-selected', String(active));
      if (active) row.scrollIntoView({ block: 'nearest' });
    }
  }

  private render(): void {
    this.stale = false;
    this.body.replaceChildren();
    if (!this.root) { el('p', 'om3d-empty', this.body, t('outline.empty')); return; }
    const list = el('ul', 'om3d-outline-tree', this.body);
    const stack: [OutlineNode, HTMLElement, number][] = [];
    for (let i = this.root.children.length - 1; i >= 0; i--) stack.push([this.root.children[i], list, 1]);
    let budget = 4000;
    while (stack.length && budget-- > 0) {
      const [node, parent, level] = stack.pop()!;
      const li = el('li', '', parent);
      const row = el('button', 'om3d-outline-row', li);
      row.type = 'button';
      row.tabIndex = -1;
      row.dataset.id = node.id;
      row.setAttribute('role', 'treeitem');
      row.setAttribute('aria-level', String(level));
      row.setAttribute('aria-selected', String(node.id === this.selected));
      row.style.setProperty('--om3d-level', String(level - 1));
      if (node.id === this.selected) row.classList.add('is-active');
      el('span', 'om3d-outline-kind', row, node.kind === 'heading' ? `H${node.headingLevel}` : '\u2022');
      el('span', 'om3d-outline-text', row, displayText(node, 80));
      if (node.note) el('span', 'om3d-outline-badge', row, t('outline.noteBadge'));
      if (node.collapsed && node.children.length) { el('span', 'om3d-outline-badge', row, t('outline.collapsedBadge', { count: node.children.length })); row.title = t('outline.collapsedHint'); }
      row.addEventListener('click', () => this.onPick(node.id));
      if (node.children.length) {
        const sub = el('ul', '', li);
        if (node.collapsed) sub.classList.add('is-collapsed');
        for (let i = node.children.length - 1; i >= 0; i--) stack.push([node.children[i], sub, level + 1]);
      }
    }
    const first = this.body.querySelector<HTMLElement>('.om3d-outline-row');
    if (first) first.tabIndex = 0;
  }

  dispose(): void { this.el.remove(); }
}
