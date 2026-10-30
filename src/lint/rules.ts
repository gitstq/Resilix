/**
 * 弹性策略静态检查规则库。
 *
 * 静态检查的价值在于：很多弹性缺陷在压测中也未必暴露，却会在某次
 * 大促/故障恢复时突然爆雷。这些缺陷几乎都是**配置形态级别**的，
 * 完全可以在提交前用规则扫出来 —— 这就是「策略界的 ESLint」。
 *
 * 每条规则都给出三件事：为什么危险、怎么改、违反了哪一条合同约定。
 */

import type { PolicyStackConfig } from '../policies/stack.js';
import { detectTimeoutInversion } from '../policies/stack.js';

export type Severity = 'error' | 'warn' | 'info';

export interface LintContextInput {
  policy: PolicyStackConfig;
  /** 调用方自身的超时预算（毫秒） */
  callerTimeoutMs?: number;
  /** 该调用对应的 HTTP 方法 / 是否幂等，用于识别不可重试的写操作 */
  httpMethod?: string;
  /** 下游服务实测容量（req/s），用于校验限流器是否真的起了保护作用 */
  serviceCapacityRps?: number;
  /** 调用方进程能提供的并发上限 */
  maxConcurrency?: number;
}

export interface Diagnostic {
  id: string;
  severity: Severity;
  title: string;
  why: string;
  fix: string;
  path: string;
}

interface Rule {
  id: string;
  check(input: LintContextInput): Omit<Diagnostic, 'id'> | null;
}

const NON_IDEMPOTENT = new Set(['POST', 'PATCH']);

