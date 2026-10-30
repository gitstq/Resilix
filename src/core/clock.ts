/**
 * 时钟抽象。
 *
 * 所有策略（退避、重试、断路器、限流、舱壁、对冲）都不允许直接触碰
 * `Date.now()` / `setTimeout`，而必须通过 Clock 接口取时间。这样同一套
 * 策略代码既能在生产环境跑真实时钟，也能在模拟器里跑虚拟时钟 ——
 * 几万次请求的策略实验在几十毫秒内算完。
 */

/** 可被取消的定时器句柄。 */
export interface TimerHandle {
  cancel(): void;
}

/** 时钟接口：真实时钟与虚拟时钟的统一抽象。 */
export interface Clock {
  /** 单调递增的逻辑时间（毫秒） */
  now(): number;
  /** 等待 ms 毫秒 */
  sleep(ms: number): Promise<void>;
  /** 延迟 ms 毫秒后触发回调 */
  setTimeout(fn: () => void, ms: number): TimerHandle;
  /** 该时钟是否为虚拟时钟（模拟器会据此调整行为） */
  virtual: boolean;
}

/** 基于 Date.now / 全局 setTimeout 的真实时钟。 */
export function createSystemClock(): Clock {
  const start = Date.now();
  return {
    virtual: false,
    now: () => Date.now() - start,
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    setTimeout: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      return { cancel: () => clearTimeout(timer) };
    },
  };
}

interface QueuedTask {
  time: number;
  seq: number;
  fn: () => void;
}

/**
 * 虚拟时钟 + 离散事件调度器。
 *
 * 实现要点：
 * 1. 事件按 (time, seq) 排序，保证同一时刻的事件按提交顺序执行，结果可复现；
 * 2. 每次推进时间后，用 setImmediate 排空 Promise 微任务队列，
 *    让 await 后续逻辑在「同一虚拟时刻」内跑完；
 * 3. run() 直到队列为空或超出最大步数，避免策略 bug 导致死循环。
 */
export class VirtualClock implements Clock {
  readonly virtual = true;

  private current = 0;
  private seq = 0;
  private tasks: QueuedTask[] = [];
  private stopped = false;

  /** 当前虚拟时间（毫秒） */
  now(): number {
    return this.current;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const time = this.current + Math.max(0, ms);
    this.seq += 1;
    const seq = this.seq;
    const task: QueuedTask = { time, seq, fn };
    // 插入保持有序，任务量不大时比每次全量排序更划算
    let low = 0;
    let high = this.tasks.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      const t = this.tasks[mid];
      if (t.time < time || (t.time === time && t.seq <= seq)) low = mid + 1;
      else high = mid;
    }
    this.tasks.splice(low, 0, task);
    return {
      cancel: () => {
        const idx = this.tasks.indexOf(task);
        if (idx >= 0) this.tasks.splice(idx, 1);
      },
    };
  }

  sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.setTimeout(() => resolve(), ms);
    });
  }

  /** 停止事件循环（用于模拟达到请求配额后优雅收尾）。 */
  stop(): void {
    this.stopped = true;
  }

  /** 队列中尚未执行的事件数量。 */
  pending(): number {
    return this.tasks.length;
  }

  /**
   * 驱动事件循环直到队列彻底排空。
   *
   * 关键点：当队列暂时为空时不能立刻退出 —— 调用方的链式微任务可能马上就会
   * 提交新任务（例如策略层的 await 才刚开始执行）。这里先让出一轮事件循环
   * 排空微任务，若仍无新任务才判定为「排空」。这正是虚拟时钟可以作为
   * 通用 Promise 驱动器的原因。
   *
   * @param maxSteps 安全阀，防止策略实现陷入自调度死循环
   */
  async run(maxSteps = 5_000_000): Promise<void> {
    let steps = 0;
    const drainMicrotasks = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));
    while (!this.stopped && steps < maxSteps) {
      if (this.tasks.length === 0) {
        await drainMicrotasks();
        if (this.tasks.length === 0) break;
        continue;
      }
      let due = this.tasks.filter((t) => t.time <= this.current);
      if (due.length === 0) {
        // 队列里只有「未来」的任务时，不能直接跳到最早那个：
        // 挂起的异步链很可能马上就会提交一个更近的任务（例如重试的第一次退避）。
        // 先排空微任务让这些调度落地，再决定时间是否推进。
        await drainMicrotasks();
        due = this.tasks.filter((t) => t.time <= this.current);
        if (due.length === 0) {
          const next = this.tasks[0];
          if (!next) break;
          this.current = Math.max(this.current, next.time);
          continue;
        }
      }
      for (const task of due) {
        const idx = this.tasks.indexOf(task);
        if (idx >= 0) this.tasks.splice(idx, 1);
      }
      for (const task of due) {
        steps += 1;
        this.current = Math.max(this.current, task.time);
        task.fn();
      }
      await drainMicrotasks();
    }
    this.stopped = false;
  }

  /** 重置虚拟时间与事件队列。 */
  reset(): void {
    this.current = 0;
    this.seq = 0;
    this.tasks = [];
    this.stopped = false;
  }
}
