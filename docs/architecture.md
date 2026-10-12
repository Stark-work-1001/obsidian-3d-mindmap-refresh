# Implementation and provenance

## Scope

对 `obsidian-3d-mindmap` 的功能扩展，不修改已安装的其它 3D 插件。
原始 TypeScript 源码不可得，因此从已安装的 JavaScript 构建产物恢复可读源码。

## Pipeline

```text
Markdown → original parser/tree/editor → visible nodes and links
  ├─ knowledge layouts / weighted radial / compact tree → learning-layouts.js
  ├─ remaining deterministic layouts → original silhouettes + local separation
  └─ force layout → RustLayout → Worker → WASM SIMD physics
positions → original scene records → InstancedMesh + emissive selected spheres
notes → Obsidian MarkdownRenderer → formulas and internal links
```

`src/recovered.js` is a formatted recovery of the installed bundle, including Three.js/d3/KaTeX. Original class symbols are preserved: `io` layout, `qc` scene, `es` renderer, `Nc` labels, `th` toolbar, `lo` view, `rh` plugin. New code receives these through an explicit adapter in `scripts/build.mjs`. The recovered source is not original TypeScript and does not regain its lost type names.

## Reference route

Input: the upstream 2.8.1 distribution. Upstream author: Aryan Gupta, MIT. Rust crate, lockfile, workspace optimization and SIMD config were copied with attribution. The worker/bridge and node batching were adapted to the existing mind-map model instead of importing the reference plugin's vault graph UI or data model. Upstream instanced rendering guided batching; its renderer is not copied wholesale.

## Adaptations

- Stride-four Float32 coordinates match glam Vec3A alignment.
- Worker has one outstanding step request, a recycled transferable buffer, initialization timeout, and generation checks on reheats.
- Fixed/dragged nodes remain fixed inside Rust as well as in the UI.
- Spatial hash handles radius separation; each node considers at most 96 nearby candidates per tick to bound dense collision work.
- A shell force maintains depth cues. These are layout forces, not physical simulation units.
- Octree subdivision stops at a 0.001 cell to handle coincident coordinates.
- Force simulation stops on convergence or after 600 ticks, and reheats on interaction.
- Ordinary spheres share a low-detail geometry batch. Emphasis uses the existing emissive mesh material. Mesh records remain available for picking, existing editing and geometry diagnostics.
- Thousands of nodes do not imply thousands of DOM labels. Candidate labels prioritize pinned/selected nodes, with a large-graph cap of 220; adaptive frame budget starts at 180.
- Large graphs cap render pixel ratio at 1.25; PNG uses the rendered canvas resolution.
- No halo sprites, selection shell or full-screen bloom are displayed.

## Knowledge learning layouts (1.17.0)

`learning-layouts.js` uses an iterative traversal of the existing visible hierarchy. Knowledge constellation partitions first-level chapters into separated spatial groups; bookshelf places chapters on pages with Markdown-order node grids; journey arranges chapter pages in a serpentine spatial order. Geometry does not create semantic or prerequisite links.

The hierarchy tree packs leaves into compact chapter footprints and places parents over descendant centroids. Weighted radial allocates subtree sectors and expands crowded rings. All deterministic layouts get up to five local separation passes, bounded neighborhood work and anchor preservation. Corrections improve overlap but do not guarantee perfect separation for every extreme radius or malformed graph.

The reading path is a separate instanced overlay of actual ancestor edges, not a new stored relationship. Chapter/topic/ancestor labels get priority; far-distance label hiding is relaxed only for learning/hierarchy views. Recommended camera angles remain freely adjustable. One new saved boolean, `learningPath`, defaults to true.

## Runtime boundaries

Rust failure produces a notice and console error before falling back to the existing d3 engine. Other layouts are deterministic geometry functions. This release retains existing bundled dependencies to preserve editing and formula compatibility; recovering separate upstream dependency modules is future maintenance work.

No app security setting is changed, no third-party plugin is overwritten, and no vault content is uploaded. Performance numbers are specific to the machine, fixture, viewport and settings used to measure them; see `validation.md`.
