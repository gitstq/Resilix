/**
 * 确定性随机数发生器与延迟采样。
 *
 * Resilix 的模拟器必须「同种子同结果」：给定相同 seed，任意环境下的
 * 模拟结果必须逐位可复现，否则策略 A/B 对比将失去意义。
 *
 * 因此这里不使用 Math.random，而是实现了可复现的 mulberry32 / splitmix32
 * 伪随机数发生器，并在此之上构建常用的延迟分布采样器。
 */

/** 最小可用的随机数发生器接口。所有方法均返回 [0, 1) 区间的双精度数。 */
export interface Rng {
  /** 下一个 [0,1) 随机数 */
  next(): number;
  /** [min, max) 区间的均匀分布 */
  uniform(min: number, max: number): number;
  /** [0, maxExclusive) 区间的整数 */
  int(maxExclusive: number): number;
  /** 以概率 p 返回 true */
  bool(p: number): boolean;
  /** 当前内部状态，便于持久化 / 复现到某一时刻 */
  state(): number;
}

/** 把字符串或数字种子规范化为 32 位无符号种子。 */
export function normalizeSeed(seed: number | string | undefined): number {
  if (seed === undefined) return 0x9e3779b9;
  if (typeof seed === 'number' && Number.isFinite(seed)) {
    const truncated = Math.trunc(seed) >>> 0;
    return truncated === 0 ? 0x6d2b79f5 : truncated;
  }
  const raw = String(seed);
  // FNV-1a 32 位变体：足够均匀地打散字符串种子
  let h = 0x811c9dc5;
  for (let i = 0; i < raw.length; i += 1) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0 || 0x9e3779b9;
}

/**
 * mulberry32：32 位状态的极快 PRNG，周期足够模拟器使用，
 * 且实现简单便于跨语言移植（Python / Go / Rust 端口只需十行）。
 */
export function mulberry32(seed: number | string | undefined): Rng {
  let a = normalizeSeed(seed);
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    uniform: (min, max) => min + next() * (max - min),
    int: (maxExclusive) => Math.floor(next() * maxExclusive),
    bool: (p) => next() < p,
    state: () => a >>> 0,
  };
}

/** splitmix32：状态打散更彻底的备选发生器。 */
export function splitmix32(seed: number | string | undefined): Rng {
  let a = normalizeSeed(seed);
  const next = (): number => {
    a = (a + 0x9e3779b9) >>> 0;
    let z = a;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    z = (z ^ (z >>> 15)) >>> 0;
    return z / 4294967296;
  };
  return {
    next,
    uniform: (min, max) => min + next() * (max - min),
    int: (maxExclusive) => Math.floor(next() * maxExclusive),
    bool: (p) => next() < p,
    state: () => a >>> 0,
  };
}

/** 创建随机数发生器。kind 省略时使用 mulberry32。 */
export function createRng(seed: number | string | undefined, kind: 'mulberry32' | 'splitmix32' = 'mulberry32'): Rng {
  return kind === 'splitmix32' ? splitmix32(seed) : mulberry32(seed);
}

/** 标准正态分布采样（Box-Muller 变换）。 */
export function gaussian(rng: Rng): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng.next();
  while (v === 0) v = rng.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * 延迟分布模型。模拟器用它刻画「下游服务到底有多快 / 多抖」。
 *
 * - constant：常量延迟，用于构造确定性基线场景
 * - uniform：均匀分布，模拟抖动范围明确的环境
 * - lognormal：对数正态，最贴近真实服务延迟（长尾但均值为正）
 * - pareto：帕累托，模拟极端长尾 / 尾部 hullabaloo（p99 是 p50 的几十倍）
 * - bimodal：双峰，模拟「命中缓存 vs 落盘」的混合路径
 */
export type LatencyDistribution =
  | { kind: 'constant'; valueMs: number }
  | { kind: 'uniform'; minMs: number; maxMs: number }
  | { kind: 'lognormal'; medianMs: number; sigma: number }
  | { kind: 'pareto'; minMs: number; shape: number }
  | { kind: 'bimodal'; fastMs: number; slowMs: number; slowRatio: number };

/** 采样一次延迟，结果保证非负且有限。 */
export function sampleLatency(dist: LatencyDistribution, rng: Rng): number {
  const clamp = (v: number): number => {
    if (!Number.isFinite(v) || v < 0) return 0;
    // 上限 10 分钟：避免帕累托采样出「一天」这种失控值
    return Math.min(v, 600000);
  };
  switch (dist.kind) {
    case 'constant':
      return clamp(dist.valueMs);
    case 'uniform':
      return clamp(rng.uniform(Math.min(dist.minMs, dist.maxMs), Math.max(dist.minMs, dist.maxMs)));
    case 'lognormal':
      return clamp(dist.medianMs * Math.exp(dist.sigma * gaussian(rng)));
    case 'pareto': {
      const u = Math.max(rng.next(), Number.EPSILON);
      return clamp(dist.minMs / Math.pow(u, 1 / Math.max(dist.shape, 0.05)));
    }
    case 'bimodal': {
      const slow = rng.bool(Math.min(Math.max(dist.slowRatio, 0), 1));
      return clamp(slow ? dist.slowMs : dist.fastMs);
    }
    default: {
      const never: never = dist;
      throw new Error(`未知的延迟分布: ${JSON.stringify(never)}`);
    }
  }
}

/** 返回一个描述性的分布摘要，用于报告输出。 */
export function describeDistribution(dist: LatencyDistribution): string {
  switch (dist.kind) {
    case 'constant':
      return `constant(${dist.valueMs}ms)`;
    case 'uniform':
      return `uniform(${dist.minMs}~${dist.maxMs}ms)`;
    case 'lognormal':
      return `lognormal(median=${dist.medianMs}ms, sigma=${dist.sigma})`;
    case 'pareto':
      return `pareto(min=${dist.minMs}ms, shape=${dist.shape})`;
    case 'bimodal':
      return `bimodal(${dist.fastMs}ms / ${dist.slowMs}ms @${(dist.slowRatio * 100).toFixed(1)}%)`;
    default:
      return 'unknown';
  }
}
