#!/usr/bin/env node
/**
 * Resilix 命令行。
 *
 * 零第三方依赖：参数解析、渲染、导出全部自研，因此安装体积只有几十 KB，
 * 也不会因为某个 CLI 框架停维护而被卡住升级。
 *
 * 命令总览：
 *   resilix sim      跑一次策略 × 故障模型的虚拟压测
 *   resilix compare  多策略横向对比并给出综合评分
 *   resilix lint     对策略配置做提交前静态体检
 *   resilix presets  列出内置预设
 *   resilix show     打印规范化后的配置（用于确认合并结果）
 *   resilix order    打印策略分层顺序与设计理由
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { VERSION } from '../index.js';
import { loadFault, loadPolicy, normalizePolicy, normalizeFault } from '../config.js';
import { simulate } from '../sim/engine.js';
import { compareResults, renderSimReport, toCsv, toJson, toMarkdown } from '../sim/report.js';
import { lintPolicy, lintToMarkdown, renderLintReport } from '../lint/linter.js';
import { listFaultPresets, listPolicyPresets } from '../presets.js';
import type { PolicyStackConfig } from '../policies/stack.js';

interface ParsedArgs {
  cmd: string;
  flags: Record<string, string | boolean>;
  positional: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const cmd = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'help';
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = cmd === 'help' ? 0 : 1; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--help' || token === '-h') {
      flags.help = true;
      continue;
    }
    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eq = body.indexOf('=');
      if (eq > 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[body] = next;
        i += 1;
      } else {
        flags[body] = true;
      }
      continue;
    }
    if (token.startsWith('-') && token.length === 2) {
      const key = token.slice(1);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
      continue;
    }
    positional.push(token);
  }
  return { cmd, flags, positional };
}

const str = (v: string | boolean | undefined, fallback: string): string => (typeof v === 'string' ? v : fallback);
const num = (v: string | boolean | undefined, fallback: number): number => {
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
};
const bool = (v: string | boolean | undefined): boolean => v === true || v === 'true' || v === '1';

const HELP = `
🛡️  Resilix v${VERSION} — 弹性策略工具箱 / 离线故障注入沙盘

用法:
  resilix <command> [options]

命令:
  sim        跑一次【策略 × 故障模型】虚拟压测并输出指标报告
  compare    多策略横向对比，按可用性/延迟/成本给出综合评分
  lint       对策略配置做静态体检（适合放进 CI）
  presets    列出内置的策略预设与故障场景预设
  show       打印规范化后的配置（确认默认值合并结果）
  order      打印策略分层顺序与设计理由

通用参数:
  -p, --policy <name|file>   策略来源：预设名(none/conservative/balanced/aggressive)或 JSON 文件
  -f, --fault  <name|file>   故障来源：预设名(healthy/flaky/gray-failure/overload/blackhole)或 JSON 文件
  --requests <n>             总请求数（默认 1000）
  --concurrency <n>          并发客户端数（默认 20）
  --seed <n|string>          随机种子，同种子结果完全一致（默认 42）
  --think <ms>               每个客户端两次请求之间的间隔（默认 0）
  --json / --md / --csv      指定输出格式
  -o, --out <file>           写入文件而非标准输出
  -h, --help                 显示本帮助

示例:
  resilix sim -p balanced -f flaky --requests 2000 --seed 7
  resilix compare -p none,balanced,aggressive -f overload
  resilix lint -p examples/policy-dangerous.json --method POST --caller-timeout 1000
  resilix sim -p balanced -f gray-failure --md -o report.md
`;

function fail(message: string): never {
  process.stderr.write(`❌ ${message}\n`);
  process.exit(1);
}

function ensureFile(path: string): void {
  if (!existsSync(path)) fail(`找不到文件: ${path}`);
}

function emit(content: string, flags: Record<string, string | boolean>): void {
  const out = flags.out ?? flags.o;
  if (typeof out === 'string') {
    writeFileSync(out, content, 'utf8');
    process.stdout.write(`✅ 已写入 ${out}\n`);
    return;
  }
  process.stdout.write(`${content}\n`);
}

async function cmdSim(flags: Record<string, string | boolean>, positional: string[]): Promise<void> {
  const policySource = str(flags.p ?? flags.policy, positional[1] ?? 'balanced');
  const faultSource = str(flags.f ?? flags.fault, positional[2] ?? 'flaky');
  if (typeof (flags.p ?? flags.policy) === 'string') ensureFileUnlessPreset(policySource, listPolicyPresets());
  if (typeof (flags.f ?? flags.fault) === 'string') ensureFileUnlessPreset(faultSource, listFaultPresets());

  const policy = loadPolicy(policySource);
  const fault = loadFault(faultSource);
  if (!policy.name) policy.name = policySource;

  const result = await simulate(policy, fault, {
    seed: str(flags.seed, '42'),
    requests: num(flags.requests, 1000),
    concurrency: num(flags.concurrency, 20),
    thinkTimeMs: num(flags.think, 0),
  });

  if (bool(flags.json)) emit(toJson(result), flags);
  else if (bool(flags.md)) emit(toMarkdown(result), flags);
  else if (bool(flags.csv)) emit(toCsv(result), flags);
  else emit(renderSimReport(result), flags);
}

async function cmdCompare(flags: Record<string, string | boolean>, positional: string[]): Promise<void> {
  const raw = str(flags.p ?? flags.policy, positional[1] ?? 'none,balanced,aggressive');
  const faultSource = str(flags.f ?? flags.fault, positional[2] ?? 'flaky');
  const sources = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (sources.length === 0) fail('--policy 至少需要提供一个策略');
  const fault = loadFault(faultSource);

  const policies: PolicyStackConfig[] = sources.map((s) => {
    const cfg = loadPolicy(s);
    return { ...cfg, name: cfg.name ?? s };
  });

  const results = [];
  for (const policy of policies) {
    results.push(
      await simulate(policy, fault, {
        seed: str(flags.seed, '42'),
        requests: num(flags.requests, 1000),
        concurrency: num(flags.concurrency, 20),
        thinkTimeMs: num(flags.think, 0),
      }),
    );
  }

  const comparison = compareResults(results, {
    p99TargetMs: num(flags.p99target, 500),
    ampTarget: num(flags.amptarget, 1.5),
    latencyWeight: num(flags.latencyweight, 0.4),
    ampWeight: num(flags.ampweight, 0.3),
  });
  const summary: string[] = ['════════════════════════════════════════════════════════════════'];
  summary.push(`  Resilix 策略对比 · 场景 ${fault.name ?? faultSource} · 种子 ${String(str(flags.seed, '42'))}`);
  summary.push('════════════════════════════════════════════════════════════════');
  summary.push(comparison.table);
  summary.push('');
  summary.push(`  🏆 综合最优: ${comparison.winner.name}（评分 ${comparison.winner.score}，成功率 ${(comparison.winner.successRate * 100).toFixed(2)}%，p99 ${comparison.winner.p99}ms，放大 ${comparison.winner.amplification}x）`);
  summary.push('════════════════════════════════════════════════════════════════');
  emit(summary.join('\n'), flags);
}

function cmdLint(flags: Record<string, string | boolean>, positional: string[]): Promise<void> {
  const policySource = str(flags.p ?? flags.policy, positional[1] ?? 'balanced');
  ensureFileUnlessPreset(policySource, listPolicyPresets());
  const policy = loadPolicy(policySource);
  const result = lintPolicy({
    policy,
    callerTimeoutMs: flags['caller-timeout'] !== undefined ? num(flags['caller-timeout'], 0) : undefined,
    httpMethod: typeof flags.method === 'string' ? flags.method : undefined,
    serviceCapacityRps: flags.capacity !== undefined ? num(flags.capacity, 0) : undefined,
    maxConcurrency: flags['max-concurrency'] !== undefined ? num(flags['max-concurrency'], 0) : undefined,
  });
  if (bool(flags.md)) emit(lintToMarkdown(result, policy.name ?? policySource), flags);
  else emit(renderLintReport(result, policy.name ?? policySource), flags);
  if (!result.ok) process.exitCode = 1;
  return Promise.resolve();
}

function ensureFileUnlessPreset(source: string, presets: string[]): void {
  if (presets.includes(source)) return;
  ensureFile(source);
}

function cmdPresets(flags: Record<string, string | boolean>): void {
  const lines: string[] = [];
  lines.push('════════════════════════════════════════════════════════════════');
  lines.push('  Resilix 内置预设');
  lines.push('════════════════════════════════════════════════════════════════');
  lines.push('  【策略预设】');
  for (const p of listPolicyPresets()) {
    const cfg = loadPolicy(p);
    const parts: string[] = [];
    if (cfg.timeoutMs) parts.push(`timeout=${cfg.timeoutMs}ms`);
    if (cfg.retry) parts.push(`retry=${cfg.retry.maxAttempts}次/${cfg.retry.backoff.jitter}`);
    if (cfg.breaker) parts.push(`breaker@${(cfg.breaker.failureRateThreshold * 100).toFixed(0)}%`);
    if (cfg.limiter) parts.push(`limiter=${cfg.limiter.algorithm}`);
    if (cfg.bulkhead) parts.push(`bulkhead=${cfg.bulkhead.maxConcurrent}`);
    if (cfg.hedge) parts.push(`hedge=${cfg.hedge.maxHedges}`);
    lines.push(`    ${p.padEnd(14)} ${parts.join('  ') || '（无治理）'}`);
  }
  lines.push('');
  lines.push('  【故障场景预设】');
  for (const f of listFaultPresets()) {
    const cfg = loadFault(f);
    lines.push(`    ${f.padEnd(14)} errorRate=${(cfg.errorRate * 100).toFixed(2)}%  ${JSON.stringify(cfg.latency)}`);
  }
  lines.push('════════════════════════════════════════════════════════════════');
  emit(lines.join('\n'), flags);
}

function cmdShow(flags: Record<string, string | boolean>, positional: string[]): void {
  const source = str(flags.p ?? flags.policy, positional[1] ?? 'balanced');
  ensureFileUnlessPreset(source, listPolicyPresets());
  const policy = loadPolicy(source);
  if (!policy.name) policy.name = source;
  emit(JSON.stringify({ ...policy, name: policy.name }, null, 2), flags);
}

function cmdOrder(flags: Record<string, string | boolean>): void {
  const order = [
    ['timeout', '最外层硬预算，杜绝超时倒挂'],
    ['hedge', '超过 p95 未返回时发起对冲，压缩长尾'],
    ['breaker', '持续性故障时本地快速失败，阻断级联'],
    ['bulkhead', '限制同时占用的资源，隔离影响域'],
    ['limiter', '限制发出速率，保护下游与自己'],
    ['retry', '仅对瞬时错误重建请求'],
    ['transport', '真实的底层调用'],
  ] as const;
  const lines: string[] = [];
  lines.push('════════════════════════════════════════════════════════════════');
  lines.push('  Resilix 策略分层顺序（由外向内）');
  lines.push('════════════════════════════════════════════════════════════════');
  order.forEach(([ name, reason ], i) => {
    lines.push(`  ${String(i + 1).padStart(2)}. ${name.padEnd(12)} ${reason}`);
  });
  lines.push('');
  lines.push('  完整链路: timeout → hedge → breaker → bulkhead → limiter → retry → transport');
  lines.push('════════════════════════════════════════════════════════════════');
  emit(lines.join('\n'), flags);
}

async function main(): Promise<void> {
  const { cmd, flags, positional } = parseArgs(process.argv.slice(2));
  if (flags.help && cmd === 'help') {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  switch (cmd) {
    case 'sim':
    case 'simulate':
      await cmdSim(flags, positional);
      break;
    case 'compare':
      await cmdCompare(flags, positional);
      break;
    case 'lint':
      await cmdLint(flags, positional);
      break;
    case 'presets':
      cmdPresets(flags);
      break;
    case 'show':
      cmdShow(flags, positional);
      break;
    case 'order':
      cmdOrder(flags);
      break;
    case 'version':
    case '--version':
      process.stdout.write(`resilix v${VERSION}\n`);
      break;
    case 'help':
    default:
      process.stdout.write(`${HELP}\n`);
      break;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`❌ ${message}\n`);
  if (process.env.RESILIX_DEBUG === '1' && error instanceof Error) process.stderr.write(`${error.stack}\n`);
  process.exit(1);
});
