/**
 * 策略编排。
 *
 * 单一策略几乎总是错的：只重试不限流会把抖动放大成雪崩；只限流不重试
 * 会把偶发抖动直接暴露给用户；有了断路器还无限重试，等于在本地白烧 CPU。
 *
 * Resilix 固定采用如下「由外向内」的分层顺序：
 *
 *   timeout  →  hedge  →  breaker  →  bulkhead  →  limiter  →  retry  →  底层调用
 *
 * 设计理由：
 * - **timeout 最外层**：给整条链路一个硬上限，杜绝超时倒挂；
 * - **hedge 在 breaker 外**：每个对冲请求都要各自通过健康度检查；
 * - **breaker 在 retry 外**：一次逻辑调用（含其全部重试）只贡献一个失败样本，
 *   否则下游抖动时重试会瞬间灌满窗口，把断路器过早冲开；
 * - **bulkhead 在 limiter 外**：先限制同时占用的资源，再限制发出速率；
 * - **limiter 在 retry 外**：重试同样要消耗配额，否则限流形同虚设；
 * - **retry 最内层**：只对真正拿到响应的失败做重建。
 */

import type { Clock } from '../core/clock.js';
import type { Rng } from '../core/random.js';
import { RejectedError, type RejectionReason } from '../core/errors.js';
import { CircuitBreaker, executeWithBreaker, type BreakerConfig, type BreakerMetrics } from './breaker.js';
import { Bulkhead, executeWithBulkhead, type BulkheadConfig } from './bulkhead.js';
import { createLimiter, type LimiterConfig, type RateLimiter } from './limiter.js';
import { executeWithRetry, RetryBudget, type RetryConfig } from './retry.js';
import { executeWithHedge, type HedgeConfig } from './hedge.js';
import { executeWithTimeout } from './timeout.js';

/** 策略需要的运行时上下文。生产环境用真实时钟，模拟器用虚拟时钟。 */
export interface PolicyContext {
  clock: Clock;
  rng: Rng;
}

/** 一次策略栈的完整配置。所有子策略都可省略（省略即不启用）。 */
export interface PolicyStackConfig {
  /** 策略名称，用于报告与 A/B 对比 */
  name?: string;
  /** 整条链路的总超时（毫秒），0/undefined 表示不限 */
  timeoutMs?: number;
  limiter?: LimiterConfig;
  bulkhead?: BulkheadConfig;
  breaker?: BreakerConfig;
  retry?: RetryConfig;
  hedge?: HedgeConfig;
}

export interface StackMetrics {
  breaker?: BreakerMetrics;
  bulkhead?: { rejected: number; maxObservedConcurrency: number; running: number; waiting: number };
  rejectedBy: Record<RejectionReason, number>;
  /**
   * 是否发生了「超时倒挂」：各层预算之和大于最外层截止时间。
   * 这是一个静态推导结论，用于给出配置级的告警。
   */
  invertedTimeout: boolean;
}

/** 一整套弹性策略的运行时实例。 */
export class ResilixStack {
  private readonly breaker?: CircuitBreaker;
  private readonly bulkhead?: Bulkhead;
  private readonly limiter?: RateLimiter;
  private readonly retryBudget?: RetryBudget;
  private readonly rejectedBy: Record<RejectionReason, number> = {
    'rate-limit': 0,
    'circuit-breaker': 0,
    bulkhead: 0,
    timeout: 0,
    hedge: 0,
  };

  constructor(
    readonly config: PolicyStackConfig,
    private readonly ctx: PolicyContext,
  ) {
    if (config.breaker) this.breaker = new CircuitBreaker(config.breaker, ctx.clock);
    if (config.bulkhead) this.bulkhead = new Bulkhead(config.bulkhead, ctx.clock);
    if (config.limiter) this.limiter = createLimiter(config.limiter, ctx.clock);
    if (config.retry) {
      this.retryBudget = new RetryBudget(config.retry.retryBudgetRatio, config.retry.retryBudgetWindowMs, ctx.clock);
    }
  }

  /** 最外层超时（毫秒）；0 表示不限。 */
  get timeoutMs(): number {
    return this.config.timeoutMs ?? 0;
  }

  noteRejection(reason: RejectionReason): void {
    this.rejectedBy[reason] = (this.rejectedBy[reason] ?? 0) + 1;
  }

