// Diagnostics report for one view: sizes, timings and renderer statistics.
// It contains counts and timings only -- no note text, node names or paths --
// so it can be shared in an issue. It is shown in a dialog and copied to the
// clipboard on request; nothing is written into the vault.
import { Modal, Notice, type App } from 'obsidian';
import { t } from '../i18n';

export function percentile(values: readonly number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const k = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[k];
}

export function summarise(values: readonly number[]): { count: number; p50: number; p95: number; p99: number; max: number } {
  const r = (v: number) => Math.round(v * 100) / 100;
  return { count: values.length, p50: r(percentile(values, 50)), p95: r(percentile(values, 95)), p99: r(percentile(values, 99)), max: r(values.length ? Math.max(...values) : 0) };
}

export class DiagnosticsModal extends Modal {
  constructor(app: App, private readonly report: Record<string, unknown>) { super(app); }

  override onOpen(): void {
    this.titleEl.setText(t('diagnostics.title'));
    const root = this.contentEl;
    root.addClass('om3d-diagnostics');
    root.createEl('p', { text: t('diagnostics.intro') });
    const text = JSON.stringify(this.report, null, 2);
    const pre = root.createEl('pre', { cls: 'om3d-diagnostics-report' });
    pre.setText(text);
    pre.tabIndex = 0;
    const actions = root.createDiv({ cls: 'modal-button-container' });
    const copy = actions.createEl('button', { text: t('diagnostics.copy'), cls: 'mod-cta' });
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(text); new Notice(t('diagnostics.copied')); }
      catch { new Notice(t('diagnostics.copyFailed')); }
    };
    actions.createEl('button', { text: t('common.close') }).onclick = () => this.close();
  }

  override onClose(): void { this.contentEl.empty(); }
}
