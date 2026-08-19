import { describe, expect, it } from "vitest";
import type { CreateAnalysisInput, UserContext } from "@agreement-lens/shared";
import { mergeSupplementalSources } from "./supplemental-sources.js";

const context: UserContext = {
  action: "register",
  concerns: ["data"],
  redlines: [],
  notes: ""
};

function source(index: number): CreateAnalysisInput["sources"][number] {
  return {
    id: `source-${index}`,
    kind: "url",
    title: `协议 ${index}`,
    url: `https://example.com/agreement/${index}`,
    selected: true,
    relation: index < 8 ? "primary" : "manual"
  };
}

describe("supplemental source merging", () => {
  it("accepts eight additional sources after an eight-source analysis", () => {
    const previous: CreateAnalysisInput = {
      serviceName: "测试服务",
      pageUrl: "https://example.com/",
      sources: Array.from({ length: 8 }, (_, index) => source(index)),
      context
    };
    const merged = mergeSupplementalSources(previous, context, {
      sources: Array.from({ length: 8 }, (_, index) => source(index + 8))
    });
    expect(merged.success).toBe(true);
    if (merged.success) {
      expect(merged.addedCount).toBe(8);
      expect(merged.data.sources).toHaveLength(16);
    }
  });

  it("deduplicates URLs while preserving SPA hash routes", () => {
    const previous: CreateAnalysisInput = {
      serviceName: "QQ邮箱",
      pageUrl: "https://mail.qq.com/",
      sources: [{
        ...source(0),
        url: "https://wx.mail.qq.com/list/readtemplate?name=app_intro.html#/agreement/mailService"
      }],
      context
    };
    const merged = mergeSupplementalSources(previous, context, {
      sources: [
        {
          ...source(1),
          url: "https://wx.mail.qq.com/list/readtemplate?name=app_intro.html#/agreement/mailService"
        },
        {
          ...source(2),
          url: "https://wx.mail.qq.com/list/readtemplate?name=app_intro.html#/agreement/expand"
        }
      ]
    });
    expect(merged.success).toBe(true);
    if (merged.success) {
      expect(merged.addedCount).toBe(1);
      expect(merged.data.sources).toHaveLength(2);
    }
  });
});
