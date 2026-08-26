# Agent 交互轨迹

每次模型分析都会把 Agent 的交互轨迹写入本地 SQLite 数据库 `data/app.db` 的 `agent_trace_events` 表。

轨迹包含：

- 模型请求：模型、API 格式、轮次、上下文消息数量、请求长度和摘要。
- 模型响应：完整可见文本、工具调用参数、用量信息和传输修复标记。
- 工具调用：Agent 请求的工具名称、调用 ID 和参数。
- 工具返回：工具的完整返回值，便于核对模型是否真正使用了返回结果。
- 重试与校验：请求失败、结构化输出校验失败及对应的错误信息。

## 查询接口

服务启动后，可以通过以下接口获取指定分析的轨迹：

```text
GET /v1/analyses/:analysisId/trace
```

接口返回按 `sequence` 排序的事件列表。例如：

```json
{
  "analysisId": "...",
  "events": [
    {
      "sequence": 1,
      "agent": "privacy",
      "phase": "request",
      "round": 0,
      "attempt": 0,
      "toolName": null,
      "data": {
        "messageCount": 2,
        "requestBytes": 4200
      },
      "createdAt": "..."
    }
  ]
}
```

## 常用排查方式

- 检查上下文是否增长：比较连续 `request` 事件中的 `messageCount`、`requestBytes`、`messages` 和 `lastMessageContent`。
- 检查工具是否真正执行：按 `tool_call` 和 `tool_result` 配对，并核对 `toolName`、调用 ID 和返回值。
- 检查是否是模型重试：查看 `retry` 事件，而不是只看 Agent 的 `round`。
- 检查格式修复：查看 `validation` 事件中的 `issues` 和原始 `content`。
- 检查 Gemini 原生会话：比较请求事件中的 `history`、`request` 以及响应后的历史摘要。

默认单条轨迹事件最多保存约 1 MB。可以通过 `TRACE_MAX_PAYLOAD_BYTES` 调整；超过上限时事件会标记为 `truncated: true`。