  /**
   * 按分层顺序执行一个操作。
   * @param transport 底层调用，必须 Throw-First；入参 attempt 从 1 开始（retry 内部序号）
   */
  async execute<T>(transport: (attempt: number) => Promise<T> | T): Promise<T> {
    const { clock } = this.ctx;
    const timeoutMs = this.config.timeoutMs ?? 0;
    const deadlineMs = timeoutMs > 0 ? clock.now() + timeoutMs : undefined;
    return executeWithTimeout(
      () => this.runHedgeLayer(transport),
      { timeoutMs },
      clock,
      deadlineMs,
    );
  }

  private async runHedgeLayer<T>(transport: (attempt: number) => Promise<T> | T): Promise<T> {
    const hedge = this.config.hedge;
    if (!hedge || hedge.maxHedges <= 0) return this.runBreakerLayer(0, transport);
    const outcome = await executeWithHedge(
      (attempt) => this.runBreakerLayer(attempt, transport),
      hedge,
      this.ctx.clock,
    );
    return outcome.value;
  }

  private async runBreakerLayer<T>(_attempt: number, transport: (attempt: number) => Promise<T> | T): Promise<T> {
    const op = (): Promise<T> => this.runBulkheadLayer(transport);
    if (!this.breaker) return op();
    try {
      return await executeWithBreaker(this.breaker, op, this.ctx.clock);
    } catch (error) {
      if (error instanceof RejectedError) this.noteRejection('circuit-breaker');
      throw error;
    }
  }

  private async runBulkheadLayer<T>(transport: (attempt: number) => Promise<T> | T): Promise<T> {
    const op = (): Promise<T> => this.runLimiterLayer(transport);
    if (!this.bulkhead) return op();
    try {
      return await executeWithBulkhead(this.bulkhead, op);
    } catch (error) {
      if (error instanceof RejectedError) this.noteRejection('bulkhead');
      throw error;
    }
  }

  private async runLimiterLayer<T>(transport: (attempt: number) => Promise<T> | T): Promise<T> {
    if (this.limiter && !this.limiter.tryConsume(1)) {
      this.noteRejection('rate-limit');
      throw new RejectedError('rate-limit', '本地限流器拒绝：超出配额');
    }
    return this.runRetryLayer(transport);
  }

  private async runRetryLayer<T>(transport: (attempt: number) => Promise<T> | T): Promise<T> {
    const retry = this.config.retry;
    if (!retry || retry.maxAttempts <= 1) {
      try {
        return await transport(1);
      } catch (error) {
        throw error;
      }
    }
    // 预算必须在整条链路上共享，否则每次调用各自建桶，预算约束形同虚设
    this.retryBudget?.noteRequest();
    return executeWithRetry(transport, { config: retry, ctx: this.ctx, budget: this.retryBudget });
  }

  /** 导出当前策略栈的可观测指标。 */
  metrics(): StackMetrics {
    const bulkheadStats = this.bulkhead?.stats();
    return {
      breaker: this.breaker?.metrics(),
      bulkhead: bulkheadStats
        ? {
            rejected: bulkheadStats.rejected,
            maxObservedConcurrency: bulkheadStats.maxObservedConcurrency,
            running: this.bulkhead?.running() ?? 0,
            waiting: this.bulkhead?.waiting() ?? 0,
          }
        : undefined,
      rejectedBy: { ...this.rejectedBy },
      invertedTimeout: detectTimeoutInversion(this.config),
    };
  }
}

/**
 * 静态检测超时倒挂：把内层各层的时间预算加起来，超过最外层截止时间即告警。
 * 这是一个保守估计（并非所有层都会满额消耗），因此只在明显倒挂时报警。
 */
export function detectTimeoutInversion(config: PolicyStackConfig): boolean {
  const outer = config.timeoutMs ?? 0;
  if (outer <= 0) return false;
  let sum = 0;
  const retry = config.retry;
  if (retry && retry.maxAttempts > 1) {
    let wait = retry.backoff.baseMs;
    for (let i = 1; i < retry.maxAttempts - 1; i += 1) {
      sum += Math.min(wait, retry.backoff.maxMs);
      wait = Math.min(wait * retry.backoff.multiplier, retry.backoff.maxMs);
    }
    if (retry.maxElapsedMs > 0) sum = Math.max(sum, retry.maxElapsedMs);
  }
  if (config.hedge && config.hedge.maxHedges > 0) {
    sum += config.hedge.delayMs * config.hedge.maxHedges;
  }
  if (config.bulkhead && config.bulkhead.queueTimeoutMs > 0) {
    sum += config.bulkhead.queueTimeoutMs;
  }
  return sum > outer;
}
