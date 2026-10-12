// Minimal, offline stand-in for the parts of the Obsidian API used by this
// plugin. It exists only for the browser benchmark/interaction harness; it is
// never bundled into the shipped plugin. Behaviour is intentionally simple:
// enough to construct the view, read/write in-memory notes and render menus.

let nextRef = 0;
function on(target, name, cb) {
  target.__events ??= new Map();
  if (!target.__events.has(name)) target.__events.set(name, new Set());
  const ref = { target, name, cb, id: nextRef++ };
  target.__events.get(name).add(ref);
  return ref;
}
function emit(target, name, ...args) {
  for (const ref of [...(target.__events?.get(name) ?? [])]) {
    try { ref.cb(...args); } catch (error) { console.error(error); }
  }
}
function offref(ref) { ref?.target?.__events?.get(ref.name)?.delete(ref); }

export const notices = [];
export class Notice {
  constructor(message) { notices.push(String(message)); console.info('[Notice]', message); }
  setMessage(message) { notices.push(String(message)); return this; }
  hide() {}
}

export class Events {
  on(name, cb) { return on(this, name, cb); }
  off(name, cb) { for (const ref of [...(this.__events?.get(name) ?? [])]) if (ref.cb === cb) offref(ref); }
  offref(ref) { offref(ref); }
  trigger(name, ...args) { emit(this, name, ...args); }
}

export class Component {
  constructor() { this._cleanups = []; this._children = []; }
  load() { this.onload?.(); }
  unload() {
    for (const c of this._children) c.unload?.();
    for (const fn of this._cleanups.splice(0)) { try { fn(); } catch (e) { console.error(e); } }
    this.onunload?.();
  }
  register(fn) { this._cleanups.push(fn); }
  registerEvent(ref) { this._cleanups.push(() => offref(ref)); }
  registerDomEvent(el, type, cb, options) { el.addEventListener(type, cb, options); this._cleanups.push(() => el.removeEventListener(type, cb, options)); }
  registerInterval(id) { this._cleanups.push(() => clearInterval(id)); return id; }
  addChild(child) { this._children.push(child); child.load?.(); return child; }
  removeChild(child) { child.unload?.(); this._children = this._children.filter(c => c !== child); return child; }
}

export class TAbstractFile { constructor(path) { this.path = path; this.name = path.split('/').pop(); this.parent = null; } }
export class TFile extends TAbstractFile {
  constructor(path) {
    super(path);
    this.extension = path.split('.').pop();
    this.basename = this.name.replace(/\.[^.]+$/, '');
    this.stat = { mtime: Date.now(), ctime: Date.now(), size: 0 };
  }
}
export class TFolder extends TAbstractFile {}

const domHelpers = {
  empty() { this.replaceChildren(); },
  createEl(tag, opts = {}) {
    const child = document.createElement(tag);
    if (typeof opts === 'string') child.className = opts;
    else {
      if (opts.cls) child.className = Array.isArray(opts.cls) ? opts.cls.join(' ') : opts.cls;
      if (opts.text !== undefined) child.textContent = opts.text;
      if (opts.type) child.type = opts.type;
      if (opts.value !== undefined) child.value = opts.value;
      if (opts.placeholder) child.placeholder = opts.placeholder;
      if (opts.title) child.title = opts.title;
      for (const [k, v] of Object.entries(opts.attr ?? {})) child.setAttribute(k, v);
    }
    this.appendChild(child);
    return child;
  },
  createDiv(opts = {}) { return this.createEl('div', typeof opts === 'string' ? { cls: opts } : opts); },
  createSpan(opts = {}) { return this.createEl('span', typeof opts === 'string' ? { cls: opts } : opts); },
  setText(text) { this.textContent = text; },
  addClass(...c) { this.classList.add(...c); },
  removeClass(...c) { this.classList.remove(...c); },
  toggleClass(c, v) { this.classList.toggle(c, v); },
  hasClass(c) { return this.classList.contains(c); },
  isShown() { return this.isConnected && this.offsetParent !== null; },
};
export function installDomHelpers() {
  for (const [name, fn] of Object.entries(domHelpers)) {
    if (!(name in HTMLElement.prototype)) Object.defineProperty(HTMLElement.prototype, name, { value: fn, configurable: true, writable: true });
  }
}
installDomHelpers();
const div = (cls) => { const el = document.createElement('div'); if (cls) el.className = cls; return el; };

