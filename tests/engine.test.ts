import test from 'node:test';
import assert from 'node:assert/strict';
import { simulate, simulateMany } from '../src/sim/engine.js';
import { compareResults, score, renderSimReport, toJson, toCsv, toMarkdown } from '../src/sim/report.js';
import { percentile, computeMetrics } from '../src/sim/metrics.js';
import { getPolicyPreset, getFaultPreset } from '../src/presets.js';

const baseScenario = { seed: 7, requests: 400, concurrency: 10 } as const;

test('相同种子得到逐位一致的结果', async () => {
  const a = await simulate(getPolicyPreset('balanced'), getFaultPreset('flaky'), { ...baseScenario, seed: 7 });
  const b = await simulate(getPolicyPreset('balanced'), getFaultPreset('flaky'), { ...baseScenario, seed: 7 });
  assert.equal(a.metrics.successRate, b.metrics.successRate);
  assert.equal(a.metrics.latencyMs.p99, b.metrics.latencyMs.p99);
  assert.equal(a.metrics.amplification, b.metrics.amplification);
  assert.equal(a.virtualElapsedMs, b.virtualElapsedMs);
  assert.equal(a.outcomes.length, b.outcomes.length);
});

test('不同种子会产生不同的采样结果', async () => {
  const a = await simulate(getPolicyPreset('balanced'), getFaultPreset('flaky'), { ...baseScenario, seed: 1 });
  const b = await simulate(getPolicyPreset('balanced'), getFaultPreset('flaky'), { ...baseScenario, seed: 2 });
  assert.notEqual(a.virtualElapsedMs, b.virtualElapsedMs);
});

test('结果计数自洽：成功 + 失败 + 拒绝 = 总请求数', async () => {
  const r = await simulate(getPolicyPreset('conservative'), getFaultPreset('overload'), baseScenario);
  const m = r.metrics;
  assert.equal(m.success + m.error + m.rejected, m.requests);
  assert.equal(m.requests, baseScenario.requests);
  assert.ok(m.successRate >= 0 && m.successRate <= 1);
});

test('重试策略在抖动场景下显著提升可用性', async () => {
  const none = await simulate(getPolicyPreset('none'), getFaultPreset('flaky'), baseScenario);
  const balanced = await simulate(getPolicyPreset('balanced'), getFaultPreset('flaky'), baseScenario);
  assert.ok(
    balanced.metrics.successRate >= none.metrics.successRate,
    `治理后的成功率不应更差: ${balanced.metrics.successRate} < ${none.metrics.successRate}`,
  );
  assert.ok(balanced.metrics.amplification >= 1, '放大系数至少为 1');
});

test('过载场景下舱壁把并发压在上限内', async () => {
  const r = await simulate(getPolicyPreset('conservative'), getFaultPreset('overload'), baseScenario);
  assert.ok(
    (r.stackMetrics.bulkhead?.maxObservedConcurrency ?? 0) <= 16,
    `舱壁未生效: ${r.stackMetrics.bulkhead?.maxObservedConcurrency}`,
  );
});

test('黑洞场景下没有超时的策略会显著变差', async () => {
  const withoutTimeout = await simulate(getPolicyPreset('none'), getFaultPreset('blackhole'), {
    seed: 3,
    requests: 60,
    concurrency: 5,
  });
  const withTimeout = await simulate(getPolicyPreset('balanced'), getFaultPreset('blackhole'), {
    seed: 3,
    requests: 60,
    concurrency: 5,
  });
  assert.ok(
    withTimeout.metrics.latencyMs.p99 < withoutTimeout.metrics.latencyMs.p99,
    '有超时兜底的策略 p99 应明显更低',
  );
});

test('simulateMany 支持多策略批量模拟', async () => {
  const results = await simulateMany(
    [getPolicyPreset('none'), getPolicyPreset('balanced')],
    getFaultPreset('gray-failure'),
    baseScenario,
  );
  assert.equal(results.length, 2);
  assert.equal(results[0].policyName, 'none');
});

test('compareResults 给出排序与最优策略', async () => {
  const results = await simulateMany(
    [getPolicyPreset('none'), getPolicyPreset('conservative'), getPolicyPreset('balanced')],
    getFaultPreset('flaky'),
    baseScenario,
  );
  const cmp = compareResults(results);
  assert.equal(cmp.rows.length, 3);
  assert.ok(cmp.rows[0].score >= cmp.rows[2].score, '评分应降序排列');
  assert.match(cmp.table, /成功率/);
  assert.ok(cmp.winner.name.length > 0);
});

test('score 会惩罚过高的重试放大', () => {
  const mk = (successRate: number, amplification: number): unknown => ({
    policyName: 'x',
    policy: {},
    fault: {},
    scenario: {},
    outcomes: [],
    stackMetrics: { rejectedBy: {}, invertedTimeout: false },
    virtualElapsedMs: 1000,
    metrics: { successRate, latencyMs: { p99: 100 }, amplification },
  });
  assert.ok(score(mk(0.9, 1.1) as never) > score(mk(0.9, 3.5) as never));
});

test('percentile 计算结果符合定义', () => {
  const sorted = Array.from({ length: 101 }, (_, i) => i);
  assert.equal(percentile(sorted, 50), 50);
  assert.equal(percentile(sorted, 100), 100);
  assert.equal(percentile(sorted, 0), 0);
  assert.equal(percentile([], 50), 0);
  assert.equal(percentile([42], 99), 42);
});

test('延迟分位数单调不减', async () => {
  const r = await simulate(getPolicyPreset('balanced'), getFaultPreset('gray-failure'), baseScenario);
  const l = r.metrics.latencyMs;
  assert.ok(l.p50 <= l.p90 && l.p90 <= l.p95 && l.p95 <= l.p99 && l.p99 <= l.max);
});

test('报告渲染覆盖全部导出格式', async () => {
  const r = await simulate(getPolicyPreset('balanced'), getFaultPreset('flaky'), { seed: 1, requests: 50, concurrency: 5 });
  assert.match(renderSimReport(r), /Resilix 模拟报告/);
  const json = JSON.parse(toJson(r));
  assert.equal(json.policy, 'balanced');
  assert.ok(json.metrics.requests === 50);
  const csv = toCsv(r);
  assert.match(csv.split('\n')[0], /^id,start_ms/);
  assert.equal(csv.split('\n').length, 51);
  assert.match(toMarkdown(r), /Resilix 模拟报告/);
});

test('空结果的指标计算不会崩溃', () => {
  const m = computeMetrics([], 0);
  assert.equal(m.requests, 0);
  assert.equal(m.successRate, 0);
  assert.equal(m.throughputRps, 0);
});
