# Validation

This document records how 2.0.0 was checked, what was measured, and what has
not been checked. Every number below comes from the scripts in `scripts/` and
can be reproduced (see the last section).

## Environment

| | |
| --- | --- |
| Machine | Intel Core i9-12900H (20 threads), 64 GB, NVIDIA GeForce RTX 3070 Ti Laptop GPU (Direct3D 11 via ANGLE), Windows 11 (10.0.26200) |
| Browser | Microsoft Edge (Chromium), headless, driven by playwright-core; viewport 1280×720 at device pixel ratio 1.5 |
| Tooling | Node.js 22.20.0, TypeScript 5.9.3, esbuild 0.25.12, Rust 1.94.0, wasm-pack 0.15.0 |
| Plugin under test | The built `dist/obsidian-3d-mindmap/main.js`, loaded into `tests/harness/` with a stand-in for the Obsidian API and generated notes |
| Baseline | The 1.17.0 release build, loaded into the same harness with the same notes and settings |

The plugin was also checked inside **Obsidian 1.14.4** (desktop, Windows), in
a throwaway test vault, including an upgrade from real 1.17.0 data (see
[In Obsidian](#in-obsidian)). **Not covered:** mobile devices, macOS and Linux.

## In Obsidian

`scripts/obsidian-check.mjs` starts Obsidian with a local DevTools port, drives
the installed plugin with real mouse and keyboard input and closes it again.
It only runs on a vault containing a `.3dmm-test-vault` marker file and
restores the notes it edits.

**Upgrade path.** The test vault first ran the 1.17.0 release: it opened a
note as a map and, through 1.17's own API, saved an association, a key
concept, a 2.5× node size with a global node size of 1.5, and its camera pose.
The vault was then upgraded with `scripts/install-to-vault.mjs` (1.17 files
backed up, `data.json` untouched) and the 1.x `vendor/` folder deleted.

**Result: 37 of 37 checks passed** with no errors in Obsidian's console:

- 2.0.0 loads; `data.json` migrates from schema 1 to 2, an English notice is shown and `data.backup-v1.json` is byte-identical to the 1.17 file; the size override becomes the multiplier 2.5 / 1.5; the association, key concept, camera pose and settings are kept and appear in the map;
- the map opens from the command with WebGL; the force layout runs on the WebAssembly worker; formulas render with the bundled KaTeX fonts (no `vendor/` folder);
- all 19 toolbar controls are visible in a 718 px pane with no horizontal overflow; in a 209 px pane the toolbar wraps, nothing is clipped and the inspector stays out of the way;
- clicking selects (also where another node's label overlaps the sphere), hovering shows the rendered note, double-click enters a branch, Escape leaves it, Alt+← returns;
- after typing in the editor, one click on the map is enough for its shortcuts; F2 renames the node, not the file; Ctrl+P (Obsidian's own hotkey) still works while the map has focus;
- with the note open in an editor: Tab and Enter add a child through the editor, Ctrl+Z restores the note exactly; text typed in the editor and a rename made in the map immediately afterwards both survive; replacing the editor content updates the map;
- with no editor open: the map writes the file atomically, and a change made on disk appears in the map;
- clicking a heading in Obsidian's Outline pane shows it in the map;
- switching Obsidian to the light theme re-colours labels and background;
- 251 plugin strings (toolbar, menus, inspector, settings, commands, notices) are English;
- PNG export writes next to the note; moving and renaming the note keeps its map data and updates the title;
- a settled 3,000-node map draws no frames while idle; orbiting it runs at the display rate with render CPU time well under a frame;
- disabling the plugin removes its views, menus and styles; enabling it again works.

**Found only in Obsidian, and fixed** before the release (all now covered by
the checks above or by unit tests):

- Formulas did not render: the hardened KaTeX options used an object without
  a prototype for `macros`, which KaTeX cannot read. Unit tests now render formulas.
- F2 opened Obsidian's "Rename file" instead of renaming the node, because
  Obsidian's global hotkeys ran first. Map shortcuts now live in the view's
  own key scope, which Obsidian consults first; unused keys fall through.
- The first key press after switching to the map from another pane was lost:
  Obsidian blurs a view when it activates its leaf. The map now takes focus
  when its leaf is activated.
- In narrow panes the toolbar pushed the view wider than its pane (horizontal
  scrollbar, clipped map) and menu labels only collapsed by window width. The
  pane is now a CSS size container: labels collapse by pane width and the
  toolbar wraps.
- In narrow panes the inspector (open by default) covered most of the map; it
  now only appears there when opened explicitly or while editing a note.
- Camera positions migrated from 1.17 pointed at the wrong place because 2.0
  lays nodes out differently; 1.x poses are no longer restored, and a restored
  2.0 pose is replaced when the settled map would be off-screen or tiny.

## Automated tests

| Suite | Command | Result | Covers |
| --- | --- | --- | --- |
| Unit and integration (TypeScript) | `npm test` | 123 passed | Outline parsing and model operations compared with the 1.15 implementation; node identity across edits; path tracking for renames and moves; data migration from 1.x and malformed data; conflict-safe writing (stale text, external edits, rebase, failures); physics in JavaScript and WebAssembly (convergence, bounded collisions, coincident nodes, fixed nodes); worker protocol (stale generations, one outstanding frame, buffer return, fallback); all 22 deterministic layouts (finite, deterministic, anchors kept, time bounds) on balanced, 500-deep, 3,000-wide, uneven and mixed-radius outlines; transitions; camera (frame-rate independent damping, pivot changes, follow, pan/zoom invariants, fitting with insets, clipping, trackball recovery); emphasis rules; keyboard map; wheel normalisation; pose storage; menus; inspector provenance; node-layer batching; packaging audit and archive writer |
| Rust engine | `npm run test:rust` | 11 passed | Settling, cooling, bounded collision work, large-node grid, coincident positions, fixed nodes, sanitising |
| Interactive UI (real browser, light and dark) | `npm run test:ui` | 74 passed (37 per theme) | See below |
| End to end in Obsidian 1.14.4 | `node scripts/obsidian-check.mjs` | 37 passed | See [In Obsidian](#in-obsidian) |
| English-only text | `npm run check:strings` | passed | Sources, styles, docs and the built bundle contain no non-English text except allowlisted data formats; 495 interface strings well formed |
| Build reproducibility | `npm run build` | identical | Rebuilding the WebAssembly from the Rust sources produced a byte-identical module (SHA-256 `ebd7fef4…`) |
| Packaging audit | `npm run package` | passed | Release (5 files) and source (155 files) archives contain only allowlisted files; no build output, plugin data, vault files, machine paths, user names or credentials |

### Interactive UI test

Run with real mouse and keyboard input against the built plugin, in both
themes, on a note with formulas, links, duplicates and nesting:

- formulas in node text render with KaTeX;
- all seven toolbar menus open with the mouse, close with Escape and return focus; keyboard opening and roving focus work;
- clicking a sphere selects it and the inspector shows it; double-click enters the branch (breadcrumb shows it, the rest fades); Escape leaves; Alt+← returns;
- Tab, typing and Enter create a child and a chained sibling in the note text; Ctrl+Z restores the note byte for byte; Ctrl+Y redoes; F2 renames and undo restores;
- rotating and zooming leave the note unchanged;
- switching the rotation centre moves the camera by less than 1e-13 units; with "Selected node", the selected node stayed within 1e-12 px on screen while it moved 219 units through the scene;
- Connect mode creates an association (stored in plugin data, note unchanged); Arrange mode pins a dragged node;
- search finds the matching nodes and counts them; edits made outside the map appear in it;
- the settings tab renders; diagnostics contain no note text or file names; PNG export writes next to the note;
- 409 distinct visible strings (toolbar, menus, inspector, search, settings, commands, notices, dialogs) are English with no unfilled placeholders; no page errors.

Screenshots of each step are written to `_tmp/ui-smoke/`.

## Performance

**Method.** `scripts/bench.mjs` loads each build with the same generated note
(a balanced outline of 300, 1,200 or 3,000 nodes with chapters, topics and
items) in the force layout, and records for 5 seconds: the interval between
displayed frames, the main-thread time spent in animation-frame callbacks
(rendering, labels, camera, layout animation), frames actually drawn, the
worker's time per simulation step, draw calls and heap. Each scenario ran 3
times, interleaved between the two builds, on the final release build;
medians are shown. The headless
browser presents frames at about 240 Hz, so "frames drawn per second" can
exceed 60 and frame intervals are short.

**How to read it.** Main-thread work per frame is the stable measure of cost.
Frame-interval tails (p95/p99) in headless mode vary strongly from run to run
and with the machine's state, for both builds: in a control experiment, 2.0
with labels turned off did only 0.4 ms of work per frame and still showed
p95 intervals of 46–58 ms, and 1.17's p95 at 3,000 nodes moved from 17 ms to
63 ms between two sessions. Treat the interval columns as indicative only.
**Idle (settled map)**

| Nodes | Frame interval p50 / p95 / p99 (ms) 1.17 → 2.0 | Main-thread work per frame p50 / p95 (ms) 1.17 → 2.0 | Main-thread work per second (ms) 1.17 → 2.0 | Frames drawn per second 1.17 → 2.0 | Worker step p50 (ms) 1.17 → 2.0 |
| ---: | --- | --- | --- | --- | --- |
| 300 | 4.2 / 4.3 / 4.4 → 4.2 / 4.3 / 4.4 | 0.6 / 1.1 → 0.0 / 0.0 | 136 → 0 | 240 → 0 | 0.7 → – |
| 1200 | 4.2 / 4.3 / 4.3 → 4.2 / 4.3 / 4.3 | 1.0 / 1.6 → 0.0 / 0.0 | 230 → 0 | 240 → 0 | 3.0 → – |
| 3000 | 4.2 / 4.3 / 4.3 → 4.2 / 4.3 / 4.4 | 1.9 / 2.6 → 0.0 / 0.0 | 428 → 0 | 240 → 0 | 8.1 → – |

**Force simulation running**

| Nodes | Frame interval p50 / p95 / p99 (ms) 1.17 → 2.0 | Main-thread work per frame p50 / p95 (ms) 1.17 → 2.0 | Main-thread work per second (ms) 1.17 → 2.0 | Frames drawn per second 1.17 → 2.0 | Worker step p50 (ms) 1.17 → 2.0 |
| ---: | --- | --- | --- | --- | --- |
| 300 | 4.2 / 8.3 / 8.4 → 4.2 / 4.3 / 4.4 | 0.8 / 1.9 → 0.0 / 1.2 | 181 → 93 | 226 → 120 | 0.6 → 0.3 |
| 1200 | 4.2 / 8.3 / 8.4 → 4.2 / 4.3 / 4.5 | 1.2 / 2.4 → 0.8 / 1.9 | 269 → 171 | 224 → 130 | 3.0 → 1.8 |
| 3000 | 4.2 / 8.4 / 12.5 → 4.2 / 4.3 / 8.4 | 2.2 / 3.7 → 1.5 / 2.6 | 463 → 312 | 215 → 179 | 9.2 → 5.8 |

**Camera orbiting**

| Nodes | Frame interval p50 / p95 / p99 (ms) 1.17 → 2.0 | Main-thread work per frame p50 / p95 (ms) 1.17 → 2.0 | Main-thread work per second (ms) 1.17 → 2.0 | Frames drawn per second 1.17 → 2.0 | Worker step p50 (ms) 1.17 → 2.0 |
| ---: | --- | --- | --- | --- | --- |
| 300 | 4.2 / 4.3 / 8.3 → 4.2 / 4.3 / 4.3 | 1.1 / 1.8 → 1.0 / 1.5 | 247 → 256 | 236 → 240 | 0.8 → – |
| 1200 | 4.2 / 4.3 / 8.2 → 4.2 / 4.3 / 4.3 | 1.4 / 2.1 → 1.4 / 2.0 | 309 → 358 | 237 → 238 | 3.0 → – |
| 3000 | 4.2 / 8.4 / 8.5 → 4.2 / 4.3 / 4.3 | 2.4 / 3.2 → 1.3 / 1.8 | 422 → 314 | 195 → 239 | 8.3 → – |

**Switching layout every 1.2 s**

| Nodes | Frame interval p50 / p95 / p99 (ms) 1.17 → 2.0 | Main-thread work per frame p50 / p95 (ms) 1.17 → 2.0 | Main-thread work per second (ms) 1.17 → 2.0 | Frames drawn per second 1.17 → 2.0 | Worker step p50 (ms) 1.17 → 2.0 |
| ---: | --- | --- | --- | --- | --- |
| 300 | 4.2 / 4.3 / 8.3 → 4.2 / 4.3 / 4.4 | 0.9 / 2.2 → 0.5 / 1.3 | 222 → 128 | 236 → 156 | – → – |
| 1200 | 4.2 / 4.3 / 8.4 → 4.2 / 4.3 / 4.6 | 1.4 / 2.4 → 0.7 / 1.9 | 311 → 163 | 230 → 154 | – → – |
| 3000 | 4.2 / 8.3 / 8.5 → 4.2 / 4.3 / 4.6 | 2.4 / 3.7 → 1.1 / 2.4 | 457 → 222 | 204 → 150 | – → – |

**Renaming a node every 0.4 s**

| Nodes | Frame interval p50 / p95 / p99 (ms) 1.17 → 2.0 | Main-thread work per frame p50 / p95 (ms) 1.17 → 2.0 | Main-thread work per second (ms) 1.17 → 2.0 | Frames drawn per second 1.17 → 2.0 | Worker step p50 (ms) 1.17 → 2.0 |
| ---: | --- | --- | --- | --- | --- |
| 300 | 4.2 / 4.3 / 20.8 → 4.2 / 4.3 / 4.4 | 0.7 / 1.2 → 0.0 / 0.0 | 146 → 2 | 228 → 3 | 0.0 → – |
| 1200 | 4.2 / 4.3 / 33.4 → 4.2 / 4.3 / 8.2 | 1.1 / 1.7 → 0.0 / 0.0 | 219 → 2 | 218 → 3 | 0.0 → – |
| 3000 | 4.2 / 4.3 / 66.8 → 4.2 / 4.3 / 20.7 | 2.1 / 3.0 → 0.0 / 0.0 | 381 → 3 | 196 → 3 | 0.0 → – |

**Per-edit latency** (rename one node: compute the edit, write the note,
re-parse with identity matching, rebuild the map), 39 edits per size:

| Nodes | 1.17 p50 / p95 / max (ms) | 2.0 p50 / p95 / max (ms) |
| ---: | --- | --- |
| 300 | 23.2 / 30.3 / 35.0 | 2.9 / 6.1 / 6.7 |
| 1,200 | 37.2 / 47.5 / 51.1 | 9.5 / 15.1 / 15.1 |
| 3,000 | 69.8 / 86.9 / 103.5 | 21.5 / 31.7 / 32.5 |

**Many emphasised nodes** (a key-concept rule matching 2,297 of 3,000 nodes,
camera orbiting, 2 runs): 1.17 issued 2,298 draw calls per frame with 6.5 ms of
main-thread work per frame (p95 8.3); 2.0 issued 2 draw calls with 1.9 ms
(p95 2.6). At 1,200 nodes (894 marked): 896 → 2 draw calls, 3.8 → 1.5 ms.

**Animated background** (subtle gradient animation, map otherwise idle;
2.0 only): 14 frames per second, at most 0.2 ms of work per frame (p95), about
3 ms per second at 1,200–3,000 nodes. It stops while the view is hidden and
when reduced motion is on.

**Memory and DOM** (3,000 nodes): JavaScript heap 18 MB (1.17: 43 MB);
425 elements in the view including 160 pooled label elements (1.17: 399).
Draw calls for a normal frame: 2 for both builds (spheres, edges); 2.0 adds
one for association curves, one for arrowheads and one for a gradient
background when present.

**Inside Obsidian** (3,000-node note, Obsidian 1.14.4, same machine): the
settled map drew no frames in 3 s; while orbiting, frames were presented at the
display rate (240 Hz on this laptop) with 0.5 ms (p50) / 0.7 ms (p95) of render
CPU time per frame; the force layout ran on the WebAssembly worker (6.5 ms per
step) and settled after 3.4 s.

**Target of ~60 fps at 3,000 nodes:** the heaviest 2.0 frame types at 3,000
nodes cost 1.1–1.5 ms of main-thread work at the median and at most 2.6 ms at
p95, a small fraction of a 16.7 ms frame; the force simulation runs in the
worker (5.8 ms per step, interpolated on the main thread). This has not been
measured on slower hardware.

## Layouts

`scripts/layout-sweep.mjs` switched through all 23 layouts on five outline
shapes in the browser (3,000 nodes each, except the 11-node malformed note) and
counted sphere pairs that still intersect once the layout came to rest (115
runs, no page errors):

| Layout | Balanced | 500-deep chains | 3,000 siblings | Uneven | Malformed | Slowest run (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Knowledge map | 0 | 0 | 0 | 0 | 0 | 30 |
| Bookshelf | 0 | 0 | 0 | 0 | 0 | 15 |
| Learning journey | 0 | 0 | 0 | 0 | 0 | 23 |
| Tree | 0 | 0 | 0 | 0 | 0 | 17 |
| Radial | 0 | 0 | 0 | 0 | 0 | 25 |
| Cone tree | 0 | 0 | 0 | 0 | 0 | 20 |
| Force-directed | 0 | 0 | 0 | 0 | 0 | rest after 5–7.5 s |
| Shell, Terraces, Curtain, Grid, Scatter | 0 | 0 | 0 | 0 | 0 | ≤ 42 |
| Bond angles, Shells by level, Coil, Dandelion, Nebula | 0 | 0 | 1,036–20,893 | 13–399 | 0 | ≤ 567 (Coil) |
| Feather, Orbitals, Lattice, Galaxy disc, Rays, Hubs | 13–6,192 | 0–4,113 | 5,068–136,809 | 504–19,070 | 0 | ≤ 90 |

The seven main layouts leave no intersecting spheres on any of these outlines
(the uneven-outline case for Radial was found by this sweep and fixed; it is
now part of the unit tests). Compared with 1.17 on the same outlines (unit
test report), Tree on 500-deep chains went from 31,872 intersecting pairs to
0, and Radial on 3,000 nodes shrank from 19,459 to 2,420 units across.

Several experimental shapes still overlap heavily on dense or flat outlines:
their geometry is ported unchanged from 1.x (made iterative so deep outlines
cannot overflow the stack) and the general separation pass is bounded, so it
cannot resolve thousands of nodes forced onto a few rings or lattice sites.
They are listed separately in the Layout menu as decorative.

## Known limitations

- Checked in Obsidian 1.14.4 on Windows only; not on mobile, macOS or Linux.
- Frame-interval tails were not measured with a real display at 60 Hz.
- With very large flat lists the overview shows few labels; labels appear as
  you move closer.
- Experimental shapes overlap on dense outlines (see Layouts).
- Bundled KaTeX is 0.16.47. Advisory GHSA-238p-pmpm-9mq7 (low severity;
  fixed in 0.18.2) only applies when another script has already altered
  `Object.prototype`; the plugin passes every KaTeX option explicitly, so the
  inherited `trust` value the advisory describes is never read, and formulas
  come only from your own notes. Upgrading to 0.18.x needs a visual review of
  formula rendering and is planned separately.

## Checking in your own Obsidian

1. Use a copy of a vault, install with
   `node scripts/install-to-vault.mjs --vault <copy> --yes` and enable the plugin.
2. Open a note you know well; check headings, lists, tasks, notes (quote
   blocks), formulas and links in light and dark themes.
3. *More → Diagnostics* shows the physics backend (`wasm` expected) and frame
   timings for your machine.

For the automated in-app check, create an empty vault, add an empty file named
`.3dmm-test-vault`, install the plugin, open the vault once in Obsidian
(trusting it), close Obsidian and run
`node scripts/obsidian-check.mjs --vault <that vault>`.

## Reproducing

```bash
npm ci
npm run build                 # or npm run build:js without Rust
npm test && npm run test:rust
npm run test:ui
node scripts/obsidian-check.mjs --vault <test vault>   # needs Obsidian, see above
node scripts/layout-sweep.mjs --count 3000
# 1.17 baseline: place its main.js, manifest.json and styles.css in _tmp/baseline/
node scripts/bench.mjs --build baseline,dist --counts 300,1200,3000 --repeat 3 --out _tmp/bench/run.json
node scripts/bench-report.mjs _tmp/bench/run.json
```
