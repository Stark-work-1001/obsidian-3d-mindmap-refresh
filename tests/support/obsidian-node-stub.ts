// Node-side stand-in for the `obsidian` module, used only by unit tests of
// modules that import Obsidian types or classes but are exercised headlessly.
export class Notice { static log: string[] = []; constructor(message: string) { Notice.log.push(message); } }
export class Component { register(_fn: () => void): void {} registerEvent(): void {} load(): void {} unload(): void {} }
export class TFile { path = ''; basename = ''; extension = 'md'; }
export class Events {}
export class MarkdownView { file: TFile | null = null; editor: unknown = null; }
export class ItemView extends Component {}
export class Plugin extends Component {}
export class Modal extends Component {}
export class PluginSettingTab {}
export class Setting {}
export const MarkdownRenderer = { render: async () => {} };
export function setIcon(): void {}
export const Platform = { isMobile: false, isDesktop: true };
export const Keymap = { isModEvent: (e?: { ctrlKey?: boolean; metaKey?: boolean }) => !!(e && (e.ctrlKey || e.metaKey)) };
export class FuzzySuggestModal<T> extends Modal { getItems(): T[] { return []; } }
export function normalizePath(p: string): string { return p.replace(/\\/g, '/'); }
export class Scope { constructor(readonly parent?: unknown) {} register(): unknown { return {}; } unregister(): void {} }
