/**
 * 限流器集合。
 *
 * 为什么一口气实现五种？因为「选错限流算法」是线上事故的高频根因：
 * - **令牌桶**：允许突发（ bursts ），形状最自然，网关默认选择；
 * - **漏桶**：恒定速率放行，输出绝对平滑，代价是突发被延迟或丢弃；
 * - **固定窗口**：实现最简单，但在窗口边界处可能放行 2 倍配额（边界效应）；
 * - **滑动计数窗口**：折定方案，用当前+上一窗口加权估算，内存 O(1)；
 * - **滑动日志**：最精确，内存 O(请求数)，适合低频强约束场景。
 *
 * 全部基于抽象 Clock，因此可以在虚拟时间里做百万次验证。
 */

import type { Clock } from '../core/clock.js';

export interface RateLimiter {
  /** 尝试获取 n 个许可，成功返回 true */
  tryConsume(tokens?: number): boolean;
  /** 预计多久后可以有 n 个许可可用（毫秒），0 表示立即可用 */
  retryAfterMs(tokens?: number): number;
  /** 当前可用许可数（可能为小数） */
  available(): number;
}

export const DEFAULT_LIMITER_CHECK_MS = 0;

/** 令牌桶。 */
export interface TokenBucketConfig {
  /** 桶容量，决定允许的瞬时突发量 */
  capacity: number;
  /** 每秒补充的令牌数（稳态速率） */
  refillPerSec: number;
  /** 初始令牌数，默认等于容量 */
  initialTokens?: number;
}

export class TokenBucketLimiter implements RateLimiter {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private readonly config: TokenBucketConfig,
    private readonly clock: Clock,
  ) {
    this.tokens = config.initialTokens ?? config.capacity;
    this.lastRefillMs = clock.now();
  }

  private refill(): void {
    const now = this.clock.now();
    const elapsedSec = Math.max(0, now - this.lastRefillMs) / 1000;
    if (elapsedSec <= 0) return;
    this.tokens = Math.min(this.config.capacity, this.tokens + elapsedSec * this.config.refillPerSec);
    this.lastRefillMs = now;
  }

  tryConsume(tokens = 1): boolean {
    this.refill();
    if (this.tokens >= tokens) {
      this.tokens -= tokens;
      return true;
    }
    return false;
  }

  retryAfterMs(tokens = 1): number {
    this.refill();
    const missing = tokens - this.tokens;
    if (missing <= 0) return 0;
    return Math.ceil((missing / Math.max(this.config.refillPerSec, Number.EPSILON)) * 1000);
  }

  available(): number {
    this.refill();
    return this.tokens;
  }
}

/** 漏桶：以固定间隔放行请求，输出恒定速率。 */
export interface LeakyBucketConfig {
  /** 桶容量 */
  capacity: number;
  /** 每秒漏出的请求数 */
  leakPerSec: number;
}

export class LeakyBucketLimiter implements RateLimiter {
  private water = 0;
  private lastLeakMs: number;

  constructor(
    private readonly config: LeakyBucketConfig,
    private readonly clock: Clock,
  ) {
    this.lastLeakMs = clock.now();
  }

  private leak(): void {
    const now = this.clock.now();
    const elapsedSec = Math.max(0, now - this.lastLeakMs) / 1000;
    if (elapsedSec <= 0) return;
    this.water = Math.max(0, this.water - elapsedSec * this.config.leakPerSec);
    this.lastLeakMs = now;
  }

  tryConsume(tokens = 1): boolean {
    this.leak();
    if (this.water + tokens <= this.config.capacity) {
      this.water += tokens;
      return true;
    }
    return false;
  }

  retryAfterMs(tokens = 1): number {
    this.leak();
    const overflow = this.water + tokens - this.config.capacity;
    if (overflow <= 0) return 0;
    return Math.ceil((overflow / Math.max(this.config.leakPerSec, Number.EPSILON)) * 1000);
  }

  available(): number {
    this.leak();
    return Math.max(0, this.config.capacity - this.water);
  }
}

/** 固定窗口计数。 */
export class FixedWindowLimiter implements RateLimiter {
  private used = 0;
  private windowStartMs: number;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly clock: Clock,
  ) {
    this.windowStartMs = clock.now();
  }

  private roll(): void {
    const now = this.clock.now();
    if (now - this.windowStartMs >= this.windowMs) {
      this.windowStartMs = now - ((now - this.windowStartMs) % this.windowMs);
      this.used = 0;
    }
  }

  tryConsume(tokens = 1): boolean {
    this.roll();
    if (this.used + tokens <= this.limit) {
      this.used += tokens;
      return true;
    }
    return false;
  }

  retryAfterMs(tokens = 1): number {
    this.roll();
    if (this.used + tokens <= this.limit) return 0;
    const elapsed = this.clock.now() - this.windowStartMs;
    return Math.ceil(this.windowMs - elapsed);
  }

  available(): number {
    this.roll();
    return Math.max(0, this.limit - this.used);
  }
}

