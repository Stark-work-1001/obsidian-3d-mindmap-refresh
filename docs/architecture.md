# Architecture

2.0 is a rewrite in TypeScript with small, separately tested modules. 1.x
existed only as a minified bundle plus readable code recovered from it,
extended through prototype patches; that code is kept in `reference/` solely
for differential tests and is not part of the build.

```
note text ──► OutlineModel ──► buildGraph ──► LayoutEngine ──► SceneRenderer ──► screen
   ▲             (parse, ids,     (index-aligned   (positions;      (instanced WebGL,
   │              undo history)    arrays, edges,   transitions;     DOM labels,
   │                               colours, labels) physics worker)  camera rig)
   └──── DocumentSync ◄── edit operations (create, rename, move, notes, undo)
```

## Source layout

| Folder | Responsibility |
| --- | --- |
| `src/model/` | Markdown outline parser (headings, lists, tasks, notes as quote blocks, formulas, frontmatter), stable node identity across edits, text-edit operations, undo history, node paths, rules, links written in notes. Pure; no Obsidian or DOM. |
| `src/sync/` | `DocumentSync` keeps one model and one note in agreement; `ObsidianNoteIO` writes through the open editor (transaction) or `Vault.process` (atomic compare-and-write). |
| `src/persistence/` | Settings (defaults, ranges, normalisation), data schema, migrations, debounced store with `flush()` on unload. |
| `src/layout/` | Layout catalogue (stable ids, categories), 7 main and 16 experimental layouts, effective node radius, separation, collision-aware transitions, `LayoutEngine`. |
| `src/physics/` | Physics protocol, worker core, worker entry, main-thread client with interpolation, JavaScript engine (fallback), WASM backend, generated wasm-bindgen glue and the embedded `.wasm`. |
| `crates/graph-physics/` | Rust force engine compiled to WebAssembly. |
| `src/camera/` | `CameraRig` (pivot + orientation + offset, damping, flights, fitting, clipping), navigation history, pose storage. |
| `src/render/` | `SceneRenderer` (render on demand), node, edge and link layers (instanced), labels, background, picking, colours. |
| `src/ui/` | Toolbar, accessible menus, inspector, outline panel, search bar, inline editor, hover card, dialogs. |
| `src/view/` | `MindMapView` (wires everything for one note), interaction (pointer, wheel, touch), keyboard, emphasis rules, menus, inspector data, diagnostics. |
| `src/i18n/` | English strings by stable key (`t('key', params)`). |
| `src/plugin.ts` | Registration, commands (1.x ids), vault events, settings tab, outline-pane bridge. |

## Identity and persistence

Nodes get session ids that survive edits: after each re-parse, siblings are
matched to the previous tree by text and position (longest common
subsequence), so a rename or move keeps the id. Anything stored across
sessions uses **node paths** instead (texts from the note title down, with
`#n` for duplicate siblings), resolved with a fallback that ignores the root
text so renaming the file does not orphan data. When nodes are renamed or moved
in the map, saved sizes, key concepts, associations, pinned positions and
collapsed state are re-keyed to the new paths.

## Writing notes without losing data

Every operation produces text edits against the text the model last saw
(`beforeText`). `ObsidianNoteIO.write` applies them only if the note still
equals that text — in the editor (compare, then one transaction) or on disk
(`Vault.process`, which compares inside the atomic callback). There is no
"replace the whole note" fallback. On a mismatch the model adopts the newer
text and the operation is retried once by node identity; if it no longer
applies, the user is told and nothing is written. External changes are
debounced, paused while an inline editor is open, and always consumed before a
new operation runs.

## Layouts

Deterministic layouts are pure functions of the outline (and, for the study
layouts, a remembered arrangement of chapters so that edits do not reshuffle
the map). Node radius is a single function used by layout, physics, rendering,
picking and camera. Spacing is the visible gap between sphere surfaces, so it
stays correct when nodes are resized. Long chains fold, wide sibling lists wrap
into rows, and a bounded grid-accelerated separation pass removes overlaps.
Transitions take longer for longer moves and run one bounded separation pass
per frame, fading the correction out so they end exactly on the target.
User-placed nodes are anchors that layouts respect.

## Physics

The force layout runs in a worker (Rust/WASM; the same core in JavaScript on
the main thread if the worker or WASM cannot start). The protocol carries a
generation number: messages from an older graph are dropped and their buffers
returned. Only one frame is outstanding at a time (the worker waits until the
main thread returns the buffer), simulation steps are time-based, and the main
thread interpolates between frames so motion is smooth at any refresh rate.
Collision handling is bounded per node and step (hash grid with exact-cell
filtering, a coarse grid for large nodes); the run ends as *settled* (low
energy for several steps) or *cooled* (annealing temperature exhausted), and
diagnostics report both.

## Rendering

All spheres are drawn in at most two instanced draw calls (solid and faded),
hierarchy edges in one, association and link curves in one plus arrowheads.
Emphasis is a per-instance attribute read by the material (emission and a rim
for the selection): no extra geometry, sprites or post-processing. Positions
are uploaded only when they change, styles only when they change, and a frame
is drawn only when something moved: an idle map costs nothing, and the loop
stops while the view is hidden. Labels are a fixed pool of DOM elements ranked
by importance; each is tried above, below, right and left of its node before
it is hidden, and important ones always show. The camera's near and far planes
follow the scene, and the camera is kept clear of sphere surfaces.

## Camera

The rig stores a pivot, an orientation quaternion and an offset in camera
space. User input changes a goal state; the rendered state approaches it with
exponential damping `1 − e^(−dt/τ)`, which is frame-rate independent; flights
interpolate with slerp and logarithmic distance. Changing the pivot (orbit
around the selection or the map centre) recomputes the offset so the camera
does not move; following a moving node translates the whole rig rigidly. Pan
speed comes from the projection at the pivot depth, so content under the
pointer follows it. Framing is closed-form for the current orientation, field
of view, aspect ratio and the area not covered by panels.

## Interface

The toolbar groups commands by task; menus follow the WAI-ARIA menu pattern
(roving focus, type-ahead, Escape returns focus, outside click closes). Panels
sit beside the map, or over it in narrow panes, in which case the camera's
view offset keeps the framed content in the visible area. All text comes from
`src/i18n/en.ts`; code compares keys, never display text.

## Build

`scripts/build.mjs` compiles the Rust crate with wasm-pack, generates the
glue and an embedded copy of the `.wasm` (with a digest of the Rust sources),
bundles the worker as a string, inlines the KaTeX stylesheet and fonts, and
bundles the plugin with esbuild. The result is three files:
`main.js`, `manifest.json`, `styles.css`. Full licence texts of everything
bundled are appended to `main.js`.
