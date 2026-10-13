# Changes

## 2.0.0

A rewrite focused on a dependable study experience: a camera that behaves
predictably, layouts that keep their shape while you edit, relationships whose
origin is always clear, and edits that never overwrite newer note text. Plugin
ID, commands and saved data carry over; see docs/migration.md.

### Navigation and camera
- New camera rig: frame-rate-independent smoothing, shortest-path rotation,
  turntable or trackball rotation (with "Level the horizon").
- Rotate around a free point, the selected node (followed while the layout
  moves, without jitter) or the map centre; switching keeps the camera where it is.
- Zoom towards the pointer, never through a sphere; Alt+scroll magnifies
  (field of view) without moving; wheel, trackpad and pinch are normalised.
- Framing accounts for aspect ratio, node sizes, label room and panels;
  near and far planes follow the scene.
- Study flow: overview, enter chapter or branch (the rest fades), focus a
  concept, read its note and relationships; breadcrumbs, Back/Forward
  history (Alt+arrows, mouse buttons) and Escape to step out.

### Layouts
- Layouts grouped by purpose: Study (Knowledge map, Bookshelf, Learning
  journey), Structure (Tree, Radial, Cone tree), Explore (Force-directed) and 16
  Experimental shapes in a separate submenu.
- Spacing is the visible gap between spheres; node sizes, long chains, wide
  sibling lists and uneven branches are handled without overlaps.
- Arrangements are remembered across edits; new nodes grow out of their parent.
- Transitions scale with distance and avoid nodes passing through each other.
- Arrange mode pins nodes per layout.

### Nodes, edges and emphasis
- One effective radius everywhere (layout, physics, rendering, picking,
  camera); per-node sizes are multipliers of the global size.
- Hierarchy, chapter order, associations and links written in the note are
  drawn and listed separately, with arrowheads for direction; curves bend
  around spheres in their way.
- Emphasis uses colour only: selection rim, hover, search hits, key concepts,
  pinned and out-of-focus nodes are distinguishable on light, dark, solid and
  gradient backgrounds. No glow sprites or bloom.
- Labels try four positions before hiding; important labels always show.
- Inspector with note (Markdown and formulas), ancestry, associations,
  outgoing links, backlinks, size, key concept and pinned position.

### Editing and data
- Conflict-safe writing: edits apply only to the note text they were computed
  from; newer text is adopted and the edit re-applied or reported.
- Undo/redo in the map; inline create and rename with IME support; chained
  Enter/Tab entry; confirmation for large deletions.
- Explicit Navigate, Arrange and Connect modes.
- Saved data is keyed by node path and follows renames and moves made in the
  map; camera, selection and layout actions never write to the note.
- Data schema 2 with automatic migration and a backup of the 1.x data.

### Performance
- Rust/WebAssembly force engine in a worker with bounded collision handling,
  annealing, convergence diagnostics, one outstanding frame and interpolation;
  JavaScript fallback with the same behaviour.
- Constant draw calls; positions and styles uploaded only on change; no
  rendering while idle or hidden. See docs/validation.md for measurements.

### Interface
- Task-based toolbar, accessible menus (keyboard, Escape, focus return),
  outline panel, search with match navigation, background editor with an
  optional subtle animation that respects reduced motion and pauses when hidden.
- All interface text is English and comes from one string table.

### Packaging
- Single version source (package.json), versions.json history kept.
- The release is main.js, manifest.json and styles.css; physics, worker and
  formula fonts are bundled, so the plugin works offline however it is installed.
- Release and source archives are built from an allowlist and audited for
  private data, machine paths and credentials.
## 1.17.0

- Add knowledge constellation, chapter bookshelf and learning journey layouts; total 23.
- Rework radial layout with subtree-weighted sectors and hierarchy tree with compact leaf grids and ancestor centroids.
- Apply bounded spatial overlap correction to deterministic layouts and retain a 320 ms transition.
- Prioritize chapter/topic/ancestor labels and increase readability on custom backgrounds.
- Highlight real parent-child ancestry with an instanced edge overlay; add branch focus and recommended reading camera controls.
- Preserve individual node-radius overrides when changing global radius, and refresh geometry/collision spacing.
- Adapt the camera far plane and zoom range to large layout bounds.
- Make note panels opaque and readable under arbitrary graph backgrounds.
- Verify twelve tests, and smoke-test all 23 layouts with 3000 nodes.

## 1.16.0

- Recover readable JavaScript sources from the installed 1.15.0 build, retaining existing mind-map semantics and editing.
- Integrate and adapt the upstream 2.8.1 Rust physics engine; add fixed-node, radius-collision and hierarchy constraints and coincident-position safety.
- Use a WASM Web Worker with transferable recycled buffers, generation checks and explicit error fallback.
- Batch ordinary sphere rendering and allocate labels on demand; adapt pixel ratio for large graphs.
- Replace light halos and bloom with sphere emissive materials.
- Regroup controls, make layout descriptions wrap independently, add keyboard menu navigation and continuous spacing/brightness controls.
- Add an in-view single-color/two-color background editor.
- Fix note-preview source paths and aliased wiki-link targets.
- Shorten the community-plugin description; retain plugin ID, settings and other installed plugins.
