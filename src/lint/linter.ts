/**
 * 静态检查执行器。
 *
 * 把「策略配置 + 运行环境约定」喂给规则库，得到可直接放进 CI 的诊断列表。
 * 任何一条 severity=error 都应阻断合并 —— 这类配置缺陷在生产环境的
 * 表现，往往是一次谁都没预料到的雪崩。
 */

import { RULES, type Diagnostic, type LintContextInput, type Severity } from './rules.js';

export interface LintSummary {
  errors: number;
  warns: number;
  infos: number;
  passed: number;
}

export interface LintResult {
  diagnostics: Diagnostic[];
  summary: LintSummary;
  /** 是否通过（无 error 级问题） */
  ok: boolean;
}

const ORDER: Record<Severity, number> = { error: 0, warn: 1, info: 2 };

/** 对策略配置执行全量静态检查。 */
export function lintPolicy(input: LintContextInput): LintResult {
  const diagnostics: Diagnostic[] = [];
  for (const rule of RULES) {
    const found = rule.check(input);
    if (found) diagnostics.push({ id: rule.id, ...found });
  }
  diagnostics.sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || a.id.localeCompare(b.id));
  const summary: LintSummary = { errors: 0, warns: 0, infos: 0, passed: RULES.length - diagnostics.length };
  for (const d of diagnostics) {
    if (d.severity === 'error') summary.errors += 1;
    else if (d.severity === 'warn') summary.warns += 1;
    else summary.infos += 1;
  }
  return { diagnostics, summary, ok: summary.errors === 0 };
}

const SEVERITY_LABEL: Record<Severity, string> = {
  error: '❌ ERROR',
  warn: '⚠️  WARN ',
  info: 'ℹ️  INFO ',
};

const repeatish = (s: string, n: number): string => Array.from({ length: Math.max(0, n) }, () => s).join('');

/** 渲染终端可读的检查报告。 */
export function renderLintReport(result: LintResult, policyName?: string): string {
  const lines: string[] = [];
  lines.push('════════════════════════════════════════════════════════════════');
  lines.push(`  Resilix 策略体检 · ${policyName ?? 'policy'}`);
  lines.push('════════════════════════════════════════════════════════════════');
  if (result.diagnostics.length === 0) {
    lines.push('  ✅ 未发现策略缺陷，配置可上线。');
    lines.push('════════════════════════════════════════════════════════════════');
    return lines.join('\n');
  }
  for (const d of result.diagnostics) {
    lines.push(`  ${SEVERITY_LABEL[d.severity]}  ${d.id}  ${d.title}`);
    lines.push(`            位置: ${d.path}`);
    lines.push(`            风险: ${d.why}`);
    lines.push(`            建议: ${d.fix}`);
    lines.push('');
  }
  lines.push(
    `  统计: ${repeatish('', 0)}${result.summary.errors} error / ${result.summary.warns} warn / ${result.summary.infos} info（共 ${RULES.length} 条规则，通过 ${result.summary.passed} 条）`,
  );
  lines.push('════════════════════════════════════════════════════════════════');
  return lines.join('\n');
}

/** 渲染 Markdown 版体检报告，便于贴到 PR 评论。 */
export function lintToMarkdown(result: LintResult, policyName?: string): string {
  const lines: string[] = [];
  lines.push(`## Resilix 策略体检 — ${policyName ?? 'policy'}`);
  lines.push('');
  if (result.diagnostics.length === 0) {
    lines.push('✅ **未发现策略缺陷**，配置可上线。');
    return lines.join('\n');
  }
  lines.push('| 等级 | 规则 | 问题 | 位置 | 建议 |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const d of result.diagnostics) {
    lines.push(
      `| ${d.severity.toUpperCase()} | ${d.id} | ${d.title} | \`${d.path}\` | ${d.fix} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

export type { Diagnostic, LintContextInput } from './rules.js';
