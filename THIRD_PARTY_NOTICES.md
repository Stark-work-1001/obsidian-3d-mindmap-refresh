# Third-party notices

## Included in the release (`main.js`)

The full licence texts below are also appended to `main.js`.

| Component | Version | Licence | Text |
| --- | --- | --- | --- |
| Physics engine, derived from Obsidian 3D Graph by Aryan Gupta | 2.8.1 (modified) | MIT | `licenses/obsidian_3d_graph_MIT.txt` |
| three.js | 0.160.1 | MIT | `licenses/three_MIT.txt` |
| KaTeX (code, stylesheet and fonts) | 0.16.47 | MIT | `licenses/katex_MIT.txt` |
| Rust crates compiled into the WebAssembly module (glam, serde, wasm-bindgen, js-sys and their dependencies) | see `Cargo.lock` | MIT or Apache-2.0 (MIT chosen) | `licenses/rust-crates.txt` |

The physics engine keeps the Barnes–Hut octree and integrator structure of
Obsidian 3D Graph 2.8.1 and adds fixed nodes, collision radii, per-edge rest
lengths, depth shells, bounded collision handling, annealing and diagnostics.

## Repository only

`reference/` holds the 1.15.0 and 1.17.0 builds of this plugin, used by tests
to compare behaviour. They embed three.js, KaTeX and d3-force-3d with its d3
dependencies; those licences are in `licenses/` (`d3_*`, `three_MIT.txt`,
`katex_MIT.txt`). d3-force-3d is not part of 2.0.

Build tools (TypeScript, esbuild, wasm-pack, playwright-core) and their
dependencies are listed in `package-lock.json` and are not distributed.
