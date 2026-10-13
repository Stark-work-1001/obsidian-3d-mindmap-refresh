// Settings tab: the same options as the toolbar menus, grouped by task, plus
// the rule editors that only make sense here. All labels come from i18n.
import { PluginSettingTab, Setting, type App } from 'obsidian';
import { t, type StringKey } from './i18n';
import { LAYOUTS } from './layout/catalog';
import { compileRule, newRuleId, RULE_MODES, type GroupRule, type MatchRule } from './model/rules';
import {
  DEFAULT_SETTINGS, EDGE_GAP_MAX, EDGE_GAP_MIN, FOV_MAX, FOV_MIN, LINK_STYLES, NODE_SCALE_MAX, NODE_SCALE_MIN,
  isColor, type Settings,
} from './persistence/settings';
import { ConfirmModal } from './ui/modals';

export interface SettingsHost {
  readonly config: Settings;
  updateSettings(patch: Partial<Settings>): void;
}

type NumberKey = { [K in keyof Settings]: Settings[K] extends number ? K : never }[keyof Settings];
type BooleanKey = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings];

export class MindMapSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly host: SettingsHost & ConstructorParameters<typeof PluginSettingTab>[1]) {
    super(app, host);
  }

  private get s(): Settings { return this.host.config; }
  private set(patch: Partial<Settings>): void { this.host.updateSettings(patch); }

  private heading(el: HTMLElement, key: StringKey): void { new Setting(el).setName(t(key)).setHeading(); }

  private toggle(el: HTMLElement, key: BooleanKey, name: StringKey, desc?: StringKey): void {
    const setting = new Setting(el).setName(t(name)).addToggle(c => c.setValue(this.s[key]).onChange(v => this.set({ [key]: v } as Partial<Settings>)));
    if (desc) setting.setDesc(t(desc));
  }

  private slider(el: HTMLElement, key: NumberKey, name: StringKey, min: number, max: number, step: number, desc?: StringKey, transform: (v: number) => number = v => v, inverse: (v: number) => number = v => v): void {
    const setting = new Setting(el).setName(t(name)).addSlider(c => c
      .setLimits(min, max, step)
      .setValue(inverse(this.s[key]))
      .setDynamicTooltip()
      .onChange(v => this.set({ [key]: transform(v) } as Partial<Settings>)));
    if (desc) setting.setDesc(t(desc));
  }

  private color(el: HTMLElement, key: 'nodeColor' | 'bgTop' | 'bgBottom' | 'assocColor', name: StringKey): void {
    new Setting(el).setName(t(name)).addColorPicker(c => c.setValue(toHex(this.s[key])).onChange(v => this.set({ [key]: v } as Partial<Settings>)));
  }

  override display(): void {
    const el = this.containerEl;
    el.empty();
    el.addClass('om3d-settings');
    el.createEl('p', { text: t('settings.intro'), cls: 'setting-item-description' });

    this.heading(el, 'settings.section.notes');
    this.toggle(el, 'autoFocusOnOpen', 'settings.autoFocusOnOpen', 'settings.autoFocusOnOpen.desc');
    this.toggle(el, 'rootAsTitlePlate', 'settings.rootAsTitlePlate', 'settings.rootAsTitlePlate.desc');
    this.slider(el, 'collapseDepth', 'settings.collapseDepth', 0, 8, 1, 'settings.collapseDepth.desc');
    this.slider(el, 'maxHeadingLevel', 'settings.maxHeadingLevel', 1, 6, 1, 'settings.maxHeadingLevel.desc');
    this.toggle(el, 'coreNameStripSuffix', 'settings.coreNameStripSuffix', 'settings.coreNameStripSuffix.desc');
    this.toggle(el, 'enableFormula', 'settings.enableFormula', 'settings.enableFormula.desc');
    this.slider(el, 'syncDebounceMs', 'settings.syncDebounceMs', 0, 2000, 50, 'settings.syncDebounceMs.desc');

    this.heading(el, 'settings.section.layout');
    new Setting(el).setName(t('settings.layout')).addDropdown(c => {
      for (const l of LAYOUTS) c.addOption(l.id, `${t(l.name)}${l.category === 'experimental' ? ` (${t('layout.category.experimental')})` : ''}`);
      c.setValue(this.s.layout).onChange(v => this.set({ layout: v as Settings['layout'] }));
    });
    this.slider(el, 'edgeGap', 'settings.edgeGap', EDGE_GAP_MIN, Math.min(400, EDGE_GAP_MAX), 1, 'settings.edgeGap.desc');
    this.slider(el, 'chargeStrength', 'settings.chargeStrength', 40, 600, 10, undefined, v => -v, v => Math.abs(v));
    this.toggle(el, 'linkLevel1', 'settings.linkLevel1', 'settings.linkLevel1.desc');
    this.toggle(el, 'learningPath', 'settings.learningPath', 'menu.readingPath.hint');
    this.toggle(el, 'animate', 'settings.animate');

    this.heading(el, 'settings.section.nodes');
    this.slider(el, 'nodeScale', 'settings.nodeScale', NODE_SCALE_MIN, NODE_SCALE_MAX, 0.05);
    this.toggle(el, 'sizeByHierarchy', 'settings.sizeByHierarchy', 'menu.sizeByHierarchy.hint');
    new Setting(el).setName(t('settings.nodeColorMode')).addDropdown(c => c
      .addOption('depth', t('colors.depth')).addOption('hash', t('colors.hash')).addOption('single', t('colors.single'))
      .setValue(this.s.nodeColorMode).onChange(v => this.set({ nodeColorMode: v as Settings['nodeColorMode'] })));
    this.color(el, 'nodeColor', 'settings.nodeColor');
    this.slider(el, 'glowStrength', 'settings.glowStrength', 0, 2, 0.05, 'settings.glowStrength.desc');
    this.toggle(el, 'showLabels', 'settings.showLabels');
    this.slider(el, 'maxLabels', 'settings.maxLabels', 20, 600, 10);
    this.slider(el, 'labelDistance', 'settings.labelDistance', 400, 20000, 100);
    this.toggle(el, 'labelAvoid', 'settings.labelAvoid', 'menu.labelAvoid.hint');
    this.toggle(el, 'showNoteOnHover', 'settings.showNoteOnHover', 'menu.hoverPreview.hint');
    this.slider(el, 'hoverNoteDelayMs', 'settings.hoverNoteDelayMs', 0, 2000, 20);

    this.heading(el, 'settings.section.edges');
    this.slider(el, 'linkWidth', 'settings.linkWidth', 0.2, 14, 0.1);
    this.slider(el, 'linkOpacity', 'settings.linkOpacity', 0, 1, 0.02);
    new Setting(el).setName(t('settings.linkStyle')).addDropdown(c => {
      for (const s of LINK_STYLES) c.addOption(s, t(`style.${s}`));
      c.setValue(this.s.linkStyle).onChange(v => this.set({ linkStyle: v as Settings['linkStyle'] }));
    });
    new Setting(el).setName(t('settings.linkColor')).setDesc(t('settings.linkColor.desc')).addText(c => c
      .setPlaceholder('#8a8a8a').setValue(this.s.linkColor)
      .onChange(v => { const value = v.trim(); if (!value || isColor(value)) this.set({ linkColor: value }); }));
    this.toggle(el, 'showAssociations', 'settings.showAssociations', 'menu.showAssociations.hint');
    new Setting(el).setName(t('settings.assocStyle')).addDropdown(c => {
      for (const s of LINK_STYLES) c.addOption(s, t(`style.${s}`));
      c.setValue(this.s.assocStyle).onChange(v => this.set({ assocStyle: v as Settings['assocStyle'] }));
    });
    this.color(el, 'assocColor', 'settings.assocColor');
    this.toggle(el, 'assocCurve', 'settings.assocCurve');
    this.slider(el, 'assocBulge', 'settings.assocBulge', 0.05, 0.6, 0.01);
    this.toggle(el, 'showNoteLinks', 'settings.showNoteLinks', 'menu.showNoteLinks.hint');
    this.toggle(el, 'edgeDirection', 'settings.edgeDirection', 'menu.direction.hint');

    this.heading(el, 'settings.section.camera');
    new Setting(el).setName(t('settings.orbitCenter')).addDropdown(c => c
      .addOption('free', t('orbit.free')).addOption('selected', t('orbit.selected')).addOption('root', t('orbit.centre'))
      .setValue(this.s.orbitCenter).onChange(v => this.set({ orbitCenter: v as Settings['orbitCenter'] })));
    new Setting(el).setName(t('settings.rotationStyle')).addDropdown(c => c
      .addOption('turntable', t('rotation.turntable')).addOption('trackball', t('rotation.trackball'))
      .setValue(this.s.rotationStyle).onChange(v => this.set({ rotationStyle: v as Settings['rotationStyle'] })));
    this.toggle(el, 'zoomToCursor', 'settings.zoomToCursor', 'menu.zoomToCursor.hint');
    this.slider(el, 'fieldOfView', 'settings.fieldOfView', FOV_MIN, FOV_MAX, 1);
    this.slider(el, 'cameraSmoothingMs', 'settings.cameraSmoothingMs', 0, 400, 10, 'settings.cameraSmoothingMs.desc');

    this.heading(el, 'settings.section.background');
    new Setting(el).setName(t('settings.bgMode')).addDropdown(c => c
      .addOption('theme', t('background.mode.theme')).addOption('solid', t('background.mode.solid')).addOption('gradient', t('background.mode.gradient'))
      .setValue(this.s.bgMode).onChange(v => { this.set({ bgMode: v as Settings['bgMode'] }); this.display(); }));
    if (this.s.bgMode !== 'theme') this.color(el, 'bgTop', 'settings.bgTop');
    if (this.s.bgMode === 'gradient') {
      this.color(el, 'bgBottom', 'settings.bgBottom');
      new Setting(el).setName(t('settings.animatedBackground')).setDesc(t('settings.animatedBackground.desc'))
        .addToggle(c => c.setValue(this.s.animatedBackground === 'subtle').onChange(v => this.set({ animatedBackground: v ? 'subtle' : 'off' })));
    }
    new Setting(el).setName(t('settings.motion')).addDropdown(c => c
      .addOption('system', t('motion.system')).addOption('reduce', t('motion.reduce')).addOption('full', t('motion.full'))
      .setValue(this.s.motion).onChange(v => this.set({ motion: v as Settings['motion'] })));

    this.heading(el, 'settings.section.marks');
    el.createEl('p', { text: t('settings.rules.desc'), cls: 'setting-item-description' });
    this.ruleList(el, false);

    this.heading(el, 'settings.section.groups');
    el.createEl('p', { text: t('settings.groups.desc'), cls: 'setting-item-description' });
    this.ruleList(el, true);

    this.heading(el, 'settings.section.advanced');
    this.toggle(el, 'enablePngExport', 'settings.enablePngExport', 'settings.enablePngExport.desc');
    this.toggle(el, 'showInspector', 'settings.showInspector');
    new Setting(el).setName(t('settings.logLevel')).addDropdown(c => c
      .addOption('none', t('settings.logLevel.none')).addOption('info', t('settings.logLevel.info')).addOption('debug', t('settings.logLevel.debug'))
      .setValue(this.s.logLevel).onChange(v => this.set({ logLevel: v as Settings['logLevel'] })));
    new Setting(el).setName(t('settings.reset')).setDesc(t('settings.reset.desc')).addButton(b => b
      .setButtonText(t('common.reset')).setWarning()
      .onClick(() => new ConfirmModal(this.app, t('settings.reset'), t('settings.reset.confirm'), t('common.reset'), () => {
        const keep = { pinRules: this.s.pinRules, groupRules: this.s.groupRules };
        this.set({ ...DEFAULT_SETTINGS, ...keep });
        this.display();
      }).open()));
  }

  /** Editable list of key-concept rules (pinRules) or group rules (groupRules). */
  private ruleList(el: HTMLElement, groups: boolean): void {
    const rules: MatchRule[] = groups ? this.s.groupRules : this.s.pinRules;
    const save = (next: MatchRule[]) => this.set(groups ? { groupRules: next as GroupRule[] } : { pinRules: next });
    const update = (index: number, patch: Partial<GroupRule>) => save(rules.map((r, i) => (i === index ? { ...r, ...patch } : r)));
    rules.forEach((rule, index) => {
      const box = el.createDiv({ cls: 'om3d-rule' });
      const main = new Setting(box)
        .addText(c => c.setPlaceholder(t('settings.rule.pattern')).setValue(rule.pattern).onChange(v => { if (v.trim()) update(index, { pattern: v }); }))
        .addDropdown(c => {
          for (const mode of RULE_MODES) c.addOption(mode, t(`settings.rule.mode.${mode}`));
          c.setValue(rule.mode).onChange(v => { update(index, { mode: v as MatchRule['mode'] }); this.display(); });
        })
        .addToggle(c => c.setTooltip(t('settings.rule.enabled')).setValue(rule.enabled).onChange(v => update(index, { enabled: v })))
        .addExtraButton(c => c.setIcon('trash-2').setTooltip(t('common.remove')).onClick(() => { save(rules.filter((_, i) => i !== index)); this.display(); }));
      if (rule.mode === 'regex' && !compileRule(rule.pattern)) main.setDesc(t('settings.rule.broken'));
      const options = new Setting(box)
        .setName(t('settings.rule.depthMax'))
        .addText(c => c.setPlaceholder('\u2013').setValue(rule.depthMax === null ? '' : String(rule.depthMax)).onChange(v => {
          const n = Number.parseInt(v, 10);
          update(index, { depthMax: v.trim() === '' || !Number.isFinite(n) ? null : Math.max(0, Math.min(12, n)) });
        }))
        .addToggle(c => c.setTooltip(t('settings.rule.requireNote')).setValue(rule.requireNote).onChange(v => update(index, { requireNote: v })))
        .addToggle(c => c.setTooltip(t('settings.rule.requireTaskDone')).setValue(rule.requireTaskDone).onChange(v => update(index, { requireTaskDone: v })));
      options.setDesc(`${t('settings.rule.requireNote')} \u00B7 ${t('settings.rule.requireTaskDone')}`);
      if (groups) {
        const group = rule as GroupRule;
        new Setting(box)
          .setName(t('settings.rule.color'))
          .addColorPicker(c => c.setValue(toHex(group.color || '#e8590c')).onChange(v => update(index, { color: v })))
          .addToggle(c => c.setTooltip(t('settings.rule.hide')).setValue(group.hide).onChange(v => update(index, { hide: v })))
          .setDesc(t('settings.rule.hide'));
      }
    });
    new Setting(el).addButton(b => b.setButtonText(t('settings.rule.add')).onClick(() => {
      const base: MatchRule = { id: newRuleId(), pattern: '?', mode: 'contains', depthMax: null, requireNote: false, requireTaskDone: false, enabled: true };
      save([...rules, groups ? ({ ...base, color: '#e8590c', hide: false } as GroupRule) : base]);
      this.display();
    }));
  }
}

function toHex(color: string): string {
  if (/^#[0-9a-f]{6}$/i.test(color)) return color;
  if (/^#[0-9a-f]{3}$/i.test(color)) return `#${color.slice(1).split('').map(c => c + c).join('')}`;
  return '#888888';
}
