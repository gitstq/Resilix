/**
 * 舱壁隔离（Bulkhead）。
 *
 * 名字取自船舶的防水舱壁：把资源切成互不相通的格子，
 * 一个格子进水不会让整艘船沉没。在微服务调用里，它表现为
 * 「对某个下游的并发上限」—— 即使该下游慢到不可用，
 * 调用方也只会耗尽这一个格子，其余能力不受影响。
 */

import type { Clock } from '../core/clock.js';
import { RejectedError } from '../core/errors.js';

export interface BulkheadConfig {
  /** 最大并发数 */
  maxConcurrent: number;
  /** 等待队列长度上限，0 表示不排队（超出并发立即拒绝） */
  maxQueue: number;
  /** 队列中最长等待时间（毫秒），超时则拒绝 */
  queueTimeoutMs: number;
}

export const DEFAULT_BULKHEAD: BulkheadConfig = Object.freeze({
  maxConcurrent: 32,
  maxQueue: 64,
  queueTimeoutMs: 200,
});

interface Waiter {
  resolveGranted: () => void;
  reject: (err: unknown) => void;
  handle: { cancel(): void };
  enqueuedAt: number;
}

/** 并发隔离器。 */
export class Bulkhead {
  private active = 0;
  private queue: Waiter[] = [];
  private rejected = 0;
  private maxObservedConcurrency = 0;

  constructor(
    private readonly config: BulkheadConfig,
    private readonly clock: Clock,
  ) {}

  /** 获取当前正在执行的调用数。 */
  running(): number {
    return this.active;
  }

  /** 获取当前排队等待的调用数。 */
  waiting(): number {
    return this.queue.length;
  }

  /** 累计被拒绝次数与观测到的最大并发。 */
  stats(): { rejected: number; maxObservedConcurrency: number } {
    return { rejected: this.rejected, maxObservedConcurrency: this.maxObservedConcurrency };
  }

  /**
   * 获取一个执行许可；如果超出并发与队列上限则抛出 RejectedError。
   */
  async acquire(): Promise<void> {
    if (this.active < this.config.maxConcurrent) {
      this.active += 1;
      this.maxObservedConcurrency = Math.max(this.maxObservedConcurrency, this.active);
      return;
    }
    if (this.queue.length >= this.config.maxQueue) {
      this.rejected += 1;
      throw new RejectedError('bulkhead', '舱壁已满：超出并发上限且队列已占满');
    }
    return new Promise<void>((resolve, reject) => {
      const enqueuedAt = this.clock.now();
      const waitMs = this.config.queueTimeoutMs > 0 ? this.config.queueTimeoutMs : Number.POSITIVE_INFINITY;
      const entry: Waiter = {
        resolveGranted: () => resolve(),
        reject,
        enqueuedAt,
        handle: undefined as unknown as { cancel(): void },
      };
      const handle = this.clock.setTimeout(() => {
        const idx = this.queue.indexOf(entry);
        if (idx >= 0) {
          this.queue.splice(idx, 1);
          this.rejected += 1;
          reject(new RejectedError('bulkhead', '舱壁排队超时'));
        }
      }, waitMs);
      entry.handle = handle;
      this.queue.push(entry);
    });
  }

  /** 释放一个许可并唤醒队首等待者。 */
  release(): void {
    const next = this.queue.shift();
    if (next) {
      next.handle.cancel();
      next.resolveGranted();
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }
}

/** 用舱壁包裹一个操作。 */
export async function executeWithBulkhead<T>(
  bulkhead: Bulkhead,
  operation: () => Promise<T> | T,
): Promise<T> {
  await bulkhead.acquire();
  try {
    return await operation();
  } finally {
    bulkhead.release();
  }
}
