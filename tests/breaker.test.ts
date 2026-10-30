import test from 'node:test';
import assert from 'node:assert/strict';
import { VirtualClock } from '../src/core/clock.js';
import { CircuitBreaker, DEFAULT_BREAKER, executeWithBreaker } from '../src/policies/breaker.js';
import { TransientError, RejectedError } from '../src/core/errors.js';

const config = { ...DEFAULT_BREAKER, minimumCalls: 5, failureRateThreshold: 0.5, windowMs: 1000, openWaitMs: 1000 };

test('样本不足时不断路', () => {
  const clock = new VirtualClock();
  const breaker = new CircuitBreaker(config, clock);
  for (let i = 0; i < 4; i += 1) breaker.recordFailure(10);
  assert.equal(breaker.getState(), 'closed');
});

test('失败率超阈值后进入 OPEN，冷却期后转为 HALF_OPEN', async () => {
  const clock = new VirtualClock();
  const breaker = new CircuitBreaker(config, clock);
  for (let i = 0; i < 5; i += 1) breaker.recordFailure(10);
  assert.equal(breaker.getState(), 'open');
  assert.equal(breaker.allowRequest(), false);
  const quit = Promise.resolve(clock.setTimeout(() => undefined, 1100)).then(() => clock.run());
  await quit;
  // 冷却结束后，第一次放行请求会把状态推进到 HALF_OPEN（惰性迁移）
  assert.equal(breaker.allowRequest(), true);
  assert.equal(breaker.getState(), 'half-open');
});

test('HALF_OPEN 探测全部成功后恢复 CLOSED', async () => {
  const clock = new VirtualClock();
  const breaker = new CircuitBreaker(config, clock);
  for (let i = 0; i < 5; i += 1) breaker.recordFailure(10);
  assert.equal(breaker.getState(), 'open');
  await clock.setTimeout(() => undefined, 2000) && (await clock.run());
  assert.equal(breaker.allowRequest(), true);
  assert.equal(breaker.getState(), 'half-open');
  for (let i = 0; i < config.halfOpenMaxCalls; i += 1) breaker.recordSuccess(10);
  assert.equal(breaker.getState(), 'closed');
});

test('HALF_OPEN 期间任意失败立即回到 OPEN', async () => {
  const clock = new VirtualClock();
  const breaker = new CircuitBreaker(config, clock);
  for (let i = 0; i < 5; i += 1) breaker.recordFailure(10);
  await clock.setTimeout(() => undefined, 1500) && (await clock.run());
  assert.equal(breaker.allowRequest(), true);
  assert.equal(breaker.getState(), 'half-open');
  breaker.recordFailure(10);
  assert.equal(breaker.getState(), 'open');
});

test('慢调用率超阈值同样会触发断路', () => {
  const clock = new VirtualClock();
  const breaker = new CircuitBreaker({ ...config, slowCallRateThreshold: 0.5, slowCallMs: 100 }, clock);
  for (let i = 0; i < 5; i += 1) breaker.recordSuccess(200);
  assert.equal(breaker.getState(), 'open');
});

test('OPEN 状态下 executeWithBreaker 直接抛 RejectedError', async () => {
  const clock = new VirtualClock();
  const breaker = new CircuitBreaker(config, clock);
  for (let i = 0; i < 5; i += 1) breaker.recordFailure(10);
  let calls = 0;
  await assert.rejects(
    executeWithBreaker(
      breaker,
      () => {
        calls += 1;
        return Promise.resolve('ok');
      },
      clock,
    ),
    RejectedError,
  );
  assert.equal(calls, 0, '断路期间不应发起任何底层调用');
});

test('断路器会记录底层调用的失败', async () => {
  const clock = new VirtualClock();
  const breaker = new CircuitBreaker(config, clock);
  await assert.rejects(
    executeWithBreaker(
      breaker,
      () => Promise.reject(new TransientError('boom')),
      clock,
    ),
    TransientError,
  );
  const m = breaker.metrics();
  assert.equal(m.failures, 1);
  assert.equal(m.state, 'closed');
});

test('metrics 暴露断路次数与拒绝数', () => {
  const clock = new VirtualClock();
  const breaker = new CircuitBreaker(config, clock);
  for (let i = 0; i < 5; i += 1) breaker.recordFailure(10);
  breaker.allowRequest();
  breaker.noteRejected();
  const m = breaker.metrics();
  assert.equal(m.trips, 1);
  assert.equal(m.rejected, 1);
});
