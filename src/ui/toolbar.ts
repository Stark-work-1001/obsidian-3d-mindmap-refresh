// Toolbar organised by task. Left: the note and the interaction mode.
// Middle: task menus (edit, study, layout, view, appearance, relationships).
// Right: history, search, panels, more. A breadcrumb trail and a live status
// line sit underneath. Labels collapse to icons in narrow panels (CSS).
import { setIcon } from 'obsidian';
import { t, type StringKey } from '../i18n';
import { el, iconButton, isolatePointer, setButtonLabel } from './dom';
import { Menu, type MenuItem } from './menu';

export type InteractionMode = 'navigate' | 'arrange' | 'connect';

export interface Crumb { label: string; title: string; onClick?: () => void; current?: boolean }

export interface ToolbarController {
  documentName(): string | null;
  pickDocument(): void;
  mode(): InteractionMode;
  setMode(mode: InteractionMode): void;
  menu(group: ToolbarMenu): MenuItem[];
  history(): { back: boolean; forward: boolean; backLabel: string | null; forwardLabel: string | null };
  back(): void;
  forward(): void;
  toggleSearch(): void;
  togglePanel(panel: 'outline' | 'inspector'): void;
  panelOpen(panel: 'outline' | 'inspector'): boolean;
}

export type ToolbarMenu = 'edit' | 'study' | 'layout' | 'view' | 'appearance' | 'relationships' | 'more';

const MENUS: { id: ToolbarMenu; icon: string; label: StringKey; tooltip: StringKey }[] = [
  { id: 'edit', icon: 'pencil', label: 'toolbar.edit', tooltip: 'toolbar.edit.tooltip' },
  { id: 'study', icon: 'graduation-cap', label: 'toolbar.study', tooltip: 'toolbar.study.tooltip' },
  { id: 'layout', icon: 'layout-dashboard', label: 'toolbar.layout', tooltip: 'toolbar.layout.tooltip' },
  { id: 'view', icon: 'rotate-3d', label: 'toolbar.view', tooltip: 'toolbar.view.tooltip' },
  { id: 'appearance', icon: 'palette', label: 'toolbar.appearance', tooltip: 'toolbar.appearance.tooltip' },
  { id: 'relationships', icon: 'waypoints', label: 'toolbar.relationships', tooltip: 'toolbar.relationships.tooltip' },
];

const MODES: { id: InteractionMode; icon: string; label: StringKey; tooltip: StringKey }[] = [
  { id: 'navigate', icon: 'mouse-pointer-2', label: 'mode.navigate', tooltip: 'mode.navigate.tooltip' },
  { id: 'arrange', icon: 'move', label: 'mode.arrange', tooltip: 'mode.arrange.tooltip' },
  { id: 'connect', icon: 'spline', label: 'mode.connect', tooltip: 'mode.connect.tooltip' },
];

export class Toolbar {
  readonly el: HTMLDivElement;
  private readonly docButton: HTMLButtonElement;
  private readonly modeButtons = new Map<InteractionMode, HTMLButtonElement>();
  private readonly backButton: HTMLButtonElement;
  private readonly forwardButton: HTMLButtonElement;
  private readonly outlineButton: HTMLButtonElement;
  private readonly inspectorButton: HTMLButtonElement;
  private readonly crumbs: HTMLElement;
  private readonly status: HTMLElement;