export class Modal extends Component {
  constructor(app) {
    super();
    this.app = app;
    this.containerEl = div('modal-container mod-dim');
    this.modalEl = this.containerEl.createDiv({ cls: 'modal' });
    this.titleEl = this.modalEl.createDiv({ cls: 'modal-title' });
    this.contentEl = this.modalEl.createDiv({ cls: 'modal-content' });
    this.scope = { register() {} };
  }
  setTitle(t) { this.titleEl.textContent = t; return this; }
  open() { document.body.appendChild(this.containerEl); this.onOpen?.(); }
  close() { this.onClose?.(); this.containerEl.remove(); }
}
export class FuzzySuggestModal extends Modal {
  setPlaceholder(p) { this.placeholder = p; }
  open() {
    super.open();
    for (const item of (this.getItems?.() ?? []).slice(0, 50)) {
      const b = this.contentEl.createEl('button', { text: this.getItemText(item) });
      b.onclick = () => { this.onChooseItem(item); this.close(); };
    }
  }
}

function control(el, extra) { return Object.assign({ inputEl: el, setDisabled(v) { el.disabled = v; return this; }, setTooltip() { return this; } }, extra); }
export class Setting {
  constructor(containerEl) {
    this.settingEl = containerEl.createDiv({ cls: 'setting-item' });
    this.infoEl = this.settingEl.createDiv({ cls: 'setting-item-info' });
    this.nameEl = this.infoEl.createDiv({ cls: 'setting-item-name' });
    this.descEl = this.infoEl.createDiv({ cls: 'setting-item-description' });
    this.controlEl = this.settingEl.createDiv({ cls: 'setting-item-control' });
  }
  setName(n) { if (typeof n === 'string') this.nameEl.textContent = n; else if (n) this.nameEl.append(n); return this; }
  setDesc(d) { if (typeof d === 'string') this.descEl.textContent = d; else if (d) this.descEl.append(d); return this; }
  setHeading() { this.settingEl.classList.add('setting-item-heading'); return this; }
  setClass(c) { this.settingEl.classList.add(c); return this; }
  setDisabled() { return this; }
  setTooltip() { return this; }
  then(cb) { cb(this); return this; }
  addToggle(cb) {
    const input = this.controlEl.createEl('input', { type: 'checkbox' });
    const c = control(input, { toggleEl: input, setValue(v) { input.checked = !!v; return c; }, getValue: () => input.checked, onChange(fn) { input.onchange = () => fn(input.checked); return c; } });
    cb(c); return this;
  }
  addText(cb) {
    const input = this.controlEl.createEl('input', { type: 'text' });
    const c = control(input, { setValue(v) { input.value = v; return c; }, getValue: () => input.value, setPlaceholder(p) { input.placeholder = p; return c; }, onChange(fn) { input.oninput = () => fn(input.value); return c; } });
    cb(c); return this;
  }
  addTextArea(cb) { return this.addText(cb); }
  addColorPicker(cb) {
    const input = this.controlEl.createEl('input', { type: 'color' });
    const c = control(input, { setValue(v) { input.value = v; return c; }, getValue: () => input.value, onChange(fn) { input.oninput = () => fn(input.value); return c; } });
    cb(c); return this;
  }
  addSlider(cb) {
    const input = this.controlEl.createEl('input', { type: 'range' });
    const c = control(input, { sliderEl: input, setLimits(a, b, s) { input.min = a; input.max = b; input.step = s; return c; }, setValue(v) { input.value = v; return c; }, getValue: () => Number(input.value), setDynamicTooltip() { return c; }, onChange(fn) { input.oninput = () => fn(Number(input.value)); return c; } });
    cb(c); return this;
  }
  addDropdown(cb) {
    const select = this.controlEl.createEl('select');
    const c = control(select, { selectEl: select, addOption(v, t) { const o = document.createElement('option'); o.value = v; o.textContent = t; select.append(o); return c; }, addOptions(map) { for (const [v, t] of Object.entries(map)) c.addOption(v, t); return c; }, setValue(v) { select.value = v; return c; }, getValue: () => select.value, onChange(fn) { select.onchange = () => fn(select.value); return c; } });
    cb(c); return this;
  }
  addButton(cb) {
    const button = this.controlEl.createEl('button');
    const c = control(button, { buttonEl: button, setButtonText(t) { button.textContent = t; return c; }, setCta() { button.classList.add('mod-cta'); return c; }, setWarning() { button.classList.add('mod-warning'); return c; }, setIcon() { return c; }, onClick(fn) { button.onclick = fn; return c; } });
    cb(c); return this;
  }
  addExtraButton(cb) { return this.addButton(cb); }
}

