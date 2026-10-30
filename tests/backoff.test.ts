import test from 'node:test';
import assert from 'node:assert/strict';
import { BackoffCalculator, computeBackoff, backoffSchedule, DEFAULT_BACKOFF } from '../src/policies/backoff.js';
import { createRng } from '../src/core/random.js';

const base = { baseMs: 100, multiplier: 2, maxMs: 2000, jitter: 'none' as const };

test('无抖动时严格指数增长并受上限约束', () => {
  const calc = new BackoffCalculator(base, createRng(1));
  assert.deepEqual([calc.next(), calc.next(), calc.next(), calc.next(), calc.next(), calc.next()], [
    100, 200, 400, 800, 1600, 2000,
  ]);
});

test('完全抖动落在 [0, 指数值) 之间', () => {
  const rng = createRng('full');
  const calc = new BackoffCalculator({ ...base, jitter: 'full' }, rng);
  const expected = [100, 200, 400, 800, 1600, 2000];
  expected.forEach((upper, i) => {
    const v = calc.next();
    assert.ok(v >= 0 && v <= upper + 1e-9, `第 ${i + 1} 次越界: ${v} > ${upper}`);
  });
});

test('半抖动落在 [值/2, 值] 之间', () => {
  const calc = new BackoffCalculator({ ...base, jitter: 'equal' }, createRng('equal'));
  const expected = [100, 200, 400, 800];
  expected.forEach((upper, i) => {
    const v = calc.next();
    assert.ok(v >= upper / 2 - 1e-9 && v <= upper + 1e-9, `第 ${i + 1} 次越界: ${v}`);
  });
});

test('去相关抖动只会比指数值更柔和（均值更低）', () => {
  const sumOf = (jitter: 'none' | 'decorrelated'): number => {
    const calc = new BackoffCalculator({ ...base, jitter }, createRng('decorr'));
    let sum = 0;
    for (let i = 0; i < 200; i += 1) sum += calc.next();
    return sum;
  };
  assert.ok(sumOf('decorrelated') < sumOf('none'));
});

test('退避上限永不被突破', () => {
  const calc = new BackoffCalculator({ ...base, jitter: 'full', maxMs: 500 }, createRng('cap'));
  for (let i = 0; i < 50; i += 1) {
    assert.ok(calc.next() <= 500);
  }
});

test('reset 之后重新从第 1 阶开始', () => {
  const calc = new BackoffCalculator(base, createRng(1));
  calc.next();
  calc.next();
  calc.reset();
  assert.equal(calc.next(), 100);
});

test('computeBackoff 与 BackoffCalculator 的第 1 阶一致', () => {
  const rng = createRng(7);
  assert.equal(computeBackoff(base, 1, rng), 100);
  const calc = new BackoffCalculator(base, createRng(7));
  assert.equal(calc.next(), 100);
});

test('backoffSchedule 产出可读的重试阶梯', () => {
  const schedule = backoffSchedule(DEFAULT_BACKOFF, 4);
  assert.equal(schedule.length, 4);
  for (const v of schedule) assert.ok(v >= 0 && v <= DEFAULT_BACKOFF.maxMs);
});

test('退避序列整体递增（无抖动场景下）', () => {
  const schedule = backoffSchedule({ ...base, jitter: 'none' }, 5);
  for (let i = 1; i < schedule.length; i += 1) assert.ok(schedule[i] >= schedule[i - 1]);
});
