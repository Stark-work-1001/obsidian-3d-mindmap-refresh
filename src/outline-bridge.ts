// Clicking a heading in Obsidian's core Outline pane also shows it in the 3D
// map of the same note. The pane exposes no API, so the clicked item is read
// from its DOM: the heading text and how many earlier items carry the same
// text (to tell duplicate headings apart). If the pane's markup changes, the
// bridge simply finds nothing; it never throws or blocks the click.
const PANE = [
  '.workspace-leaf-content[data-type="outline"]',
  '.workspace-leaf-content[data-type="outline-pane"]',
].join(',');

export interface OutlineClick { text: string; occurrence: number; pane: HTMLElement }

const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

export function readOutlineClick(target: EventTarget | null): OutlineClick | null {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== 'function' || el.closest('.om3d-root') || el.closest('.collapse-icon')) return null;
  const pane = el.closest<HTMLElement>(PANE);
  if (!pane) return null;
  const item = el.closest('.tree-item-inner') ?? el.closest('.tree-item-self')?.querySelector('.tree-item-inner') ?? el.closest('.tree-item-self');
  if (!item || !pane.contains(item)) return null;
  const items = Array.from(pane.querySelectorAll('.tree-item-inner'));
  const list = items.length ? items : Array.from(pane.querySelectorAll('.tree-item-self'));
  const index = list.indexOf(item);
  const text = clean(item.textContent);
  if (index < 0 || !text) return null;
  let occurrence = 0;
  for (let i = 0; i < index; i++) if (clean(list[i].textContent) === text) occurrence++;
  return { text, occurrence, pane };
}
