// Audit rules for public archives (see scripts/package.mjs).
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const DENY_PATHS = [
  /(^|\/)(node_modules|target|_tmp|dist|release|\.git|\.obsidian|\.claude|\.vscode|\.idea|pkg)\//,
  /(^|\/)data\.json$/, /\.map$/, /(^|\/)\.env/, /\.(pem|key|p12|pfx|log)$/i, /(^|\/)(Thumbs\.db|\.DS_Store)$/,
];

export function contentRules(user) {
  return [
    { name: 'Windows user path', re: /[A-Za-z]:\\{1,2}Users\\{1,2}[^\\\s"'`]+/ },
    { name: 'macOS/Linux home path', re: /\/(Users|home)\/(?!runner\b)[a-z0-9._-]+\//i },
    { name: 'local working folder', re: /[A-Za-z]:[\\/]+playground/i },
    ...(user && user.length > 1 ? [{ name: 'local user name', re: new RegExp(escape(user)) }] : []),
    { name: 'private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
    { name: 'access token', re: /\b(ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9]{32,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{20,})\b/ },
    { name: 'credential assignment', re: /\b(api[_-]?key|secret|password|passwd|token)\s*[:=]\s*['"][^'"\s]{12,}['"]/i },
  ];
}

const BINARY = /\.(png|woff2?|ttf|wasm|zip|jpg|gif|mp4)$/i;

/** entries: [{ name, data: Buffer }] -> findings (strings); `skipContent` names files whose text is not scanned. */
export function auditEntries(entries, { user = '', skipContent = [] } = {}) {
  const rules = contentRules(user);
  const findings = [];
  for (const { name, data } of entries) {
    for (const re of DENY_PATHS) if (re.test(name)) findings.push(`${name}: path not allowed (${re})`);
    if (BINARY.test(name) || skipContent.some(s => name.endsWith(s))) continue;
    const text = data.toString('utf8');
    for (const rule of rules) {
      const m = rule.re.exec(text);
      if (m) findings.push(`${name}:${text.slice(0, m.index).split('\n').length}: ${rule.name}: ${m[0].slice(0, 60)}`);
    }
  }
  return findings;
}