export class PluginSettingTab {
  constructor(app, plugin) { this.app = app; this.plugin = plugin; this.containerEl = div('vertical-tab-content'); this.containerEl.append(div(), div()); }
}

function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
export const MarkdownRenderer = {
  async render(app, markdown, el, sourcePath) {
    for (const block of String(markdown).split(/\n{2,}/)) {
      const p = document.createElement('p');
      p.innerHTML = escapeHtml(block).replace(/\[\[([^\]|#]+)(#[^\]|]+)?(?:\|([^\]]+))?\]\]/g,
        (m, target, anchor = '', alias) => `<a class="internal-link" data-href="${target}${anchor}" href="${target}${anchor}">${alias ?? target + anchor}</a>`);
      el.append(p);
    }
    el.dataset.sourcePath = sourcePath;
  },
  async renderMarkdown(markdown, el, sourcePath, component) { return MarkdownRenderer.render(null, markdown, el, sourcePath, component); },
};

export function setIcon(el, name) {
  el.replaceChildren();
  const span = document.createElement('span');
  span.className = `svg-icon lucide-${name}`;
  span.dataset.icon = name;
  span.setAttribute('aria-hidden', 'true');
  el.append(span);
}
export function debounce(fn, ms = 0) { let t = null; const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); return d; }; d.cancel = () => { clearTimeout(t); return d; }; return d; }
export function normalizePath(p) { return String(p).replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, ''); }
export const Platform = { isDesktop: true, isMobile: false, isDesktopApp: true };
export const Keymap = { isModEvent: e => !!(e && (e.ctrlKey || e.metaKey)) };
export function getLinkpath(link) { return String(link).split('#')[0].split('|')[0]; }
export function parseLinktext(text) { const [path, ...rest] = String(text).split('#'); return { path, subpath: rest.length ? '#' + rest.join('#') : '' }; }

export class Plugin extends Component {
  constructor(app, manifest) { super(); this.app = app; this.manifest = manifest; this.commands = []; this.settingTabs = []; }
  async loadData() { return this.app.__pluginData ? structuredClone(this.app.__pluginData) : null; }
  async saveData(data) { this.app.__pluginData = structuredClone(data); this.app.__saves = (this.app.__saves ?? 0) + 1; }
  addCommand(c) { this.commands.push(c); return c; }
  addRibbonIcon() { return document.createElement('div'); }
  addStatusBarItem() { return div(); }
  addSettingTab(tab) { this.settingTabs.push(tab); }
  registerView(type, creator) { this.app.workspace.viewCreators.set(type, creator); }
  registerHoverLinkSource() {}
  registerMarkdownPostProcessor() {}
}

export class ItemView extends Component {
  constructor(leaf) {
    super();
    this.leaf = leaf;
    this.app = leaf.app;
    this.containerEl = div('workspace-leaf-content');
    this.containerEl.append(div('view-header'), div('view-content'));
    this.contentEl = this.containerEl.children[1];
  }
  getState() { return {}; }
  async setState() {}
  getEphemeralState() { return {}; }
  setEphemeralState() {}
  onResize() {}
}

export class MarkdownView extends ItemView {}

// Obsidian consults a focused view's scope before the app scope; the harness relies on DOM listeners only.
export class Scope { constructor(parent) { this.parent = parent; this.keys = []; } register(modifiers, key, func) { const h = { modifiers, key, func }; this.keys.push(h); return h; } unregister(h) { this.keys = this.keys.filter(k => k !== h); } }

