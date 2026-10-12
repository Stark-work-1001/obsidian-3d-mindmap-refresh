# 3D Mind Map for Obsidian

Turn a note's headings and lists into an editable 3D mind map. Navigate from
the whole subject to a chapter, a branch and a single concept; read and edit
notes beside the map; see exactly which relationships come from your note and
which you added in the map. Everything runs locally and offline.

Plugin ID: `obsidian-3d-mindmap` · Version 2.0.0 · Obsidian 1.4.0 or later · Desktop and mobile

## What it does

- **Your note is the map.** Headings and list items become nodes; editing in
  the map edits the Markdown, and edits in the editor appear in the map.
  Changes made elsewhere are never overwritten (see [Editing safely](#editing-safely)).
- **Study-oriented navigation.** Overview → enter a chapter → enter a branch →
  focus a concept → read its note and relationships → go back. Breadcrumbs,
  Back/Forward (Alt+←/→ or the mouse buttons) and Escape always tell you where
  you are and how to get out.
- **A coherent camera.** Rotate around the point you panned to, around the
  selected node (and follow it while the layout moves), or around the map
  centre. Zoom moves towards the pointer and never passes through a sphere;
  Alt+scroll magnifies without moving. Smoothing is the same at any frame rate.
- **23 layouts**, grouped by purpose: *Study* (Knowledge map, Bookshelf,
  Learning journey), *Structure* (Tree, Radial, Cone tree), *Explore*
  (Force-directed) and 16 *Experimental shapes* in their own submenu. Layouts
  keep their arrangement when you edit, so the map does not jump around.
- **Honest relationships.** Hierarchy edges, chapter order, associations you
  create in the map and `[[links]]` written in the note are drawn differently,
  and the inspector says where each relationship comes from. Nodes that merely
  sit close together are never presented as related.
- **Emphasis without clutter.** Selection, hover, search hits, key concepts and
  pinned nodes are distinguished by colour, labels and badges only — no glow
  sprites, halos or bloom — and stay readable on light, dark, solid and
  gradient backgrounds.
- **Formulas and notes.** `$…$` and `$$…$$` render with KaTeX (bundled; no
  network). Node notes render as Markdown in the inspector and on hover.
- **Fast with large outlines.** 3,000 nodes render in a constant handful of
  draw calls; the force layout runs in a Rust/WebAssembly worker with a
  JavaScript fallback; an idle map uses no CPU or GPU time. Measured results are
  in [docs/validation.md](docs/validation.md).

## Install

**From a release archive (manual install).** Download
`obsidian-3d-mindmap-2.0.0.zip`, extract it, and copy the
`obsidian-3d-mindmap` folder into `<your vault>/.obsidian/plugins/`. Then enable
*3D Mind Map* under *Settings → Community plugins*. The plugin needs only
`main.js`, `manifest.json` and `styles.css`; everything else (physics engine,
formula fonts) is inside `main.js`.

**From a built checkout.** `npm run install:vault -- --vault <path>` shows what
it would do; add `--yes` to install (details in [docs/development.md](docs/development.md)).

Upgrading from 1.x keeps your settings, associations, key concepts and node
sizes (camera positions from 1.x are kept in the data file, but 2.0 lays the map
out differently and frames it afresh the first time). On first start 2.0 converts its data file and keeps a
copy of the old one as `data.backup-v1.json` in the plugin folder. Your notes
are not modified by the upgrade. See [docs/migration.md](docs/migration.md).

You never need Node.js, Rust or npm to use the plugin.

## Quick start

1. Open a Markdown note with headings or lists.
2. Run **Open current note as 3D mind map** (ribbon icon, command palette, or
   Ctrl/Cmd+Shift+M for a new tab).
3. Drag to rotate, scroll to zoom, right-drag (or Shift+drag) to pan.
4. Click a node to see its note and relationships in the inspector.
   Double-click a node to enter its branch; Escape goes back up.
5. Press **Tab** to add a child, **Enter** to add a sibling, **F2** to rename,
   **Shift+Enter** to write a note. **Ctrl/Cmd+Z** undoes.

## Controls

| Action | Mouse / touch | Keyboard |
| --- | --- | --- |
| Select | Click a sphere or its label | Arrow keys (↑/↓ order, ← parent, → child), type a letter to jump |
| Rotate | Drag · one finger | Shift+arrows |
| Pan | Right-drag · Shift+drag · two fingers | — |
| Zoom (move closer) | Scroll · pinch | Page Up / Page Down |
| Magnify (field of view) | Alt+scroll | — |
| Enter branch | Double-click a node | Ctrl/Cmd+Enter |
| Up one level / clear | Double-click empty space | Escape |
| Overview | — | Home |
| Back / forward | Mouse back/forward buttons | Alt+← / Alt+→ |
| Search | Toolbar | Ctrl/Cmd+F, then Enter / Shift+Enter |
| Open the note at a node | Ctrl/Cmd+click | — |

The full list, including editing keys, is in [docs/keyboard.md](docs/keyboard.md).

**Interaction modes** (toolbar, left): *Navigate* (default), *Arrange* (drag a
node to place it; it keeps that position in this layout until you release it)
and *Connect* (click two nodes to create an association; click the same pair
again to remove it). Escape returns to Navigate.

**Toolbar menus** are organised by task: *Edit*, *Study* (overview, branches,
levels, key concepts, reading path), *Layout*, *View* (rotation centre, camera
controls, labels), *Appearance* (background, node size and colours, edges,
motion), *Relationships*, and *More* (export PNG, open note, diagnostics,
reload, settings). Every menu works with the keyboard (↓ to open, arrows,
Enter, Escape).

## Editing safely

- Every change is computed against the exact note text the map last saw. If
  the note changed in the meantime (another editor, sync, a script), nothing
  is overwritten: the map adopts the newer text and re-applies your change by
  node identity, or tells you it could not.
- Undo/redo (Ctrl/Cmd+Z, Ctrl/Cmd+Y) covers edits made in the map.
- Rotating, zooming, selecting, searching, collapsing branches and arranging
  nodes never write to your note. They are stored in the plugin's own data:
  camera position per note, collapsed branches, associations, key concepts,
  node sizes and pinned positions. These are keyed by node path and follow
  renames and moves made in the map.
- Deleting a branch with many nodes asks first, and can be undone.

## Privacy and offline use

The plugin makes no network requests and loads no remote code. Formula fonts,
the physics engine and its worker are bundled. The diagnostics report
(*More → Diagnostics*) contains counts and timings only — no note text or file
names — and is copied to the clipboard only when you ask.

## Known limitations

- Very large outlines (well beyond 3,000 nodes) still render, but labels are
  reduced to the most relevant ones; collapse branches or use search.
- The Experimental shapes arrange nodes by form, not meaning (they were visual
  motifs in 1.x and are kept for those who like them).
- Links to headings in *other* notes open those notes; only links within the
  same note are drawn in the map.
- The plugin is not marked desktop-only, as in 1.x, but 2.0 has not been tested on mobile devices.
- 2.0 was validated in Obsidian 1.14.4 on Windows (including an upgrade from
  1.17 data) and in a browser test harness; see
  [docs/validation.md](docs/validation.md).

## Documentation

- [docs/keyboard.md](docs/keyboard.md) — all shortcuts and gestures
- [docs/migration.md](docs/migration.md) — upgrading from 1.x, data format, rollback
- [docs/architecture.md](docs/architecture.md) — how the plugin is built
- [docs/development.md](docs/development.md) — building, testing, packaging
- [docs/validation.md](docs/validation.md) — test coverage and measured performance
- [CHANGELOG.md](CHANGELOG.md) — release notes

## License

MIT — see [LICENSE](LICENSE). The physics engine is derived from Obsidian 3D
Graph 2.8.1 (MIT). Bundled three.js and KaTeX are MIT licensed; Rust crates
are MIT/Apache-2.0. Full texts are in [licenses/](licenses/) and inside
`main.js`; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
