# Specialist JSON output contract

This is a strict machine-readable contract, not a writing suggestion.

- `confidence` must be a JSON number between `0` and `1`, never a string and never a label. Use `0.85`, not `"0.85"` and not `"high"`.
- `actions`, `evidence`, and `knowledgeRefs` must be JSON arrays.
- `evidence` must be an array of objects containing `sourceId`, `sectionId`, and a short exact `quote`.
- Do not output Markdown, comments, trailing commas, or explanatory text outside the JSON object.

Minimal valid example:

```json
{
  "findings": [
    {
      "category": "money",
      "title": "示例风险",
      "trigger": "触发条件",
      "platformAction": "平台可能采取的行为",
      "userImpact": "对用户的影响",
      "severity": "medium",
      "confidence": 0.85,
      "actions": ["付款前核对取消路径"],
      "evidence": [
        {
          "sourceId": "source-id",
          "sectionId": "section-id",
          "quote": "协议中的短句原文"
        }
      ],
      "knowledgeRefs": [],
      "uncertainty": ""
    }
  ]
}
```
