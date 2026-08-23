# Prompt 维护说明

本文说明如何修改协议明镜的 Prompt，以及修改内容会进入哪些 Agent。

## 1. Prompt 在工作流中的位置

一次完整分析的主要顺序是：

```text
当前网页协议正文
        ↓
四个专业 Agent 并行审阅
        ↓
本地证据核验
        ↓
主 Agent 综合结论
        ↓
用户追问时继续使用主 Agent 会话
```

Prompt 只影响配置了模型的分析路径。没有配置模型时，系统使用本地确定性分析器，相关规则位于 `packages/agent-core/src/index.ts`。

## 2. 文件和 Agent 的对应关系

| 文件 | 使用它的 Agent | 修改它会影响什么 |
| --- | --- | --- |
| `common.md` | 专业 Agent、证据核验、主 Agent、版本路由 | 全局原则、证据边界、语言和风险定级 |
| `fees.md` | 费用 Agent | 费用、续费、退款、试用 |
| `privacy.md` | 隐私与数据 Agent | 数据收集、共享、跨境、保存期限 |
| `content-account.md` | 内容与账号 Agent | 用户内容授权、账号暂停、删除、导出 |
| `rights-changes.md` | 权利与变更 Agent | 单方变更、责任限制、争议和救济 |
| `specialist-output.md` | 四个专业 Agent | 输出字段和 JSON 格式 |
| `verifier.md` | 证据核验 Agent | 证据是否存在、是否可核验 |
| `main.md` | 主 Agent 和追问 Agent | 告警去重、排序、最终建议、追问 |
| `change-router.md` | 版本路由 Agent | 变化涉及哪些专业领域 |

## 3. Prompt 如何组合

专业 Agent 使用：

```text
common.md
+ 对应领域 Prompt
+ specialist-output.md
+ 程序中的结构化输出约束
```

例如费用 Agent 使用：

```text
common.md
+ fees.md
+ specialist-output.md
```

主 Agent 使用：

```text
common.md
+ main.md
+ 程序中的整合任务约束
```

追问继续沿用主 Agent 的会话，并追加“自然语言回答用户”的对话约束。

## 4. 应该在哪里写不同类型的规则

### 全局风险标准

写入 `common.md`，例如：

- 常见条款不应自动判为高危；
- 必须同时考虑实际影响、异常程度、可逆性和用户控制权；
- 证据必须来自当前协议；
- 不确定时应明确说明缺口。

### 领域判断标准

写入对应领域 Prompt。例如：

- 自动续费的默认开启、取消难度和通知方式，写入 `fees.md`；
- 敏感信息、接收方和保存期限，写入 `privacy.md`；
- 永久、不可撤销、可转授权，写入 `content-account.md`；
- 单方修改、通知和退出期限，写入 `rights-changes.md`。

### 最终整合标准

写入 `main.md`，例如：

- 如何处理重复告警；
- 如何排序重点问题；
- 什么时候给出“可以继续”；
- 如何生成面向用户的追问，而不是反向询问用户。

### 输出格式

写入 `specialist-output.md`，但不要把风险判断规则主要写在这里。该文件的职责是保证模型返回可以被程序解析的 JSON。

## 5. 风险校准建议

如果发现模型把大量常见条款判为高危，建议在 `common.md` 中加入以下原则：

```text
不要因为出现某个风险主题就自动生成高危告警。

每个候选告警都必须评估：
1. 该安排在同类服务中是否常见；
2. 当前条款是否明显超出通常范围；
3. 对用户的实际影响；
4. 影响是否可逆；
5. 用户是否有清晰的取消、撤回、删除、申诉或导出路径；
6. 平台是否提供了清楚的通知、期限和限制。

常见、影响有限、限制清楚且可逆的安排，应判为低风险或不单独告警。
只有实际影响较大，并且存在明显异常、低透明度、低可逆性或用户控制权不足时，才使用 high 或 critical。
用户个人底线冲突时，即使该安排常见，也不能因此忽略。
```

## 6. 修改后如何生效

Prompt 会在模型请求时从 `prompts/` 读取。修改后建议：

```bash
pnpm build
pnpm server:stop
pnpm server:background
```

同时修改：

```dotenv
PROMPT_VERSION=2026-08-23-risk-calibration-v1
```

`PROMPT_VERSION` 不会改变 Prompt 内容，它只是写入分析结果，用于识别这次分析采用的 Prompt 版本。

## 7. Prompt 的边界

Prompt 可以改变模型 Agent 的审阅原则，但不能：

- 为协议原文不存在的事实补充证据；
- 直接改变当前网页解析结果；
- 改变没有配置模型时的确定性分析器；
- 让知识库自动成为协议证据；
- 替代对当前协议原文的核验。

如果要改变无模型模式的严重程度和触发规则，应修改：

```text
packages/agent-core/src/index.ts
```

中的 `patterns` 和 `runSpecialist()`。
