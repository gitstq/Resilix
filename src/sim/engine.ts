/**
 * 模拟引擎。
 *
 * 核心思想：**闭环（closed-loop）虚拟压测**。
 * N 个虚拟客户端各自「发请求 → 等结果 → 发下一个」，时间由 VirtualClock
 * 推进。于是：
 * - 一分钟能从虚拟时间里跑完几十万次请求；
 * - 同 seed 必得同结果（策略对比可以放心diff）；
 * - 完全离线，不碰网络，CI 里也能跑。
 */

import { VirtualClock } from '../core/clock.js';
import { createRng, type Rng } from '../core/random.js';
import { RejectedError, type RejectionReason } from '../core/errors.js';
import { ResilixStack, type PolicyStackConfig, type StackMetrics } from '../policies/stack.js';
import { createFaultyTransport, type FaultModel } from '../faults/model.js';
import { computeMetrics, type Metrics } from './metrics.js';

export interface ScenarioConfig {
  /** 随机种子，同种子必得同结果 */
  seed?: number | string;
  /** 总请求数 */
  requests: number;
  /** 并发客户端数 */
  concurrency: number;
  /** 每个客户端两次请求之间的间隔（毫秒），默认 0 */
  thinkTimeMs?: number;
  /** 安全阀：虚拟时间上限，防止异常策略导致无限等待 */
  maxVirtualMs?: number;
}

export const DEFAULT_SCENARIO: ScenarioConfig = Object.freeze({
  seed: 42,
  requests: 1000,
  concurrency: 20,
  thinkTimeMs: 0,
  maxVirtualMs: 3_600_000,
});

export type OutcomeKind = 'success' | 'error' | 'rejected';

export interface RequestOutcome {
  id: number;
  startMs: number;
  endMs: number;
  latencyMs: number;
  attempts: number;
  kind: OutcomeKind;
  /** 失败/拒绝原因标签 */
  reason: string;
  /** 底层调用次数（含对冲产生的重复请求） */
  transportCalls: number;
}

export interface SimulationResult {
  policyName: string;
  policy: PolicyStackConfig;
  fault: FaultModel;
  scenario: ScenarioConfig;
  outcomes: RequestOutcome[];
  metrics: Metrics;
  stackMetrics: StackMetrics;
  /** 模拟结束时的虚拟时间 */
  virtualElapsedMs: number;
}

/**
 * 在虚拟时间里跑一次完整的策略 × 故障模型实验。
 */
export async function simulate(
  policy: PolicyStackConfig,
  fault: FaultModel,
  scenario: ScenarioConfig,
): Promise<SimulationResult> {
  const total = Math.max(1, Math.floor(scenario.requests));
  const clients = Math.max(1, Math.floor(scenario.concurrency));
  const thinkTimeMs = Math.max(0, scenario.thinkTimeMs ?? 0);
  const maxVirtualMs = scenario.maxVirtualMs ?? 3_600_000;

  const clock = new VirtualClock();
  const rng: Rng = createRng(scenario.seed ?? 42);
  const ctx = { clock, rng };

  const stack = new ResilixStack(policy, ctx);
  const transport = createFaultyTransport<void>(fault, ctx);

  const outcomes: RequestOutcome[] = [];
  let issued = 0;
  let aborted = false;

  const runOnce = async (id: number): Promise<void> => {
    const startMs = clock.now();
    let attempts = 0;
    // 每个请求的调用次数必须独立计数：并发场景下共享计数会被其他请求污染
    let requestCalls = 0;
    const outcome: RequestOutcome = {
      id,
      startMs,
      endMs: startMs,
      latencyMs: 0,
      attempts: 0,
      kind: 'success',
      reason: 'ok',
      transportCalls: 0,
    };
    try {
      await stack.execute(async (attempt) => {
        attempts = Math.max(attempts, attempt);
        requestCalls += 1;
        return transport(attempt);
      });
      outcome.kind = 'success';
      outcome.reason = 'ok';
    } catch (error) {
      if (error instanceof RejectedError) {
        outcome.kind = 'rejected';
        outcome.reason = error.by;
      } else {
        outcome.kind = 'error';
        outcome.reason = classifyErrorName(error);
      }
    } finally {
      outcome.endMs = clock.now();
      outcome.latencyMs = outcome.endMs - startMs;
      outcome.attempts = Math.max(1, attempts);
      outcome.transportCalls = Math.max(0, requestCalls);
      outcomes.push(outcome);
    }
  };

  const clientLoop = async (): Promise<void> => {
    while (!aborted) {
      if (issued >= total) return;
      const id = issued;
      issued += 1;
      if (clock.now() > maxVirtualMs) {
        aborted = true;
        return;
      }
      await runOnce(id);
      if (thinkTimeMs > 0) await clock.sleep(thinkTimeMs);
    }
  };

  // 注意：事件循环必须与客户端并发启动，否则客户端在等待虚拟时间推进、
  // 而 time driver 又在等待客户端结束 —— 互相等待直接死锁。
  const driver = clock.run();
  const clientTasks = Array.from({ length: clients }, () => clientLoop());
  await Promise.all(clientTasks);
  await driver;

  const virtualElapsedMs = clock.now();
  return {
    policyName: policy.name ?? 'policy',
    policy,
    fault,
    scenario: { ...scenario, seed: scenario.seed ?? 42 },
    outcomes,
    metrics: computeMetrics(outcomes, virtualElapsedMs),
    stackMetrics: stack.metrics(),
    virtualElapsedMs,
  };
}

function classifyErrorName(error: unknown): string {
  if (error instanceof Error) {
    switch (error.name) {
      case 'TransientError':
        return 'transient';
      case 'PermanentError':
        return 'permanent';
      case 'TimeoutError':
        return 'timeout';
      case 'RejectedError':
        return (error as RejectedError).by;
      default:
        return error.name;
    }
  }
  return 'unknown';
}

/** 方便地把多个策略跑在同一故障模型下做横向对比。 */
export async function simulateMany(
  policies: PolicyStackConfig[],
  fault: FaultModel,
  scenario: ScenarioConfig,
): Promise<SimulationResult[]> {
  const results: SimulationResult[] = [];
  for (const policy of policies) {
    // 每个策略使用同一个 seed 从头开始，保证公平
    results.push(await simulate(policy, fault, scenario));
  }
  return results;
}

export type { RejectionReason };
