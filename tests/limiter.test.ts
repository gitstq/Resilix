import test from 'node:test';
import assert from 'node:assert/strict';
import { VirtualClock } from '../src/core/clock.js';
import {
  TokenBucketLimiter,
  LeakyBucketLimiter,
  FixedWindowLimiter,
  SlidingWindowCounterLimiter,
  SlidingWindowLogLimiter,
  createLimiter,
} from '../src/policies/limiter.js';

test('令牌桶允许突发并按速率补充', () => {
  const clock = new VirtualClock();
  const bucket = new TokenBucketLimiter({ capacity: 3, refillPerSec: 10 }, clock);
  assert.equal(bucket.tryConsume(), true);
  assert.equal(bucket.tryConsume(), true);
  assert.equal(bucket.tryConsume(), true);
  assert.equal(bucket.tryConsume(), false, '超出容量应被拒绝');
  assert.equal(bucket.retryAfterMs() > 0, true);
  // 推进 100ms == 补充 1 个令牌
  clock.setTimeout(() => undefined, 100);
  return clock.run().then(() => {
    assert.equal(bucket.tryConsume(), true);
    assert.equal(bucket.tryConsume(), false);
  });
});

test('令牌桶不会无限累积（容量封顶）', async () => {
  const clock = new VirtualClock();
  const bucket = new TokenBucketLimiter({ capacity: 5, refillPerSec: 100 }, clock);
  clock.setTimeout(() => undefined, 60_000);
  await clock.run();
  assert.equal(bucket.available(), 5);
});

test('漏桶按固定速率放行', async () => {
  const clock = new VirtualClock();
  const leaky = new LeakyBucketLimiter({ capacity: 2, leakPerSec: 10 }, clock);
  assert.equal(leaky.tryConsume(), true);
  assert.equal(leaky.tryConsume(), true);
  assert.equal(leaky.tryConsume(), false);
  clock.setTimeout(() => undefined, 200);
  await clock.run();
  assert.equal(leaky.tryConsume(), true);
});

test('固定窗口在窗口结束后重置', async () => {
  const clock = new VirtualClock();
  const limiter = new FixedWindowLimiter(2, 1000, clock);
  assert.equal(limiter.tryConsume(), true);
  assert.equal(limiter.tryConsume(), true);
  assert.equal(limiter.tryConsume(), false);
  clock.setTimeout(() => undefined, 1100);
  await clock.run();
  assert.equal(limiter.tryConsume(), true);
});

test('滑动计数窗口在上一个新窗口的前半段按比例放行', async () => {
  const clock = new VirtualClock();
  const limiter = new SlidingWindowCounterLimiter(10, 1000, clock);
  for (let i = 0; i < 10; i += 1) assert.equal(limiter.tryConsume(), true);
  assert.equal(limiter.tryConsume(), false);
  // 跨到下一个窗口后再走 500ms：上一窗口权重衰减一半 → 预计放行约 5 个
  clock.setTimeout(() => undefined, 1500);
  await clock.run();
  let granted = 0;
  for (let i = 0; i < 10; i += 1) if (limiter.tryConsume()) granted += 1;
  assert.ok(granted >= 4 && granted <= 6, `滑动窗口放行数异常: ${granted}`);
  assert.equal(limiter.available() >= 0, true);
});

test('滑动日志在窗口滑出后精确恢复配额', async () => {
  const clock = new VirtualClock();
  const limiter = new SlidingWindowLogLimiter(3, 1000, clock);
  for (let i = 0; i < 3; i += 1) assert.equal(limiter.tryConsume(), true);
  assert.equal(limiter.tryConsume(), false);
  clock.setTimeout(() => undefined, 1001);
  await clock.run();
  for (let i = 0; i < 3; i += 1) assert.equal(limiter.tryConsume(), true);
  assert.equal(limiter.tryConsume(), false);
});

test('createLimiter 支持全部五种算法', () => {
  const clock = new VirtualClock();
  assert.ok(createLimiter({ algorithm: 'token-bucket', capacity: 1, refillPerSec: 1 }, clock));
  assert.ok(createLimiter({ algorithm: 'leaky-bucket', capacity: 1, leakPerSec: 1 }, clock));
  assert.ok(createLimiter({ algorithm: 'fixed-window', limit: 1, windowMs: 1000 }, clock));
  assert.ok(createLimiter({ algorithm: 'sliding-counter', limit: 1, windowMs: 1000 }, clock));
  assert.ok(createLimiter({ algorithm: 'sliding-log', limit: 1, windowMs: 1000 }, clock));
});

test('retryAfterMs 在立即可用时返回 0', () => {
  const clock = new VirtualClock();
  const bucket = new TokenBucketLimiter({ capacity: 2, refillPerSec: 100 }, clock);
  assert.equal(bucket.retryAfterMs(), 0);
});
