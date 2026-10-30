/**
 * 重试策略。
 *
 * 包含三个业界常被忽略的关键设计：
 * 1. **重试预算（retry budget）**：全局维度限制重试占总调用的比例，
 *    例如 20%。没有预算的重试在下游抖动时会把流量放大成雪崩；
 * 2. **可重试性分类**：区分瞬时错误与永久错误，绝不重试 400 类错误；
 * 3. **总耗时上限**：退避可以很优雅，但若整体超过调用方截止时间，
 *    再多的重试都是无意义的等待。
 */

import type { Clock } from '../core/clock.js';
import type { Rng } from '../core/random.js';
import { RejectedError, type RejectionReason } from '../core/errors.js';
import { BackoffCalculator, DEFAULT_BACKOFF, type BackoffConfig } from './backoff.js';

/** 操作 sleep 所依赖的最小执行环境。 */
export interface RetryContext {
  clock: Clock;
  rng: Rng;
}

/** 判定一次失败是否值得重试。 */
export type RetryClassifier = (error: unknown, attempt: number) => boolean;

export interface RetryConfig {
  /** 总尝试次数上限（含首次调用），1 表示不重试 */
  maxAttempts: number;
  /** 退避参数 */
  backoff: BackoffConfig;
  /**
   * 重试预算：滑动窗口内允许的重试次数占成功调用次数的比例。
   * 0.2 表示每 10 次成功调用最多允许 2 次重试。设 0 或负数表示不限制。
   */
  retryBudgetRatio: number;
  /** 预算窗口长度（毫秒） */
  retryBudgetWindowMs: number;
  /** 单次调用链的总重试耗时上限（毫秒），0 表示不限 */
  maxElapsedMs: number;
}

export const DEFAULT_RETRY: RetryConfig = Object.freeze({
  maxAttempts: 3,
  backoff: DEFAULT_BACKOFF,
  retryBudgetRatio: 0.2,
  retryBudgetWindowMs: 10_000,
  maxElapsedMs: 0,
});

export interface RetryOutcome<T> {
  value?: T;
  attempts: number;
  retried: number;
  /** 是否被重试预算拒绝继续重试（此时最后一次错误仍会被抛出） */
  budgetExhausted: boolean;
  totalWaitMs: number;
}

/**
 * 重试预算。
 *
 * 语义取自 Google SRE Handbook：**正常请求按比例「挣得」重试额度，重试消耗额度**。
 * 因此额度天然跟随流量伸缩 —— 流量小的时候可以重试的比例也是固定的，
 * 而不是像固定 QPS 配额那样在低峰期形同虚设、高峰期又过于宽松。
 *
 * 同时引入基于窗口的线性衰减，长时间没有流量时额度不会无限累积。
 */
export class RetryBudget {
  /** 额度队列：每一笔「正常请求」都在有效期内按比例贡献额度 */
  private entries: Array<{ amount: number; expiresAt: number }> = [];

  constructor(
    private readonly ratio: number,
    private readonly windowMs: number,
    private readonly clock: Clock,
  ) {}

  /** 过期额度清理。 */
  private prune(): void {
    const now = this.clock.now();
    let i = 0;
    while (i < this.entries.length && this.entries[i].expiresAt <= now) i += 1;
    if (i > 0) this.entries.splice(0, i);
  }

  /** 记录一个「正常请求」，在 windowMs 内按 retryBudgetRatio 贡献额度。 */
  noteRequest(): void {
    this.prune();
    this.entries.push({ amount: Math.max(0, this.ratio), expiresAt: this.clock.now() + Math.max(1, this.windowMs) });
  }

  /** 是否有重试额度。 */
  tryConsume(): boolean {
    if (this.ratio <= 0) return true; // 显式关闭预算
    this.prune();
    let need = 1;
    while (need > 0 && this.entries.length > 0) {
      const head = this.entries[0];
      if (head.amount > need) {
        head.amount -= need;
        need = 0;
      } else {
        need -= head.amount;
        this.entries.shift();
      }
    }
    return need === 0;
  }

  /** 当前可用额度（调试/观测用）。 */
  available(): number {
    this.prune();
    return this.entries.reduce((acc, e) => acc + e.amount, 0);
  }

  /** 当前队列长度，便于诊断内存占用。 */
  depth(): number {
    return this.entries.length;
  }
}

export interface RetryExecutorOptions {
  config: RetryConfig;
  ctx: RetryContext;
  classify?: RetryClassifier;
  /** 共享的重试预算；不传则为本次调用单独创建（仅适合一次性调用） */
  budget?: RetryBudget;
  /** 每次尝试前的钩子，便于埋点 / 日志 */
  onAttempt?: (info: { attempt: number; waitMs: number; deadlineHit: boolean }) => void;
}

/**
 * 依据重试策略执行一个可能失败的操作。
 *
 * @param operation 每次尝试都会被调用一次，要求 Throw-First（失败抛错）
 */
export async function executeWithRetry<T>(
  operation: (attempt: number) => Promise<T> | T,
  options: RetryExecutorOptions,
): Promise<T> {
  const { config, ctx } = options;
  const defaultClassify: RetryClassifier = (error) => defaultClassifier(error);
  const classify = options.classify ?? defaultClassify;
  const calculator = new BackoffCalculator(config.backoff, ctx.rng);
  const budget = options.budget ?? new RetryBudget(config.retryBudgetRatio, config.retryBudgetWindowMs, ctx.clock);
  const startedAt = ctx.clock.now();
  const maxAttempts = Math.max(1, Math.floor(config.maxAttempts));

  let lastError: unknown;
  let totalWaitMs = 0;
  let budgetExhausted = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      if (attempt > 1) options.onAttempt?.({ attempt, waitMs: 0, deadlineHit: false });
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts) break;
      if (error instanceof RejectedError) break; // 本地拒绝不重试，避免无意义等待
      if (!classify(error, attempt)) break;

      const elapsed = ctx.clock.now() - startedAt;
      if (config.maxElapsedMs > 0 && elapsed >= config.maxElapsedMs) break;

      if (!budget.tryConsume()) {
        budgetExhausted = true;
        break;
      }

      let waitMs = calculator.next();
      if (config.maxElapsedMs > 0) {
        const remaining = config.maxElapsedMs - (ctx.clock.now() - startedAt);
        if (remaining <= 0) break;
        waitMs = Math.min(waitMs, remaining);
      }
      totalWaitMs += waitMs;
      options.onAttempt?.({ attempt: attempt + 1, waitMs, deadlineHit: false });
      await ctx.clock.sleep(waitMs);
    }
  }
  void budgetExhausted;
  throw lastError;
}

function defaultClassifier(error: unknown): boolean {
  // 延迟引入避免循环依赖：这里内联一份等价判断
  if (error instanceof Error) {
    const name = error.name;
    if (name === 'PermanentError') return false;
    if (name === 'RejectedError') return false;
    if (name === 'TimeoutError') return true;
    if (name === 'TransientError') return true;
    const code = (error as { code?: string }).code;
    if (typeof code === 'string' && ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE'].includes(code)) return true;
  }
  return false;
}

/** 构造一个 RejectedError（集中在此处便于统一调优文案）。 */
export function rejection(reason: RejectionReason, message?: string): RejectedError {
  return new RejectedError(reason, message);
}
