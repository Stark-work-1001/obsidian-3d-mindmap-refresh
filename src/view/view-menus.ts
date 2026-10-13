// Toolbar menus, organised by task. Common actions come first; detailed
// tuning sits in submenus (progressive disclosure). Every label is an i18n
// key; settings are identified by their stable keys, never by display text.
import { t } from '../i18n';
import { CATEGORY_ORDER, LAYOUTS, type LayoutCategory } from '../layout/catalog';
import {
  EDGE_GAP_MAX, EDGE_GAP_MIN, FOV_MAX, FOV_MIN, LINK_STYLES, NODE_SCALE_MAX, NODE_SCALE_MIN,
  type LinkStyle, type OrbitCenter, type Settings,
} from '../persistence/settings';
import type { MenuItem } from '../ui/menu';
import type { InteractionMode, ToolbarMenu } from '../ui/toolbar';

export type ViewAction =
  | 'addChild' | 'addSibling' | 'rename' | 'editNote' | 'remove' | 'indent' | 'outdent' | 'moveUp' | 'moveDown'
  | 'undo' | 'redo' | 'toggleCollapse' | 'expandAll'
  | 'overview' | 'enterBranch' | 'upLevel' | 'locate' | 'toggleMark' | 'nextMark' | 'clearMarks'
  | 'rearrange' | 'reheat' | 'releaseAll' | 'resetCamera' | 'resetRoll' | 'background'
  | 'connect' | 'clearAssociations' | 'exportPng' | 'openNote' | 'diagnostics' | 'reload' | 'settings';

export interface MenuHost {
  readonly settings: Settings;
  update(patch: Partial<Settings>): void;
  run(action: ViewAction): void;
  collapseToDepth(depth: number): void;
  setMode(mode: InteractionMode): void;
  readonly state: {
    hasFile: boolean;
    selected: boolean;
    selectedIsRoot: boolean;
    selectedHasChildren: boolean;
    selectedCollapsed: boolean;
    selectedMarked: boolean;
    inBranch: boolean;
    canUndo: boolean;
    canRedo: boolean;
    undoLabel: string | null;
    redoLabel: string | null;
    anchoredCount: number;
    associationCount: number;
    markCount: number;
    physics: boolean;
    pngEnabled: boolean;
  };
}

const STYLE_KEYS: Record<LinkStyle, Parameters<typeof t>[0]> = {
  solid: 'style.solid', dashed: 'style.dashed', dotted: 'style.dotted', dashdot: 'style.dashdot',
};
const CATEGORY_KEYS: Record<LayoutCategory, Parameters<typeof t>[0]> = {
  study: 'layout.category.study', structure: 'layout.category.structure', explore: 'layout.category.explore', experimental: 'layout.category.experimental',
};

const pct = (v: number) => `${Math.round(v * 100)}%`;
const times = (v: number) => `\u00D7${v.toFixed(2)}`;

function styleItems(current: LinkStyle, apply: (s: LinkStyle) => void): MenuItem[] {
  return LINK_STYLES.map(s => ({ kind: 'radio' as const, label: t(STYLE_KEYS[s]), checked: s === current, run: () => apply(s) }));
}

