/**
 * 内置预设。
 *
 * 预设存在的意义不是「替你做决定」，而是提供一个**安全起点**：
 * 从 balanced 出发，用 `resilix sim` 量化它的表现，再结合自己的 SLO
 * 微调。所有预设都刻意保留了显式字段值，方便逐项对照取舍。
 */

import type { PolicyStackConfig } from './policies/stack.js';
import type { FaultModel } from './faults/model.js';

export type PolicyPresetName = 'none' | 'conservative' | 'balanced' | 'aggressive';

export const POLICY_PRESETS: Record<PolicyPresetName, PolicyStackConfig> = {
  /** 完全不加治理：作为对照组，用于量化「弹性层到底值不值」 */
  none: {
    name: 'none',
    timeoutMs: 0,
  },
  /** 保守：优先保护下游与自身资源，宁可多拒绝，不可把下游打垮 */
  conservative: {
    name: 'conservative',
    timeoutMs: 800,
    limiter: { algorithm: 'token-bucket', capacity: 400, refillPerSec: 250 },
    bulkhead: { maxConcurrent: 16, maxQueue: 16, queueTimeoutMs: 100 },
    breaker: {
      windowMs: 10_000,
      bucketCount: 10,
      minimumCalls: 20,
      failureRateThreshold: 0.3,
      slowCallRateThreshold: 0.6,
      slowCallMs: 400,
      openWaitMs: 5000,
      halfOpenMaxCalls: 3,
    },
    retry: {
      maxAttempts: 2,
      backoff: { baseMs: 50, multiplier: 2, maxMs: 1000, jitter: 'full' },
      retryBudgetRatio: 0.1,
      retryBudgetWindowMs: 10_000,
      maxElapsedMs: 300,
    },
  },
  /** 均衡：默认推荐，覆盖绝大多数 RPC / HTTP 调用场景 */
  balanced: {
    name: 'balanced',
    timeoutMs: 1500,
    limiter: { algorithm: 'token-bucket', capacity: 600, refillPerSec: 400 },
    bulkhead: { maxConcurrent: 32, maxQueue: 64, queueTimeoutMs: 200 },
    breaker: {
      windowMs: 10_000,
      bucketCount: 10,
      minimumCalls: 20,
      failureRateThreshold: 0.5,
      slowCallRateThreshold: 0.8,
      slowCallMs: 800,
      openWaitMs: 5000,
      halfOpenMaxCalls: 3,
    },
    retry: {
      maxAttempts: 3,
      backoff: { baseMs: 50, multiplier: 2, maxMs: 2000, jitter: 'equal' },
      retryBudgetRatio: 0.2,
      retryBudgetWindowMs: 10_000,
      maxElapsedMs: 600,
    },
  },
  /** 激进：追求可用性，用更高成本换取成功率，适合强一致读取场景 */
  aggressive: {
    name: 'aggressive',
    timeoutMs: 3000,
    limiter: { algorithm: 'token-bucket', capacity: 1200, refillPerSec: 900 },
    bulkhead: { maxConcurrent: 64, maxQueue: 128, queueTimeoutMs: 400 },
    breaker: {
      windowMs: 5000,
      bucketCount: 10,
      minimumCalls: 30,
      failureRateThreshold: 0.7,
      slowCallRateThreshold: 1,
      slowCallMs: 2000,
      openWaitMs: 3000,
      halfOpenMaxCalls: 5,
    },
    retry: {
      maxAttempts: 5,
      backoff: { baseMs: 25, multiplier: 2, maxMs: 2000, jitter: 'full' },
      retryBudgetRatio: 0.4,
      retryBudgetWindowMs: 10_000,
      maxElapsedMs: 1500,
    },
    hedge: { delayMs: 300, maxHedges: 1 },
  },
};

export type FaultPresetName = 'healthy' | 'flaky' | 'gray-failure' | 'overload' | 'blackhole';

export const FAULT_PRESETS: Record<FaultPresetName, FaultModel> = {
  /** 健康服务：轻微抖动，偶发瞬时错误 */
  healthy: {
    name: 'healthy',
    latency: { kind: 'lognormal', medianMs: 30, sigma: 0.4 },
    errorRate: 0.005,
    transientErrorRatio: 1,
  },
  /** 抖动服务：错误率中等，偶有长尾，最能体现重试的收益 */
  flaky: {
    name: 'flaky',
    latency: { kind: 'lognormal', medianMs: 40, sigma: 0.8 },
    errorRate: 0.08,
    transientErrorRatio: 0.95,
  },
  /** 灰度故障：延迟长尾 + 偶发永久错误，最容易被误判为「偶发抖动」 */
  'gray-failure': {
    name: 'gray-failure',
    latency: { kind: 'bimodal', fastMs: 30, slowMs: 900, slowRatio: 0.25 },
    errorRate: 0.03,
    transientErrorRatio: 0.7,
    bursts: [{ fromMs: 3000, toMs: 8000, errorRate: 0.35, latencyMultiplier: 2 }],
  },
  /** 过载：并发越高越慢（排队效应），用于验证舱壁与限流 */
  overload: {
    name: 'overload',
    latency: { kind: 'lognormal', medianMs: 50, sigma: 0.6 },
    errorRate: 0.02,
    transientErrorRatio: 0.9,
    serverConcurrencyLimit: 24,
    extraDelayPerInflightMs: 15,
    bursts: [{ fromMs: 2000, toMs: 12000, errorRate: 0.2, latencyMultiplier: 3 }],
  },
  /** 黑洞：部分请求永不响应，只能通过客户端超时兜底 */
  blackhole: {
    name: 'blackhole',
    latency: { kind: 'lognormal', medianMs: 35, sigma: 0.5 },
    errorRate: 0.01,
    transientErrorRatio: 1,
    blackholeRate: 0.06,
    bursts: [{ fromMs: 5000, toMs: 15000, errorRate: 0.1 }],
  },
};

/** 列出全部策略预设名。 */
export function listPolicyPresets(): PolicyPresetName[] {
  return Object.keys(POLICY_PRESETS) as PolicyPresetName[];
}

/** 列出全部故障预设名。 */
export function listFaultPresets(): FaultPresetName[] {
  return Object.keys(FAULT_PRESETS) as FaultPresetName[];
}

/** 取一个策略预设（深拷贝，避免调用方改脏全局配置）。 */
export function getPolicyPreset(name: PolicyPresetName): PolicyStackConfig {
  const preset = POLICY_PRESETS[name];
  if (!preset) throw new Error(`未知策略预设: ${name}`);
  return structuredClone(preset);
}

/** 取一个故障预设（深拷贝）。 */
export function getFaultPreset(name: FaultPresetName): FaultModel {
  const preset = FAULT_PRESETS[name];
  if (!preset) throw new Error(`未知故障预设: ${name}`);
  return structuredClone(preset);
}
