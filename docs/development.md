# Development

Users of the plugin need none of this; it is for building and testing.

## Requirements

| Tool | Version | Used for |
| --- | --- | --- |
| Node.js | 20.19 or later (developed with 22.20) | Build scripts, TypeScript, tests |
| npm | 10 or later | Dependencies (`npm ci`) |
| Rust | stable, 1.85 or later (edition 2024; developed with 1.94) with the `wasm32-unknown-unknown` target | The physics engine |
| wasm-pack | 0.15 (installed by `npm ci`) | WebAssembly bindings |
| A Chromium-based browser (Edge or Chrome) | current | Optional: UI smoke test and benchmarks |

On Windows, Rust needs the MSVC build tools. Rust is only required when the
Rust sources change: the generated WebAssembly is kept in
`src/physics/generated/`, and `npm run build:js` reuses it (the build warns if
it was made from different Rust sources).

Tool discovery is portable: wasm-pack comes from `$WASM_PACK`, `PATH` or
`node_modules`; cargo from `PATH` or `~/.cargo/bin`. No paths of a particular
machine are used.

## Commands

```bash
npm ci                 # install exact dependency versions
npm run build          # Rust -> WASM -> plugin, into dist/obsidian-3d-mindmap/
npm run build:js       # same, reusing the committed WASM (no Rust needed)
npm run typecheck      # TypeScript, strict
npm test               # unit and integration tests (node:test)
npm run test:rust      # Rust engine tests
npm run test:ui        # interactive UI test in a headless browser (needs a build)
node scripts/obsidian-check.mjs --vault <test vault>   # end-to-end check in a real Obsidian (see docs/validation.md)
npm run check:strings  # English-only check of sources, docs and the built bundle
npm run bench -- --build dist --counts 300,1200,3000
npm run package        # release and source archives with audit, into release/
```

`npm test` bundles each `tests/**/*.test.ts` with esbuild and runs it with
Node's test runner; Obsidian APIs are replaced by `tests/support/obsidian-node-stub.ts`.

`npm run test:ui` and `npm run bench` load the built plugin into
`tests/harness/` — a page with a stand-in for the Obsidian API
(`obsidian-shim.js`) and generated notes — through playwright-core and an
installed Edge (set `BENCH_BROWSER=chrome` or `BENCH_EXECUTABLE=<path>` to use
another browser). Nothing is downloaded and no vault is touched. For manual
work, `node scripts/dev-server.mjs` serves the harness at
`http://127.0.0.1:5179/tests/harness/index.html?fixture=balanced&count=1200&theme=light&layout=tree`.

## Versioning

The version lives in `package.json`; `npm version <x.y.z>` runs
`scripts/sync-version.mjs`, which updates `manifest.json` and adds the new
entry to `versions.json` while keeping its history. The build refuses to run
if the three disagree or if the manifest contains non-English text.

## Packaging and installing

`npm run package` collects files from an explicit allowlist and writes
`release/obsidian-3d-mindmap-<version>.zip` (the plugin folder),
`release/obsidian-3d-mindmap-<version>-source.zip` and `SHA256SUMS.txt`. Both
archives are read back and audited: no `node_modules`, `target`, `_tmp`,
`dist`, `.git`, source maps, `data.json`, `.obsidian`, machine-specific paths,
user names or credentials. Any finding stops the script.

To try a build in a vault of your own:

```bash
node scripts/install-to-vault.mjs --vault <path-to-vault>          # dry run
node scripts/install-to-vault.mjs --vault <path-to-vault> --yes    # install
node scripts/install-to-vault.mjs --vault <path-to-vault> --rollback --yes
```

It writes only to `<vault>/.obsidian/plugins/obsidian-3d-mindmap/`, refuses if
that folder belongs to another plugin, never touches `data.json`, backs up the
previous files and verifies the copies.

## Licences

`scripts/rust-licenses.mjs` regenerates `licenses/rust-crates.txt` from
`Cargo.lock` and the local Cargo registry after Rust dependency changes. The
build appends all licence texts to `main.js`.
