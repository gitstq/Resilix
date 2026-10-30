import test from 'node:test';
import assert from 'node:assert/strict';
import { VirtualClock } from '../src/core/clock.js';
import { executeWithHedge, DEFAULT_HEDGE } from '../src/policies/hedge.js';

/** 立刻挂上处理器并驱动虚拟时钟，避免「拒绝晚于断言」造成的未处理拒绝。 */
async function settle<T>(clock: VirtualClock, promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  const probe = promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  await clock.run();
  return probe;
}

test('主请求先返回时不发起对冲', async () => {
  const clock = new VirtualClock();
  let calls = 0;
  const outcome = await settle(
    clock,
    executeWithHedge(
      async (attempt) => {
        calls += 1;
        assert.equal(attempt, 0);
        await clock.sleep(10);
        return 'main';
      },
      DEFAULT_HEDGE,
      clock,
    ).then((r) => r),
  );
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.equal(outcome.value.value, 'main');
    assert.equal(outcome.value.requestsSent, 1);
  }
  assert.equal(calls, 1);
});

test('主请求超阈值未返回时发起对冲，取先成功者', async () => {
  const clock = new VirtualClock();
  const latencies = [5000, 100];
  const outcome = await settle(
    clock,
    executeWithHedge(
      (attempt) => clock.sleep(latencies[attempt]).then(() => `res-${attempt}`),
      { delayMs: 200, maxHedges: 1 },
      clock,
    ),
  );
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.equal(outcome.value.value, 'res-1');
    assert.equal(outcome.value.requestsSent, 2);
    assert.equal(outcome.value.canceled, 0);
  }
});

test('主请求成功则后续对冲被取消', async () => {
  const clock = new VirtualClock();
  const outcome = await settle(
    clock,
    executeWithHedge(
      (attempt) => clock.sleep(attempt === 0 ? 50 : 500).then(() => `res-${attempt}`),
      { delayMs: 200, maxHedges: 1 },
      clock,
    ),
  );
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.equal(outcome.value.value, 'res-0');
    assert.equal(outcome.value.requestsSent, 1);
    assert.equal(outcome.value.canceled, 1);
  }
});

test('全部尝试失败时抛出最后一个收到的错误', async () => {
  const clock = new VirtualClock();
  let attemptsSeen = 0;
  const outcome = await settle(
    clock,
    executeWithHedge(
      (attempt) => {
        attemptsSeen += 1;
        return clock.sleep(attempt === 0 ? 500 : 10).then(() => {
          throw new Error(`fail-${attempt}`);
        });
      },
      { delayMs: 100, maxHedges: 1 },
      clock,
    ),
  );
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.match((outcome.error as Error).message, /^fail-\d$/);
  assert.equal(attemptsSeen, 2);
});

test('shouldHedge 返回 false 时不发起任何对冲', async () => {
  const clock = new VirtualClock();
  let calls = 0;
  const outcome = await settle(
    clock,
    executeWithHedge(
      (attempt) => {
        calls += 1;
        return clock.sleep(1000).then(() => attempt);
      },
      { delayMs: 10, maxHedges: 2 },
      clock,
      () => false,
    ),
  );
  assert.equal(outcome.ok, true);
  assert.equal(calls, 1);
});