function editMenu(h: MenuHost): MenuItem[] {
  const s = h.state;
  const none = !s.selected;
  return [
    { kind: 'action', label: t('menu.addChild'), shortcut: 'Tab', icon: 'corner-down-right', disabled: !s.hasFile, run: () => h.run('addChild') },
    { kind: 'action', label: t('menu.addSibling'), shortcut: 'Enter', icon: 'plus', disabled: none || s.selectedIsRoot, run: () => h.run('addSibling') },
    { kind: 'action', label: t('menu.rename'), shortcut: 'F2', icon: 'text-cursor-input', disabled: none || s.selectedIsRoot, run: () => h.run('rename') },
    { kind: 'action', label: t('menu.editNote'), shortcut: 'Shift+Enter', icon: 'sticky-note', disabled: none || s.selectedIsRoot, run: () => h.run('editNote') },
    { kind: 'action', label: t('menu.remove'), shortcut: 'Del', icon: 'trash-2', danger: true, disabled: none || s.selectedIsRoot, run: () => h.run('remove') },
    { kind: 'separator' },
    {
      kind: 'submenu', label: t('menu.restructure'), icon: 'indent', disabled: none || s.selectedIsRoot, items: () => [
        { kind: 'action', label: t('menu.indent'), shortcut: ']', run: () => h.run('indent') },
        { kind: 'action', label: t('menu.outdent'), shortcut: '[', run: () => h.run('outdent') },
        { kind: 'action', label: t('menu.moveUp'), shortcut: 'Alt+\u2191', run: () => h.run('moveUp') },
        { kind: 'action', label: t('menu.moveDown'), shortcut: 'Alt+\u2193', run: () => h.run('moveDown') },
      ],
    },
    { kind: 'separator' },
    { kind: 'action', label: s.undoLabel ? t('menu.undoLabel', { label: s.undoLabel }) : t('menu.undo'), shortcut: 'Ctrl+Z', icon: 'undo-2', disabled: !s.canUndo, run: () => h.run('undo') },
    { kind: 'action', label: s.redoLabel ? t('menu.redoLabel', { label: s.redoLabel }) : t('menu.redo'), shortcut: 'Ctrl+Y', icon: 'redo-2', disabled: !s.canRedo, run: () => h.run('redo') },
    { kind: 'note', text: t('menu.undoScope') },
  ];
}

function studyMenu(h: MenuHost): MenuItem[] {
  const s = h.state;
  return [
    { kind: 'action', label: t('menu.overview'), shortcut: 'Home', icon: 'maximize', disabled: !s.hasFile, run: () => h.run('overview') },
    { kind: 'action', label: t('menu.enterBranch'), shortcut: 'Ctrl+Enter', icon: 'log-in', hint: t('menu.enterBranch.hint'), disabled: !s.selectedHasChildren, run: () => h.run('enterBranch') },
    { kind: 'action', label: t('menu.upLevel'), shortcut: 'Esc', icon: 'log-out', disabled: !s.inBranch, run: () => h.run('upLevel') },
    { kind: 'action', label: t('menu.locate'), icon: 'locate-fixed', disabled: !s.selected, run: () => h.run('locate') },
    { kind: 'separator' },
    { kind: 'action', label: s.selectedCollapsed ? t('menu.expand') : t('menu.collapse'), shortcut: 'Space', disabled: !s.selectedHasChildren && !s.selectedCollapsed, run: () => h.run('toggleCollapse') },
    {
      kind: 'submenu', label: t('menu.showLevels'), icon: 'list-collapse', disabled: !s.hasFile, items: () => [
        ...[1, 2, 3, 4].map(depth => ({ kind: 'action' as const, label: t('menu.showLevels.n', { count: depth }), run: () => h.collapseToDepth(depth) })),
        { kind: 'action', label: t('menu.expandAll'), run: () => h.run('expandAll') },
      ],
    },
    { kind: 'separator' },
    { kind: 'heading', label: t('menu.keyConcepts') },
    { kind: 'action', label: s.selectedMarked ? t('menu.unmark') : t('menu.mark'), icon: 'star', disabled: !s.selected || s.selectedIsRoot, run: () => h.run('toggleMark') },
    { kind: 'action', label: t('menu.nextMark'), icon: 'skip-forward', disabled: !s.markCount, run: () => h.run('nextMark') },
    { kind: 'action', label: t('menu.clearMarks'), danger: true, disabled: !s.markCount, run: () => h.run('clearMarks') },
    { kind: 'toggle', label: t('menu.readingPath'), hint: t('menu.readingPath.hint'), checked: h.settings.learningPath, run: v => h.update({ learningPath: v }) },
  ];
}

