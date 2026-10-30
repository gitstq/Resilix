/**
 * 断路器（Circuit Breaker）。
 *
 * 与「重试」互补：重试解决偶发抖动，断路器解决持续性故障。
 * 没有断路器的重试，会在下游已经彻底不可用时，把调用方的线程池
 * 全部耗在等待超时上 —— 这是级联故障最典型的传播路径。
 *
 * 状态机：CLOSED →（失败率/慢调用率超阈值且样本足够）→ OPEN →
 * （冷却期结束）→ HALF_OPEN →（探测成功达标/CLOSED，失败/OPEN）
 */

import type { Clock } from '../core/clock.js';
import { SlidingWindow } from '../core/window.js';
import { RejectedError } from '../core/errors.js';

export type BreakerState = 'closed' | 'open' | 'half-open';

export interface BreakerConfig {
  /** 统计窗口长度（毫秒） */
  windowMs: number;
  /** 窗口分桶数，越多越精确 */
  bucketCount: number;
  /** 触发断路的最小样本量，避免「1 次失败就断路」的误判 */
  minimumCalls: number;
  /** 失败率阈值（0~1） */
  failureRateThreshold: number;
  /** 慢调用率阈值（0~1），设为 1 表示不启用慢调用断路 */
  slowCallRateThreshold: number;
  /** 判定「慢」的耗时阈值（毫秒） */
  slowCallMs: number;
  /** OPEN 状态持续多久后进入 HALF_OPEN（毫秒） */
  openWaitMs: number;
  /** HALF_OPEN 状态下允许的探测请求数 */
  halfOpenMaxCalls: number;
}

export const DEFAULT_BREAKER: BreakerConfig = Object.freeze({
  windowMs: 10_000,
  bucketCount: 10,
  minimumCalls: 20,
  failureRateThreshold: 0.5,
  slowCallRateThreshold: 1,
  slowCallMs: 1000,
  openWaitMs: 5000,
  halfOpenMaxCalls: 3,
});

export interface BreakerMetrics {
  state: BreakerState;
  total: number;
  failures: number;
  slow: number;
  failureRate: number;
  slowRate: number;
  rejected: number;
  trips: number;
  halfOpenProbes: number;
  halfOpenSuccess: number;
}

/** 一个可被观测的断路器实例。 */
export class CircuitBreaker {
  private state: BreakerState = 'closed';
  private readonly window: SlidingWindow;
  private openedAtMs = 0;
  private probes = 0;
  private probeSuccess = 0;
  private trips = 0;
  private rejected = 0;

  constructor(
    private readonly config: BreakerConfig,
    private readonly clock: Clock,
  ) {
    this.window = new SlidingWindow(config.windowMs, config.bucketCount, clock.now());
  }

  /** 当前状态。 */
  getState(): BreakerState {
    return this.state;
  }

  /**
   * 是否允许放行一次调用（纯查询，不做状态迁移以外的记录）。
   * OPEN 状态超过冷却期后会自动推进到 HALF_OPEN，并放行探测请求。
   */
  allowRequest(): boolean {
    const now = this.clock.now();
    this.window.advance(now);
    if (this.state === 'closed') return true;
    if (this.state === 'open') {
      if (now - this.openedAtMs >= this.config.openWaitMs) {
        this.state = 'half-open';
        this.probes = 0;
        this.probeSuccess = 0;
        return true;
      }
      return false;
    }
    // half-open：仅允许有限个探测请求
    return this.probes < this.config.halfOpenMaxCalls;
  }

  /** 记录一次成功。 */
  recordSuccess(latencyMs: number): void {
    const now = this.clock.now();
    this.window.record(now, false, latencyMs >= this.config.slowCallMs, latencyMs);
    if (this.state === 'half-open') {
      this.probes += 1;
      this.probeSuccess += 1;
      if (this.probeSuccess >= this.config.halfOpenMaxCalls) this.reset('closed', now);
      return;
    }
    // 慢调用率必须由「成功但很慢」的样本驱动，因此每次成功都要评估
    this.evaluate(now);
  }

  /** 记录一次失败。 */
  recordFailure(latencyMs: number): void {
    const now = this.clock.now();
    this.window.record(now, true, latencyMs >= this.config.slowCallMs, latencyMs);
    if (this.state === 'half-open') {
      // 只要有一个探测失败，立刻回到 OPEN —— 说明下游尚未恢复
      this.trip(now);
      return;
    }
    this.evaluate(now);
  }

  /** 依据窗口统计判断是否应当断路。 */
  private evaluate(now: number): void {
    if (this.state !== 'closed') return;
    const snap = this.window.snapshot();
    const enoughSamples = snap.total >= this.config.minimumCalls;
    const overFailure = snap.failureRate >= this.config.failureRateThreshold;
    const overSlow = this.config.slowCallRateThreshold < 1 && snap.slowRate >= this.config.slowCallRateThreshold;
    if (enoughSamples && (overFailure || overSlow)) this.trip(now);
  }

  /** 手动把状态切换为打开（用于运维干预场景）。 */
  forceOpen(): void {
    this.trip(this.clock.now());
  }

  private trip(now: number): void {
    if (this.state !== 'open') this.trips += 1;
    this.state = 'open';
    this.openedAtMs = now;
  }

  private reset(state: BreakerState, now: number): void {
    this.state = state;
    this.window.reset(now);
    this.probes = 0;
    this.probeSuccess = 0;
  }

  /** 导出当前指标快照。 */
  metrics(): BreakerMetrics {
    const snap = this.window.snapshot();
    return {
      state: this.state,
      total: snap.total,
      failures: snap.failures,
      slow: snap.slow,
      failureRate: snap.failureRate,
      slowRate: snap.slowRate,
      rejected: this.rejected,
      trips: this.trips,
      halfOpenProbes: this.probes,
      halfOpenSuccess: this.probeSuccess,
    };
  }

  /** 增加本地拒绝计数（由调用方在拦截时调用）。 */
  noteRejected(): void {
    this.rejected += 1;
  }
}

/**
 * 用断路器包裹一个操作。
 * 处于 OPEN 状态时**直接本地失败**，不消耗连接与时间预算。
 */
export async function executeWithBreaker<T>(
  breaker: CircuitBreaker,
  operation: () => Promise<T> | T,
  clock: Clock,
): Promise<T> {
  if (!breaker.allowRequest()) {
    breaker.noteRejected();
    throw new RejectedError('circuit-breaker', '断路器处于 OPEN 状态，本地快速失败');
  }
  const startedAt = clock.now();
  try {
    const value = await operation();
    breaker.recordSuccess(clock.now() - startedAt);
    return value;
  } catch (error) {
    breaker.recordFailure(clock.now() - startedAt);
    throw error;
  }
}
