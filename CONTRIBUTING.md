# 贡献指南 🤝

感谢你愿意为 Resilix 添一块砖。为了保证每一处改动都能被快速理解与验证，请花两分钟读完下面几条约定。

## 提交规范（Angular Commit Convention）

所有 commit message 必须以下列前缀之一开头：

| 前缀 | 适用场景 |
| --- | --- |
| `feat:` | 新增能力（新的策略、新的 CLI 子命令、新的规则） |
| `fix:` | 修复缺陷（计算结果错误、边界条件遗漏） |
| `docs:` | 仅文档变更 |
| `refactor:` | 不影响外部行为的重构 |
| `perf:` | 性能优化 |
| `test:` | 新增或调整测试 |
| `chore:` | 构建、依赖、脚本等杂项 |

格式：`<前缀> <简短描述>`，描述使用祈使句，首字母不大写，结尾不加句号。例如：

```
feat: 新增去相关抖动策略
fix: 修正滑动计数窗口的边界判定
docs: 补充 hedge 层的幂等性说明
```

## 本地验证

提交 Pull Request 之前请完整跑一遍：

```bash
npm ci
npm run typecheck   # 类型检查
npm run test        # 全量测试（Node 内置 node:test）
npm run build       # 产物构建
npm run smoke       # CLI 冒烟
```

四项全绿才可能被合并。

## 新增一条静态检查规则

1. 在 `src/lint/rules.ts` 追加一个 `Rule`，必须同时给出 `why`（为什么危险）与 `fix`（怎么改）；
2. 规则 ID 沿用 `RX0XX` 递增，不得复用历史 ID；
3. 在 `tests/lint.test.ts` 中补一条用例，验证「命中」与「不误伤」两种情形；
4. `RULES` 数量变化会体现在体检报告的统计行里，无需手动登记。

## 新增一种限流算法

必须实现 `src/policies/limiter.ts` 中的 `RateLimiter` 接口全部四个方法（`tryConsume` / `retryAfterMs` / `available` 及其语义），
并满足：

- 只能通过构造函数注入的 `Clock` 取时间，禁止调用 `Date.now()`；
- 在 `tests/limiter.test.ts` 中覆盖「超配拒绝」「窗口重置」「边界效应」三类场景；
- 在 `createLimiter` 工厂与 `LimiterConfig` 联合类型中登记。

## 设计红线

以下几条是本项目刻意坚持的，提交前请确认没有被破坏：

1. **运行时依赖必须为零**。`package.json` 的 `dependencies` 永远为空，开发期依赖只允许 `typescript` 与 `@types/node`；
2. **时间与随机必须可注入**。任何直接读取真实时间或 `Math.random()` 的代码都不可合并；
3. **同种子必须同结果**。模拟器对同一个 seed 的输出必须逐位一致；
4. **AST / 源码解析类能力优先考虑静态推导**，能用配置层面推导出的结论，就不要依赖运行时采样。