function layoutMenu(h: MenuHost): MenuItem[] {
  const current = h.settings.layout;
  const radio = (id: (typeof LAYOUTS)[number]) => ({ kind: 'radio' as const, label: t(id.name), hint: t(id.hint), checked: id.id === current, run: () => h.update({ layout: id.id }) });
  const items: MenuItem[] = [];
  for (const category of CATEGORY_ORDER) {
    const list = LAYOUTS.filter(l => l.category === category);
    if (category === 'experimental') {
      const active = list.find(l => l.id === current);
      items.push({ kind: 'submenu', label: active ? t('layout.category.experimentalActive', { name: t(active.name) }) : t(CATEGORY_KEYS[category]), hint: t('layout.category.experimental.hint'), icon: 'flask-conical', items: () => list.map(radio) });
    } else {
      items.push({ kind: 'heading', label: t(CATEGORY_KEYS[category]) }, ...list.map(radio));
    }
  }
  const s = h.state;
  items.push(
    { kind: 'separator' },
    { kind: 'action', label: t('menu.rearrange'), hint: t('menu.rearrange.hint'), icon: 'shuffle', disabled: !s.hasFile, run: () => h.run('rearrange') },
    { kind: 'action', label: t('menu.releaseAll', { count: s.anchoredCount }), icon: 'pin-off', disabled: !s.anchoredCount, run: () => h.run('releaseAll') },
    {
      kind: 'submenu', label: t('menu.spacing'), icon: 'move-horizontal', items: () => [
        { kind: 'slider', label: t('menu.edgeGap'), min: EDGE_GAP_MIN, max: 400, step: 1, value: Math.min(400, h.settings.edgeGap), format: v => `${Math.round(v)}`, onInput: v => h.update({ edgeGap: Math.min(EDGE_GAP_MAX, v) }) },
        ...(s.physics ? [
          { kind: 'slider' as const, label: t('menu.repulsion'), min: 40, max: 600, step: 10, value: Math.abs(h.settings.chargeStrength), format: (v: number) => `${Math.round(v)}`, onInput: (v: number) => h.update({ chargeStrength: -v }) },
          { kind: 'action' as const, label: t('menu.reheat'), run: () => h.run('reheat') },
        ] : []),
        { kind: 'toggle', label: t('menu.chapterOrder'), hint: t('menu.chapterOrder.hint'), checked: h.settings.linkLevel1, run: v => h.update({ linkLevel1: v }) },
      ],
    },
  );
  return items;
}

