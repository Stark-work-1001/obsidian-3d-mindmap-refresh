// Inspector: everything known about the selected node, grouped so that the
// source of every relationship is explicit. Spatial nearness in a layout is
// never presented as a relationship.
import { Component, MarkdownRenderer, setIcon, type App } from 'obsidian';
import { formatDate, t } from '../i18n';
import type { StoredAssociation } from '../model/node-paths';
import { el, iconButton, isolatePointer } from './dom';

export interface LinkTarget { kind: 'node'; id: string; label: string } 
export interface DocumentTarget { kind: 'document'; linktext: string; resolved: string | null }

export interface InspectorData {
  id: string;
  isRoot: boolean;
  text: string;
  title: string;
  kindLabel: string;
  ancestors: { id: string; label: string }[];
  childCount: number;
  descendantCount: number;
  note: string | null;
  marked: boolean;
  markedByRule: string | null;
  anchored: boolean;
  sizeMultiplier: number;
  hasOverride: boolean;
  associations: { link: StoredAssociation; otherId: string | null; otherLabel: string }[];
  outgoing: { display: string; where: 'text' | 'note'; target: LinkTarget | DocumentTarget }[];
  incoming: { sourceId: string; sourceLabel: string; display: string; where: 'text' | 'note' }[];
}

export interface InspectorController {
  app: App;
  sourcePath(): string;
  rename(text: string): void;
  saveNote(text: string): void;
  clearNote(): void;
  locate(id: string): void;
  openLink(linktext: string, event: MouseEvent): void;
  removeAssociation(link: StoredAssociation): void;
  toggleAssociationHidden(link: StoredAssociation): void;
  startConnect(): void;
  toggleMark(): void;
  setSize(multiplier: number | null): void;
  releaseAnchor(): void;
  enterBranch(): void;
  frame(): void;
  editingChanged(editing: boolean): void;
}

export class Inspector {
  readonly el: HTMLElement;
  private data: InspectorData | null = null;
  private editing = false;
  private draft = '';
  private composing = false;
  private renderChild: Component | null = null;
  private open = true;

  constructor(host: HTMLElement, private readonly c: InspectorController, private readonly parent: Component) {
    this.el = el('aside', 'om3d-inspector', host);
    this.el.setAttribute('aria-label', t('inspector.label'));
    isolatePointer(this.el);
    this.el.addEventListener('keydown', e => e.stopPropagation());
    this.el.addEventListener('click', e => {
      const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('a.internal-link, .om3d-wikilink');
      if (!a) return;
      e.preventDefault();
      const href = a.getAttribute('data-href') ?? a.getAttribute('data-link') ?? a.getAttribute('href') ?? '';
      if (href) this.c.openLink(decodeURIComponent(href), e);
    });
  }

  get isOpen(): boolean { return this.open; }
  get isEditing(): boolean { return this.editing; }
  get editingId(): string | null { return this.editing ? this.data?.id ?? null : null; }

  setOpen(open: boolean): void {
    this.open = open;
    this.el.classList.toggle('is-hidden', !open);
    if (open) this.render();
  }

  /** Show a node (or nothing). While a note edit is unsaved, the edited node stays. */
  show(data: InspectorData | null): void {
    if (this.editing && this.data && data?.id !== this.data.id) { this.data = { ...this.data }; return; }
    this.data = data;
    if (this.open) this.render();
  }

