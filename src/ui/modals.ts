// Dialogs: background editor, note picker and confirmation.
import { FuzzySuggestModal, Modal, type App, type TFile } from 'obsidian';
import { t } from '../i18n';
import type { BackgroundMode } from '../persistence/settings';

export interface BackgroundChoice { mode: BackgroundMode; top: string; bottom: string; animated: boolean }

export class BackgroundModal extends Modal {
  constructor(app: App, private readonly current: BackgroundChoice, private readonly apply: (choice: BackgroundChoice) => void) { super(app); }

  override onOpen(): void {
    this.titleEl.setText(t('background.dialog.title'));
    const root = this.contentEl;
    root.addClass('om3d-background-editor');
    const mode = root.createEl('select', { attr: { 'aria-label': t('background.dialog.mode') } });
    for (const [value, label] of [['theme', t('background.mode.theme')], ['solid', t('background.mode.solid')], ['gradient', t('background.mode.gradient')]] as const) {
      mode.createEl('option', { text: label, value });
    }
    mode.value = this.current.mode;
    const fields = root.createDiv({ cls: 'om3d-color-fields' });
    const topLabel = fields.createEl('label', { text: t('background.dialog.top') });
    const top = topLabel.createEl('input', { type: 'color' });
    top.value = toHex(this.current.top);
    const bottomLabel = fields.createEl('label', { text: t('background.dialog.bottom') });
    const bottom = bottomLabel.createEl('input', { type: 'color' });
    bottom.value = toHex(this.current.bottom);
    const animatedLabel = root.createEl('label', { cls: 'om3d-check' });
    const animated = animatedLabel.createEl('input', { type: 'checkbox' });
    animated.checked = this.current.animated;
    animatedLabel.createSpan({ text: t('background.dialog.animated') });
    const preview = root.createDiv({ cls: 'om3d-background-preview', text: t('background.dialog.preview') });
    const update = () => {
      fields.hidden = mode.value === 'theme';
      bottomLabel.hidden = mode.value !== 'gradient';
      animatedLabel.hidden = mode.value !== 'gradient';
      preview.style.background = mode.value === 'theme' ? 'var(--background-primary)' : mode.value === 'solid' ? top.value : `linear-gradient(to bottom, ${top.value}, ${bottom.value})`;
    };
    mode.onchange = top.oninput = bottom.oninput = update;
    update();
    const actions = root.createDiv({ cls: 'om3d-dialog-actions' });
    actions.createEl('button', { text: t('common.cancel') }).onclick = () => this.close();
    const ok = actions.createEl('button', { text: t('background.dialog.apply'), cls: 'mod-cta' });
    ok.onclick = () => { this.apply({ mode: mode.value as BackgroundMode, top: top.value, bottom: bottom.value, animated: animated.checked }); this.close(); };
  }

  override onClose(): void { this.contentEl.empty(); }
}

function toHex(color: string): string {
  return /^#[0-9a-f]{6}$/i.test(color) ? color : /^#[0-9a-f]{3}$/i.test(color) ? `#${color.slice(1).split('').map(c => c + c).join('')}` : '#ffffff';
}

export class NotePicker extends FuzzySuggestModal<TFile> {
  constructor(app: App, private readonly exclude: string | null, private readonly onPick: (file: TFile) => void) {
    super(app);
    this.setPlaceholder(t('picker.placeholder'));
  }
  getItems(): TFile[] { return this.app.vault.getMarkdownFiles().filter(f => f.path !== this.exclude); }
  getItemText(file: TFile): string { return file.path; }
  onChooseItem(file: TFile): void { this.onPick(file); }
}

export class ConfirmModal extends Modal {
  constructor(app: App, private readonly titleText: string, private readonly message: string, private readonly confirmLabel: string, private readonly onConfirm: () => void) { super(app); }
  override onOpen(): void {
    this.titleEl.setText(this.titleText);
    this.contentEl.createEl('p', { text: this.message });
    const actions = this.contentEl.createDiv({ cls: 'om3d-dialog-actions' });
    actions.createEl('button', { text: t('common.cancel') }).onclick = () => this.close();
    const ok = actions.createEl('button', { text: this.confirmLabel, cls: 'mod-warning' });
    ok.onclick = () => { this.close(); this.onConfirm(); };
    requestAnimationFrame(() => ok.focus());
  }
  override onClose(): void { this.contentEl.empty(); }
}
