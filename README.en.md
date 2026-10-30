<div align="center">

# 🛡️ Resilix

**Resilience policy toolkit · offline fault-injection sandbox**

Turn "retry three times, back off 100ms, add 20% jitter" from a guess into
an **engineering decision you can actually measure**.

[简体中文](./README.md) · [繁體中文](./README.zh-TW.md) · English

![zero dependency](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen)
![node](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)
![license](https://img.shields.io/badge/license-MIT-blue)
![version](https://img.shields.io/badge/npm-resilix%401.0.0-orange)
![tests](https://img.shields.io/badge/tests-84%20passing-success)

</div>

---

## 🎉 What is it?

**Resilix** is a zero-runtime-dependency TypeScript resilience toolkit plus a
**fully offline fault-injection sandbox**.

It exists because nearly every team has answered the question *"how many retries should we do?"*
with something nobody can defend:

> Retry three times, wait 100ms, add 20% jitter — says who?
> Why three and not two? Will things fall over if we disable the retry? **Nobody knows,
> because nobody ever measured it.**

Validating policies on real infrastructure is prohibitively expensive: you can't kill your
production database just to see whether the circuit breaker opens. So most resilience configs
end up copied from another repo, and then blow up at 4am during a traffic peak.

Resilix **makes time a controllable variable**:

- 🧪 A **virtual clock** drives a discrete-event engine: tens of thousands of requests finish in milliseconds of wall time
- 🎯 A **configurable downstream fault model** (latency distribution + error rate + burst windows + congestion feedback + blackholes) replaces real outages
- 📊 Policies are scored on three hard numbers: **success rate / p99 / retry amplification**
- 🔍 **17 static rules** catch configuration-level defects (thundering herd, retry storms, timeout inversion) before you merge

### Where it comes from, and how it differs

| Reference | Borrowed idea | What Resilix does differently |
| --- | --- | --- |
| Google SRE Handbook | The retry-budget concept | Implements "requests earn credits, retries spend credits" as a deterministic windowed model — and quantifies its payoff offline |
| *The Tail at Scale* | Hedged requests to cut tail latency | Adds a disabling predicate and attempt accounting, so hedging becomes a cost/latency trade-off you can measure |
| Resilience4j / Polly | Mature policy composition | Upgrades composition into *experimentation*: not just usable, but provably well-tuned |
| Chaos Mesh / Litmus | The value of fault injection | Removes the cluster/sidecar requirement — one command runs locally or in CI |

---

## ✨ Features

- 🧱 **Six policies, none missing**: backoff / retry / circuit breaker / rate limiter / bulkhead / hedging / timeout, all hand-written with zero dependencies
- ⏱️ **Injectable clock and randomness**: the same policy code runs on a real clock in production and a virtual clock in the lab — **same seed ⇒ identical results**
- 🎲 **Five latency distributions**: constant, uniform, log-normal (long tail), Pareto (extreme tail), bimodal (cache hit vs. disk)
- 🔥 **Six fault dimensions**: base error rate, transient/permanent split, burst windows, congestion feedback, server-side timeout, blackholes
- 📈 **Three hard metrics**: success rate, **p99 latency**, **retry amplification** — averages are useless here
- 🏥 **Static policy checkup**: 17 rules; any `error` fails your CI like ESLint failing your lint
- 🔁 **Side-by-side A/B/C comparison**: score multiple policies by "availability − latency penalty − cost penalty" and pick a winner
- 📦 **Zero runtime dependencies**: `dependencies` is permanently empty, so your supply-chain surface is ~zero
- 🧩 **Dual CJS + ESM builds** with full `.d.ts`
- 🎛️ **Six CLI subcommands** with a hand-rolled parser — no CLI framework pulled in

---

## 🚀 Quick start

### Requirements

- **Node.js ≥ 18** (20 or 22 recommended)
- npm / pnpm / yarn — any of them
- Any OS: Linux / macOS / Windows, no compiler toolchain needed

### Install

```bash
# as a project dependency
npm install resilix

# or try it without installing
npx resilix sim -p balanced -f flaky --requests 1000
```

### Get an answer in 30 seconds

```bash
# nothing to install: measure "governed" against "raw"
npx resilix compare -p none,balanced,aggressive -f flaky --requests 1000 --seed 2026
```

Actual output:

```
═══════════════════════════════════════════════════════════════
  Resilix policy comparison · scenario flaky · seed 2026
═══════════════════════════════════════════════════════════════
policy       success  p99(ms)  amplif  rejected  thruput(r/s)  score
─────────────────────────────────────────────────────────────
balanced     99.30%   308.21   1.1x    0.00%     282.5         99.3
aggressive   99.20%   261.51   1.09x   0.00%     315.99        99.2
none         90.90%   267.69   1x      0.00%     311.13        90.9

  🏆 Best overall: balanced (score 99.3, success 99.30%, p99 308.21ms, amplification 1.1x)
═══════════════════════════════════════════════════════════════
```

One sentence: **on this flaky downstream, a single governance layer lifts availability from
90.9% to 99.3% — for 10% more downstream calls.**

### Library usage

```ts
import { ResilixStack, createSystemClock, createRng, getPolicyPreset } from 'resilix';

const stack = new ResilixStack(getPolicyPreset('balanced'), {
  clock: createSystemClock(),
  rng: createRng('my-service'),
});

// Throw-First: fail by throwing, the policy layer decides whether to go again
const html = await stack.execute(() => fetch('https://api.example.com/ping').then((r) => r.text()));
```

```js
// CommonJS is a first-class citizen too
const { ResilixStack, createSystemClock, createRng } = require('resilix');
```

---

## 📖 Usage guide

### Command overview

| Command | Purpose | Typical use |
| --- | --- | --- |
| `sim` | One policy vs. one fault scenario | `resilix sim -p balanced -f flaky --requests 2000` |
| `compare` | Score several policies side by side | `resilix compare -p none,conservative,balanced,aggressive -f overload` |
| `lint` | Static policy checkup | `resilix lint -p ./policy.json --method POST --caller-timeout 1000` |
| `presets` | List built-in presets | `resilix presets` |
| `show` | Print the normalized config | `resilix show -p balanced -o policy.json` |
| `order` | Print layer order and why | `resilix order` |

### Global flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `-p, --policy <name\|file>` | `balanced` | Policy source: preset name or JSON file path |
| `-f, --fault <name\|file>` | `flaky` | Fault scenario source: preset name or JSON file path |
| `--requests <n>` | `1000` | Total requests in this experiment |
| `--concurrency <n>` | `20` | Concurrent clients (closed-loop model) |
| `--seed <n\|string>` | `42` | Random seed — **same seed ⇒ bit-identical results** |
| `--think <ms>` | `0` | Delay between two requests on the same client |
| `--json / --md / --csv` | — | Export format; default is a rendered terminal report |
| `-o, --out <file>` | — | Write to a file instead of stdout |
| `--p99target / --amptarget` | `500` / `1.5` | Latency and amplification targets for scoring |
| `-h, --help` | — | Help |

### Scenario 1: bring evidence to a PR

You changed the retry count. Prove it doesn't hammer the downstream:

```bash
resilix compare -p ./policy-before.json,./policy-after.json -f overload \
  --requests 5000 --seed 2026 --md -o pr-comment.md
```

`--md` output drops straight into a PR comment; `--csv` feeds dashboards for long-term trend tracking.

### Scenario 2: checkup before shipping

```bash
resilix lint -p ./examples/policy-dangerous.json --method POST --caller-timeout 1000
```

```
  ❌ ERROR  RX001  retries enabled without jitter
  ❌ ERROR  RX004  missing retry budget
  ❌ ERROR  RX006  retries enabled without an overall timeout
  ❌ ERROR  RX015  retries enabled on a non-idempotent method
  ⚠️  WARN   RX002  exponential base too large
  ⚠️  WARN   RX003  too many retry attempts
  ⚠️  WARN   RX014  backoff ceiling too small
  ℹ️  INFO   RX013  retries without a circuit breaker

  summary: 4 error / 3 warn / 1 info (17 rules checked, 9 passed)
```

Any `error` sets exit code `1`, so CI fails naturally:

```yaml
- name: policy checkup
  run: npx resilix lint -p policy/checkout.json --method POST --caller-timeout 1000
```

### Scenario 3: fighting tail latency

```bash
resilix sim -p aggressive -f gray-failure --requests 3000 --concurrency 50
```

The `aggressive` preset ships one hedged request: any request still pending past
`hedge.delayMs` gets a duplicate, cutting the tail for roughly 10% extra load.
Worth it? The **amplification** row tells you.

### Policy reference

```jsonc
{
  "name": "checkout",              // label used in reports and comparisons
  "timeoutMs": 1500,               // hard ceiling for the whole chain (outermost)

  "limiter": {                     // rate limiting: pick one of five algorithms
    "algorithm": "token-bucket",   // token-bucket | leaky-bucket | fixed-window | sliding-counter | sliding-log
    "capacity": 600,               // bucket size = allowed burst
    "refillPerSec": 400            // steady-state rate (req/s)
  },

  "bulkhead": {                    // resource isolation
    "maxConcurrent": 32,           // max in-flight calls
    "maxQueue": 64,                // max queued waiters
    "queueTimeoutMs": 200          // max time spent queuing
  },

  "breaker": {                     // circuit breaker: stop cascades
    "windowMs": 10000,             // statistics window
    "bucketCount": 10,             // number of buckets (more = more precise)
    "minimumCalls": 20,            // minimum samples before tripping
    "failureRateThreshold": 0.5,   // failure-rate threshold
    "slowCallRateThreshold": 0.8,  // slow-call threshold (1 disables it)
    "slowCallMs": 800,             // latency above this counts as "slow"
    "openWaitMs": 5000,            // how long OPEN lasts
    "halfOpenMaxCalls": 3          // probes allowed in HALF_OPEN
  },

  "retry": {                       // retry: transient failures only
    "maxAttempts": 3,              // total attempts (first included)
    "backoff": {
      "baseMs": 50,                // first wait
      "multiplier": 2,             // exponential base
      "maxMs": 2000,               // per-wait ceiling
      "jitter": "equal"            // none | full | equal | decorrelated
    },
    "retryBudgetRatio": 0.2,       // each request earns 0.2 credit, each retry spends 1
    "retryBudgetWindowMs": 10000,  // credit lifetime
    "maxElapsedMs": 600            // total budget allowed for retries in this chain
  },

  "hedge": {                       // hedging: cut the tail
    "delayMs": 300,                // wait this long before the first hedge
    "maxHedges": 1                 // how many hedges at most
  }
}
```

> ⚠️ **Idempotency**: enabling `retry` or `hedge` requires an idempotent operation.
> For writes, make sure the server honours an `Idempotency-Key` header — otherwise turn both layers off.

### Fault scenario reference

```jsonc
{
  "name": "flaky",
  "latency": { "kind": "lognormal", "medianMs": 40, "sigma": 0.8 },  // latency distribution
  "errorRate": 0.08,              // base error rate
  "transientErrorRatio": 0.95,    // share of errors that are retryable
  "bursts": [                     // burst windows
    { "fromMs": 3000, "toMs": 8000, "errorRate": 0.35, "latencyMultiplier": 2 }
  ],
  "serverConcurrencyLimit": 24,   // downstream saturation point
  "extraDelayPerInflightMs": 15,  // extra queueing delay per excess concurrent request
  "serverTimeoutMs": 1000,        // downstream's own timeout
  "blackholeRate": 0.06           // blackholes: these requests never answer
}
```

Latency distributions:

| `kind` | Parameters | Use for |
| --- | --- | --- |
| `constant` | `valueMs` | deterministic baselines, regression tests |
| `uniform` | `minMs` `maxMs` | environments with a known jitter band |
| `lognormal` | `medianMs` `sigma` | **closest to real services** (long tail, positive mean) |
| `pareto` | `minMs` `shape` | extreme tails where p99 is 10×+ the median |
| `bimodal` | `fastMs` `slowMs` `slowRatio` | mixed paths such as cache hit vs. disk |

### Built-in presets

**Policy presets**

| Preset | Intent | Key values |
| --- | --- | --- |
| `none` | control group — measures whether the resilience layer pays off at all | no governance |
| `conservative` | protect the downstream and your own resources first | 2 attempts / 10% budget / 30% failure threshold |
| `balanced` | **recommended default** for most RPC / HTTP calls | 3 attempts / 20% budget / equal jitter |
| `aggressive` | buy availability with cost | 5 attempts / 40% budget / 1 hedge |

**Fault presets**

| Preset | What it models |
| --- | --- |
| `healthy` | light jitter, rare transient errors (baseline) |
| `flaky` | moderate error rate with a long tail — where retries shine |
| `gray-failure` | gray failure: tail latency + burst window, easiest to misread as "random jitter" |
| `overload` | the slower it gets, the more it queues — validates bulkhead and limiter |
| `blackhole` | some requests never answer; only client-side timeouts can save you |

Every preset is exported as ready-to-edit JSON under `examples/`.

### API surface

```ts
import {
  // policies: usable standalone
  BackoffCalculator, executeWithRetry, CircuitBreaker, executeWithBreaker,
  createLimiter, TokenBucketLimiter, LeakyBucketLimiter, SlidingWindowCounterLimiter,
  Bulkhead, executeWithBulkhead, executeWithHedge, executeWithTimeout,
  // composition
  ResilixStack,
  // experimentation
  simulate, simulateMany, compareResults, renderSimReport, toMarkdown, toCsv, toJson,
  // static checkup
  lintPolicy, renderLintReport,
  // infrastructure
  createSystemClock, VirtualClock, createRng,
} from 'resilix';
```

Using a single building block:

```ts
import { CircuitBreaker, createSystemClock } from 'resilix';

const clock = createSystemClock();
const breaker = new CircuitBreaker({
  windowMs: 10_000, bucketCount: 10, minimumCalls: 20,
  failureRateThreshold: 0.5, slowCallRateThreshold: 0.8, slowCallMs: 800,
  openWaitMs: 5000, halfOpenMaxCalls: 3,
}, clock);

const started = clock.now();
if (!breaker.allowRequest()) return fallback();
try {
  const data = await callRemote();
  breaker.recordSuccess(clock.now() - started);
  return data;
} catch (e) {
  breaker.recordFailure(clock.now() - started);
  throw e;
}
```

---

## 💡 Design notes and roadmap

### Why a virtual clock?

Everything hard about resilience is about **time**:

- How long should a retry wait? Only visible over minutes and tens of thousands of requests
- Should the breaker open? Depends on the failure distribution inside a window, not on one request
- When should a hedge fire? The answer hides in the gap between p95 and p99

Wall-clock time can't be compressed. `VirtualClock` turns every wait into an entry in a
discrete-event queue, so "tens of thousands of requests / hours of system behaviour" finishes in
milliseconds — and **the same seed always produces the same result**, which makes policy changes
regression-testable in CI.

Two implementation details matter:

1. Events are ordered by `(time, seq)`, so events sharing a virtual instant run in submission order
2. The microtask queue is drained *before* advancing time; otherwise you hit the classic race where
   an async chain hasn't submitted its next task yet and the clock jumps past it

### Why these three metrics?

| Metric | Why it earns its place |
| --- | --- |
| **Success rate** | User-perceived availability, split into *business failures* vs. *local rejections* — the latter is the resilience layer protecting you without touching the downstream |
| **p99 latency** | Tails decide the experience; averages whitewash "99 fast requests + one timeout" into a nice-looking number |
| **Amplification** | Actual downstream calls ÷ logical requests. **Above 2× you are doubling down on a downstream that is already failing** — the usual start of a cascade |

Drop any one and your conclusion flips: success rate alone picks suicidal infinite retries;
retry counts alone hide the waste spent retrying errors that were permanent.

### Why is the layer order fixed?

```
timeout  →  hedge  →  breaker  →  bulkhead  →  limiter  →  retry  →  transport
```

| Layer | Reason for its position |
| --- | --- |
| `timeout` | outermost hard budget, eliminating **timeout inversion** (inner budgets exceeding the outer ceiling) |
| `hedge` | outside the breaker so every hedge passes its own health check |
| `breaker` | outside the retry so one logical call (all retries included) contributes exactly one sample — otherwise retries instantly flood the window and trip the breaker prematurely |
| `bulkhead` | outside the limiter: cap occupied resources before capping emission rate |
| `limiter` | outside the retry so retries consume quota too, otherwise the limiter is decorative |
| `retry` | innermost: only rebuild failures that actually reached the wire |

### Roadmap

- [ ] **Open-loop load model**: Poisson arrivals at a target QPS for precise rate experiments
- [ ] **Multi-hop call chains**: model A → B → C amplification to quantify stacked retries
- [ ] **Policy auto-tuning**: search the parameter space for Pareto-optimal configs given an SLO
- [ ] **HAR / OTLP replay**: fit latency distributions from real traces instead of hand-tuning
- [ ] **JSON Schema export** for editor autocompletion and validation of policy files
- [ ] **Cross-language ports** of the PRNG and virtual clock (Python / Go / Rust) so one experiment reproduces everywhere

---

## 📦 Build and deploy

Resilix is a **library / CLI** project: there is no cross-platform binary to ship and no Release
assets to upload — the npm package *is* the artifact, and Node supplies the runtime.

### Local build

```bash
git clone https://github.com/gitstq/Resilix.git
cd Resilix
npm ci

npm run typecheck   # TypeScript type checking
npm run build       # emits dist/cjs (CommonJS) and dist/esm (ESM)
npm test            # full test suite (built-in node:test, 84 cases)
npm run smoke       # CLI smoke test
npm run clean       # remove artifacts
```

Artifact layout:

```
dist/
├── cjs/            # CommonJS, scoped package.json {"type":"commonjs"}
│   ├── index.js    # library entry
│   ├── cli/index.js# CLI entry (shebang included)
│   └── **/*.d.ts   # type declarations
└── esm/            # ESM, scoped package.json {"type":"module"}
    └── ...
```

### CI integration (recommended)

```yaml
- uses: actions/setup-node@v4
  with: { node-version: 22, cache: npm }
- run: npm ci
- name: policy checkup (config gate)
  run: npx resilix lint -p policies/checkout.json --method POST --caller-timeout 1000
- name: policy regression (availability floor)
  run: |
    npx resilix sim -p policies/checkout.json -f scenarios/overload.json \
      --requests 5000 --seed 2026 --json -o report.json
```

### Private registry / air-gapped installs

```bash
npm pack                     # produces resilix-1.0.0.tgz with dist + docs only
npm install ./resilix-1.0.0.tgz
```

With zero runtime dependencies, the tarball can be copied around an internal network without
the usual "some transitive dep can't be fetched" pain.

### Compatibility matrix

| Node | Status |
| --- | --- |
| 18.x | ✅ supported |
| 20.x | ✅ supported |
| 22.x | ✅ supported (recommended) |
| < 18 | ❌ not supported (requires `structuredClone` and `node:test`) |

---

## 🤝 Contributing

Issues and PRs are welcome. Before you push:

1. Commit messages follow the **Angular convention**: `feat:` / `fix:` / `docs:` / `refactor:` / `perf:` / `test:` / `chore:`
2. `npm run typecheck && npm test && npm run build` must be green
3. New or changed behaviour needs tests (living in `tests/`, using the built-in `node:test`)
4. Three red lines: **zero runtime dependencies**, **clock and randomness must stay injectable**, **same seed ⇒ same result**

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full set of conventions.

**Before filing an issue**, please do one thing: reproduce your problem with `resilix sim` and
attach the `--json` output. It makes your scenario reproducible in seconds.

---

## 📄 License

Released under the **MIT License** — see [LICENSE](./LICENSE).

- ✅ Commercial use, modification, redistribution and private deployment allowed
- ✅ Closed-source derivatives allowed
- ⚠️ The only requirement: keep the original copyright and license notice

On dependencies: there are none at runtime (deliberate). Development uses only `typescript` and
`@types/node`, licensed Apache-2.0 and MIT respectively.

---

<div align="center">

**Stop guessing "retry three times". Measure it first.**

Made with 🛡️ by [gitstq](https://github.com/gitstq)

</div>
