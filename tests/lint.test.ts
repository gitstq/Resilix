import test from 'node:test';
import assert from 'node:assert/strict';
import { lintPolicy, renderLintReport, lintToMarkdown } from '../src/lint/linter.js';
import { RULES } from '../src/lint/rules.js';
import { getPolicyPreset } from '../src/presets.js';
import type { PolicyStackConfig } from '../src/policies/stack.js';

const dangerous: PolicyStackConfig = {
  name: 'dangerous',
  timeoutMs: 0,
  retry: {
    maxAttempts: 8,
    backoff: { baseMs: 50, multiplier: 4, maxMs: 100, jitter: 'none' },
    retryBudgetRatio: 0,
    retryBudgetWindowMs: 10_000,
    maxElapsedMs: 0,
  },
};

test('危险配置被判定为不通过', () => {
  const result = lintPolicy({ policy: dangerous });
  assert.equal(result.ok, false);
  assert.ok(result.summary.errors >= 3, `应至少命中 3 条 error，实际 ${result.summary.errors}`);
  const ids = result.diagnostics.map((d) => d.id);
  assert.ok(ids.includes('RX001'), '应命中「未开启抖动」');
  assert.ok(ids.includes('RX004'), '应命中「缺少重试预算」');
  assert.ok(ids.includes('RX006'), '应命中「无总超时」');
});

test('内置 balanced 预设零 error', () => {
  const result = lintPolicy({ policy: getPolicyPreset('balanced') });
  assert.equal(result.summary.errors, 0);
  assert.equal(result.ok, true);
});

test('每条规则都提供可执行的修复建议', () => {
  for (const rule of RULES) {
    const found = rule.check({ policy: dangerous, httpMethod: 'POST', callerTimeoutMs: 500, maxConcurrency: 8 });
    if (found) {
      assert.ok(found.fix.length > 5, `${rule.id} 缺少修复建议`);
      assert.ok(found.why.length > 5, `${rule.id} 缺少风险说明`);
      assert.ok(['error', 'warn', 'info'].includes(found.severity));
    }
  }
});

test('非幂等方法 + 重试会被拦截', () => {
  const result = lintPolicy({ policy: getPolicyPreset('balanced'), httpMethod: 'POST' });
  const hit = result.diagnostics.find((d) => d.id === 'RX015');
  assert.ok(hit, '应识别出 POST 上的重试风险');
  assert.equal(hit?.severity, 'error');
  const getResult = lintPolicy({ policy: getPolicyPreset('balanced'), httpMethod: 'GET' });
  assert.equal(getResult.diagnostics.find((d) => d.id === 'RX015'), undefined);
});

test('调用方超时小于自身超时会被识别', () => {
  const result = lintPolicy({ policy: getPolicyPreset('aggressive'), callerTimeoutMs: 1000 });
  assert.ok(result.diagnostics.some((d) => d.id === 'RX016'), '应识别调用方超时倒挂');
});

test('限流配额高于下游容量会被提示', () => {
  const result = lintPolicy({ policy: getPolicyPreset('aggressive'), serviceCapacityRps: 20 });
  assert.ok(result.diagnostics.some((d) => d.id === 'RX017'));
});

test('慢调用阈值与外层超时的冲突可被识别', () => {
  const policy = getPolicyPreset('balanced');
  policy.breaker!.slowCallMs = 5000;
  const result = lintPolicy({ policy });
  assert.ok(result.diagnostics.some((d) => d.id === 'RX008'));
});

test('诊断按严重级别排序', () => {
  const result = lintPolicy({ policy: dangerous, httpMethod: 'POST', callerTimeoutMs: 100 });
  const order = result.diagnostics.map((d) => d.severity);
  const rank = { error: 0, warn: 1, info: 2 } as const;
  for (let i = 1; i < order.length; i += 1) {
    assert.ok(rank[order[i]] >= rank[order[i - 1]], '严重级别应降序在前');
  }
});

test('报告渲染可读且 Markdown 版含表格', () => {
  const result = lintPolicy({ policy: dangerous });
  const text = renderLintReport(result, 'dangerous');
  assert.match(text, /策略体检/);
  assert.match(text, /RX001/);
  const md = lintToMarkdown(result, 'dangerous');
  assert.match(md, /\|\s*ERROR\s*\|\s*RX001\s*\|/);
});

test('零缺陷配置的报告包含通过提示', () => {
  const clean: PolicyStackConfig = {
    name: 'clean',
    timeoutMs: 800,
    breaker: {
      windowMs: 10_000,
      bucketCount: 10,
      minimumCalls: 20,
      failureRateThreshold: 0.5,
      slowCallRateThreshold: 0.8,
      slowCallMs: 300,
      openWaitMs: 5000,
      halfOpenMaxCalls: 3,
    },
  };
  const result = lintPolicy({ policy: clean });
  assert.match(renderLintReport(result), /✅/);
});
