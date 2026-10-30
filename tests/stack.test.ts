import test from 'node:test';
import assert from 'node:assert/strict';
import { VirtualClock } from '../src/core/clock.js';
import { createRng } from '../src/core/random.js';
import { ResilixStack, detectTimeoutInversion } from '../src/policies/stack.js';
import { TransientError, PermanentError, TimeoutError, RejectedError } from '../src/core/errors.js';
import { getPolicyPreset } from '../src/presets.js';
import type { PolicyStackConfig } from '../src/policies/stack.js';

const build = (policy: PolicyStackConfig = getPolicyPreset('balanced')) => {
  const clock = new VirtualClock();
  const rng = createRng('seed');
  return { clock, rng, stack: new ResilixStack(policy, { clock, rng }) };
};

/**
 * 立即挂上结果处理器，再驱动虚拟时钟。
 * 这样即便 Promise 在 run() 期间就 settle，也不会被判定为未处理拒绝。
 */
async function settle<T>(clock: VirtualClock, promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  const probe = promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  await clock.run();
  return probe;
}

test('瞬时失败会按配置重试并最终成功', async () => {
  const { clock, stack } = build({
    name: 'retry-then-win',
    timeoutMs: 5000,
    retry: {
      maxAttempts: 3,
      // 预算语义：每 1 次正常请求挣得 retryBudgetRatio 点额度，每次重试消耗 1 点
      // 因此要支撑 2 次重试，额度需要 ≥ 2
      backoff: { baseMs: 10, multiplier: 2, maxMs: 100, jitter: 'none' },
      retryBudgetRatio: 2,
      retryBudgetWindowMs: 1000,
      maxElapsedMs: 0,
    },
  });
  let calls = 0;
  const outcome = await settle(
    clock,
    stack.execute(() => {
      calls += 1;
      if (calls < 3) return Promise.reject(new TransientError('flaky'));
      return Promise.resolve('done');
    }),
  );
  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.value, 'done');
  assert.equal(calls, 3);
});

test('永久错误不会被重试', async () => {
  const { clock, stack } = build();
  let calls = 0;
  const outcome = await settle(
    clock,
    stack.execute(() => {
      calls += 1;
      return Promise.reject(new PermanentError('nope'));
    }),
  );
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.ok(outcome.error instanceof PermanentError);
  assert.equal(calls, 1);
});

test('超出外层超时会被 TimeoutError 截断', async () => {
  const { clock, stack } = build({ name: 'slow', timeoutMs: 100, retry: undefined });
  const outcome = await settle(clock, stack.execute(() => clock.sleep(1000).then(() => 'late')));
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.ok(outcome.error instanceof TimeoutError);
});

test('限流器用尽配额后本地拒绝', async () => {
  const { clock, stack } = build({
    name: 'limited',
    limiter: { algorithm: 'token-bucket', capacity: 2, refillPerSec: 1 },
  });
  let calls = 0;
  const results = await Promise.all(
    Array.from({ length: 4 }, () =>
      settle(
        clock,
        stack.execute(() => {
          calls += 1;
          return Promise.resolve('ok');
        }),
      ),
    ),
  );
  assert.equal(calls, 2, '只有拿到令牌的请求才会真正下发');
  assert.equal(results.filter((r) => !r.ok && r.error instanceof RejectedError).length, 2);
  assert.equal(stack.metrics().rejectedBy['rate-limit'], 2);
});

test('重试预算耗尽后停止重试', async () => {
  const { clock, stack } = build({
    name: 'budget',
    timeoutMs: 10_000,
    retry: {
      maxAttempts: 5,
      backoff: { baseMs: 1, multiplier: 2, maxMs: 10, jitter: 'none' },
      retryBudgetRatio: 0.05,
      retryBudgetWindowMs: 1000,
      maxElapsedMs: 0,
    },
  });
  let calls = 0;
  const outcome = await settle(
    clock,
    stack.execute(() => {
      calls += 1;
      return Promise.reject(new TransientError('always'));
    }),
  );
  assert.equal(outcome.ok, false);
  assert.ok(calls >= 1 && calls <= 3, `预算应显著限制重试次数，实际 ${calls}`);
});

test('断路器在持续失败后熔断，停止下发底层调用', async () => {
  const { clock, stack } = build({
    name: 'trip',
    timeoutMs: 5000,
    breaker: {
      windowMs: 1000,
      bucketCount: 5,
      minimumCalls: 4,
      failureRateThreshold: 0.5,
      slowCallRateThreshold: 1,
      slowCallMs: 1000,
      openWaitMs: 1000,
      halfOpenMaxCalls: 1,
    },
  });
  let calls = 0;
  let rejected = 0;
  for (let i = 0; i < 6; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const outcome = await settle(
      clock,
      stack.execute(() => {
        calls += 1;
        return Promise.reject(new TransientError('down'));
      }),
    );
    if (!outcome.ok && outcome.error instanceof RejectedError) rejected += 1;
  }
  assert.ok(calls < 6, `熔断后应停止下发，实际下发 ${calls} 次`);
  assert.ok(rejected > 0, '应至少产生一次本地拒绝');
  assert.equal(stack.metrics().breaker?.state, 'open');
});

test('detectTimeoutInversion 能识别超时倒挂', () => {
  const ok = detectTimeoutInversion({
    timeoutMs: 100,
    retry: {
      maxAttempts: 4,
      backoff: { baseMs: 100, multiplier: 2, maxMs: 5000, jitter: 'equal' },
      retryBudgetRatio: 0.2,
      retryBudgetWindowMs: 1000,
      maxElapsedMs: 0,
    },
  });
  assert.equal(ok, true);
});

test('正常配置不会被判为倒挂', () => {
  assert.equal(detectTimeoutInversion(getPolicyPreset('balanced')), false);
});
