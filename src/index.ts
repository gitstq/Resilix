/**
 * Resilix — 零依赖的弹性策略工具箱与离线故障注入沙盘。
 *
 * 设计目标：**让弹性策略像自动化测试一样可验证**。
 * 你在 JSON 里写策略，在虚拟时间里跑几万次请求，拿成功率 / p99 / 放大系数
 * 三个数字做决策，而不是靠拍脑袋写「重试三次」。
 *
 * @example
 * ```ts
 * import { ResilixStack, createSystemClock, createRng, createLimiter } from 'resilix';
 *
 * const stack = new ResilixStack(
 *   { name: 'api', timeoutMs: 1500, retry: { maxAttempts: 3, backoff: { baseMs: 50, multiplier: 2, maxMs: 2000, jitter: 'equal' }, retryBudgetRatio: 0.2, retryBudgetWindowMs: 10_000, maxElapsedMs: 600 } },
 *   { clock: createSystemClock(), rng: createRng('prod') },
 * );
 * const data = await stack.execute(() => fetch('https://api.example.com/health').then((r) => r.text()));
 * ```
 *
 * @packageDocumentation
 */

// ── 核心 ────────────────────────────────────────────────────────────────
export { createSystemClock, VirtualClock } from './core/clock.js';
export type { Clock, TimerHandle } from './core/clock.js';
export {
  createRng,
  mulberry32,
  splitmix32,
  gaussian,
  sampleLatency,
  describeDistribution,
  normalizeSeed,
} from './core/random.js';
export type { Rng, LatencyDistribution } from './core/random.js';
export { SlidingWindow } from './core/window.js';
export type { WindowSample } from './core/window.js';
export {
  ResilixError,
  TransientError,
  PermanentError,
  TimeoutError,
  RejectedError,
  isRetryableByDefault,
} from './core/errors.js';
export type { RejectionReason } from './core/errors.js';

// ── 策略 ────────────────────────────────────────────────────────────────
export {
  BackoffCalculator,
  computeBackoff,
  backoffSchedule,
  DEFAULT_BACKOFF,
} from './policies/backoff.js';
export type { BackoffConfig, JitterStrategy } from './policies/backoff.js';
export { executeWithRetry, RetryBudget, DEFAULT_RETRY } from './policies/retry.js';
export type { RetryConfig, RetryOutcome, RetryClassifier, RetryContext } from './policies/retry.js';
export {
  CircuitBreaker,
  executeWithBreaker,
  DEFAULT_BREAKER,
} from './policies/breaker.js';
export type { BreakerConfig, BreakerState, BreakerMetrics } from './policies/breaker.js';
export {
  TokenBucketLimiter,
  LeakyBucketLimiter,
  FixedWindowLimiter,
  SlidingWindowCounterLimiter,
  SlidingWindowLogLimiter,
  createLimiter,
} from './policies/limiter.js';
export type { RateLimiter, LimiterConfig, LimiterAlgorithm } from './policies/limiter.js';
export { Bulkhead, executeWithBulkhead, DEFAULT_BULKHEAD } from './policies/bulkhead.js';
export type { BulkheadConfig } from './policies/bulkhead.js';
export { executeWithHedge, DEFAULT_HEDGE } from './policies/hedge.js';
export type { HedgeConfig, HedgeOutcome } from './policies/hedge.js';
export { executeWithTimeout, DEFAULT_TIMEOUT } from './policies/timeout.js';
export type { TimeoutConfig } from './policies/timeout.js';
export { ResilixStack, detectTimeoutInversion } from './policies/stack.js';
export type { PolicyStackConfig, PolicyContext, StackMetrics } from './policies/stack.js';

// ── 故障注入 ────────────────────────────────────────────────────────────
export { createFaultyTransport, withFaults, DEFAULT_FAULT } from './faults/model.js';
export type { FaultModel, BurstWindow, FaultContext, TransportCall } from './faults/model.js';

// ── 模拟与报告 ──────────────────────────────────────────────────────────
export { simulate, simulateMany, DEFAULT_SCENARIO } from './sim/engine.js';
export type { ScenarioConfig, SimulationResult, RequestOutcome, OutcomeKind } from './sim/engine.js';
export { computeMetrics, percentile, buildHistogram } from './sim/metrics.js';
export type { Metrics, LatencyBucket } from './sim/metrics.js';
export {
  renderSimReport,
  renderHistogram,
  compareResults,
  score,
  toMarkdown,
  toCsv,
  toJson,
  DEFAULT_WEIGHTS,
} from './sim/report.js';
export type { CompareRow, CompareResult, ScoreWeights } from './sim/report.js';

// ── 静态检查 ────────────────────────────────────────────────────────────
export { lintPolicy, renderLintReport, lintToMarkdown } from './lint/linter.js';
export type { LintResult, LintSummary } from './lint/linter.js';
export { RULES } from './lint/rules.js';
export type { Diagnostic, LintContextInput, Severity } from './lint/rules.js';

// ── 预设与配置装载 ──────────────────────────────────────────────────────
export {
  POLICY_PRESETS,
  FAULT_PRESETS,
  getPolicyPreset,
  getFaultPreset,
  listPolicyPresets,
  listFaultPresets,
} from './presets.js';
export type { PolicyPresetName, FaultPresetName } from './presets.js';
export { loadScenario, loadPolicy, loadFault, normalizePolicy, normalizeFault, readJson } from './config.js';
export type { LoadedScenario } from './config.js';

/** 当前版本号，与 package.json 保持同步。 */
export const VERSION = '1.0.0';
