/**
 * 报告渲染。
 *
 * 三种输出形态覆盖三类场景：
 * - 终端表格 + ASCII 直方图：人看的；
 * - Markdown：贴 PR / issue / 复盘文档的；
 * - JSON / CSV：喂给流水线与看板的。
 */

import type { SimulationResult } from './engine.js';
import type { Metrics } from './metrics.js';

/** 终端显示宽度：CJK 字符按 2 宽处理。 */
export function displayWidth(str: string): number {
  let w = 0;
  for (const ch of str) {
    const code = ch.codePointAt(0) ?? 0;
    w += code > 0x2e80 ? 2 : 1;
  }
  return w;
}

const pad = (s: string, width: number): string => {
  const widthOf = (out: string): number => displayWidth(out);
  let cur = widthOf(s);
  let out = s;
  while (cur > width && out.length > 1) {
    out = out.slice(0, -1);
    cur = widthOf(out);
  }
  return out + ' '.repeat(Math.max(0, width - cur));
};

const pct = (v: number): string => `${(v * 100).toFixed(2)}%`;

/** 渲染延迟直方图。 */
export function renderHistogram(result: SimulationResult, width = 34): string[] {
  const buckets = result.metrics.histogram.filter((b) => b.count > 0);
  if (buckets.length === 0) return ['  (无样本)'];
  const max = Math.max(...buckets.map((b) => b.count));
  const lines: string[] = [];
  for (const b of buckets) {
    const len = Math.max(1, Math.round((b.count / max) * width));
    const label = Number.isFinite(b.upperMs) ? `<${b.upperMs}ms` : '>6400ms';
    lines.push(`  ${pad(label, 10)} ${'█'.repeat(len)} ${b.count}`);
  }
  return lines;
}

/** 渲染单次模拟的完整文本报告。 */
export function renderSimReport(result: SimulationResult): string {
  const m = result.metrics;
  const lines: string[] = [];
  lines.push('════════════════════════════════════════════════════════════════');
  lines.push(`  Resilix 模拟报告 · 策略: ${result.policyName} · 场景: ${result.fault.name ?? 'fault'}`);
  lines.push('════════════════════════════════════════════════════════════════');
  lines.push(`  请求数 ${m.requests}   并发 ${result.scenario.concurrency}   种子 ${String(result.scenario.seed)}   虚拟耗时 ${result.virtualElapsedMs.toFixed(0)}ms`);
  lines.push('');
  lines.push('  【结果构成】');
  lines.push(`    成功       ${pad(String(m.success), 8)} ${pct(m.successRate)}`);
  lines.push(`    业务失败   ${pad(String(m.error), 8)} ${pct(m.errorRate)}`);
  lines.push(`    本地拒绝   ${pad(String(m.rejected), 8)} ${pct(m.rejectedRate)}`);
  const reasons = Object.entries(m.byReason)
    .filter(([k]) => k !== 'ok')
    .sort((a, b) => b[1] - a[1]);
  if (reasons.length > 0) {
    lines.push(`    失败明细   ${reasons.map(([k, v]) => `${k}=${v}`).join('  ')}`);
  }
  lines.push('');
  lines.push('  【延迟分布 (ms)】');
  lines.push(`    mean ${m.latencyMs.mean}   p50 ${m.latencyMs.p50}   p90 ${m.latencyMs.p90}   p95 ${m.latencyMs.p95}`);
  lines.push(`    p99 ${m.latencyMs.p99}   p99.9 ${m.latencyMs.p999}   max ${m.latencyMs.max}`);
  lines.push('');
  lines.push(...renderHistogram(result));
  lines.push('');
  lines.push('  【成本与吞吐】');
  lines.push(`    下游调用数 ${m.transportCalls}   重试次数 ${m.retries}   每请求重试 ${m.retriesPerRequest}`);
  lines.push(`    放大系数   ${m.amplification}x   成功吞吐 ${m.throughputRps} req/s(虚拟)`);
  if (result.stackMetrics.breaker) {
    const b = result.stackMetrics.breaker;
    lines.push(`    断路器     状态=${b.state} 断路次数=${b.trips} 失败率=${pct(b.failureRate)} 拒绝=${b.rejected}`);
  }
  if (result.stackMetrics.bulkhead) {
    const b = result.stackMetrics.bulkhead;
    lines.push(`    舱壁       峰值并发=${b.maxObservedConcurrency} 拒绝=${b.rejected}`);
  }
  if (result.stackMetrics.invertedTimeout) {
    lines.push('    ⚠️  检测到超时倒挂：内层各层预算之和大于最外层超时');
  }
  lines.push('════════════════════════════════════════════════════════════════');
  return lines.join('\n');
}

export interface CompareRow {
  name: string;
  successRate: number;
  p99: number;
  amplification: number;
  rejectedRate: number;
  throughputRps: number;
  score: number;
}

export interface ScoreWeights {
  p99TargetMs: number;
  ampTarget: number;
  latencyWeight: number;
  ampWeight: number;
}

export const DEFAULT_WEIGHTS: ScoreWeights = {
  p99TargetMs: 500,
  ampTarget: 1.5,
  latencyWeight: 0.4,
  ampWeight: 0.3,
};

