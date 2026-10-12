# Changes

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