function viewMenu(h: MenuHost): MenuItem[] {
  const st = h.settings;
  const centre = (value: OrbitCenter, label: Parameters<typeof t>[0], hint: Parameters<typeof t>[0]): MenuItem =>
    ({ kind: 'radio', label: t(label), hint: t(hint), checked: st.orbitCenter === value, run: () => h.update({ orbitCenter: value }) });
  return [
    { kind: 'action', label: t('menu.fitAll'), shortcut: 'Home', icon: 'maximize', disabled: !h.state.hasFile, run: () => h.run('overview') },
    { kind: 'action', label: t('menu.resetCamera'), icon: 'rotate-ccw', disabled: !h.state.hasFile, run: () => h.run('resetCamera') },
    { kind: 'separator' },
    { kind: 'heading', label: t('menu.orbitAround') },
    centre('free', 'orbit.free', 'orbit.free.hint'),
    centre('selected', 'orbit.selected', 'orbit.selected.hint'),
    centre('root', 'orbit.centre', 'orbit.centre.hint'),
    {
      kind: 'submenu', label: t('menu.cameraControls'), icon: 'settings-2', items: () => [
        { kind: 'radio', label: t('rotation.turntable'), hint: t('rotation.turntable.hint'), checked: st.rotationStyle === 'turntable', run: () => h.update({ rotationStyle: 'turntable' }) },
        { kind: 'radio', label: t('rotation.trackball'), hint: t('rotation.trackball.hint'), checked: st.rotationStyle === 'trackball', run: () => h.update({ rotationStyle: 'trackball' }) },
        { kind: 'action', label: t('menu.resetRoll'), disabled: st.rotationStyle !== 'trackball', run: () => h.run('resetRoll') },
        { kind: 'separator' },
        { kind: 'toggle', label: t('menu.zoomToCursor'), hint: t('menu.zoomToCursor.hint'), checked: st.zoomToCursor, run: v => h.update({ zoomToCursor: v }) },
        { kind: 'slider', label: t('menu.fov'), min: FOV_MIN, max: FOV_MAX, step: 1, value: st.fieldOfView, format: v => `${Math.round(v)}\u00B0`, onInput: v => h.update({ fieldOfView: v }) },
        { kind: 'slider', label: t('menu.smoothing'), min: 0, max: 400, step: 10, value: st.cameraSmoothingMs, format: v => (v ? `${Math.round(v)} ms` : t('common.off')), onInput: v => h.update({ cameraSmoothingMs: v }) },
        { kind: 'note', text: t('menu.cameraHelp') },
      ],
    },
    { kind: 'separator' },
    { kind: 'heading', label: t('menu.labels') },
    { kind: 'toggle', label: t('menu.showLabels'), checked: st.showLabels, run: v => h.update({ showLabels: v }) },
    {
      kind: 'submenu', label: t('menu.labelOptions'), disabled: !st.showLabels, items: () => [
        { kind: 'slider', label: t('menu.labelBudget'), min: 20, max: 600, step: 10, value: st.maxLabels, format: v => `${Math.round(v)}`, onInput: v => h.update({ maxLabels: v }) },
        { kind: 'slider', label: t('menu.labelDistance'), min: 400, max: 20000, step: 100, value: st.labelDistance, format: v => `${Math.round(v)}`, onInput: v => h.update({ labelDistance: v }) },
        { kind: 'toggle', label: t('menu.labelAvoid'), hint: t('menu.labelAvoid.hint'), checked: st.labelAvoid, run: v => h.update({ labelAvoid: v }) },
      ],
    },
    { kind: 'toggle', label: t('menu.hoverPreview'), hint: t('menu.hoverPreview.hint'), checked: st.showNoteOnHover, run: v => h.update({ showNoteOnHover: v }) },
  ];
}

function appearanceMenu(h: MenuHost): MenuItem[] {
  const st = h.settings;
  return [
    { kind: 'action', label: t('menu.background'), icon: 'image', run: () => h.run('background') },
    { kind: 'separator' },
    { kind: 'heading', label: t('menu.nodes') },
    { kind: 'slider', label: t('menu.nodeScale'), min: NODE_SCALE_MIN, max: NODE_SCALE_MAX, step: 0.05, value: st.nodeScale, format: times, onInput: v => h.update({ nodeScale: v }) },
    { kind: 'toggle', label: t('menu.sizeByHierarchy'), hint: t('menu.sizeByHierarchy.hint'), checked: st.sizeByHierarchy, run: v => h.update({ sizeByHierarchy: v }) },
    {
      kind: 'submenu', label: t('menu.nodeColors'), items: () => [
        { kind: 'radio', label: t('colors.depth'), checked: st.nodeColorMode === 'depth', run: () => h.update({ nodeColorMode: 'depth' }) },
        { kind: 'radio', label: t('colors.hash'), checked: st.nodeColorMode === 'hash', run: () => h.update({ nodeColorMode: 'hash' }) },
        { kind: 'radio', label: t('colors.single'), checked: st.nodeColorMode === 'single', run: () => h.update({ nodeColorMode: 'single' }) },
        { kind: 'note', text: t('colors.note') },
      ],
    },
    { kind: 'slider', label: t('menu.emphasis'), min: 0, max: 2, step: 0.05, value: Math.min(2, st.glowStrength), format: pct, onInput: v => h.update({ glowStrength: v }) },
    { kind: 'separator' },
    { kind: 'heading', label: t('menu.edges') },
    { kind: 'slider', label: t('menu.edgeWidth'), min: 0.2, max: 8, step: 0.1, value: Math.min(8, st.linkWidth), format: v => v.toFixed(1), onInput: v => h.update({ linkWidth: v }) },
    { kind: 'slider', label: t('menu.edgeOpacity'), min: 0, max: 1, step: 0.02, value: st.linkOpacity, format: pct, onInput: v => h.update({ linkOpacity: v }) },
    { kind: 'submenu', label: t('menu.edgeStyle'), items: () => styleItems(st.linkStyle, s => h.update({ linkStyle: s })) },
    { kind: 'separator' },
    {
      kind: 'submenu', label: t('menu.motion'), icon: 'activity', items: () => [
        { kind: 'radio', label: t('motion.system'), hint: t('motion.system.hint'), checked: st.motion === 'system', run: () => h.update({ motion: 'system' }) },
        { kind: 'radio', label: t('motion.reduce'), checked: st.motion === 'reduce', run: () => h.update({ motion: 'reduce' }) },
        { kind: 'radio', label: t('motion.full'), checked: st.motion === 'full', run: () => h.update({ motion: 'full' }) },
        { kind: 'toggle', label: t('menu.animateLayout'), checked: st.animate, run: v => h.update({ animate: v }) },
      ],
    },
  ];
}

