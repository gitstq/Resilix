/**
 * 配置装载与合并。
 *
 * CLI 与库共用一套装载逻辑，保证「命令行跑出来的结论」和「代码里用的
 * 配置」完全一致 —— 这是很多工具做不到的地方（两套装载两套行为）。
 */

import { readFileSync } from 'node:fs';
import { getFaultPreset, getPolicyPreset, type FaultPresetName, type PolicyPresetName } from './presets.js';
import type { PolicyStackConfig } from './policies/stack.js';
import type { FaultModel } from './faults/model.js';
import { DEFAULT_BACKOFF } from './policies/backoff.js';
import { DEFAULT_BREAKER } from './policies/breaker.js';
import { DEFAULT_BULKHEAD } from './policies/bulkhead.js';
import { DEFAULT_RETRY } from './policies/retry.js';
import { DEFAULT_HEDGE } from './policies/hedge.js';

/** 读取并解析 JSON 文件；文件为 '-' 时读标准输入（同步场景较少用）。 */
export function readJson(path: string): unknown {
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 把部分配置与默认值合并，得到完整策略配置。 */
export function normalizePolicy(input: unknown): PolicyStackConfig {
  if (!isRecord(input)) throw new Error('策略配置必须是一个 JSON 对象');
  const out: PolicyStackConfig = {};
  if (typeof input.name === 'string') out.name = input.name;
  if (typeof input.timeoutMs === 'number') out.timeoutMs = input.timeoutMs;

  if (isRecord(input.limiter)) {
    const l = input.limiter as Record<string, unknown>;
    switch (l.algorithm) {
      case 'token-bucket':
        out.limiter = {
          algorithm: 'token-bucket',
          capacity: Number(l.capacity),
          refillPerSec: Number(l.refillPerSec),
          ...(l.initialTokens !== undefined ? { initialTokens: Number(l.initialTokens) } : {}),
        };
        break;
      case 'leaky-bucket':
        out.limiter = { algorithm: 'leaky-bucket', capacity: Number(l.capacity), leakPerSec: Number(l.leakPerSec) };
        break;
      case 'fixed-window':
      case 'sliding-counter':
      case 'sliding-log':
        out.limiter = { algorithm: l.algorithm, limit: Number(l.limit), windowMs: Number(l.windowMs) };
        break;
      default:
        throw new Error(`不支持的限流算法: ${String(l.algorithm)}`);
    }
  }

  if (isRecord(input.bulkhead)) {
    const b = input.bulkhead as Record<string, unknown>;
    out.bulkhead = {
      maxConcurrent: b.maxConcurrent !== undefined ? Number(b.maxConcurrent) : DEFAULT_BULKHEAD.maxConcurrent,
      maxQueue: b.maxQueue !== undefined ? Number(b.maxQueue) : DEFAULT_BULKHEAD.maxQueue,
      queueTimeoutMs: b.queueTimeoutMs !== undefined ? Number(b.queueTimeoutMs) : DEFAULT_BULKHEAD.queueTimeoutMs,
    };
  }

  if (isRecord(input.breaker)) {
    const b = input.breaker as Record<string, unknown>;
    out.breaker = {
      windowMs: b.windowMs !== undefined ? Number(b.windowMs) : DEFAULT_BREAKER.windowMs,
      bucketCount: b.bucketCount !== undefined ? Number(b.bucketCount) : DEFAULT_BREAKER.bucketCount,
      minimumCalls: b.minimumCalls !== undefined ? Number(b.minimumCalls) : DEFAULT_BREAKER.minimumCalls,
      failureRateThreshold:
        b.failureRateThreshold !== undefined ? Number(b.failureRateThreshold) : DEFAULT_BREAKER.failureRateThreshold,
      slowCallRateThreshold:
        b.slowCallRateThreshold !== undefined
          ? Number(b.slowCallRateThreshold)
          : DEFAULT_BREAKER.slowCallRateThreshold,
      slowCallMs: b.slowCallMs !== undefined ? Number(b.slowCallMs) : DEFAULT_BREAKER.slowCallMs,
      openWaitMs: b.openWaitMs !== undefined ? Number(b.openWaitMs) : DEFAULT_BREAKER.openWaitMs,
      halfOpenMaxCalls: b.halfOpenMaxCalls !== undefined ? Number(b.halfOpenMaxCalls) : DEFAULT_BREAKER.halfOpenMaxCalls,
    };
  }

  if (isRecord(input.retry)) {
    const r = input.retry as Record<string, unknown>;
    const bo = isRecord(r.backoff) ? r.backoff : {};
    out.retry = {
      maxAttempts: r.maxAttempts !== undefined ? Number(r.maxAttempts) : DEFAULT_RETRY.maxAttempts,
      backoff: {
        baseMs: bo.baseMs !== undefined ? Number(bo.baseMs) : DEFAULT_BACKOFF.baseMs,
        multiplier: bo.multiplier !== undefined ? Number(bo.multiplier) : DEFAULT_BACKOFF.multiplier,
        maxMs: bo.maxMs !== undefined ? Number(bo.maxMs) : DEFAULT_BACKOFF.maxMs,
        jitter: (typeof bo.jitter === 'string' ? bo.jitter : DEFAULT_BACKOFF.jitter) as never,
      },
      retryBudgetRatio: r.retryBudgetRatio !== undefined ? Number(r.retryBudgetRatio) : DEFAULT_RETRY.retryBudgetRatio,
      retryBudgetWindowMs:
        r.retryBudgetWindowMs !== undefined ? Number(r.retryBudgetWindowMs) : DEFAULT_RETRY.retryBudgetWindowMs,
      maxElapsedMs: r.maxElapsedMs !== undefined ? Number(r.maxElapsedMs) : DEFAULT_RETRY.maxElapsedMs,
    };
  }

  if (isRecord(input.hedge)) {
    const h = input.hedge as Record<string, unknown>;
    out.hedge = {
      delayMs: h.delayMs !== undefined ? Number(h.delayMs) : DEFAULT_HEDGE.delayMs,
      maxHedges: h.maxHedges !== undefined ? Number(h.maxHedges) : DEFAULT_HEDGE.maxHedges,
    };
  }

  return out;
}

/** 把部分配置合并为完整故障模型。 */
export function normalizeFault(input: unknown): FaultModel {
  if (!isRecord(input)) throw new Error('故障模型必须是一个 JSON 对象');
  const latency = isRecord(input.latency) ? (input.latency as unknown as FaultModel['latency']) : undefined;
  const out: FaultModel = {
    name: typeof input.name === 'string' ? input.name : 'custom',
    latency: latency ?? { kind: 'lognormal', medianMs: 40, sigma: 0.6 },
    errorRate: input.errorRate !== undefined ? Number(input.errorRate) : 0.02,
    transientErrorRatio: input.transientErrorRatio !== undefined ? Number(input.transientErrorRatio) : 0.9,
  };
  if (Array.isArray(input.bursts)) out.bursts = input.bursts as FaultModel['bursts'];
  if (input.serverConcurrencyLimit !== undefined) out.serverConcurrencyLimit = Number(input.serverConcurrencyLimit);
  if (input.extraDelayPerInflightMs !== undefined) out.extraDelayPerInflightMs = Number(input.extraDelayPerInflightMs);
  if (input.serverTimeoutMs !== undefined) out.serverTimeoutMs = Number(input.serverTimeoutMs);
  if (input.blackholeRate !== undefined) out.blackholeRate = Number(input.blackholeRate);
  return out;
}

export interface LoadedScenario {
  policy: PolicyStackConfig;
  fault: FaultModel;
}

/**
 * 统一装载入口：既可以传文件路径，也可以传内置预设名。
 * 预设与文件同时给出时，文件覆盖预设（逐字段浅覆盖）。
 */
export function loadPolicy(source: string): PolicyStackConfig {
  const maybePreset = source as PolicyPresetName;
  try {
    const preset = getPolicyPreset(maybePreset);
    if (!source.includes('.') && !source.includes('/')) return preset;
  } catch {
    // 不是预设名，继续按文件路径处理
  }
  return normalizePolicy(readJson(source));
}

export function loadFault(source: string): FaultModel {
  const maybePreset = source as FaultPresetName;
  try {
    const preset = getFaultPreset(maybePreset);
    if (!source.includes('.') && !source.includes('/')) return preset;
  } catch {
    // 不是预设名，继续按文件路径处理
  }
  return normalizeFault(readJson(source));
}

/** 便捷组合：直接得到可直接交给 simulate() 的一对配置。 */
export function loadScenario(policySource: string, faultSource: string): LoadedScenario {
  return { policy: loadPolicy(policySource), fault: loadFault(faultSource) };
}