/**
 * 综合评分：以可用率为主，扣掉 p99 超标与重试放大的惩罚。
 * 这样得出的「最优策略」是可用性、延迟、成本三者权衡后的结果，
 * 而不是单纯比成功率（后者往往会选出无限重试这种危险配置）。
 */
export function score(result: SimulationResult, weights: ScoreWeights = DEFAULT_WEIGHTS): number {
  const m = result.metrics;
  const latencyPenalty = Math.max(0, (m.latencyMs.p99 - weights.p99TargetMs) / Math.max(weights.p99TargetMs, 1)) * 100 * weights.latencyWeight;
  const ampPenalty = Math.max(0, m.amplification - weights.ampTarget) * 100 * weights.ampWeight;
  return Math.round((m.successRate * 100 - latencyPenalty - ampPenalty) * 100) / 100;
}

export interface CompareResult {
  rows: CompareRow[];
  winner: CompareRow;
  table: string;
}

/** 渲染多策略对比报告，并给出综合最优项。 */
export function compareResults(results: SimulationResult[], weights: ScoreWeights = DEFAULT_WEIGHTS): CompareResult {
  const rows: CompareRow[] = results.map((r) => ({
    name: r.policyName,
    successRate: r.metrics.successRate,
    p99: r.metrics.latencyMs.p99,
    amplification: r.metrics.amplification,
    rejectedRate: r.metrics.rejectedRate,
    throughputRps: r.metrics.throughputRps,
    score: score(r, weights),
  }));
  rows.sort((a, b) => b.score - a.score);
  const header = ['策略', '成功率', 'p99(ms)', '放大', '本地拒绝', '吞吐(r/s)', '评分'];
  const tableRows = rows.map((r) => [
    r.name,
    pct(r.successRate),
    String(r.p99),
    `${r.amplification}x`,
    pct(r.rejectedRate),
    String(r.throughputRps),
    String(r.score),
  ]);
  const widths = header.map((h, i) => Math.max(2, ...tableRows.map((row) => displayWidth(row[i])), displayWidth(h)));
  const lines: string[] = [];
  lines.push(header.map((h, i) => pad(h, widths[i])).join('  '));
  lines.push(widths.map((w) => '─'.repeat(Math.min(w, 60))).join('──'));
  for (const row of tableRows) {
    lines.push(row.map((c, i) => pad(c, widths[i])).join('  '));
  }
  return {
    rows,
    winner: rows[0],
    table: lines.join('\n'),
  };
}

/** 导出 Markdown 版报告。 */
export function toMarkdown(result: SimulationResult): string {
  const m = result.metrics;
  const lines: string[] = [];
  lines.push(`## Resilix 模拟报告 — ${result.policyName}`);
  lines.push('');
  lines.push(`- 故障场景：**${result.fault.name ?? 'fault'}**`);
  lines.push(`- 请求数：${m.requests}　并发：${result.scenario.concurrency}　随机种子：\`${String(result.scenario.seed)}\``);
  lines.push(`- 虚拟耗时：${result.virtualElapsedMs.toFixed(0)} ms`);
  lines.push('');
  lines.push('| 指标 | 数值 | 指标 | 数值 |');
  lines.push('| --- | --- | --- | --- |');
  lines.push(`| 成功率 | ${pct(m.successRate)} | p50 延迟 | ${m.latencyMs.p50} ms |`);
  lines.push(`| 业务失败率 | ${pct(m.errorRate)} | p95 延迟 | ${m.latencyMs.p95} ms |`);
  lines.push(`| 本地拒绝率 | ${pct(m.rejectedRate)} | p99 延迟 | ${m.latencyMs.p99} ms |`);
  lines.push(`| 重试次数 | ${m.retries} | 最大延迟 | ${m.latencyMs.max} ms |`);
  lines.push(`| 放大系数 | ${m.amplification}x | 成功吞吐 | ${m.throughputRps} req/s |`);
  lines.push('');
  return lines.join('\n');
}

/** 导出 CSV，一行一条请求明细，便于外部看板二次聚合。 */
export function toCsv(result: SimulationResult): string {
  const lines = ['id,start_ms,latency_ms,attempts,transport_calls,kind,reason'];
  for (const o of result.outcomes) {
    lines.push(
      [o.id, o.startMs.toFixed(3), o.latencyMs.toFixed(3), o.attempts, o.transportCalls, o.kind, o.reason].join(','),
    );
  }
  return lines.join('\n');
}

/** 导出可被管道消费的 JSON（指标 + 配置回执）。 */
export function toJson(result: SimulationResult, pretty = true): string {
  return JSON.stringify(
    {
      policy: result.policyName,
      fault: result.fault.name ?? 'fault',
      scenario: result.scenario,
      virtualElapsedMs: result.virtualElapsedMs,
      metrics: {
        requests: result.metrics.requests,
        success: result.metrics.success,
        error: result.metrics.error,
        rejected: result.metrics.rejected,
        successRate: result.metrics.successRate,
        latency: result.metrics.latencyMs,
        retries: result.metrics.retries,
        transportCalls: result.metrics.transportCalls,
        amplification: result.metrics.amplification,
        throughputRps: result.metrics.throughputRps,
        byReason: result.metrics.byReason,
      },
      stack: result.stackMetrics,
    },
    null,
    pretty ? 2 : 0,
  );
}

export type { Metrics };
