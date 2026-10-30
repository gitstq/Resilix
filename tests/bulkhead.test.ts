import test from 'node:test';
import assert from 'node:assert/strict';
import { VirtualClock } from '../src/core/clock.js';
import { Bulkhead, DEFAULT_BULKHEAD, executeWithBulkhead } from '../src/policies/bulkhead.js';
import { RejectedError } from '../src/core/errors.js';

test('并发上限内的请求全部立即放行', async () => {
  const clock = new VirtualClock();
  const bulkhead = new Bulkhead({ ...DEFAULT_BULKHEAD, maxConcurrent: 2, maxQueue: 0 }, clock);
  await bulkhead.acquire();
  await bulkhead.acquire();
  assert.equal(bulkhead.running(), 2);
  assert.equal(bulkhead.stats().maxObservedConcurrency, 2);
});

test('超出并发且队列已满时立即拒绝', async () => {
  const clock = new VirtualClock();
  const bulkhead = new Bulkhead({ maxConcurrent: 1, maxQueue: 0, queueTimeoutMs: 0 }, clock);
  await bulkhead.acquire();
  await assert.rejects(bulkhead.acquire(), RejectedError);
  assert.equal(bulkhead.stats().rejected, 1);
});

test('排队请求会在有空位时被唤醒', async () => {
  const clock = new VirtualClock();
  const bulkhead = new Bulkhead({ maxConcurrent: 1, maxQueue: 5, queueTimeoutMs: 1000 }, clock);
  await bulkhead.acquire();
  const order: string[] = [];
  const waiter = bulkhead.acquire().then(() => order.push('second-granted'));
  bulkhead.release();
  // release 会立即把执行权交给等待者（resolveGranted）
  await waiter;
  // 第一个许可仍在占用，第二个通过接替的方式拿到资源
  assert.deepEqual(order, ['second-granted']);
  assert.equal(bulkhead.running(), 1);
});

test('排队超时的请求会被拒绝', async () => {
  const clock = new VirtualClock();
  const bulkhead = new Bulkhead({ maxConcurrent: 1, maxQueue: 1, queueTimeoutMs: 50 }, clock);
  await bulkhead.acquire();
  const task = bulkhead.acquire().then(
    () => 'granted',
    () => 'rejected',
  );
  await clock.run();
  assert.equal(await task, 'rejected');
  assert.equal(bulkhead.stats().rejected, 1);
  assert.equal(bulkhead.waiting(), 0);
});

test('executeWithBulkhead 保证异常后也会释放许可', async () => {
  const clock = new VirtualClock();
  const bulkhead = new Bulkhead({ maxConcurrent: 1, maxQueue: 0, queueTimeoutMs: 0 }, clock);
  await assert.rejects(
    executeWithBulkhead(bulkhead, () => Promise.reject(new Error('boom'))),
    Error,
  );
  assert.equal(bulkhead.running(), 0);
  // 释放后可以立刻再拿
  await bulkhead.acquire();
  assert.equal(bulkhead.running(), 1);
});

test('并发跑 n 个任务时峰值不超过上限', async () => {
  const clock = new VirtualClock();
  const limit = 4;
  const bulkhead = new Bulkhead({ maxConcurrent: limit, maxQueue: 100, queueTimeoutMs: 10_000 }, clock);
  let inflight = 0;
  const driver = clock.run();
  const tasks = Array.from({ length: 20 }, () =>
    executeWithBulkhead(bulkhead, async () => {
      inflight += 1;
      assert.ok(inflight <= limit, `并发越界: ${inflight}`);
      await clock.sleep(10);
      inflight -= 1;
    }),
  );
  await Promise.all(tasks);
  await driver;
  assert.equal(bulkhead.stats().maxObservedConcurrency, limit);
  assert.equal(bulkhead.running(), 0);
});
