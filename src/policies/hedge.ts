/**
 * 对冲请求（Hedged Requests）。
 *
 * 源自 Google《The Tail at Scale》：当单个请求的 p99 远高于 p50 时，
 * 与其坐等最慢的那 1%，不如在等待超过某个阈值（通常是 p95/p99）后
 * 立刻发起一次对冲请求，取先返回的结果。
 *
 * 代价是额外负载，因此必须严格限制对冲次数，否则会自我制造拥塞。
 */

import type { Clock, TimerHandle } from '../core/clock.js';

export interface HedgeConfig {
  /** 主请求多久没返回就发起第一个对冲（毫秒），第 n 个对冲延迟为 delayMs * n */
  delayMs: number;
  /** 最多额外发起多少个对冲请求 */
  maxHedges: number;
}

export const DEFAULT_HEDGE: HedgeConfig = Object.freeze({
  delayMs: 200,
  maxHedges: 1,
});

export interface HedgeOutcome<T> {
  value: T;
  /** 实际发起的请求总数（含主请求） */
  requestsSent: number;
  /** 因主请求已返回而未真正发出的对冲数 */
  canceled: number;
}

/**
 * 执行对冲策略：多个请求并发，「先成功者胜」。
 *
 * @param operation 每次调用会收到一个 attempt 序号（0 为主请求）。
 *                  被包装的操作**必须是幂等的**，否则重复副作用由调用方承担。
 * @param shouldHedge 可选谓词，返回 false 时不发起第 n 个对冲
 */
export function executeWithHedge<T>(
  operation: (attempt: number) => Promise<T> | T,
  config: HedgeConfig,
  clock: Clock,
  shouldHedge?: (attempt: number) => boolean,
): Promise<HedgeOutcome<T>> {
  const timers: TimerHandle[] = [];
  const pendingHedges = new Set<TimerHandle>();
  let requestsSent = 0;
  let scheduled = 0;
  let failures = 0;
  let skipped = 0;
  let firstError: unknown;
  let settled = false;

  const cleanup = (): void => {
    for (const t of timers) t.cancel();
  };

  return new Promise<HedgeOutcome<T>>((resolve, reject) => {
    const run = (attempt: number): void => {
      scheduled += 1;
      requestsSent += 1;
      Promise.resolve()
        .then(() => operation(attempt))
        .then((value) => {
          if (settled) return;
          settled = true;
          cleanup();
          skipped += pendingHedges.size;
          resolve({ value, requestsSent, canceled: skipped });
        })
        .catch((error) => {
          if (settled) return;
          failures += 1;
          if (failures === 1) firstError = error;
          if (failures >= scheduled && !settled) {
            settled = true;
            cleanup();
            reject(firstError ?? new Error('hedged request failed'));
          }
        });
    };

    run(0);

    for (let h = 1; h <= Math.max(0, config.maxHedges); h += 1) {
      if (shouldHedge && !shouldHedge(h)) continue;
      const attempt = h;
      const handle = clock.setTimeout(() => {
        pendingHedges.delete(handle);
        if (settled) return;
        run(attempt);
      }, config.delayMs * h);
      pendingHedges.add(handle);
      timers.push(handle);
    }

    // 极端情况：主请求已调度但所有对冲都被禁用，仍需等待主请求结果；
    // 若主请求也不存在（shouldHedge 为假且无主请求）是不可能的，故此处不处理。
  });
}
