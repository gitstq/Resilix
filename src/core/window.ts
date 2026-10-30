/**
 * 滑动窗口统计：断路器与指标模块共用。
 *
 * 采用「分桶环形缓冲」而不是保留每一个样本：
 * - 内存占用恒定 O(buckets)，与请求量无关；
 * - 统计复杂度 O(1) 摊销，适合放在每次调用的热路径上；
 * - 天然附带时间衰减，老数据会被新桶挤出。
 */

export interface WindowSample {
  total: number;
  failures: number;
  slow: number;
  latencySum: number;
}

/** 基于分桶的滑动窗口计数器。 */
export class SlidingWindow {
  private readonly buckets: WindowSample[];
  private cursor = 0;
  private windowStartMs: number;
  private totals: WindowSample = { total: 0, failures: 0, slow: 0, latencySum: 0 };

  /**
   * @param windowMs 窗口总长度
   * @param bucketCount 分桶数量（越多越精确，也越耗内存）
   */
  constructor(
    private readonly windowMs: number,
    bucketCount: number,
    startMs = 0,
  ) {
    const count = Math.max(1, Math.floor(bucketCount));
    this.buckets = Array.from({ length: count }, () => ({ total: 0, failures: 0, slow: 0, latencySum: 0 }));
    this.windowStartMs = startMs;
  }

  /** 把窗口滚动到 nowMs，丢弃过期分桶。 */
  advance(nowMs: number): void {
    const bucketMs = this.windowMs / this.buckets.length;
    let elapsed = nowMs - this.windowStartMs;
    if (elapsed < bucketMs) return;
    // 跨过的整桶数量
    let steps = Math.floor(elapsed / bucketMs);
    if (steps >= this.buckets.length) {
      this.reset(nowMs);
      return;
    }
    while (steps > 0) {
      const cleared = this.buckets[this.cursor];
      this.totals.total -= cleared.total;
      this.totals.failures -= cleared.failures;
      this.totals.slow -= cleared.slow;
      this.totals.latencySum -= cleared.latencySum;
      cleared.total = 0;
      cleared.failures = 0;
      cleared.slow = 0;
      cleared.latencySum = 0;
      this.cursor = (this.cursor + 1) % this.buckets.length;
      this.windowStartMs += bucketMs;
      elapsed -= bucketMs;
      steps -= 1;
    }
    // 浮点累计误差兜底
    this.totals.total = Math.max(0, this.totals.total);
    this.totals.failures = Math.max(0, Math.min(this.totals.failures, this.totals.total));
    this.totals.slow = Math.max(0, Math.min(this.totals.slow, this.totals.total));
  }

  /**
   * 记录一次调用结果。
   * @param failed 是否失败
   * @param slow 是否超过慢调用阈值
   */
  record(nowMs: number, failed: boolean, slow: boolean, latencyMs = 0): void {
    this.advance(nowMs);
    const bucket = this.buckets[this.cursor];
    bucket.total += 1;
    if (failed) bucket.failures += 1;
    if (slow) bucket.slow += 1;
    bucket.latencySum += latencyMs;
    this.totals.total += 1;
    if (failed) this.totals.failures += 1;
    if (slow) this.totals.slow += 1;
    this.totals.latencySum += latencyMs;
  }

  /** 当前窗口快照（未做浮动修正，约等于最近 windowMs 的统计）。 */
  snapshot(): WindowSample & { failureRate: number; slowRate: number; avgLatencyMs: number } {
    const total = this.totals.total;
    return {
      total,
      failures: this.totals.failures,
      slow: this.totals.slow,
      latencySum: this.totals.latencySum,
      failureRate: total === 0 ? 0 : this.totals.failures / total,
      slowRate: total === 0 ? 0 : this.totals.slow / total,
      avgLatencyMs: total === 0 ? 0 : this.totals.latencySum / total,
    };
  }

  reset(nowMs = 0): void {
    for (const b of this.buckets) {
      b.total = 0;
      b.failures = 0;
      b.slow = 0;
      b.latencySum = 0;
    }
    this.totals = { total: 0, failures: 0, slow: 0, latencySum: 0 };
    this.cursor = 0;
    this.windowStartMs = nowMs;
  }
}
