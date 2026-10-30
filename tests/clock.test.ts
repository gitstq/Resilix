import test from 'node:test';
import assert from 'node:assert/strict';
import { VirtualClock, createSystemClock } from '../src/core/clock.js';

test('虚拟时钟按提交顺序推进', async () => {
  const clock = new VirtualClock();
  const seen: string[] = [];
  clock.setTimeout(() => seen.push('a@200'), 200);
  clock.setTimeout(() => seen.push('b@100'), 100);
  clock.setTimeout(() => seen.push('c@100'), 100);
  await clock.run();
  assert.deepEqual(seen, ['b@100', 'c@100', 'a@200']);
  assert.equal(clock.now(), 200);
  assert.equal(clock.pending(), 0);
});

test('同一虚拟时刻内的任务是按序执行的', async () => {
  const clock = new VirtualClock();
  const order: number[] = [];
  for (let i = 0; i < 5; i += 1) clock.setTimeout(() => order.push(i), 10);
  await clock.run();
  assert.deepEqual(order, [0, 1, 2, 3, 4]);
});

test('sleep 会真正挂起后续逻辑', async () => {
  const clock = new VirtualClock();
  let finished = false;
  void (async () => {
    await clock.sleep(50);
    finished = true;
    assert.equal(clock.now(), 50);
  })();
  await clock.run();
  assert.equal(finished, true);
});

test('定时器可以被取消', async () => {
  const clock = new VirtualClock();
  let fired = false;
  const handle = clock.setTimeout(() => {
    fired = true;
  }, 10);
  handle.cancel();
  await clock.run();
  assert.equal(fired, false);
  assert.equal(clock.now(), 0);
});

test('reset 清空时间与队列', async () => {
  const clock = new VirtualClock();
  clock.setTimeout(() => undefined, 100);
  clock.reset();
  assert.equal(clock.now(), 0);
  assert.equal(clock.pending(), 0);
  await clock.run();
  assert.equal(clock.now(), 0);
});

test('链式的自调度任务能被正确推进（模拟重试等待）', async () => {
  const clock = new VirtualClock();
  const times: number[] = [];
  let count = 0;
  const step = (): void => {
    count += 1;
    times.push(clock.now());
    if (count < 4) clock.setTimeout(step, count * 50);
  };
  clock.setTimeout(step, 0);
  await clock.run();
  assert.deepEqual(times, [0, 50, 150, 300]);
});

test('stop() 会让事件循环提前收尾', async () => {
  const clock = new VirtualClock();
  let calls = 0;
  const step = (): void => {
    calls += 1;
    if (calls >= 3) clock.stop();
    clock.setTimeout(step, 10);
  };
  clock.setTimeout(step, 0);
  await clock.run();
  assert.equal(calls, 3);
});

test('真实时钟具备递增时间与可用 sleep', async () => {
  const clock = createSystemClock();
  const t0 = clock.now();
  await clock.sleep(5);
  assert.ok(clock.now() >= t0);
  assert.equal(clock.virtual, false);
});
