// Loads the recovered 1.15.0 bundle in Node and exposes its internal
// functions, so new modules can be compared against the original behaviour.
import fs from 'node:fs';
import path from 'node:path';


export interface Reference {
  qp: (text: string, options: Record<string, unknown>) => any;
  ja: new (text: string, basename: string, cap?: number, strip?: boolean) => any;
  tl: (raw: unknown) => any;
  Cn: (node: any) => string;
  Av: (tree: any, links: any[]) => { resolved: any[]; dangling: any[] };
  Rv: (tree: any, pins: any[]) => { ids: string[]; dangling: any[] };
  Ev: (links: any[], a: any, b: any, now?: number) => any;
  cm: (root: any, rules: any[]) => any;
  Cc: (root: any, rules: any[]) => Set<string>;
  Pv: (node: any, rules: any[]) => string | null;
  qa: (text: string) => any[];
  Dc: (depth: number, opts: Record<string, unknown>) => number;
  Bi: Record<string, unknown>;
  Oi: string[];
  [key: string]: any;
}

let cached: Reference | null = null;
export function loadReference(): Reference {
  if (cached) return cached;
  const root = process.env.OM3D_ROOT ?? '.';
  const code = fs.readFileSync(path.join(root, 'reference', 'recovered-1.15.0.js'), 'utf8');
  class Stub {}
  const obsidian = { Plugin: Stub, PluginSettingTab: Stub, ItemView: Stub, FuzzySuggestModal: Stub, Modal: Stub, Notice: Stub, TFile: Stub, Setting: Stub, MarkdownRenderer: {} };
  const mod: { exports: Record<string, unknown> } = { exports: {} };
  const expose = 'qp, ja, el, nl, tl, Cn, Tw, A0, C0, Ac, Ev, Av, Cv, Rv, cm, Cc, Pv, il, qa, Dc, Oc, Bi, Oi, $a, Mi, Qn, Xp, Dp, Ip, Xa';
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', `${code}\n;module.exports.__internals = { ${expose} };`)(
    mod, mod.exports, (name: string) => (name === 'obsidian' ? obsidian : require(name)));
  cached = mod.exports.__internals as Reference;
  return cached;
}