  constructor(private readonly host: HTMLElement, private readonly c: ToolbarController) {
    this.el = el('div', 'om3d-toolbar', host);
    this.el.setAttribute('role', 'toolbar');
    this.el.setAttribute('aria-label', t('toolbar.label'));
    isolatePointer(this.el);
    const main = el('div', 'om3d-toolbar-row', this.el);

    const left = el('div', 'om3d-toolgroup', main);
    this.docButton = iconButton(left, { label: t('toolbar.document.none'), icon: 'file-text', showLabel: true, cls: 'om3d-doc', onClick: () => this.c.pickDocument() });
    const modes = el('div', 'om3d-segmented', left);
    modes.setAttribute('role', 'radiogroup');
    modes.setAttribute('aria-label', t('mode.label'));
    for (const m of MODES) {
      const b = iconButton(modes, { label: t(m.label), icon: m.icon, tooltip: t(m.tooltip), cls: 'om3d-segment', onClick: () => this.c.setMode(m.id) });
      b.setAttribute('role', 'radio');
      this.modeButtons.set(m.id, b);
    }

    const middle = el('div', 'om3d-toolgroup om3d-menus', main);
    for (const m of MENUS) {
      const b = iconButton(middle, { label: t(m.label), icon: m.icon, tooltip: t(m.tooltip), cls: 'om3d-menubtn', showLabel: true });
      b.setAttribute('aria-haspopup', 'menu');
      b.setAttribute('aria-expanded', 'false');
      b.addEventListener('click', e => { e.stopPropagation(); Menu.open(b, this.c.menu(m.id), this.host, t(m.label)); });
      b.addEventListener('keydown', e => { if (e.key === 'ArrowDown') { e.preventDefault(); Menu.open(b, this.c.menu(m.id), this.host, t(m.label)); } });
    }

    const right = el('div', 'om3d-toolgroup om3d-right', main);
    this.backButton = iconButton(right, { label: t('nav.back'), icon: 'arrow-left', onClick: () => this.c.back() });
    this.forwardButton = iconButton(right, { label: t('nav.forward'), icon: 'arrow-right', onClick: () => this.c.forward() });
    iconButton(right, { label: t('toolbar.search'), icon: 'search', tooltip: t('toolbar.search.tooltip'), onClick: () => this.c.toggleSearch() });
    this.outlineButton = iconButton(right, { label: t('toolbar.outline'), icon: 'list-tree', tooltip: t('toolbar.outline.tooltip'), onClick: () => this.c.togglePanel('outline') });
    this.inspectorButton = iconButton(right, { label: t('toolbar.inspector'), icon: 'panel-right', tooltip: t('toolbar.inspector.tooltip'), onClick: () => this.c.togglePanel('inspector') });
    for (const b of [this.outlineButton, this.inspectorButton]) b.setAttribute('aria-pressed', 'false');
    const more = iconButton(right, { label: t('toolbar.more'), icon: 'more-horizontal', cls: 'om3d-menubtn' });
    more.setAttribute('aria-haspopup', 'menu');
    more.addEventListener('click', e => { e.stopPropagation(); Menu.open(more, this.c.menu('more'), this.host, t('toolbar.more')); });

    const sub = el('div', 'om3d-toolbar-row om3d-subbar', this.el);
    this.crumbs = el('nav', 'om3d-crumbs', sub);
    this.crumbs.setAttribute('aria-label', t('crumbs.label'));
    this.status = el('div', 'om3d-status', sub);
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    this.sync();
  }

  /** Refresh state-dependent controls. */
  sync(): void {
    const name = this.c.documentName();
    setButtonLabel(this.docButton, name ?? t('toolbar.document.none'), name ? t('toolbar.document.tooltip', { name }) : t('toolbar.document.pick'));
    const mode = this.c.mode();
    for (const [id, b] of this.modeButtons) { b.setAttribute('aria-checked', String(id === mode)); b.classList.toggle('is-active', id === mode); }
    const h = this.c.history();
    this.backButton.disabled = !h.back;
    this.forwardButton.disabled = !h.forward;
    this.backButton.title = h.backLabel ? t('nav.backTo', { label: h.backLabel }) : t('nav.back');
    this.forwardButton.title = h.forwardLabel ? t('nav.forwardTo', { label: h.forwardLabel }) : t('nav.forward');
    for (const [panel, b] of [['outline', this.outlineButton], ['inspector', this.inspectorButton]] as const) {
      const open = this.c.panelOpen(panel);
      b.setAttribute('aria-pressed', String(open));
      b.classList.toggle('is-active', open);
    }
  }

  setCrumbs(crumbs: Crumb[]): void {
    this.crumbs.replaceChildren();
    const list = el('ol', 'om3d-crumb-list', this.crumbs);
    crumbs.forEach((crumb, i) => {
      const item = el('li', 'om3d-crumb', list);
      if (i > 0) { const sep = el('span', 'om3d-crumb-sep', item); setIcon(sep, 'chevron-right'); sep.setAttribute('aria-hidden', 'true'); }
      if (crumb.onClick && !crumb.current) {
        const b = el('button', 'om3d-crumb-btn', item, crumb.label);
        b.type = 'button';
        b.title = crumb.title;
        b.addEventListener('click', e => { e.stopPropagation(); crumb.onClick!(); });
      } else {
        const s = el('span', 'om3d-crumb-current', item, crumb.label);
        s.title = crumb.title;
        if (crumb.current) s.setAttribute('aria-current', 'location');
      }
    });
  }

  setStatus(message: string, level: 'info' | 'warning' = 'info'): void {
    this.status.textContent = message;
    this.status.classList.toggle('is-warn', level === 'warning');
  }

  dispose(): void { Menu.closeAll(false); this.el.remove(); }
}
