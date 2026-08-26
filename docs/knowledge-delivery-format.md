# 知识库材料交付格式

运行时知识、提示词示例和评测集应分开保存。运行时知识放在 `knowledge/`，每份材料为一个 Markdown 文件：

```markdown
---
id: cn-auto-renewal-example-001
title: 自动续费告知与取消案例
source: 某公开裁判文书或监管材料
source_url: https://example.com/source
jurisdiction: CN
document_type: case
effective_date: 2025-01-01
topics:
  - automatic-renewal
  - consumer-rights
annotations:
  - type: risk_event
    label: 自动续费
---

材料正文……
```

必填字段为 `id`、`title` 和 `source`。建议同时提供适用地区、材料类型、生效日期、原始链接、主题与结构化标注。运行 `pnpm knowledge:import` 后会生成只读的 `data/knowledge.db`，并记录正文哈希和完整 frontmatter。

评测材料不放入 `knowledge/`，避免运行时检索泄漏答案。建议分别交付：

- `tests/evaluation/development/`：8 个开发规则包。
- `tests/evaluation/holdout/`：4 个封存规则包。
- `tests/evaluation/version-pairs/`：6 组版本变化。

每个规则包的标签至少包含风险事件、证据范围、影响等级和建议动作。封存集在最终评测前不用于提示词或规则调整。
