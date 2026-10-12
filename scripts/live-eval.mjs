// Run a JavaScript snippet inside a running Obsidian through Obsidian's
// command-line interface (optional helper for checks in a real vault).
//
//   node scripts/live-eval.mjs <vault name or path> [script file]
//
// No machine paths are built in: the vault is always given explicitly, and the
// Obsidian CLI is taken from $OBSIDIAN_CLI or from PATH (`obsidian`). The
// snippet runs with full access to that vault: only run code you have read.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const vault = process.argv[2];
if (!vault) throw Error('Usage: node scripts/live-eval.mjs <vault> [script file]');
const scriptPath = process.argv[3];
const script = scriptPath ? fs.readFileSync(scriptPath, 'utf8') : 'console.log(app.plugins.plugins["obsidian-3d-mindmap"]?.manifest.version ?? "not loaded")';
const cli = process.env.OBSIDIAN_CLI || 'obsidian';
const result = spawnSync(cli, ['eval', `code=${script}`, `vault=${vault}`], { encoding: 'utf8', timeout: 60000, windowsHide: true });
if (result.error) throw new Error(`Could not start the Obsidian CLI ("${cli}"). Set OBSIDIAN_CLI to its full path or put "obsidian" on PATH.`);
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
process.exit(result.status ?? 0);
