/**
 * 超时与截止时间传播。
 *
 * 时间线是整个弹性体系里最容易被忽视的一环：如果内层超时之和大于外层
 * 截止时间，那么外层的等待会在真正拿到超时之前耗尽 —— 这就是所谓
 * 「超时倒挂（timeout inversion）」，表现为调用方已经放弃、被调用方还在
 * 空转，白白占用资源。
 *
 * `executeWithTimeout` 同时支持固定时长与绝对截止时间两种语义，
 * 便于上层把剩余预算一路传下去。
 */

import type { Clock } from '../core/clock.js';
import { TimeoutError } from '../core/errors.js';

export interface TimeoutConfig {
  /** 超时时间（毫秒），0 表示不限 */
  timeoutMs: number;
}

export const DEFAULT_TIMEOUT: TimeoutConfig = Object.freeze({ timeoutMs: 0 });

/**
 * 为操作施加超时约束。
 *
 * @param deadlineMs 绝对截止时间（相对 clock.now()），优先级高于 timeoutMs，
 *                   用于把调用链剩余的预算一路传递到下层。
 */
export async function executeWithTimeout<T>(
  operation: (remainingMs: number) => Promise<T> | T,
  config: TimeoutConfig,
  clock: Clock,
  deadlineMs?: number,
): Promise<T> {
  const budget =
    deadlineMs !== undefined
      ? Math.max(0, deadlineMs - clock.now())
      : config.timeoutMs;
  if (budget <= 0) return operation(deadlineMs !== undefined ? 0 : Number.POSITIVE_INFINITY) as never;

  let timer: { cancel(): void } | undefined;
  let timedOut = false;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = clock.setTimeout(() => {
      timedOut = true;
      reject(new TimeoutError(`操作超时: budget=${budget}ms`));
    }, budget);
  });

  try {
    const result = await Promise.race([
      Promise.resolve()
        .then(() => operation(deadlineMs ?? clock.now() + budget))
        .then((value) => value),
      guard,
    ]);
    return result;
  } finally {
    timer?.cancel();
    // 超时后不再关心底层结果，但底层仍应在自己的 deadline 前结束
    void timedOut;
  }
}
