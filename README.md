<div align="center">

# 🛡️ Resilix

**弹性策略工具箱 · 离线故障注入沙盘**

把「重试几次、多久退避、什么时候熔断」从拍脑袋的常量，
变成可以被**量化验证**的工程对象。

简体中文 · [繁體中文](./README.zh-TW.md) · [English](./README.en.md)

![zero dependency](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen)
![node](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)
![license](https://img.shields.io/badge/license-MIT-blue)
![version](https://img.shields.io/badge/npm-resilix%401.0.0-orange)
![tests](https://img.shields.io/badge/tests-84%20passing-success)

</div>

---

## 🎉 项目介绍

**Resilix** 是一个零运行时依赖的 TypeScript 弹性策略工具箱，外加一个可以完全离线运行的**故障注入沙盘**。

它的存在是为了解决一个几乎每个团队都踩过的坑：

> 重试三次、间隔 100ms、抖动加 20% —— 这些数字是谁定的？
> 为什么是三次而不是两次？下线重试会雪崩还是不会？**没有人答得上来，因为没有量化过。**

线上真实验证成本太高：你不可能为了让断路器生效，真的去杀一次数据库。于是绝大多数弹性配置
最终都停留在「抄一份别的项目的值」，然后在某次大促的凌晨四点暴露问题。

Resilix 的解法是**把时间变成可操控的变量**：

- 🧪 用 **虚拟时钟** 驱动离散事件模拟，几万次请求在几十毫秒真实时间内跑完；
- 🎯 用可配置的下游故障模型（延迟分布 + 错误率 + 突发窗口 + 拥塞反馈 + 黑洞）替代真实的下游故障；
- 📊 用 **成功率 / p99 / 放大系数** 三个硬指标给策略打分，而不是争论配置好不好看；
- 🔍 用 **17 条静态规则** 在提交前扫出典型的配置级缺陷（惊群、重试风暴、超时倒挂……）。

### 灵感来源与自研差异

| 参考对象 | 借鉴之处 | Resilix 的自研突破 |
| --- | --- | --- |
| Google SRE Handbook | 重试预算（retry budget）的治理思想 | 把「按流量比例挣额度」做成确定性可实现的时间窗口模型，且能在离线沙盘中直接量化其收益 |
| 《The Tail at Scale》 | 对冲请求压缩长尾的思路 | 加入禁用谓词与尝试计数，使其可进入占用 ⇄ 尾延迟的权衡分析 |
| Resilience4j / Polly | 成熟的策略组合方式 | 把「策略组合」升级为「策略实验」：不仅能用，还能跑数据证明该这么配 |
| Chaos Mesh / Litmus | 故障注入的价值 | 去掉对集群与 sidecar 的依赖，一行命令在本机或 CI 里注入并回归 |

---

## ✨ 核心特性

- 🧱 **六种策略，一层不缺**：退避 / 重试 / 断路器 / 限流 / 舱壁 / 对冲 / 超时，全部零依赖自研实现
- ⏱️ **注入式时钟与随机源**：同一份策略代码，生产跑真实时钟，实验跑虚拟时钟；**同种子必得同结果**
- 🎲 **五种延迟分布**：常量、均匀、对数正态（长尾）、帕累托（极端长尾）、双峰（缓存命中 vs 落盘）
- 🔥 **六种故障维度**：基础错误率、瞬时/永久错误配比、突发故障窗口、并发拥塞反馈、服务端超时、黑洞（永不响应）
- 📈 **三个硬指标**：成功率、**p99 延迟**、**重试放大系数** —— 只看这三个数字就够了，均值毫无意义
- 🏥 **策略静态体检**：17 条规则，`error` 级问题直接把 CI 打红，像 ESLint 一样守护你的配置
- 🔁 **A/B/C 横向对比**：一条命令跑多套策略，按「可用性 − 延迟惩罚 − 成本惩罚」给出综合评分与最优解
- 📦 **零运行时依赖**：`dependencies` 恒为空，供应链攻击面接近于零
- 🧩 **CJS + ESM 双格式**：`import` 和 `require` 都是一等公民，附完整 `.d.ts`
- 🎛️ **六条子命令的 CLI**：自研参数解析与渲染，不含任何 CLI 框架依赖

---

## 🚀 快速开始

### 环境要求

- **Node.js ≥ 18**（推荐 20 或 22）
- npm / pnpm / yarn 任一包管理器
- 操作系统不限：Linux / macOS / Windows 均可，无需编译工具链

### 安装

```bash
# 作为项目依赖
npm install resilix

# 不安装，直接试用
npx resilix sim -p balanced -f flaky --requests 1000
```

### 30 秒看结论

```bash
# 什么都不装，先看「加上治理」与「裸调用」的差距
npx resilix compare -p none,balanced,aggressive -f flaky --requests 1000 --seed 2026
```

真实输出（`resilix compare -p none,balanced,aggressive -f flaky --requests 1000 --seed 2026`）：

```
═══════════════════════════════════════════════════════════════
  Resilix 策略对比 · 场景 flaky · 种子 2026
═══════════════════════════════════════════════════════════════
策略        成功率  p99(ms)  放大   本地拒绝  吞吐(r/s)  评分
─────────────────────────────────────────────────────────────
balanced    99.30%  308.21   1.1x   0.00%     282.5      99.3
aggressive  99.20%  261.51   1.09x  0.00%     315.99     99.2
none        90.90%  267.69   1x     0.00%     311.13     90.9

  🏆 综合最优: balanced（评分 99.3，成功率 99.30%，p99 308.21ms，放大 1.1x）
═══════════════════════════════════════════════════════════════
```

一行结论：**在这个抖动场景下，加一层治理把可用性从 90.9% 提到 99.3%，而成本只多了 10% 的下游调用。**

### 作为库使用

```ts
import { ResilixStack, createSystemClock, createRng, getPolicyPreset } from 'resilix';

const stack = new ResilixStack(getPolicyPreset('balanced'), {
  clock: createSystemClock(),
  rng: createRng('my-service'),
});

// Throw-First：失败请抛错，策略层负责处理「要不要再来一次」
const html = await stack.execute(() => fetch('https://api.example.com/ping').then((r) => r.text()));
```

```js
// CommonJS 同样是一等公民
const { ResilixStack, createSystemClock, createRng } = require('resilix');
```

---

## 📖 详细使用指南

### 命令总览

| 命令 | 作用 | 典型用法 |
| --- | --- | --- |
| `sim` | 单策略 × 单故障场景的虚拟压测 | `resilix sim -p balanced -f flaky --requests 2000` |
| `compare` | 多策略横向评分 | `resilix compare -p none,conservative,balanced,aggressive -f overload` |
| `lint` | 策略配置静态体检 | `resilix lint -p ./policy.json --method POST --caller-timeout 1000` |
| `presets` | 列出内置预设 | `resilix presets` |
| `show` | 打印规范化后的配置 | `resilix show -p balanced -o policy.json` |
| `order` | 打印分层顺序与设计理由 | `resilix order` |

### 通用参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `-p, --policy <name\|file>` | `balanced` | 策略来源，预设名或 JSON 文件路径 |
| `-f, --fault <name\|file>` | `flaky` | 故障场景来源，预设名或 JSON 文件路径 |
| `--requests <n>` | `1000` | 本次实验的请求总数 |
| `--concurrency <n>` | `20` | 并发客户端数（闭环模型） |
| `--seed <n\|string>` | `42` | 随机种子，**同种子结果逐位一致** |
| `--think <ms>` | `0` | 每个客户端两次请求之间的间隔 |
| `--json / --md / --csv` | — | 指定导出格式，默认渲染终端报告 |
| `-o, --out <file>` | — | 写入文件而非标准输出 |
| `--p99target / --amptarget` | `500` / `1.5` | 评分公式中的延迟与放大目标阈值 |
| `-h, --help` | — | 帮助 |

### 场景一：给一次 PR 找证据

改了重试次数，怎么证明没把下游打垮？

```bash
resilix compare -p ./policy-before.json,./policy-after.json -f overload \
  --requests 5000 --seed 2026 --md -o pr-comment.md
```

`.md` 输出可直接贴进 PR 评论；`--csv` 输出可喂给看板做长期趋势。

### 场景二：上线前的配置体检

```bash
resilix lint -p ./examples/policy-dangerous.json --method POST --caller-timeout 1000
```

```
  ❌ ERROR  RX001  重试未开启抖动
  ❌ ERROR  RX004  缺少重试预算
  ❌ ERROR  RX006  启用重试却没有总超时
  ❌ ERROR  RX015  对非幂等方法启用了重试
  ⚠️  WARN   RX002  指数退避底数过大
  ⚠️  WARN   RX003  重试次数过多
  ⚠️  WARN   RX014  退避上限过小
  ℹ️  INFO   RX013  有重试但没有断路器

  统计: 4 error / 3 warn / 1 info（共 17 条规则，通过 9 条）
```

只要出现 `error`，进程退出码为 `1`，CI 会自然失败。把它接进流水线：

```yaml
- name: 策略体检
  run: npx resilix lint -p policy/checkout.json --method POST --caller-timeout 1000
```

### 场景三：调延迟长尾（灰度故障）

```bash
resilix sim -p aggressive -f gray-failure --requests 3000 --concurrency 50
```

`aggressive` 预设带一层对冲请求：慢的那 25% 请求会在超过 `hedge.delayMs` 后自动补发一个，
用约 10% 的额外负载把长尾压下来。值不值？报告里的「放大系数」会告诉你答案。

### 策略配置参考

```jsonc
{
  "name": "checkout",              // 报告与对比表格中显示的名字
  "timeoutMs": 1500,               // 整条链路的硬上限（最外层）

  "limiter": {                     // 限流：五种算法任选其一
    "algorithm": "token-bucket",   // token-bucket | leaky-bucket | fixed-window | sliding-counter | sliding-log
    "capacity": 600,               // 桶容量 = 允许的瞬时突发量
    "refillPerSec": 400            // 稳态速率（req/s）
  },

  "bulkhead": {                    // 舱壁：资源隔离
    "maxConcurrent": 32,           // 允许同时在飞的调用数
    "maxQueue": 64,                // 允许排队的等待者数量
    "queueTimeoutMs": 200          // 排队最长等待时间
  },

  "breaker": {                     // 断路器：阻断级联
    "windowMs": 10000,             // 统计窗口
    "bucketCount": 10,             // 分桶数（越多越精确）
    "minimumCalls": 20,            // 触发断路所需的最小样本量
    "failureRateThreshold": 0.5,   // 失败率阈值
    "slowCallRateThreshold": 0.8,  // 慢调用率阈值（设 1 表示不启用）
    "slowCallMs": 800,             // 超过多少毫秒算「慢」
    "openWaitMs": 5000,            // OPEN 状态冷却时长
    "halfOpenMaxCalls": 3          // HALF_OPEN 允许的探测请求数
  },

  "retry": {                       // 重试：只针对瞬时错误
    "maxAttempts": 3,              // 总尝试次数（含首次）
    "backoff": {
      "baseMs": 50,                // 第一次等待
      "multiplier": 2,             // 指数底数
      "maxMs": 2000,               // 单次等待上限
      "jitter": "equal"            // none | full | equal | decorrelated
    },
    "retryBudgetRatio": 0.2,       // 重试预算：1 次正常请求挣 0.2 点额度，1 次重试消耗 1 点
    "retryBudgetWindowMs": 10000,  // 额度有效期
    "maxElapsedMs": 600            // 本次调用链允许花在重试上的总时长
  },

  "hedge": {                       // 对冲：压缩长尾
    "delayMs": 300,                // 多久没返回就补发第 1 个
    "maxHedges": 1                 // 最多补发几个
  }
}
```

> ⚠️ **幂等性提醒**：只要启用了 `retry` 或 `hedge`，底层操作就必须是幂等的。
> 对写接口请先确认服务端支持幂等键（Idempotency-Key），否则请关闭这两层。

### 故障场景参考

```jsonc
{
  "name": "flaky",
  "latency": { "kind": "lognormal", "medianMs": 40, "sigma": 0.8 },  // 延迟分布
  "errorRate": 0.08,              // 基础错误率
  "transientErrorRatio": 0.95,    // 错误中「可重试」的比例
  "bursts": [                     // 突发故障窗口
    { "fromMs": 3000, "toMs": 8000, "errorRate": 0.35, "latencyMultiplier": 2 }
  ],
  "serverConcurrencyLimit": 24,   // 服务端并发饱和点
  "extraDelayPerInflightMs": 15,  // 每超出 1 个并发所增加的排队延迟
  "serverTimeoutMs": 1000,        // 服务端自身超时
  "blackholeRate": 0.06           // 黑洞：这些请求永不响应
}
```

支持的延迟分布：

| `kind` | 参数 | 适用于 |
| --- | --- | --- |
| `constant` | `valueMs` | 确定性基线、回归测试 |
| `uniform` | `minMs` `maxMs` | 抖动范围明确的环境 |
| `lognormal` | `medianMs` `sigma` | **最贴近真实服务**（有长尾、均值恒正） |
| `pareto` | `minMs` `shape` | 极端长尾，p99 是 p50 的几十倍 |
| `bimodal` | `fastMs` `slowMs` `slowRatio` | 「命中缓存 vs 落盘」的混合路径 |

### 内置预设

**策略预设**

| 预设 | 定位 | 关键参数 |
| --- | --- | --- |
| `none` | 对照组，用于量化「弹性层到底值不值」 | 无任何治理 |
| `conservative` | 优先保护下游与自身资源 | 重试 2 次 / 预算 10% / 故障率阈值 30% |
| `balanced` | **默认推荐**，覆盖绝大多数 RPC / HTTP 调用 | 重试 3 次 / 预算 20% / 半抖动 |
| `aggressive` | 用更高成本换可用性 | 重试 5 次 / 预算 40% / 带 1 次对冲 |

**故障场景预设**

| 预设 | 刻画的问题 |
| --- | --- |
| `healthy` | 轻微抖动，偶发瞬时错误（基线） |
| `flaky` | 错误率中等、延迟有长尾 —— 最能体现重试收益 |
| `gray-failure` | 灰度故障：长尾 + 突发窗口，最容易被误判为「偶发抖动」 |
| `overload` | 过载：并发越高越慢（排队效应），验证舱壁与限流 |
| `blackhole` | 黑洞：部分请求永不响应，只能靠客户端超时兜底 |

`examples/` 目录下已经放好了全部预设导出的 JSON，可直接复制改造。

### 库 API 一览

```ts
import {
  // 策略层：可单独使用
  BackoffCalculator, executeWithRetry, CircuitBreaker, executeWithBreaker,
  createLimiter, TokenBucketLimiter, LeakyBucketLimiter, SlidingWindowCounterLimiter,
  Bulkhead, executeWithBulkhead, executeWithHedge, executeWithTimeout,
  // 组合层：一次配齐
  ResilixStack,
  // 实验层
  simulate, simulateMany, compareResults, renderSimReport, toMarkdown, toCsv, toJson,
  // 体检层
  lintPolicy, renderLintReport,
  // 基础设施
  createSystemClock, VirtualClock, createRng,
} from 'resilix';
```

单独用某个组件也很自然：

```ts
import { CircuitBreaker, createSystemClock } from 'resilix';

const clock = createSystemClock();
const breaker = new CircuitBreaker({
  windowMs: 10_000, bucketCount: 10, minimumCalls: 20,
  failureRateThreshold: 0.5, slowCallRateThreshold: 0.8, slowCallMs: 800,
  openWaitMs: 5000, halfOpenMaxCalls: 3,
}, clock);

if (!breaker.allowRequest()) return fallback();
try {
  const started = clock.now();
  const data = await callRemote();
  breaker.recordSuccess(clock.now() - started);
  return data;
} catch (e) {
  breaker.recordFailure(clock.now() - started);
  throw e;
}
```

---

## 💡 设计思路与迭代规划

### 为什么要有虚拟时钟？

弹性策略的全部难点在于**时间**：

- 重试要等多久？只有在几分钟、几万次请求的尺度上才看得出差异；
- 断路器该不该开？取决于窗口内的失败率分布，而不是某一次请求；
- 对冲该多久触发？答案藏在 p95 与 p99 的差值里。

真实时间没法压缩。`VirtualClock` 把所有等待变成离散事件队列里的一个条目，
于是「几万个请求 / 几小时系统行为」可以在几十毫秒内算完，而且**同一个种子必然得到同一份结果** ——
这让策略变更可以在 CI 里做回归测试。

实现上有两个关键设计：

1. 事件按 `(time, seq)` 排序，同一虚拟时刻的事件严格按提交顺序执行；
2. 每次推进时间前先排空微任务队列，否则会出现「异步链还没来得及提交新任务，时间就已经跳过去」的经典竞态。

### 为什么坚持这三个指标？

| 指标 | 为什么是它 |
| --- | --- |
| **成功率** | 用户视角的可用性。注意它被拆成了「业务失败」与「本地拒绝」两类：后者是弹性层主动保护的结果，不消耗下游资源 |
| **p99 延迟** | 尾巴才决定体验。均值会把「99 次很快 + 1 次超时」粉饰成一个看起来不错的数字 |
| **放大系数** | 实际发往下游的调用数 ÷ 逻辑请求数。**大于 2 意味着你在给已经出问题的下游加倍奉还**，雪崩往往从这里开始 |

缺任何一个都会得出错误结论：只看成功率会选「无限重试」这种自杀式配置；
只看重试次数会忽略对本不需要重试的永久错误的浪费。

### 分层顺序为什么是固定的？

```
timeout  →  hedge  →  breaker  →  bulkhead  →  limiter  →  retry  →  transport
```

| 层 | 位置理由 |
| --- | --- |
| `timeout` | 最外层硬预算，杜绝「内层预算之和 > 外层超时」的**超时倒挂** |
| `hedge` | 在断路器之外：每个对冲请求都要各自通过健康度检查 |
| `breaker` | 在重试之外：一次逻辑调用（含其全部重试）只贡献一个失败样本，否则抖动会被重试瞬间放大成「满窗失败」，把断路器过早冲开 |
| `bulkhead` | 在限流之外：先限制同时占用的资源，再限制发出的速率 |
| `limiter` | 在重试之外：重试同样要消耗配额，否则限流形同虚设 |
| `retry` | 最内层：只对真正拿到响应的失败做重建 |

### 迭代规划

- [ ] **开环负载模型**：泊松到达 + 指定 QPS，便于做精确的空间/速率施压实验
- [ ] **多级调用链**：A → B → C 的串联放大建模，量化「每层都配了重试」的复合后果
- [ ] **策略自动搜索**：给定 SLO 目标，在参数空间里搜索 Pareto 最优解并导出配置
- [ ] **HAR / OTLP 回放**：用真实抓包或链路数据反向拟合延迟分布，替代手调参数
- [ ] **编辑器 JSON Schema**：把 `LimiterConfig` / `PolicyStackConfig` 导出为 schema，让 IDE 直接补全与校验
- [ ] **多语言 thorax 端口**：把核心 PRNG 与虚拟时钟移植到 Python / Go / Rust，便于跨栈复现同一份实验

---

## 📦 打包与部署指南

Resilix 属于**工具库 / CLI 类**项目：不需要产出跨平台可执行二进制，也不需要上传 Release 附件 ——
产物就是 npm 包本身。Node 自带运行时，因此任何装了 Node 的机器都能直接跑。

### 本地构建

```bash
git clone https://github.com/gitstq/Resilix.git
cd Resilix
npm ci

npm run typecheck   # TypeScript 类型检查
npm run build       # 产出 dist/cjs（CommonJS）与 dist/esm（ESM）
npm test            # 全量测试（Node 内置 node:test，84 个用例）
npm run smoke       # CLI 冒烟
npm run clean       # 清理产物
```

产物结构：

```
dist/
├── cjs/            # CommonJS，package.json 声明 {"type":"commonjs"}
│   ├── index.js    # 库入口
│   ├── cli/index.js# CLI 入口（自带 shebang）
│   └── **/*.d.ts   # 类型声明
└── esm/            # ESM，package.json 声明 {"type":"module"}
    └── ...
```

### 集成到 CI（推荐用法）

```yaml
- uses: actions/setup-node@v4
  with: { node-version: 22, cache: npm }
- run: npm ci
- name: 策略体检（配置门禁）
  run: npx resilix lint -p policies/checkout.json --method POST --caller-timeout 1000
- name: 策略回归（可用性不得低于基线）
  run: |
    npx resilix sim -p policies/checkout.json -f scenarios/overload.json \
      --requests 5000 --seed 2026 --json -o report.json
```

### 发布到私有registry / 离线环境

```bash
npm pack                     # 生成 resilix-1.0.0.tgz，仅包含 dist 与文档
npm install ./resilix-1.0.0.tgz
```

由于运行时依赖为零，`npm pack` 出来的包可以直接在内网拷贝分发，不会出现「装不上某个传递依赖」的问题。

### 兼容性矩阵

| Node 版本 | 状态 |
| --- | --- |
| 18.x | ✅ 支持 |
| 20.x | ✅ 支持 |
| 22.x | ✅ 支持（推荐） |
| < 18 | ❌ 不支持（依赖 `structuredClone` 与 `node:test`） |

---

## 🤝 贡献指南

欢迎 Issue 与 PR。提交前请注意：

1. commit message 遵循 **Angular 规范**：`feat:` / `fix:` / `docs:` / `refactor:` / `perf:` / `test:` / `chore:`
2. `npm run typecheck && npm test && npm run build` 必须全绿
3. 新增或修改的行为必须配套测试用例（测试放在 `tests/`，使用 Node 内置 `node:test`）
4. 三条设计红线不得破坏：**运行时依赖为零**、**时间与随机必须可注入**、**同种子必须同结果**

完整约定见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

**提问之前，建议先做一件事**：把你遇到的问题用 `resilix sim` 跑一遍，带着 `--json` 输出来提 Issue，
这样别人能立刻复现你的场景。

---

## 📄 开源协议说明

本项目采用 **MIT License** 开源，详见 [LICENSE](./LICENSE)。

- ✅ 允许商用、修改、再发布、私有化部署
- ✅ 允许闭源衍生
- ⚠️ 唯一要求：保留原始版权声明与许可声明

第三方依赖方面：运行时依赖为零（这是刻意的设计），开发期仅使用 `typescript` 与 `@types/node`，
二者分别为 Apache-2.0 与 MIT 许可。

---

<div align="center">

**别再拍脑袋写「重试三次」了，跑一遍数据再决定。**

Made with 🛡️ by [gitstq](https://github.com/gitstq)

</div>
