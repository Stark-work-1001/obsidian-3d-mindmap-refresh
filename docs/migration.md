# Upgrading from 1.x

2.0 keeps the plugin ID (`obsidian-3d-mindmap`), the view type and every
command ID, so workspaces, hotkeys and the plugin's data carry over. Your notes
are not changed by the upgrade.

## What happens on first start

1. The plugin reads `data.json`. If it cannot be parsed, 2.0 starts with
   defaults **and does not write the file**, so nothing is lost; a notice says
   so.
2. Data written by 1.15–1.17 (no `schemaVersion`) is converted to schema 2.
   Before the converted data is saved, the original is copied to
   `data.backup-v1.json` in the plugin folder (only once).
3. Every value is range-checked; unknown or malformed entries are dropped from
   the known maps only, never from your notes.

## Data changes (schema 1 → 2)

| Stored data | 1.x | 2.0 |
| --- | --- | --- |
| Settings | Flat object | Same keys accepted. New keys get defaults. `linkDistance` (centre to centre) becomes `edgeGap` (visible gap between sphere surfaces); `linkDistance` is still written for older versions. |
| Node sizes | Absolute scale that replaced the global node size | Multiplier of the global node size (`old / nodeScale`), so maps look the same and later global changes scale them consistently. |
| Camera per note | Spherical (radius, azimuth, polar, target) | Position, orientation, pivot and field of view (`v: 6`), plus the spherical fields so 1.x can still read it. 1.x poses are kept but not restored: 2.0 places nodes differently, so each map is framed afresh the first time it opens in 2.0. |
| Collapsed branches | Session ids inside the camera pose | Node paths per note (`collapsed`), stable across restarts and edits. |
| Pinned positions | — | New: per note and per layout (`anchors`). |
| Associations, key concepts | Node paths | Unchanged; paths are updated when you rename or move nodes in the map. |

Node paths are the chain of node texts from the note title, with `#n` added
for duplicate siblings. They are stored identifiers: they are never translated
or rewritten for display.

## Behaviour changes worth knowing

- **Command "Toggle layout"** cycles through the seven main layouts; the 16
  experimental shapes are in *Layout → Experimental shapes*.
- **F2** renames the selected node (in 1.x it focused the branch; use
  Ctrl/Cmd+Enter or double-click for that).
- **Alt+← / Alt+→** navigate history (in 1.x they moved a node; use
  Alt+↑ / Alt+↓).
- **Diagnostics commands** ("bench", "self-test") show a report in a dialog
  instead of writing `_3D-MindMap-*.json` files into the vault.
- **Formula fonts** are bundled in `main.js`; the `vendor/` folder of 1.x is no
  longer used and can be deleted.
- The **note format** option ("quote block" / "comment") is no longer shown:
  it never had an effect; notes are written as quote blocks as before.
- Glow and bloom settings from 1.x are kept in `data.json` but not used:
  emphasis is now done with colour only (*Appearance → Emphasis strength*).

## Rolling back

Your notes do not need any rollback. To go back to 1.17:

- If you installed with `npm run install:vault`, run
  `node scripts/install-to-vault.mjs --vault <path> --rollback --yes`.
- Otherwise copy the 1.17 `main.js`, `manifest.json`, `styles.css` (and its
  `vendor/` folder) back into the plugin folder.
- 1.17 ignores the new keys in `data.json` and still finds the settings and
  the spherical camera fields that 2.0 keeps writing. One difference: 2.0
  stores per-node sizes as multipliers, which 1.17 would read as absolute
  sizes (they look different unless the global node size is 1). To restore the
  exact 1.x data, replace `data.json` with `data.backup-v1.json` while
  Obsidian is closed (changes made with 2.0 since then are lost).
