# Browser harness

Offline benchmark and interaction harness. It loads a built `main.js` into a
plain Chromium page with a small stand-in for the Obsidian API
(`obsidian-shim.js`) and synthetic Markdown fixtures, so that baseline and
upgraded builds can be measured under identical conditions.

The harness is a development tool only. It is never part of the release
package and does not touch any real vault. Notes live in memory only.
