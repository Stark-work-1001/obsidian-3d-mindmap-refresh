// 在真实 Obsidian 实例里执行一段 JS（可选的验收辅助脚本）。
//
// 用法：node scripts/live-eval.mjs <vault 路径> [脚本路径]
//
// 本脚本不内置任何本机路径：
//   - vault 必须由调用方显式给出；
//   - Obsidian 可执行文件优先取环境变量 OBSIDIAN_CLI，否则从 PATH 查找 `obsidian`。
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const vault = process.argv[2];
if (!vault) throw Error('Usage: node scripts/live-eval.mjs <vault path> [script path]');

const scriptPath = process.argv[3];
const script = scriptPath
  ? fs.readFileSync(scriptPath, 'utf8')
  : 'console.log("obsidian-3d-mindmap loaded")';

const cli = process.env.OBSIDIAN_CLI || 'obsidian';

const result = spawnSync(cli, ['eval', `code=${script}`, `vault=${vault}`],
  { encoding: 'utf8', timeout: 60000, windowsHide: true });

if (result.error) {
  throw new Error(
    `Failed to launch Obsidian CLI as "${cli}". Set OBSIDIAN_CLI to its full path, ` +
    'or make "obsidian" resolvable on PATH.',
  );
}
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
process.exit(result.status ?? 0);