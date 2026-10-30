/**
 * 故障模型（Fault Model）。
 *
 * 「在真实线上验证弹性策略」成本极高且不可复现：你不可能为了让重试
 * 生效而真的去杀一次数据库。Resilix 的做法是把下游服务抽象成一个
 * 可调参的概率模型 —— 同样的模型可以反复重放，策略微调立刻看到差异。
 *
 * 支持叠加的故障维度：
 * - 基础延迟分布（见 core/random 的五种分布）
 * - 基础错误率 + 瞬时/永久错误配比
 * - 突发故障窗口（某段时间内错误率飙升）
 * - 并发拥塞反馈：并发越高，每个请求的排队延迟越长
 * - 服务端自身超时 / 黑洞（无响应，只能依赖客户端超时）
 */

import type { Clock } from '../core/clock.js';
import type { Rng, LatencyDistribution } from '../core/random.js';
import { sampleLatency } from '../core/random.js';
import { PermanentError, TimeoutError, TransientError } from '../core/errors.js';

export interface BurstWindow {
  /** 起始时间（虚拟毫秒） */
  fromMs: number;
  /** 结束时间（虚拟毫秒） */
  toMs: number;
  /** 窗口内的错误率覆盖值 */
  errorRate?: number;
  /** 窗口内的延迟倍数 */
  latencyMultiplier?: number;
}

export interface FaultModel {
  name?: string;
  /** 基础延迟分布 */
  latency: LatencyDistribution;
  /** 基础错误率 0~1 */
  errorRate: number;
  /** 错误中「瞬时错误（可重试）」的比例，其余为永久错误 */
  transientErrorRatio: number;
  /** 突发故障窗口 */
  bursts?: BurstWindow[];
  /**
   * 服务端并发饱和点，超过之后每个在途请求都会为其他请求增加额外延迟，
   * 用于模拟队列堆积导致的雪崩前兆。
   */
  serverConcurrencyLimit?: number;
  /** 每超出 1 个并发所增加的延迟（毫秒） */
  extraDelayPerInflightMs?: number;
  /** 服务端自身超时（毫秒）：超过即返回超时错误 */
  serverTimeoutMs?: number;
  /** 黑洞比例 0~1：这些请求永不响应，只能靠客户端超时兜底 */
  blackholeRate?: number;
}

export const DEFAULT_FAULT: Readonly<FaultModel> = Object.freeze<FaultModel>({
  name: 'default',
  latency: { kind: 'lognormal', medianMs: 40, sigma: 0.6 },
  errorRate: 0.02,
  transientErrorRatio: 0.9,
});

export interface FaultContext {
  clock: Clock;
  rng: Rng;
}

/** 单次调用在「服务端」视角的结果，埋点/统计用。 */
export interface TransportCall {
  latencyMs: number;
  error?: 'transient' | 'permanent' | 'timeout';
}

/**
 * 依据故障模型生成一个 Throw-First 的「下游服务」函数。
 *
 * @param onCall 可选的埋点回调，模拟器用它统计放大系数
 */
export function createFaultyTransport<T = void>(
  model: FaultModel,
  ctx: FaultContext,
  onCall?: (call: TransportCall) => void,
): (attempt: number) => Promise<T> {
  const state = { inflight: 0 };

  const resolveErrorRate = (nowMs: number): number => {
    let rate = model.errorRate;
    for (const b of model.bursts ?? []) {
      if (nowMs >= b.fromMs && nowMs < b.toMs && b.errorRate !== undefined) {
        rate = Math.max(rate, b.errorRate);
      }
    }
    return Math.min(Math.max(rate, 0), 1);
  };

  const resolveLatencyMultiplier = (nowMs: number): number => {
    let mult = 1;
    for (const b of model.bursts ?? []) {
      if (nowMs >= b.fromMs && nowMs < b.toMs && b.latencyMultiplier !== undefined) {
        mult = Math.max(mult, b.latencyMultiplier);
      }
    }
    return mult;
  };

  return async (): Promise<T> => {
    const { clock, rng } = ctx;
    const baseLatency = sampleLatency(model.latency, rng) * resolveLatencyMultiplier(clock.now());
    const limit = model.serverConcurrencyLimit ?? Number.POSITIVE_INFINITY;
    const congestion =
      model.extraDelayPerInflightMs && model.extraDelayPerInflightMs > 0
        ? Math.max(0, state.inflight - Math.max(0, limit)) * model.extraDelayPerInflightMs
        : 0;
    let latencyMs = baseLatency + congestion;

    // 黑洞：永不响应，虚拟时间里表现为「一直挂到极大值」，
    // 实际由客户端超时截断；这里用 60s 封顶避免事件队列无限增长。
    if (model.blackholeRate && rng.bool(model.blackholeRate)) {
      state.inflight += 1;
      await clock.sleep(60_000);
      state.inflight -= 1;
      onCall?.({ latencyMs: 60_000, error: 'timeout' });
      throw new TimeoutError('黑洞：下游无任何响应');
    }

    if (model.serverTimeoutMs && model.serverTimeoutMs > 0 && latencyMs > model.serverTimeoutMs) {
      state.inflight += 1;
      await clock.sleep(model.serverTimeoutMs);
      state.inflight -= 1;
      onCall?.({ latencyMs: model.serverTimeoutMs, error: 'timeout' });
      throw new TimeoutError('服务端自身超时');
    }

    state.inflight += 1;
    await clock.sleep(latencyMs);
    state.inflight -= 1;

    const errorRate = resolveErrorRate(clock.now());
    if (rng.bool(errorRate)) {
      const transient = model.transientErrorRatio >= 1 || rng.bool(model.transientErrorRatio);
      if (transient) {
        onCall?.({ latencyMs, error: 'transient' });
        throw new TransientError('下游瞬时错误');
      }
      onCall?.({ latencyMs, error: 'permanent' });
      throw new PermanentError('下游永久错误');
    }

    onCall?.({ latencyMs });
    return undefined as unknown as T;
  };
}

/** 把故障模型套在任意真实/桩函数外部，用于集成测试。 */
export function withFaults<T>(
  inner: () => Promise<T> | T,
  model: FaultModel,
  ctx: FaultContext,
): () => Promise<T> {
  const faulty = createFaultyTransport<void>(model, ctx);
  return async (): Promise<T> => {
    await faulty(1);
    return inner();
  };
}