function relationshipsMenu(h: MenuHost): MenuItem[] {
  const st = h.settings, s = h.state;
  return [
    { kind: 'action', label: t('menu.connect'), hint: t('menu.connect.hint'), icon: 'spline', disabled: !s.hasFile, run: () => h.run('connect') },
    { kind: 'separator' },
    { kind: 'toggle', label: t('menu.showAssociations', { count: s.associationCount }), hint: t('menu.showAssociations.hint'), checked: st.showAssociations, run: v => h.update({ showAssociations: v }) },
    { kind: 'toggle', label: t('menu.showNoteLinks'), hint: t('menu.showNoteLinks.hint'), checked: st.showNoteLinks, run: v => h.update({ showNoteLinks: v }) },
    { kind: 'toggle', label: t('menu.direction'), hint: t('menu.direction.hint'), checked: st.edgeDirection, run: v => h.update({ edgeDirection: v }) },
    {
      kind: 'submenu', label: t('menu.associationStyle'), items: () => [
        ...styleItems(st.assocStyle, x => h.update({ assocStyle: x })),
        { kind: 'separator' },
        { kind: 'toggle', label: t('menu.curved'), checked: st.assocCurve, run: v => h.update({ assocCurve: v }) },
        { kind: 'slider', label: t('menu.curvature'), min: 0.05, max: 0.6, step: 0.01, value: st.assocBulge, format: pct, onInput: v => h.update({ assocBulge: v }) },
      ],
    },
    { kind: 'separator' },
    { kind: 'action', label: t('menu.clearAssociations'), danger: true, disabled: !s.associationCount, run: () => h.run('clearAssociations') },
    { kind: 'note', text: t('menu.relationshipsNote') },
  ];
}

function moreMenu(h: MenuHost): MenuItem[] {
  const s = h.state;
  return [
    { kind: 'action', label: t('menu.exportPng'), icon: 'image-down', disabled: !s.hasFile || !s.pngEnabled, run: () => h.run('exportPng') },
    { kind: 'action', label: t('menu.openNote'), icon: 'file-text', disabled: !s.hasFile, run: () => h.run('openNote') },
    { kind: 'separator' },
    { kind: 'action', label: t('menu.diagnostics'), icon: 'gauge', run: () => h.run('diagnostics') },
    { kind: 'action', label: t('menu.reload'), hint: t('menu.reload.hint'), icon: 'refresh-cw', run: () => h.run('reload') },
    { kind: 'action', label: t('menu.settings'), icon: 'settings', run: () => h.run('settings') },
  ];
}

export function buildMenu(group: ToolbarMenu, host: MenuHost): MenuItem[] {
  switch (group) {
    case 'edit': return editMenu(host);
    case 'study': return studyMenu(host);
    case 'layout': return layoutMenu(host);
    case 'view': return viewMenu(host);
    case 'appearance': return appearanceMenu(host);
    case 'relationships': return relationshipsMenu(host);
    case 'more': return moreMenu(host);
  }
}
