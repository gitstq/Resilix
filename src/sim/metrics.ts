/**
 * 指标体系。
 *
 * 弹性策略调得对不对，看三个数字就够了：
 * 1. **成功率（含本地拒绝）** —— 用户视角的可用性；
 * 2. **p99 延迟** —— 尾巴才决定体验，均值毫无意义；
 * 3. **重试放大系数 = 实际底层调用数 / 逻辑请求数** —— 大于 2 就意味着
 *    你在给已经出问题的下游「加倍奉还」，雪崩往往由此开始。
 */

import type { RequestOutcome } from './engine.js';

export interface LatencyBucket {
  /** 桶上界（毫秒），Infinity 表示最后一桶 */
  upperMs: number;
  count: number;
}

export interface Metrics {
  requests: number;
  success: number;
  error: number;
  rejected: number;
  successRate: number;
  errorRate: number;
  rejectedRate: number;
  byReason: Record<string, number>;
  latencyMs: {
    mean: number;
    p50: number;
    p90: number;
    p95: number;
    p99: number;
    p999: number;
    max: number;
  };
  /** 重试次数总和（不含首次） */
  retries: number;
  /** 平均每个请求的重试次数 */
  retriesPerRequest: number;
  /** 实际发往下游的调用数 */
  transportCalls: number;
  /** 放大系数 = 下游调用数 / 逻辑请求数 */
  amplification: number;
  /** 有效吞吐（成功请求 / 虚拟秒） */
  throughputRps: number;
  histogram: LatencyBucket[];
}

/** 最近邻插值分位数，输入必须已升序排列。 */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
}

const HISTOGRAM_EDGES = [5, 10, 25, 50, 100, 200, 400, 800, 1600, 3200, 6400];

/** 把延迟数组归到对数桶中，用于 ASCII 直方图渲染。 */
export function buildHistogram(latencies: number[]): LatencyBucket[] {
  const buckets: LatencyBucket[] = HISTOGRAM_EDGES.map((upperMs) => ({ upperMs, count: 0 }));
  buckets.push({ upperMs: Number.POSITIVE_INFINITY, count: 0 });
  for (const v of latencies) {
    const idx = buckets.findIndex((b) => v < b.upperMs);
    const target = idx === -1 ? buckets.length - 1 : idx;
    buckets[target].count += 1;
  }
  return buckets;
}

const round = (v: number): number => Math.round(v * 100) / 100;

/** 由原始请求结果汇总出完整指标。 */
export function computeMetrics(outcomes: RequestOutcome[], elapsedMs: number): Metrics {
  const total = outcomes.length;
  let success = 0;
  let error = 0;
  let rejected = 0;
  let retries = 0;
  let transportCalls = 0;
  const byReason: Record<string, number> = {};
  const latencies: number[] = [];

  for (const o of outcomes) {
    latencies.push(o.latencyMs);
    transportCalls += o.transportCalls;
    retries += Math.max(0, o.attempts - 1);
    byReason[o.reason] = (byReason[o.reason] ?? 0) + 1;
    if (o.kind === 'success') success += 1;
    else if (o.kind === 'rejected') rejected += 1;
    else error += 1;
  }
  latencies.sort((a, b) => a - b);

  const sum = latencies.reduce((acc, v) => acc + v, 0);
  return {
    requests: total,
    success,
    error,
    rejected,
    successRate: total === 0 ? 0 : success / total,
    errorRate: total === 0 ? 0 : error / total,
    rejectedRate: total === 0 ? 0 : rejected / total,
    byReason,
    latencyMs: {
      mean: total === 0 ? 0 : round(sum / total),
      p50: round(percentile(latencies, 50)),
      p90: round(percentile(latencies, 90)),
      p95: round(percentile(latencies, 95)),
      p99: round(percentile(latencies, 99)),
      p999: round(percentile(latencies, 99.9)),
      max: total === 0 ? 0 : round(latencies[total - 1]),
    },
    retries,
    retriesPerRequest: total === 0 ? 0 : round(retries / total),
    transportCalls,
    amplification: total === 0 ? 0 : round(transportCalls / total),
    throughputRps: elapsedMs <= 0 ? 0 : round((success / elapsedMs) * 1000),
    histogram: buildHistogram(latencies),
  };
}
