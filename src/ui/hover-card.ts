// Note preview shown after hovering a node briefly (Markdown, formulas and
// links rendered by Obsidian). Purely informational: no pointer events.
import { Component, MarkdownRenderer, type App } from 'obsidian';
import { el } from './dom';

export class HoverCard {
  readonly el: HTMLDivElement;
  private readonly title: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private shownFor: string | null = null;
  private child: Component | null = null;
  enabled = true;

  constructor(host: HTMLElement, private readonly app: App, private readonly parent: Component) {
    this.el = el('div', 'om3d-hovercard', host);
    this.el.hidden = true;
    this.el.setAttribute('role', 'tooltip');
    this.title = el('div', 'om3d-hovercard-title', this.el);
    this.body = el('div', 'om3d-hovercard-body markdown-rendered', this.el);
  }

  get target(): string | null { return this.shownFor; }

  async show(id: string, title: string, note: string | null, at: { x: number; y: number }, sourcePath: string): Promise<void> {
    if (!this.enabled || (!note && title.length < 80)) { this.hide(); return; }
    this.shownFor = id;
    this.title.textContent = title;
    this.body.replaceChildren();
    if (this.child) this.parent.removeChild(this.child);
    this.child = this.parent.addChild(new Component());
    if (note) await MarkdownRenderer.render(this.app, note, this.body, sourcePath, this.child);
    if (this.shownFor !== id) return;
    this.el.hidden = false;
    this.place(at);
  }

  place(at: { x: number; y: number }): void {
    const host = this.el.parentElement;
    const w = host?.clientWidth ?? 400, h = host?.clientHeight ?? 300;
    const width = Math.min(340, Math.max(200, w * 0.34));
    this.el.style.width = `${Math.round(width)}px`;
    this.el.style.left = `${Math.round(Math.min(Math.max(8, at.x + 16), Math.max(8, w - width - 8)))}px`;
    this.el.style.top = `${Math.round(Math.min(Math.max(8, at.y + 12), Math.max(8, h - this.el.offsetHeight - 8)))}px`;
  }

  hide(): void {
    this.shownFor = null;
    this.el.hidden = true;
  }

  dispose(): void {
    if (this.child) this.parent.removeChild(this.child);
    this.el.remove();
  }
}