class Leaf {
  constructor(app, host) { this.app = app; this.view = null; this.containerEl = div('workspace-leaf'); host.append(this.containerEl); }
  async setViewState(state) {
    if (this.view) { await this.view.onClose?.(); this.view.unload?.(); this.view.containerEl.remove(); }
    const creator = this.app.workspace.viewCreators.get(state.type);
    this.view = creator(this);
    this.containerEl.append(this.view.containerEl);
    this.view.load?.();
    await this.view.onOpen?.();
    if (state.active) this.app.workspace.activeLeaf = this;
    if (state.state) await this.view.setState?.(state.state, {});
  }
  getViewState() { return { type: this.view?.getViewType?.() }; }
  setViewTitle() {}
  async detach() {
    if (this.view) { await this.view.onClose?.(); this.view.unload?.(); }
    this.containerEl.remove();
    this.app.workspace.leaves = this.app.workspace.leaves.filter(l => l !== this);
  }
}

export function createApp({ files = {}, pluginData = null, host }) {
  const store = new Map(Object.entries(files));
  const fileObjects = new Map([...store.keys()].map(p => [p, new TFile(p)]));
  const app = {};
  const vault = new Events();
  Object.assign(vault, {
    adapter: {
      async read(path) { if (store.has(path)) return store.get(path); const r = await fetch('/' + path); if (!r.ok) throw new Error('missing ' + path); return r.text(); },
      async write(path, data) { store.set(path, data); },
      async writeBinary(path, data) { store.set(path, data); },
      async exists(path) { return store.has(path); },
      getResourcePath(path) { return '/' + path; },
    },
    async read(file) { return store.get(file.path) ?? ''; },
    async cachedRead(file) { return store.get(file.path) ?? ''; },
    async modify(file, data) { store.set(file.path, data); file.stat.mtime = Date.now(); vault.trigger('modify', file); app.metadataCache.trigger('changed', file, data, {}); },
    async process(file, fn) { const next = fn(store.get(file.path) ?? ''); store.set(file.path, next); file.stat.mtime = Date.now(); vault.trigger('modify', file); app.metadataCache.trigger('changed', file, next, {}); return next; },
    async create(path, data) { store.set(path, data); const f = new TFile(path); fileObjects.set(path, f); return f; },
    async createBinary(path, data) { store.set(path, data); const f = new TFile(path); fileObjects.set(path, f); return f; },
    async modifyBinary(file, data) { store.set(file.path, data); },
    getAbstractFileByPath(path) { return fileObjects.get(path) ?? null; },
    getFileByPath(path) { return fileObjects.get(path) ?? null; },
    getMarkdownFiles() { return [...fileObjects.values()].filter(f => f.extension === 'md'); },
    getFiles() { return [...fileObjects.values()]; },
  });
  // Simulates an edit made outside the plugin (another editor or a sync tool).
  vault.externalEdit = (path, text) => { store.set(path, text); const f = fileObjects.get(path); vault.trigger('modify', f); app.metadataCache.trigger('changed', f, text, {}); };
  const workspace = new Events();
  Object.assign(workspace, {
    viewCreators: new Map(),
    leaves: [],
    activeFile: null,
    getLeavesOfType(type) { return this.leaves.filter(l => l.view?.getViewType?.() === type); },
    getLeaf() { const leaf = new Leaf(app, host); this.leaves.push(leaf); return leaf; },
    getActiveFile() { return this.activeFile; },
    onLayoutReady(cb) { setTimeout(cb, 0); },
    iterateAllLeaves(cb) { this.leaves.forEach(cb); },
    revealLeaf() {},
    activeLeaf: null,
    setActiveLeaf(leaf) { this.activeLeaf = leaf; },
    requestSaveLayout() {},
    getActiveViewOfType(cls) { const v = this.activeLeaf?.view; return v && cls && v instanceof cls ? v : null; },
    openLinkText(link) { notices.push('open:' + link); },
  });
  const metadataCache = new Events();
  Object.assign(metadataCache, {
    getFirstLinkpathDest(link) { const name = getLinkpath(link); return [...fileObjects.values()].find(f => f.basename === name || f.path === name || f.path === name + '.md') ?? null; },
    getFileCache() { return null; },
    resolvedLinks: {},
  });
  Object.assign(app, { vault, workspace, metadataCache, scope: new Scope(null), __pluginData: pluginData, __store: store, setting: { open() {}, openTabById() {} } });
  return app;
}

export const obsidianModule = {
  Notice, Events, Component, TAbstractFile, TFile, TFolder, Modal, FuzzySuggestModal, Setting,
  PluginSettingTab, MarkdownRenderer, setIcon, debounce, normalizePath, Platform, Keymap, Plugin, ItemView, MarkdownView, Scope,
  getLinkpath, parseLinktext,
};