export const RULES: Rule[] = [
  {
    id: 'RX001',
    check: ({ policy }) => {
      const retry = policy.retry;
      if (!retry || retry.maxAttempts <= 1) return null;
      if (retry.backoff.jitter !== 'none') return null;
      return {
        severity: 'error',
        title: '重试未开启抖动',
        why: '所有客户端会在完全相同的时刻苏醒重试，形成周期性尖峰（惊群），把刚刚恢复的下游再次打垮。',
        fix: "把 retry.backoff.jitter 设为 'equal'（兼顾可预测性）或 'full'（抖动最大）。",
        path: 'retry.backoff.jitter',
      };
    },
  },
  {
    id: 'RX002',
    check: ({ policy }) => {
      const retry = policy.retry;
      if (!retry || retry.maxAttempts <= 1) return null;
      if (retry.backoff.multiplier < 3) return null;
      return {
        severity: 'warn',
        title: '指数退避底数过大',
        why: `multiplier=${retry.backoff.multiplier} 会让第 2 次重试就等待 ${retry.backoff.baseMs * retry.backoff.multiplier}ms，重试窗口迅速被等待吞掉，p99 恶化。`,
        fix: '建议 multiplier 取 2（二进制指数退避），需要更长的等待时提高 maxMs 而不是底数。',
        path: 'retry.backoff.multiplier',
      };
    },
  },
  {
    id: 'RX003',
    check: ({ policy }) => {
      const retry = policy.retry;
      if (!retry || retry.maxAttempts <= 1) return null;
      if (retry.maxAttempts <= 5) return null;
      return {
        severity: 'warn',
        title: '重试次数过多',
        why: `maxAttempts=${retry.maxAttempts} 意味着单个请求可能占用 ${retry.maxAttempts} 倍的资源与时间；在有界线程池/连接池里这等价于资源放大。`,
        fix: '一般内部调用 2~3 次足够；需要更多重试时应先确认下游的恢复时间分布。',
        path: 'retry.maxAttempts',
      };
    },
  },
  {
    id: 'RX004',
    check: ({ policy }) => {
      const retry = policy.retry;
      if (!retry || retry.maxAttempts <= 1) return null;
      if (retry.retryBudgetRatio > 0) return null;
      return {
        severity: 'error',
        title: '缺少重试预算',
        why: '没有预算的重试允许 100% 的请求同时重试，下游一次小抖动就会被放大成双倍流量 —— 这是级联故障最常见的放大器。',
        fix: '设置 retry.retryBudgetRatio（推荐 0.1~0.2）与 retryBudgetWindowMs，把重试占比限制在一个可控比例内。',
        path: 'retry.retryBudgetRatio',
      };
    },
  },
  {
    id: 'RX005',
    check: ({ policy }) => {
      const retry = policy.retry;
      if (!retry || retry.retryBudgetRatio <= 0) return null;
      if (retry.retryBudgetRatio <= 0.5) return null;
      return {
        severity: 'warn',
        title: '重试预算过于宽松',
        why: `预算比 ${retry.retryBudgetRatio} 意味着重试流量最高可达正常流量的 ${Math.round(retry.retryBudgetRatio * 100)}%，保护作用有限。`,
        fix: '推荐 0.1~0.2；确需更高预算时请配合断路器与舱壁使用。',
        path: 'retry.retryBudgetRatio',
      };
    },
  },
  {
    id: 'RX006',
    check: ({ policy }) => {
      const retry = policy.retry;
      if (!retry || retry.maxAttempts <= 1) return null;
      if (policy.timeoutMs && policy.timeoutMs > 0) return null;
      return {
        severity: 'error',
        title: '启用重试却没有总超时',
        why: '没有外层超时时，一次调用可能无限期地重试下去，调用方资源被长期占用，最终表现为进程级「假死」。',
        fix: '显式设置 policy.timeoutMs（应小于调用方自身的超时预算）。',
        path: 'timeoutMs',
      };
    },
  },
  {
    id: 'RX007',
    check: ({ policy }) => {
      if (!detectTimeoutInversion(policy)) return null;
      return {
        severity: 'error',
        title: '检测到超时倒挂',
        why: '内层各层的等待预算之和已经超过最外层超时，外层必然先超时，内层所有等待（包括重试）都成了无效功。',
        fix: '要么提高外层 timeoutMs，要么压缩 maxAttempts / 退避上限 / 队列超时。',
        path: 'timeoutMs',
      };
    },
  },
  {
    id: 'RX008',
    check: ({ policy }) => {
      const breaker = policy.breaker;
      if (!breaker || !policy.timeoutMs) return null;
      if (breaker.slowCallMs < policy.timeoutMs) return null;
      return {
        severity: 'warn',
        title: '慢调用阈值不小于外层超时',
        why: `slowCallMs=${breaker.slowCallMs} 大于等于 timeoutMs=${policy.timeoutMs}，请求会先被外层超时拦掉，断路器永远收集不到慢调用样本，慢调用断路形同虚设。`,
        fix: '把 slowCallMs 设为明显小于外层超时（例如 60%~80%），或降低 slowCallRateThreshold 依赖失败率断路。',
        path: 'breaker.slowCallMs',
      };
    },
  },
  {
    id: 'RX009',
    check: ({ policy }) => {
      const breaker = policy.breaker;
      if (!breaker) return null;
      if (breaker.minimumCalls >= 10) return null;
      return {
        severity: 'warn',
        title: '断路器最小样本量过小',
        why: `minimumCalls=${breaker.minimumCalls} 时，少量失败（甚至一次）就能触发断路，容易在正常抖动下误伤。`,
        fix: '建议 minimumCalls ≥ 20，或把统计窗口与业务 QPS 对齐后重新估算。',
        path: 'breaker.minimumCalls',
      };
    },
  },
  {
    id: 'RX010',
    check: ({ policy }) => {
      const limiter = policy.limiter;
      if (!limiter || limiter.algorithm !== 'token-bucket') return null;
      const burstSeconds = limiter.capacity / Math.max(limiter.refillPerSec, Number.EPSILON);
      if (burstSeconds <= 5) return null;
      return {
        severity: 'warn',
        title: '令牌桶突发窗口过长',
        why: `桶容量可支撑 ${burstSeconds.toFixed(1)}s 的满速突发，突发期间对下游的保护几乎失效。`,
        fix: '把 capacity 收敛到「稳态速率 × 可接受的突发时长」（通常 1~2 秒）。',
        path: 'limiter.capacity',
      };
    },
  },
  {
    id: 'RX011',
    check: ({ policy, maxConcurrency }) => {
      const bulkhead = policy.bulkhead;
      if (!bulkhead || maxConcurrency === undefined) return null;
      if (bulkhead.maxConcurrent <= maxConcurrency) return null;
      return {
        severity: 'warn',
        title: '舱壁并发上限超过进程能力',
        why: `maxConcurrent=${bulkhead.maxConcurrent} 大于进程实际并发能力 ${maxConcurrency}，舱壁在关键时刻起不到限流作用。`,
        fix: '把 maxConcurrent 设置为略小于进程/连接池的实际上限。',
        path: 'bulkhead.maxConcurrent',
      };
    },
  },
  {
    id: 'RX012',
    check: ({ policy }) => {
      const hedge = policy.hedge;
      if (!hedge || hedge.maxHedges <= 0) return null;
      if (hedge.maxHedges <= 1) return null;
      return {
        severity: 'warn',
        title: '对冲请求次数偏多',
        why: `maxHedges=${hedge.maxHedges} 会让每个慢请求最多发出 ${hedge.maxHedges + 1} 次调用，负载放大显著，可能自我制造拥塞。`,
        fix: '通常 1 次对冲足够；确需多次时应同时降低 delayMs 间隔并确保下游有余量。',
        path: 'hedge.maxHedges',
      };
    },
  },
  {
    id: 'RX013',
    check: ({ policy }) => {
      const retry = policy.retry;
      if (!retry || retry.maxAttempts <= 1) return null;
      if (policy.breaker) return null;
      return {
        severity: 'info',
        title: '有重试但没有断路器',
        why: '下游持续不可用时，重试会把每个请求都拖到超时为止，调用方资源被耗尽 —— 这正是级联故障的传播路径。',
        fix: '补一层断路器：让调用方在下游不可用时本地快速失败，而不是陪它一起慢。',
        path: 'breaker',
      };
    },
  },
  {
    id: 'RX014',
    check: ({ policy }) => {
      const retry = policy.retry;
      if (!retry || retry.maxAttempts <= 1) return null;
      if (retry.backoff.maxMs >= retry.backoff.baseMs * 4) return null;
      return {
        severity: 'warn',
        title: '退避上限过小',
        why: `maxMs=${retry.backoff.maxMs} 相对 baseMs=${retry.backoff.baseMs} 太小，指数增长几乎立刻触顶，退避退化为「固定间隔」。`,
        fix: '让 maxMs 至少是 baseMs 的 8~16 倍，使前几次退避真正呈现指数形态。',
        path: 'retry.backoff.maxMs',
      };
    },
  },
  {
    id: 'RX015',
    check: ({ policy, httpMethod }) => {
      const retry = policy.retry;
      if (!retry || retry.maxAttempts <= 1 || !httpMethod) return null;
      const method = httpMethod.toUpperCase();
      if (!NON_IDEMPOTENT.has(method)) return null;
      return {
        severity: 'error',
        title: '对非幂等方法启用了重试',
        why: `${method} 默认不是幂等操作，重试可能造成重复下单/重复扣款等副作用。`,
        fix: '为接口补充幂等键（Idempotency-Key）并确认服务端支持，或对该路径关闭重试。',
        path: 'retry.maxAttempts',
      };
    },
  },
  {
    id: 'RX016',
    check: ({ policy, callerTimeoutMs }) => {
      if (!callerTimeoutMs || !policy.timeoutMs) return null;
      if (policy.timeoutMs < callerTimeoutMs) return null;
      return {
        severity: 'error',
        title: '自身超时不小于调用方超时',
        why: `timeoutMs=${policy.timeoutMs} ≥ 调用方超时 ${callerTimeoutMs}，调用方早已放弃而你还在占用资源，属于典型的超时倒挂。`,
        fix: '把 timeoutMs 设为调用方超时的 60%~80%，给上层留出决策空间。',
        path: 'timeoutMs',
      };
    },
  },
  {
    id: 'RX017',
    check: ({ policy, serviceCapacityRps }) => {
      const limiter = policy.limiter;
      if (!limiter || serviceCapacityRps === undefined) return null;
      const configured =
        limiter.algorithm === 'token-bucket'
          ? limiter.refillPerSec
          : limiter.algorithm === 'leaky-bucket'
            ? limiter.leakPerSec
            : limiter.limit / (limiter.windowMs / 1000);
      if (configured <= serviceCapacityRps) return null;
      return {
        severity: 'warn',
        title: '限流配额高于下游容量',
        why: `限流器允许 ${configured.toFixed(1)} req/s，而下游容量仅 ${serviceCapacityRps} req/s，限流器无法在过载时保护下游。`,
        fix: '把配额下调到下游容量的 70%~90%，留出突发余量。',
        path: 'limiter',
      };
    },
  },
];
