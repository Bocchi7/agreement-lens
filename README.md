# 协议明镜

“协议明镜”是一个面向课程大作业规模的 Chrome 用户协议解读与预警产品。插件在网页中发现用户协议、隐私政策和付费规则，用户确认当前动作与个人底线后，由四个专业视角并行分析，再进行证据核验和统一整合。

## 已实现的闭环

- 自动发现中英文协议链接，支持补充 URL、粘贴文本和上传文字型 PDF。
- 费用、数据、内容与账号、权利与变更四个分析角色并行运行。
- 每条告警包含触发条件、平台行为、用户影响、行动建议和可定位原文。
- 主分析器给出“可以继续 / 先调整 / 暂缓核实”，并支持基于当前材料追问。
- HTML、PDF、动态 DOM 回退、最多 8 份直接关联规则和原始/规范化快照。
- 本地 Markdown 知识导入、SQLite FTS5 BM25，以及 bwrap 隔离的只读知识库 shell。
- 已保存服务再次访问时自动复核；正文指纹不变时零模型调用，有变化时按领域路由并记录版本影响。
- OpenAI 兼容模型可选。未配置模型时使用可复现的本地分析器，便于稳定演示。

## 启动

```bash
pnpm install
pnpm knowledge:import
pnpm build
pnpm server:start
```

后端监听 `http://127.0.0.1:4317`，默认配对码是 `246810`。在 Chrome 的“管理扩展程序”中开启开发者模式，选择“加载已解压的扩展程序”，目录为：

```text
apps/extension/dist
```

`pnpm server:start` 会占用当前终端，终端关闭后服务也会停止。需要后台运行时使用：

```bash
pnpm server:background
pnpm server:status
pnpm server:stop
```

点击工具栏中的“协议明镜”，输入配对码，然后允许当前站点权限。若配置模型，将 `.env.example` 中对应变量放入启动环境；不配置也可以完整走通演示闭环。

`MODEL_REASONING_EFFORT` 可设为 `low`、`medium` 或 `high`，默认使用 `low` 以缩短等待时间。
默认单次模型请求超时为 180 秒、最多进行四轮工具调用；可通过 `MODEL_TIMEOUT_MS` 和 `MODEL_MAX_TOOL_ROUNDS` 调整。请求使用流式响应以区分持续推理和连接无响应；模型复核器默认关闭，需要额外模型复核时设置 `MODEL_VERIFIER_ENABLED=true`。

## 开发与验证

```bash
pnpm typecheck
pnpm test
pnpm build
```

知识库材料放在 `knowledge/*.md`，使用 frontmatter 描述 `id`、`title`、`source` 和适用范围。每次更新材料后重新运行 `pnpm knowledge:import`。完整的文件格式、更新流程和维护边界见 [知识库维护说明](docs/knowledge-maintenance.md)。

## 数据位置

- `data/app.db`：任务、分析、服务和版本关系。
- `data/knowledge.db`：离线生成的只读检索库。
- `data/snapshots/`：来源原始响应、规范化章节和内容指纹。

未主动保存的分析按 7 天清理；保存的分析和版本由用户删除时才移除。完整聊天不会长期写入数据库。
