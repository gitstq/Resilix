/**
 * 重试退避计算。
 *
 * 「怎么退避」是弹性治理里性价比最高、也最容易写错的一块：
 * - 不退避 → 下游刚喘口气就被第二轮重试打死；
 * - 指数增长过快 → 有效重试窗口被浪费在等待上，尾延迟爆炸；
 * - 没有抖动 → 成千上万调用同时苏醒，制造新一轮尖峰（惊群）。
 *
 * 这里实现了业界四种主流策略，全部可在虚拟时钟下确定性复现。
 */

import type { Rng } from '../core/random.js';

/** 抖动策略。 */
export type JitterStrategy =
  /** 严格指数增长，无随机性 —— 仅供对照实验使用，生产禁用。 */
  | 'none'
  /** 完全抖动：实际等待 = random(0, 指数值)。抖动最大、尖峰最平滑。 */
  | 'full'
  /** 半抖动：占一半确定性，兼顾可预测性与去同步。 */
  | 'equal'
  /** 去相关抖动：等待 = random(base, 上一次实际等待 * 3)，AWS 架构博客推荐。 */
  | 'decorrelated';

export interface BackoffConfig {
  /** 首次重试的基准等待（毫秒） */
  baseMs: number;
  /** 指数底数，典型值 2 */
  multiplier: number;
  /** 单次等待上限（毫秒），防止退避失控 */
  maxMs: number;
  /** 抖动策略 */
  jitter: JitterStrategy;
}

export const DEFAULT_BACKOFF: BackoffConfig = Object.freeze({
  baseMs: 50,
  multiplier: 2,
  maxMs: 5000,
  jitter: 'equal',
});

/**
 * 退避计算器。
 *
 * 有状态：去相关抖动依赖上一次等待值；同一次调用链应当复用同一个实例，
 * 不同调用链之间必须隔离（否则会互相污染 prev）。
 */
export class BackoffCalculator {
  private previous = 0;

  constructor(
    private readonly config: BackoffConfig,
    private readonly rng: Rng,
  ) {}

  /**
   * 计算第 attempt 次重试（attempt 从 1 开始）应等待的毫秒数。
   */
  next(): number {
    const cfg = this.config;
    // 先算当前应选的「指数台阶」
    const step = this.previous === 0 ? cfg.baseMs : Math.min(this.previous * cfg.multiplier, cfg.maxMs);
    let waitMs = step;
    switch (cfg.jitter) {
      case 'none':
        break;
      case 'full':
        waitMs = this.rng.uniform(0, step);
        break;
      case 'equal':
        waitMs = step / 2 + this.rng.uniform(0, step / 2);
        break;
      case 'decorrelated': {
        const prev = this.lastWait();
        waitMs = Math.min(cfg.maxMs, this.rng.uniform(cfg.baseMs, prev * 3 || cfg.baseMs * 3));
        break;
      }
      default: {
        const never: never = cfg.jitter;
        throw new Error(`未知的抖动策略: ${String(never)}`);
      }
    }
    this.previous = step;
    this.lastValue = Math.max(0, Math.min(waitMs, cfg.maxMs));
    return this.lastValue;
  }

  private lastValue = 0;

  private lastWait(): number {
    return this.lastValue > 0 ? this.lastValue : this.config.baseMs;
  }

  /** 重置内部状态，开始一条新的调用链。 */
  reset(): void {
    this.previous = 0;
    this.lastValue = 0;
  }
}

/** 无状态地计算单次等待值，适用于只需要「某一阶退避」的场景。 */
export function computeBackoff(config: BackoffConfig, attempt: number, rng: Rng): number {
  if (attempt <= 0) return 0;
  const raw = Math.min(config.baseMs * Math.pow(config.multiplier, attempt - 1), config.maxMs);
  switch (config.jitter) {
    case 'none':
      return raw;
    case 'full':
      return rng.uniform(0, raw);
    case 'equal':
      return raw / 2 + rng.uniform(0, raw / 2);
    case 'decorrelated': {
      const prev = Math.min(config.baseMs * Math.pow(config.multiplier, Math.max(0, attempt - 2)), config.maxMs);
      return Math.min(config.maxMs, rng.uniform(config.baseMs, Math.max(prev, config.baseMs) * 3));
    }
    default:
      return raw;
  }
}

/**
 * 列出给定配置的理论退避序列（取中位 / 期望值），用于文档与 CLI 预览。
 */
export function backoffSchedule(config: BackoffConfig, attempts: number): number[] {
  // 使用固定种子，保证预览结果稳定
  let seed = 0x2545f491;
  const rand = (): number => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng: Rng = {
    next: rand,
    uniform: (min, max) => min + rand() * (max - min),
    int: (maxExclusive) => Math.floor(rand() * maxExclusive),
    bool: (p) => rand() < p,
    state: () => seed >>> 0,
  };
  const calc = new BackoffCalculator(config, rng);
  const out: number[] = [];
  for (let i = 0; i < attempts; i += 1) out.push(Math.round(calc.next()));
  return out;
}
