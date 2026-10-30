<div align="center">

# 🛡️ Resilix

**彈性策略工具箱 · 離線故障注入沙盤**

把「重試幾次、多久退避、什麼時候熔斷」從拍腦袋的常數，
變成可以被**量化驗證**的工程對象。

[简体中文](./README.md) · 繁體中文 · [English](./README.en.md)

![zero dependency](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen)
![node](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)
![license](https://img.shields.io/badge/license-MIT-blue)
![version](https://img.shields.io/badge/npm-resilix%401.0.0-orange)
![tests](https://img.shields.io/badge/tests-84%20passing-success)

</div>

---

## 🎉 專案介紹

**Resilix** 是零執行期依賴的 TypeScript 彈性策略工具箱，外加一套完全離線的**故障注入沙盤**。

它為了解決一個幾乎每個團隊都踩過的坑：

> 重試三次、間隔 100ms、抖動加 20% —— 這些數字是誰訂的？
> 為什麼是三次而不是兩次？關掉重試會雪崩還是不會？**沒人答得出來，因為從來沒被量化過。**

在真實環境驗證的代價太高：你不可能為了讓斷路器生效，真的去砍一次資料庫。
於是絕大多數彈性配置最後都停在「抄一份別人的值」，然後在某次大促的凌晨四點爆雷。

Resilix 的解法是**把時間變成可操控的變數**：

- 🧪 以 **虛擬時鐘** 驅動離散事件模擬，數萬次請求在數十毫秒內算完；
- 🎯 用可設定的下游故障模型（延遲分佈 + 錯誤率 + 突發窗口 + 擁塞回饋 + 黑洞）取代真實故障；
- 📊 用 **成功率 / p99 / 放大係數** 三個硬指標替策略打分，而不是爭論配置好不好看；
- 🔍 用 **17 條靜態規則** 在送出前掃出典型的配置級缺陷（驚群、重試風暴、超時倒掛……）。

### 靈感來源與自研差異

| 參考對象 | 借鏡之處 | Resilix 的自研突破 |
| --- | --- | --- |
| Google SRE Handbook | 重試預算（retry budget）的治理精神 | 把「依流量比例掙額度」做成確定性的時間窗口模型，並能在離線沙盤裡直接量化收益 |
| 《The Tail at Scale》 | 對沖請求壓縮長尾的思路 | 加入禁用謂詞與嘗試計數，讓它可以進入「佔用 ⇄ 尾延遲」的取捨分析 |
| Resilience4j / Polly | 成熟的策略組合方式 | 把「策略組合」升級為「策略實驗」：不只能用，還能跑數據證明該怎麼配 |
| Chaos Mesh / Litmus | 故障注入的價值 | 去掉對叢集與 sidecar 的依賴，一條指令就能在本機或 CI 裡注入與回歸 |

---

## ✨ 核心特性

- 🧱 **六種策略，一層不缺**：退避 / 重試 / 斷路器 / 限流 / 艙壁 / 對沖 / 超時，全部零依賴自研
- ⏱️ **注入式時鐘與隨機源**：同一套策略程式碼，上線跑真實時鐘，實驗跑虛擬時鐘；**同種子必定同結果**
- 🎲 **五種延遲分佈**：常數、均勻、對數常態（長尾）、帕累托（極端長尾）、雙峰（快取命中 vs 落盤）
- 🔥 **六種故障維度**：基礎錯誤率、瞬時/永久錯誤配比、突發故障窗口、併發擁塞回饋、伺服端超時、黑洞（永不回應）
- 📈 **三個硬指標**：成功率、**p99 延遲**、**重試放大係數** —— 只看這三個數字就夠了，均值毫無意義
- 🏥 **策略靜態體檢**：17 條規則，`error` 級問題直接讓 CI 轉紅，像 ESLint 一樣守著你的配置
- 🔁 **A/B/C 橫向對比**：一條指令跑多套策略，依「可用性 − 延遲懲罰 − 成本懲罰」給出綜合評分與最佳解
- 📦 **零執行期依賴**：`dependencies` 恆為空，供應鏈攻擊面趨近於零
- 🧩 **CJS + ESM 雙格式**：`import` 與 `require` 都是一等公民，附完整 `.d.ts`
- 🎛️ **六個子指令的 CLI**：自研參數解析與渲染，不依賴任何 CLI 框架

---

## 🚀 快速開始

### 環境需求

- **Node.js ≥ 18**（建議 20 或 22）
- npm / pnpm / yarn 任一套件管理工具
- 作業系統不限：Linux / macOS / Windows 皆可，無需編譯工具鏈

### 安裝

```bash
# 作為專案依賴
npm install resilix

# 不安裝，直接試用
npx resilix sim -p balanced -f flaky --requests 1000
```

### 30 秒看結論

```bash
# 什麼都不裝，先看「加上治理」與「裸呼叫」的差距
npx resilix compare -p none,balanced,aggressive -f flaky --requests 1000 --seed 2026
```

真實輸出（`resilix compare -p none,balanced,aggressive -f flaky --requests 1000 --seed 2026`）：

```
═══════════════════════════════════════════════════════════════
  Resilix 策略對比 · 場景 flaky · 種子 2026
═══════════════════════════════════════════════════════════════
策略        成功率  p99(ms)  放大   本地拒絕  吞吐(r/s)  評分
─────────────────────────────────────────────────────────────
balanced    99.30%  308.21   1.1x   0.00%     282.5      99.3
aggressive  99.20%  261.51   1.09x  0.00%     315.99     99.2
none        90.90%  267.69   1x     0.00%     311.13     90.9

  🏆 綜合最優: balanced（評分 99.3，成功率 99.30%，p99 308.21ms，放大 1.1x）
═══════════════════════════════════════════════════════════════
```

一句話結論：**在這個抖動場景下，加一層治理把可用性從 90.9% 提到 99.3%，代價只多了 10% 的下游呼叫。**

### 作為函式庫使用

```ts
import { ResilixStack, createSystemClock, createRng, getPolicyPreset } from 'resilix';

const stack = new ResilixStack(getPolicyPreset('balanced'), {
  clock: createSystemClock(),
  rng: createRng('my-service'),
});

// Throw-First：失敗請拋錯，策略層負責處理「要不要再來一次」
const html = await stack.execute(() => fetch('https://api.example.com/ping').then((r) => r.text()));
```

```js
// CommonJS 同樣是一等公民
const { ResilixStack, createSystemClock, createRng } = require('resilix');
```

---

## 📖 詳細使用指南

### 指令總覽

| 指令 | 作用 | 典型用法 |
| --- | --- | --- |
| `sim` | 單策略 × 單故障場景的虛擬壓測 | `resilix sim -p balanced -f flaky --requests 2000` |
| `compare` | 多策略橫向評分 | `resilix compare -p none,conservative,balanced,aggressive -f overload` |
| `lint` | 策略配置靜態體檢 | `resilix lint -p ./policy.json --method POST --caller-timeout 1000` |
| `presets` | 列出內建預設 | `resilix presets` |
| `show` | 印出正規化後的配置 | `resilix show -p balanced -o policy.json` |
| `order` | 印出分層順序與設計理由 | `resilix order` |

### 通用參數

| 參數 | 預設值 | 說明 |
| --- | --- | --- |
| `-p, --policy <name\|file>` | `balanced` | 策略來源，預設名稱或 JSON 檔案路徑 |
| `-f, --fault <name\|file>` | `flaky` | 故障場景來源，預設名稱或 JSON 檔案路徑 |
| `--requests <n>` | `1000` | 本次實驗的請求總數 |
| `--concurrency <n>` | `20` | 併發客戶端數（閉環模型） |
| `--seed <n\|string>` | `42` | 隨機種子，**同種子結果逐位一致** |
| `--think <ms>` | `0` | 每個客戶端兩次請求之間的間隔 |
| `--json / --md / --csv` | — | 指定匯出格式，預設渲染終端報告 |
| `-o, --out <file>` | — | 寫入檔案而非標準輸出 |
| `--p99target / --amptarget` | `500` / `1.5` | 評分公式中的延遲與放大目標門檻 |
| `-h, --help` | — | 說明 |

### 情境一：為一次 PR 找證據

改了重試次數，怎麼證明沒有把下游打垮？

```bash
resilix compare -p ./policy-before.json,./policy-after.json -f overload \
  --requests 5000 --seed 2026 --md -o pr-comment.md
```

`.md` 輸出可直接貼進 PR 留言；`--csv` 輸出可餵給儀表板做長期趨勢。

### 情境二：上線前的配置體檢

```bash
resilix lint -p ./examples/policy-dangerous.json --method POST --caller-timeout 1000
```

```
  ❌ ERROR  RX001  重試未開啟抖動
  ❌ ERROR  RX004  缺少重試預算
  ❌ ERROR  RX006  啟用重試卻沒有總超時
  ❌ ERROR  RX015  對非冪等方法啟用了重試
  ⚠️  WARN   RX002  指數退避底數過大
  ⚠️  WARN   RX003  重試次數過多
  ⚠️  WARN   RX014  退避上限過小
  ℹ️  INFO   RX013  有重試但沒有斷路器

  統計: 4 error / 3 warn / 1 info（共 17 條規則，通過 9 條）
```

只要有 `error`，行程結束碼為 `1`，CI 會自然失敗。把它接進流水線：

```yaml
- name: 策略體檢
  run: npx resilix lint -p policy/checkout.json --method POST --caller-timeout 1000
```

### 情境三：調整延遲長尾（灰度故障）

```bash
resilix sim -p aggressive -f gray-failure --requests 3000 --concurrency 50
```

`aggressive` 預設帶一層對沖請求：慢的那 25% 請求會在超過 `hedge.delayMs` 後自動補發一個，
用約 10% 的額外負載把長尾壓下來。值不值得？報告裡的「放大係數」會告訴你答案。

### 策略配置參考

```jsonc
{
  "name": "checkout",              // 報告與對比表格中顯示的名稱
  "timeoutMs": 1500,               // 整條鏈路的硬上限（最外層）

  "limiter": {                     // 限流：五種演算法任選其一
    "algorithm": "token-bucket",   // token-bucket | leaky-bucket | fixed-window | sliding-counter | sliding-log
    "capacity": 600,               // 桶容量 = 允許的瞬時突發量
    "refillPerSec": 400            // 穩態速率（req/s）
  },

  "bulkhead": {                    // 艙壁：資源隔離
    "maxConcurrent": 32,           // 允許同時在飛的呼叫數
    "maxQueue": 64,                // 允許排隊的等待者數量
    "queueTimeoutMs": 200          // 排隊最長等待時間
  },

  "breaker": {                     // 斷路器：阻斷級聯
    "windowMs": 10000,             // 統計窗口
    "bucketCount": 10,             // 分桶數（越多越精確）
    "minimumCalls": 20,            // 觸發斷路所需的最小樣本量
    "failureRateThreshold": 0.5,   // 失敗率門檻
    "slowCallRateThreshold": 0.8,  // 慢呼叫率門檻（設 1 表示不啟用）
    "slowCallMs": 800,             // 超過多少毫秒算「慢」
    "openWaitMs": 5000,            // OPEN 狀態冷卻時長
    "halfOpenMaxCalls": 3          // HALF_OPEN 允許的探測請求數
  },

  "retry": {                       // 重試：只針對瞬時錯誤
    "maxAttempts": 3,              // 總嘗試次數（含首次）
    "backoff": {
      "baseMs": 50,                // 第一次等待
      "multiplier": 2,             // 指數底數
      "maxMs": 2000,               // 單次等待上限
      "jitter": "equal"            // none | full | equal | decorrelated
    },
    "retryBudgetRatio": 0.2,       // 重試預算：1 次正常請求掙 0.2 點額度，1 次重試消耗 1 點
    "retryBudgetWindowMs": 10000,  // 額度有效期限
    "maxElapsedMs": 600            // 本次呼叫鏈允許花在重試上的總時長
  },

  "hedge": {                       // 對沖：壓縮長尾
    "delayMs": 300,                // 多久沒回應就補發第 1 個
    "maxHedges": 1                 // 最多補發幾個
  }
}
```

> ⚠️ **冪等性提醒**：只要啟用了 `retry` 或 `hedge`，底層操作就必須是冪等的。
> 對寫入介面請先確認伺服端支援冪等鍵（Idempotency-Key），否則請關閉這兩層。

### 故障場景參考

```jsonc
{
  "name": "flaky",
  "latency": { "kind": "lognormal", "medianMs": 40, "sigma": 0.8 },  // 延遲分佈
  "errorRate": 0.08,              // 基礎錯誤率
  "transientErrorRatio": 0.95,    // 錯誤中「可重試」的比例
  "bursts": [                     // 突發故障窗口
    { "fromMs": 3000, "toMs": 8000, "errorRate": 0.35, "latencyMultiplier": 2 }
  ],
  "serverConcurrencyLimit": 24,   // 伺服端併發飽和點
  "extraDelayPerInflightMs": 15,  // 每超出 1 個併發所增加的排隊延遲
  "serverTimeoutMs": 1000,        // 伺服端自身超時
  "blackholeRate": 0.06           // 黑洞：這些請求永不回應
}
```

支援的延遲分佈：

| `kind` | 參數 | 適用於 |
| --- | --- | --- |
| `constant` | `valueMs` | 確定性基線、回歸測試 |
| `uniform` | `minMs` `maxMs` | 抖動範圍明確的環境 |
| `lognormal` | `medianMs` `sigma` | **最貼近真實服務**（有長尾、均值恆正） |
| `pareto` | `minMs` `shape` | 極端長尾，p99 是 p50 的數十倍 |
| `bimodal` | `fastMs` `slowMs` `slowRatio` | 「快取命中 vs 落盤」的混合路徑 |

### 內建預設

**策略預設**

| 預設 | 定位 | 關鍵參數 |
| --- | --- | --- |
| `none` | 對照組，用來量化「彈性層到底值不值」 | 無任何治理 |
| `conservative` | 優先保護下游與自身資源 | 重試 2 次 / 預算 10% / 失敗率門檻 30% |
| `balanced` | **預設推薦**，涵蓋絕大多數 RPC / HTTP 呼叫 | 重試 3 次 / 預算 20% / 半抖動 |
| `aggressive` | 用更高成本換可用性 | 重試 5 次 / 預算 40% / 帶 1 次對沖 |

**故障場景預設**

| 預設 | 刻畫的問題 |
| --- | --- |
| `healthy` | 輕微抖動，偶發瞬時錯誤（基線） |
| `flaky` | 錯誤率中等、延遲有長尾 —— 最能體現重試收益 |
| `gray-failure` | 灰度故障：長尾 + 突發窗口，最容易被誤判為「偶發抖動」 |
| `overload` | 過載：併發越高越慢（排隊效應），驗證艙壁與限流 |
| `blackhole` | 黑洞：部分請求永不回應，只能靠客戶端超時兜底 |

`examples/` 目錄下已經放好全部預設匯出的 JSON，可直接複製改造。

### 函式庫 API 一覽

```ts
import {
  // 策略層：可單獨使用
  BackoffCalculator, executeWithRetry, CircuitBreaker, executeWithBreaker,
  createLimiter, TokenBucketLimiter, LeakyBucketLimiter, SlidingWindowCounterLimiter,
  Bulkhead, executeWithBulkhead, executeWithHedge, executeWithTimeout,
  // 組合層：一次配齊
  ResilixStack,
  // 實驗層
  simulate, simulateMany, compareResults, renderSimReport, toMarkdown, toCsv, toJson,
  // 體檢層
  lintPolicy, renderLintReport,
  // 基礎設施
  createSystemClock, VirtualClock, createRng,
} from 'resilix';
```

單獨使用某個元件也很自然：

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

## 💡 設計思路與迭代規劃

### 為什麼要有虛擬時鐘？

彈性策略的全部難點在於**時間**：

- 重試要等多久？只有在幾分鐘、數萬次請求的尺度上才看得出差異；
- 斷路器該不該開？取決於窗口內的失敗率分佈，而不是某一次請求；
- 對沖該多久觸發？答案藏在 p95 與 p99 的差值裡。

真實時間無法壓縮。`VirtualClock` 把所有等待離散化成事件佇列裡的一個條目，
於是「數萬個請求 / 數小時系統行為」可以在數十毫秒內算完，而且**同一個種子必然得到同一份結果** ——
這讓策略變更可以在 CI 裡做回歸測試。

實作上有兩個關鍵設計：

1. 事件依 `(time, seq)` 排序，同一虛擬時刻的事件嚴格按送出順序執行；
2. 每次推進時間前先排空微任務佇列，否則會出現「非同步鏈還來不及送出新任務，時間就已經跳過去」的經典競態。

### 為什麼堅持這三個指標？

| 指標 | 為什麼是它 |
| --- | --- |
| **成功率** | 使用者視角的可用性。它被拆成「業務失敗」與「本地拒絕」兩類：後者是彈性層主動保護的結果，不消耗下游資源 |
| **p99 延遲** | 尾巴才決定體驗。均值會把「99 次很快 + 1 次超時」粉飾成一個看起來不錯的數字 |
| **放大係數** | 實際發往下游的呼叫數 ÷ 邏輯請求數。**大於 2 表示你正在對已經出問題的下游加倍奉還**，雪崩往往從這裡開始 |

缺任何一個都會得出錯誤結論：只看成功率會選到「無限重試」這種自殺式配置；
只看重試次數則會忽略對本不需要重試的永久錯誤的浪費。

### 分層順序為什麼是固定的？

```
timeout  →  hedge  →  breaker  →  bulkhead  →  limiter  →  retry  →  transport
```

| 層 | 位置理由 |
| --- | --- |
| `timeout` | 最外層硬預算，杜絕「內層預算之和 > 外層超時」的**超時倒掛** |
| `hedge` | 在斷路器之外：每個對沖請求都要各自通過健康度檢查 |
| `breaker` | 在重試之外：一次邏輯呼叫（含其全部重試）只貢獻一個失敗樣本，否則抖動會被重試瞬間放大成「滿窗失敗」，把斷路器過早衝開 |
| `bulkhead` | 在限流之外：先限制同時佔用的資源，再限制發出的速率 |
| `limiter` | 在重試之外：重試同樣要消耗額度，否則限流形同虛設 |
| `retry` | 最內層：只對真正拿到回應的失敗做重建 |

### 迭代規劃

- [ ] **開環負載模型**：泊松到達 + 指定 QPS，便於做精確的速率施壓實驗
- [ ] **多級呼叫鏈**：A → B → C 的串聯放大建模，量化「每層都配了重試」的複合後果
- [ ] **策略自動搜尋**：給定 SLO 目標，在參數空間裡搜尋 Pareto 最佳解並匯出配置
- [ ] **HAR / OTLP 回放**：用真實封包或鏈路數據反向擬合延遲分佈，取代手調參數
- [ ] **編輯器 JSON Schema**：把 `LimiterConfig` / `PolicyStackConfig` 匯出為 schema，讓 IDE 直接補齊與驗證
- [ ] **多語言移植**：把核心 PRNG 與虛擬時鐘移植到 Python / Go / Rust，便於跨棧重現同一份實驗

---

## 📦 打包與部署指南

Resilix 屬於**工具函式庫 / CLI 類**專案：不需要產出跨平台可執行檔，也不需要上傳 Release 附件 ——
產物就是 npm 套件本身。Node 自帶執行環境，任何裝了 Node 的機器都能直接跑。

### 本機建置

```bash
git clone https://github.com/gitstq/Resilix.git
cd Resilix
npm ci

npm run typecheck   # TypeScript 型別檢查
npm run build       # 產出 dist/cjs（CommonJS）與 dist/esm（ESM）
npm test            # 全量測試（Node 內建 node:test，84 個案例）
npm run smoke       # CLI 冒煙測試
npm run clean       # 清理產物
```

產物結構：

```
dist/
├── cjs/            # CommonJS，package.json 宣告 {"type":"commonjs"}
│   ├── index.js    # 函式庫入口
│   ├── cli/index.js# CLI 入口（自帶 shebang）
│   └── **/*.d.ts   # 型別宣告
└── esm/            # ESM，package.json 宣告 {"type":"module"}
    └── ...
```

### 整合到 CI（推薦用法）

```yaml
- uses: actions/setup-node@v4
  with: { node-version: 22, cache: npm }
- run: npm ci
- name: 策略體檢（配置門禁）
  run: npx resilix lint -p policies/checkout.json --method POST --caller-timeout 1000
- name: 策略回歸（可用性不得低於基線）
  run: |
    npx resilix sim -p policies/checkout.json -f scenarios/overload.json \
      --requests 5000 --seed 2026 --json -o report.json
```

### 發佈到私有 registry / 離線環境

```bash
npm pack                     # 產生 resilix-1.0.0.tgz，僅含 dist 與文件
npm install ./resilix-1.0.0.tgz
```

由於執行期依賴為零，`npm pack` 出來的套件可以直接在內網拷貝散佈，不會出現「某個傳遞依賴裝不上」的問題。

### 相容性矩陣

| Node 版本 | 狀態 |
| --- | --- |
| 18.x | ✅ 支援 |
| 20.x | ✅ 支援 |
| 22.x | ✅ 支援（建議） |
| < 18 | ❌ 不支援（依賴 `structuredClone` 與 `node:test`） |

---

## 🤝 貢獻指南

歡迎 Issue 與 PR。送出前請注意：

1. commit message 遵循 **Angular 規範**：`feat:` / `fix:` / `docs:` / `refactor:` / `perf:` / `test:` / `chore:`
2. `npm run typecheck && npm test && npm run build` 必須全綠
3. 新增或修改的行為必須配套測試案例（測試放在 `tests/`，使用 Node 內建 `node:test`）
4. 三條設計紅線不得破壞：**執行期依賴為零**、**時間與隨機必須可注入**、**同種子必須同結果**

完整約定見 [CONTRIBUTING.md](./CONTRIBUTING.md)。

**提問之前，建議先做一件事**：把你遇到的問題用 `resilix sim` 跑一遍，帶著 `--json` 輸出來提 Issue，
這樣別人能立刻重現你的場景。

---

## 📄 開源協議說明

本專案採用 **MIT License** 開源，詳見 [LICENSE](./LICENSE)。

- ✅ 允許商用、修改、再發佈、私有化部署
- ✅ 允許閉源衍生
- ⚠️ 唯一要求：保留原始版權聲明與授權聲明

第三方依賴方面：執行期依賴為零（這是刻意的設計），開發期僅使用 `typescript` 與 `@types/node`，
兩者分別為 Apache-2.0 與 MIT 授權。

---

<div align="center">

**別再拍腦袋寫「重試三次」了，先跑一遍數據再決定。**

Made with 🛡️ by [gitstq](https://github.com/gitstq)

</div>
