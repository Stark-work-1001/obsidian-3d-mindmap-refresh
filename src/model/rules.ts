// Text-matching rules used for automatic key concepts (pin rules) and for
// group colouring / hiding. A rule matches node text with one of four modes
// plus optional depth, note and completed-task conditions.
import { walkPreorder } from './tree-utils';
import type { OutlineNode } from './types';

export type RuleMode = 'contains' | 'startsWith' | 'endsWith' | 'regex';
export const RULE_MODES: RuleMode[] = ['contains', 'startsWith', 'endsWith', 'regex'];

export interface MatchRule {
  id: string;
  pattern: string;
  mode: RuleMode;
  depthMax: number | null;
  requireNote: boolean;
  requireTaskDone: boolean;
  enabled: boolean;
}

export interface GroupRule extends MatchRule {
  color: string;
  hide: boolean;
}

const regexCache = new Map<string, RegExp | null>();
export function compileRule(pattern: string): RegExp | null {
  if (regexCache.has(pattern)) return regexCache.get(pattern) ?? null;
  let compiled: RegExp | null = null;
  try { compiled = new RegExp(pattern, 'i'); } catch { compiled = null; }
  if (regexCache.size > 256) regexCache.clear();
  regexCache.set(pattern, compiled);
  return compiled;
}

export function isBrokenRule(rule: MatchRule): boolean {
  return rule.enabled && rule.mode === 'regex' && compileRule(rule.pattern) === null;
}

/** null when not matching; `broken` when the rule is an invalid regex. */
export function matchRule(node: OutlineNode, rule: MatchRule): { rule: MatchRule; broken: boolean } | null {
  if (!rule.enabled) return null;
  if (rule.depthMax !== null && node.depth > rule.depthMax) return null;
  if (rule.requireNote && !node.note) return null;
  if (rule.requireTaskDone && !(node.taskMarker !== null && node.taskMarker.trim() !== '')) return null;
  const text = node.text ?? '';
  let hit = false;
  switch (rule.mode) {
    case 'contains': hit = text.includes(rule.pattern); break;
    case 'startsWith': hit = text.trimStart().startsWith(rule.pattern); break;
    case 'endsWith': hit = text.trimEnd().endsWith(rule.pattern); break;
    case 'regex': {
      const re = compileRule(rule.pattern);
      if (!re) return { rule, broken: true };
      hit = re.test(text);
      break;
    }
  }
  return hit ? { rule, broken: false } : null;
}

export function firstMatch(node: OutlineNode, rules: MatchRule[]): MatchRule | null {
  for (const rule of rules) {
    const hit = matchRule(node, rule);
    if (hit && !hit.broken) return rule;
  }
  return null;
}

export interface RuleScan {
  ids: string[];
  perRule: { rule: MatchRule; count: number; broken: boolean }[];
  broken: MatchRule[];
}

export function scanRules(root: OutlineNode, rules: MatchRule[]): RuleScan {
  if (!rules.length) return { ids: [], perRule: [], broken: [] };
  const counts = new Map(rules.map(r => [r.id, { count: 0, broken: isBrokenRule(r) }]));
  const ids: string[] = [];
  walkPreorder(root, node => {
    const rule = firstMatch(node, rules);
    if (rule) { ids.push(node.id); const c = counts.get(rule.id); if (c) c.count++; }
  });
  return {
    ids,
    perRule: rules.map(rule => ({ rule, count: counts.get(rule.id)?.count ?? 0, broken: counts.get(rule.id)?.broken ?? false })),
    broken: rules.filter(isBrokenRule),
  };
}

export function groupColor(node: OutlineNode, rules: GroupRule[]): string | null {
  for (const rule of rules) {
    if (!rule.enabled || !rule.color) continue;
    const hit = matchRule(node, rule);
    if (hit && !hit.broken) return rule.color;
  }
  return null;
}

/** Ids hidden by "hide" group rules (a match hides its whole subtree). */
export function hiddenByRules(root: OutlineNode, rules: GroupRule[]): Set<string> {
  const hidden = new Set<string>();
  const hiders = rules.filter(r => r.enabled && r.hide);
  if (!hiders.length) return hidden;
  const stack: OutlineNode[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.kind !== 'root' && hiders.some(rule => { const hit = matchRule(node, rule); return !!hit && !hit.broken; })) {
      walkPreorder(node, n => hidden.add(n.id));
      continue;
    }
    for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
  }
  return hidden;
}

export function newRuleId(now = Date.now()): string {
  return `rule-${now.toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}
