// Keyboard shortcuts of the map (active while the view has focus and no text
// field is being edited). Kept compatible with 1.x where possible; see
// docs/keyboard.md for the full list.
export interface KeyboardHost {
  undo(): void;
  redo(): void;
  search(): void;
  addChild(): void;
  addSibling(): void;
  editNote(): void;
  rename(): void;
  remove(): void;
  toggleCollapse(expand?: boolean): void;
  indent(direction: 1 | -1): void;
  move(delta: -1 | 1): void;
  select(direction: 'up' | 'down' | 'left' | 'right'): void;
  typeJump(char: string): void;
  escape(): void;
  enterBranch(): void;
  overview(): void;
  history(direction: -1 | 1): void;
  orbit(dx: number, dy: number): void;
  dolly(steps: number): void;
}

const ARROWS: Record<string, 'up' | 'down' | 'left' | 'right'> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
const TYPE_JUMP = /^[\p{L}\p{N}]$/u;

export function isTextInput(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return false;
  return !!el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
}

/** Handle one key event; returns true when it was consumed. */
export function handleKey(e: KeyboardEvent, h: KeyboardHost): boolean {
  if (e.isComposing || isTextInput(e.target)) return false;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key;
  if (mod) {
    if ((key === 'z' || key === 'Z') && !e.altKey) { e.shiftKey ? h.redo() : h.undo(); return true; }
    if ((key === 'y' || key === 'Y') && !e.altKey) { h.redo(); return true; }
    if ((key === 'f' || key === 'F') && !e.shiftKey && !e.altKey) { h.search(); return true; }
    if (key === 'Enter') { h.enterBranch(); return true; }
    return false;
  }
  if (e.altKey) {
    if (key === 'ArrowUp' || key === 'ArrowDown') { h.move(key === 'ArrowUp' ? -1 : 1); return true; }
    if (key === 'ArrowLeft' || key === 'ArrowRight') { h.history(key === 'ArrowLeft' ? -1 : 1); return true; }
    return false;
  }
  if (e.shiftKey && key in ARROWS) {
    const step = 36;
    const d = ARROWS[key];
    h.orbit(d === 'left' ? -step : d === 'right' ? step : 0, d === 'up' ? -step : d === 'down' ? step : 0);
    return true;
  }
  switch (key) {
    case 'Tab': e.shiftKey ? h.indent(-1) : h.addChild(); return true;
    case 'Enter': e.shiftKey ? h.editNote() : h.addSibling(); return true;
    case 'Backspace':
    case 'Delete': h.remove(); return true;
    case ' ':
    case 'Spacebar': h.toggleCollapse(); return true;
    case '+':
    case '=': h.toggleCollapse(true); return true;
    case '-': h.toggleCollapse(false); return true;
    case '[': h.indent(-1); return true;
    case ']': h.indent(1); return true;
    case 'F2': h.rename(); return true;
    case 'Escape': h.escape(); return true;
    case 'Home': h.overview(); return true;
    case 'PageUp': h.dolly(-2); return true;
    case 'PageDown': h.dolly(2); return true;
    default: break;
  }
  if (key in ARROWS) { h.select(ARROWS[key]); return true; }
  if (TYPE_JUMP.test(key)) { h.typeJump(key); return true; }
  return false;
}