  private render(): void {
    const d = this.data;
    this.renderChild && this.parent.removeChild(this.renderChild);
    this.renderChild = null;
    this.el.replaceChildren();
    if (!d) { el('p', 'om3d-empty', this.el, t('inspector.empty')); return; }

    const header = el('header', 'om3d-inspector-head', this.el);
    if (d.ancestors.length) {
      const trail = el('nav', 'om3d-ancestry', header);
      trail.setAttribute('aria-label', t('inspector.ancestry'));
      d.ancestors.forEach((a, i) => {
        if (i) el('span', 'om3d-ancestry-sep', trail, '\u203A').setAttribute('aria-hidden', 'true');
        const b = el('button', 'om3d-link-btn', trail, a.label);
        b.type = 'button';
        b.addEventListener('click', () => this.c.locate(a.id));
      });
    }
    el('div', 'om3d-kind', header, d.kindLabel);
    if (d.isRoot) el('h3', 'om3d-title', header, d.title);
    else {
      const input = el('input', 'om3d-title-input', header);
      input.type = 'text';
      input.value = d.text;
      input.setAttribute('aria-label', t('inspector.title'));
      input.addEventListener('compositionstart', () => { this.composing = true; });
      input.addEventListener('compositionend', () => { this.composing = false; });
      input.addEventListener('keydown', e => {
        if (this.composing || e.isComposing) return;
        if (e.key === 'Enter') { e.preventDefault(); this.commitTitle(input.value); }
        if (e.key === 'Escape') { e.preventDefault(); input.value = d.text; input.blur(); }
      });
      input.addEventListener('blur', () => { if (input.value.trim() && input.value.trim() !== d.text.trim()) this.commitTitle(input.value); });
    }
    const actions = el('div', 'om3d-inspector-actions', header);
    iconButton(actions, { label: t('inspector.frame'), icon: 'scan', onClick: () => this.c.frame() });
    if (d.childCount) iconButton(actions, { label: t('inspector.enterBranch'), icon: 'log-in', onClick: () => this.c.enterBranch() });

    if (!d.isRoot) this.renderNote(d);
    this.renderRelationships(d);
    this.renderDisplay(d);
  }

  private commitTitle(value: string): void {
    const text = value.replace(/\s+/g, ' ').trim();
    if (!text || !this.data || text === this.data.text.trim()) return;
    this.c.rename(text);
  }

  private section(title: string, open = true): HTMLElement {
    const details = el('details', 'om3d-section', this.el);
    details.open = open;
    el('summary', 'om3d-section-title', details, title);
    return el('div', 'om3d-section-body', details);
  }

