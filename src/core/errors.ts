/**
 * Resilix 错误模型。
 *
 * 重试策略的正确性完全取决于「什么样的失败值得重试」。这里把失败分为
 * 三类，并约定 `retryable` 语义，避免业务代码到处写 `if (e.code === ...)`。
 */

/** 所有 Resilix 抛出的错误的基类。 */
export class ResilixError extends Error {
  /** 稳定性标签，供自定义分类器使用 */
  readonly type: string;

  constructor(message: string, type = 'resilix', options?: { cause?: unknown }) {
    super(message, options as ErrorOptions | undefined);
    this.name = new.target.name;
    this.type = type;
    // 保持原型链在 ES5 目标下也正确
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** 瞬时错误：重试有意义（网络抖动、连接池耗尽、5xx、幂等超时）。 */
export class TransientError extends ResilixError {
  constructor(message = 'transient failure', options?: { cause?: unknown }) {
    super(message, 'transient', options);
  }
}

/** 永久错误：重试毫无意义（参数校验失败、404、401）。 */
export class PermanentError extends ResilixError {
  constructor(message = 'permanent failure', options?: { cause?: unknown }) {
    super(message, 'permanent', options);
  }
}

/** 超时错误：默认可重试，但需调用方确认接口幂等。 */
export class TimeoutError extends ResilixError {
  constructor(message = 'operation timed out', options?: { cause?: unknown }) {
    super(message, 'timeout', options);
  }
}

/**
 * 被弹性策略直接拒绝（未发出底层调用）。
 *
 * 这类「失败」不消耗下游资源，因此在指标统计中会被单独归类为 rejected，
 * 而非 error —— 这正是弹性治理想要的效果：宁可在本地快速失败，
 * 也不要把压力放大到已经出问题的下游。
 */
export class RejectedError extends ResilixError {
  /** 拒绝来源：限流器 / 断路器 / 舱壁 / 超时 */
  readonly by: RejectionReason;

  constructor(by: RejectionReason, message?: string, options?: { cause?: unknown }) {
    super(message ?? `rejected by ${by}`, 'rejected', options);
    this.by = by;
  }
}

export type RejectionReason = 'rate-limit' | 'circuit-breaker' | 'bulkhead' | 'timeout' | 'hedge';

/** 默认分类器：瞬时/超时可重试，永久错误与被拒绝不重试。 */
export function isRetryableByDefault(error: unknown): boolean {
  if (error instanceof RejectedError) return false;
  if (error instanceof PermanentError) return false;
  if (error instanceof TransientError) return true;
  if (error instanceof TimeoutError) return true;
  if (error instanceof Error) {
    const code = (error as { code?: string }).code;
    switch (code) {
      case 'ECONNRESET':
      case 'ECONNREFUSED':
      case 'EPIPE':
      case 'ETIMEDOUT':
      case 'EAI_AGAIN':
      case 'EHOSTUNREACH':
      case 'ENETUNREACH':
      case 'UND_ERR_CONNECT_TIMEOUT':
      case 'UND_ERR_HEADERS_TIMEOUT':
      case 'UND_ERR_BODY_TIMEOUT':
        return true;
      default:
        break;
    }
  }
  return false;
}