/**
 * 滑动计数窗口：用上一窗口的剩余时间加权，消除固定窗口的边界效应，
 * 代价 O(1) 内存、约 0.5% 的统计误差。
 */
export class SlidingWindowCounterLimiter implements RateLimiter {
  private prevCount = 0;
  private currCount = 0;
  private windowStartMs: number;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly clock: Clock,
  ) {
    this.windowStartMs = clock.now();
  }

  private roll(): void {
    const now = this.clock.now();
    let elapsed = now - this.windowStartMs;
    while (elapsed >= this.windowMs) {
      this.prevCount = this.currCount;
      this.currCount = 0;
      this.windowStartMs += this.windowMs;
      elapsed -= this.windowMs;
    }
  }

  private estimated(): number {
    const elapsed = Math.max(0, this.clock.now() - this.windowStartMs);
    const weight = 1 - elapsed / this.windowMs;
    return this.currCount + this.prevCount * Math.max(0, weight);
  }

  tryConsume(tokens = 1): boolean {
    this.roll();
    if (this.estimated() + tokens <= this.limit) {
      this.currCount += tokens;
      return true;
    }
    return false;
  }

  retryAfterMs(tokens = 1): number {
    this.roll();
    const head = this.estimated() + tokens - this.limit;
    if (head <= 0) return 0;
    const elapsed = this.clock.now() - this.windowStartMs;
    return Math.ceil((this.windowMs - elapsed) * Math.min(1, head / Math.max(this.limit, 1)) || this.windowMs - elapsed);
  }

  available(): number {
    this.roll();
    return Math.max(0, this.limit - this.estimated());
  }
}

/** 滑动日志：最精确，代价是 O(n) 内存。 */
export class SlidingWindowLogLimiter implements RateLimiter {
  private hits: number[] = [];

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly clock: Clock,
  ) {}

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    let i = 0;
    while (i < this.hits.length && this.hits[i] <= cutoff) i += 1;
    if (i > 0) this.hits.splice(0, i);
  }

  tryConsume(tokens = 1): boolean {
    const now = this.clock.now();
    this.prune(now);
    if (this.hits.length + tokens <= this.limit) {
      for (let i = 0; i < tokens; i += 1) this.hits.push(now);
      return true;
    }
    return false;
  }

  retryAfterMs(tokens = 1): number {
    const now = this.clock.now();
    this.prune(now);
    if (this.hits.length + tokens <= this.limit) return 0;
    const oldest = this.hits[this.hits.length - tokens] ?? this.hits[0] ?? now;
    return Math.ceil(Math.max(0, oldest + this.windowMs - now));
  }

  available(): number {
    this.prune(this.clock.now());
    return Math.max(0, this.limit - this.hits.length);
  }
}

export type LimiterAlgorithm = 'token-bucket' | 'leaky-bucket' | 'fixed-window' | 'sliding-counter' | 'sliding-log';

/** 限流器配置的联合类型。 */
export type LimiterConfig =
  | { algorithm: 'token-bucket'; capacity: number; refillPerSec: number; initialTokens?: number }
  | { algorithm: 'leaky-bucket'; capacity: number; leakPerSec: number }
  | { algorithm: 'fixed-window'; limit: number; windowMs: number }
  | { algorithm: 'sliding-counter'; limit: number; windowMs: number }
  | { algorithm: 'sliding-log'; limit: number; windowMs: number };

/** 依据配置创建对应算法的限流器。 */
export function createLimiter(config: LimiterConfig, clock: Clock): RateLimiter {
  switch (config.algorithm) {
    case 'token-bucket':
      return new TokenBucketLimiter(config, clock);
    case 'leaky-bucket':
      return new LeakyBucketLimiter(config, clock);
    case 'fixed-window':
      return new FixedWindowLimiter(config.limit, config.windowMs, clock);
    case 'sliding-counter':
      return new SlidingWindowCounterLimiter(config.limit, config.windowMs, clock);
    case 'sliding-log':
      return new SlidingWindowLogLimiter(config.limit, config.windowMs, clock);
    default: {
      const never: never = config;
      throw new Error(`未知的限流算法: ${JSON.stringify(never)}`);
    }
  }
}