  private renderNote(d: InspectorData): void {
    const body = this.section(t('inspector.note'));
    if (this.editing) {
      const editor = el('textarea', 'om3d-note-editor', body);
      editor.value = this.draft;
      editor.placeholder = t('inspector.note.placeholder');
      editor.setAttribute('aria-label', t('inspector.note'));
      editor.addEventListener('input', () => { this.draft = editor.value; status.textContent = this.draft !== (d.note ?? '') ? t('inspector.note.unsaved') : ''; });
      editor.addEventListener('compositionstart', () => { this.composing = true; });
      editor.addEventListener('compositionend', () => { this.composing = false; });
      editor.addEventListener('keydown', e => {
        if (this.composing || e.isComposing) return;
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.saveNote(); }
        if (e.key === 'Escape') { e.preventDefault(); this.cancelNote(); }
      });
      const preview = el('div', 'om3d-note-body markdown-rendered is-hidden', body);
      const row = el('div', 'om3d-row', body);
      const status = el('span', 'om3d-hint', row, '');
      status.setAttribute('aria-live', 'polite');
      const togglePreview = el('button', 'om3d-btn-text', row, t('inspector.note.preview'));
      togglePreview.type = 'button';
      togglePreview.addEventListener('click', () => {
        const showing = !preview.classList.contains('is-hidden');
        preview.classList.toggle('is-hidden', showing);
        togglePreview.textContent = showing ? t('inspector.note.preview') : t('inspector.note.hidePreview');
        if (!showing) this.renderMarkdown(this.draft, preview);
      });
      const cancel = el('button', 'om3d-btn-text', row, t('common.cancel'));
      cancel.type = 'button';
      cancel.addEventListener('click', () => this.cancelNote());
      const save = el('button', 'om3d-btn-text mod-cta', row, t('inspector.note.save'));
      save.type = 'button';
      save.title = 'Ctrl+Enter';
      save.addEventListener('click', () => this.saveNote());
      requestAnimationFrame(() => { editor.focus(); editor.setSelectionRange(editor.value.length, editor.value.length); });
      return;
    }
    if (d.note) this.renderMarkdown(d.note, el('div', 'om3d-note-body markdown-rendered', body));
    else el('p', 'om3d-hint', body, t('inspector.note.none'));
    const row = el('div', 'om3d-row', body);
    const edit = el('button', 'om3d-btn-text', row, d.note ? t('inspector.note.edit') : t('inspector.note.add'));
    edit.type = 'button';
    edit.title = 'Shift+Enter';
    edit.addEventListener('click', () => this.beginNote());
    if (d.note) {
      const remove = el('button', 'om3d-btn-text is-danger', row, t('inspector.note.remove'));
      remove.type = 'button';
      remove.addEventListener('click', () => this.c.clearNote());
    }
  }

  private renderMarkdown(markdown: string, target: HTMLElement): void {
    target.replaceChildren();
    if (this.renderChild) this.parent.removeChild(this.renderChild);
    this.renderChild = this.parent.addChild(new Component());
    void MarkdownRenderer.render(this.c.app, markdown, target, this.c.sourcePath(), this.renderChild);
  }

  beginNote(): void {
    if (!this.data || this.data.isRoot) return;
    this.setOpen(true);
    this.editing = true;
    this.draft = this.data.note ?? '';
    this.c.editingChanged(true);
    this.render();
  }

  private saveNote(): void {
    const text = this.draft.replace(/\r/g, '');
    this.editing = false;
    this.c.editingChanged(false);
    if (this.data && text !== (this.data.note ?? '')) this.c.saveNote(text);
    else this.render();
  }

  cancelNote(): void {
    if (!this.editing) return;
    this.editing = false;
    this.c.editingChanged(false);
    this.render();
  }

  private renderRelationships(d: InspectorData): void {
    const body = this.section(t('inspector.relationships'));
    const empty = !d.associations.length && !d.outgoing.length && !d.incoming.length;
    if (empty) el('p', 'om3d-hint', body, t('inspector.relationships.none'));
    if (d.associations.length) {
      el('h4', 'om3d-subhead', body, t('inspector.associations')).title = t('inspector.associations.provenance');
      const list = el('ul', 'om3d-rel-list', body);
      for (const a of d.associations) {
        const li = el('li', 'om3d-rel', list);
        const icon = el('span', 'om3d-rel-icon is-association', li); setIcon(icon, 'spline'); icon.setAttribute('aria-hidden', 'true');
        if (a.otherId) { const b = el('button', 'om3d-link-btn', li, a.otherLabel); b.type = 'button'; b.addEventListener('click', () => this.c.locate(a.otherId!)); }
        else el('span', 'om3d-muted', li, t('inspector.associations.missing', { label: a.otherLabel }));
        if (a.link.label) el('span', 'om3d-rel-label', li, a.link.label);
        el('span', 'om3d-rel-meta', li, t('inspector.associations.created', { date: formatDate(a.link.createdAt) }));
        const hide = iconButton(li, { label: a.link.hidden ? t('inspector.associations.show') : t('inspector.associations.hide'), icon: a.link.hidden ? 'eye' : 'eye-off', cls: 'om3d-mini', onClick: () => this.c.toggleAssociationHidden(a.link) });
        hide.classList.add('om3d-mini');
        iconButton(li, { label: t('inspector.associations.remove'), icon: 'x', cls: 'om3d-mini is-danger', onClick: () => this.c.removeAssociation(a.link) });
      }
    }
    if (d.outgoing.length) {
      el('h4', 'om3d-subhead', body, t('inspector.outgoing')).title = t('inspector.outgoing.provenance');
      const list = el('ul', 'om3d-rel-list', body);
      for (const o of d.outgoing) {
        const li = el('li', 'om3d-rel', list);
        const icon = el('span', 'om3d-rel-icon is-notelink', li); setIcon(icon, o.target.kind === 'node' ? 'corner-down-right' : 'file-symlink'); icon.setAttribute('aria-hidden', 'true');
        const target = o.target;
        const b = el('button', 'om3d-link-btn', li, o.display);
        b.type = 'button';
        if (target.kind === 'node') { b.title = t('inspector.outgoing.inMap', { label: target.label }); b.addEventListener('click', () => this.c.locate(target.id)); }
        else { b.title = target.resolved ?? t('inspector.outgoing.unresolved'); b.addEventListener('click', e => this.c.openLink(target.linktext, e)); if (!target.resolved) li.classList.add('is-unresolved'); }
        el('span', 'om3d-rel-meta', li, o.where === 'note' ? t('inspector.where.note') : t('inspector.where.text'));
      }
    }
    if (d.incoming.length) {
      el('h4', 'om3d-subhead', body, t('inspector.incoming')).title = t('inspector.incoming.provenance');
      const list = el('ul', 'om3d-rel-list', body);
      for (const i of d.incoming) {
        const li = el('li', 'om3d-rel', list);
        const icon = el('span', 'om3d-rel-icon is-notelink', li); setIcon(icon, 'corner-up-left'); icon.setAttribute('aria-hidden', 'true');
        const b = el('button', 'om3d-link-btn', li, i.sourceLabel);
        b.type = 'button';
        b.addEventListener('click', () => this.c.locate(i.sourceId));
        el('span', 'om3d-rel-meta', li, i.where === 'note' ? t('inspector.where.note') : t('inspector.where.text'));
      }
    }
    const row = el('div', 'om3d-row', body);
    const connect = el('button', 'om3d-btn-text', row, t('inspector.associations.add'));
    connect.type = 'button';
    connect.addEventListener('click', () => this.c.startConnect());
    el('p', 'om3d-footnote', body, t('inspector.proximityNote'));
  }

  private renderDisplay(d: InspectorData): void {
    const body = this.section(t('inspector.display'), false);
    const markRow = el('label', 'om3d-check', body);
    const mark = el('input', '', markRow);
    mark.type = 'checkbox';
    mark.checked = d.marked && !d.markedByRule;
    mark.disabled = !!d.markedByRule;
    mark.addEventListener('change', () => this.c.toggleMark());
    el('span', '', markRow, d.markedByRule ? t('inspector.mark.byRule', { rule: d.markedByRule }) : t('inspector.mark'));

    const sizeRow = el('div', 'om3d-slider-row', body);
    const id = `om3d-size-${d.id}`;
    const label = el('label', '', sizeRow, t('inspector.size'));
    label.htmlFor = id;
    const range = el('input', '', sizeRow);
    range.type = 'range'; range.id = id; range.min = '0.25'; range.max = '6'; range.step = '0.05';
    range.value = String(d.sizeMultiplier);
    const out = el('output', '', sizeRow, `\u00D7${d.sizeMultiplier.toFixed(2)}`);
    let frame = 0;
    range.addEventListener('input', () => {
      out.textContent = `\u00D7${Number(range.value).toFixed(2)}`;
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; this.c.setSize(Number(range.value)); });
    });
    el('p', 'om3d-hint', body, t('inspector.size.hint'));
    if (d.hasOverride) {
      const reset = el('button', 'om3d-btn-text', body, t('inspector.size.reset'));
      reset.type = 'button';
      reset.addEventListener('click', () => this.c.setSize(null));
    }
    if (d.anchored) {
      const release = el('button', 'om3d-btn-text', body, t('inspector.anchor.release'));
      release.type = 'button';
      release.addEventListener('click', () => this.c.releaseAnchor());
    } else el('p', 'om3d-hint', body, t('inspector.anchor.hint'));
    el('p', 'om3d-meta', body, t('inspector.structure', { children: d.childCount, descendants: d.descendantCount }));
  }

  dispose(): void {
    if (this.renderChild) this.parent.removeChild(this.renderChild);
    this.el.remove();
  }
}
