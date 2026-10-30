import test from 'node:test';
import assert from 'node:assert/strict';
import { createRng, sampleLatency, describeDistribution, gaussian, normalizeSeed } from '../src/core/random.js';

test('同一种子产生完全相同的随机序列', () => {
  const a = createRng('resilix');
  const b = createRng('resilix');
  const seqA = Array.from({ length: 50 }, () => a.next());
  const seqB = Array.from({ length: 50 }, () => b.next());
  assert.deepEqual(seqA, seqB);
});

test('不同种子产生不同序列', () => {
  const a = createRng(1);
  const b = createRng(2);
  assert.notDeepEqual(
    Array.from({ length: 20 }, () => a.next()),
    Array.from({ length: 20 }, () => b.next()),
  );
});

test('随机数落在 [0,1) 区间内', () => {
  const rng = createRng(2026);
  for (let i = 0; i < 10000; i += 1) {
    const v = rng.next();
    assert.ok(v >= 0 && v < 1, `越界: ${v}`);
  }
});

test('bool 的概率与期望一致（±3σ）', () => {
  const rng = createRng('coin');
  const n = 20000;
  let heads = 0;
  for (let i = 0; i < n; i += 1) if (rng.bool(0.3)) heads += 1;
  const observed = heads / n;
  assert.ok(Math.abs(observed - 0.3) < 0.02, `偏差过大: ${observed}`);
});

test('所有延迟分布都返回非负有限值', () => {
  const rng = createRng('latency');
  const distributions = [
    { kind: 'constant', valueMs: 12 },
    { kind: 'uniform', minMs: 5, maxMs: 50 },
    { kind: 'lognormal', medianMs: 40, sigma: 1.2 },
    { kind: 'pareto', minMs: 10, shape: 1.5 },
    { kind: 'bimodal', fastMs: 10, slowMs: 800, slowRatio: 0.2 },
  ] as const;
  for (const dist of distributions) {
    for (let i = 0; i < 500; i += 1) {
      const v = sampleLatency(dist, rng);
      assert.ok(Number.isFinite(v) && v >= 0, `${dist.kind} 产生非法值: ${v}`);
    }
  }
});

test('双峰分布的比例大致符合设定', () => {
  const rng = createRng('bimodal');
  let slow = 0;
  const n = 5000;
  for (let i = 0; i < n; i += 1) {
    const v = sampleLatency({ kind: 'bimodal', fastMs: 10, slowMs: 900, slowRatio: 0.25 }, rng);
    if (v === 900) slow += 1;
  }
  const ratio = slow / n;
  assert.ok(Math.abs(ratio - 0.25) < 0.03, `慢路径比例偏差过大: ${ratio}`);
});

test('gaussian 均值接近 0', () => {
  const rng = createRng('normal');
  let sum = 0;
  const n = 20000;
  for (let i = 0; i < n; i += 1) sum += gaussian(rng);
  assert.ok(Math.abs(sum / n) < 0.05, `均值漂移: ${sum / n}`);
});

test('字符串种子经过哈希后稳定', () => {
  assert.equal(normalizeSeed('abc'), normalizeSeed('abc'));
  assert.notEqual(normalizeSeed('abc'), normalizeSeed('abd'));
});

test('分布摘要可渲染', () => {
  const text = describeDistribution({ kind: 'lognormal', medianMs: 40, sigma: 0.8 });
  assert.match(text, /lognormal/);
});
