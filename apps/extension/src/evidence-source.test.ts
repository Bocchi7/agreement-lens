import { describe, expect, it } from "vitest";
import type { AnalysisResult } from "@agreement-lens/shared";
import { resultSourceLabel } from "./evidence-source";

function resultWithSource(source: Partial<AnalysisResult["sources"][number]>): AnalysisResult {
  return {
    id: "analysis-1",
    serviceId: "example.com",
    serviceName: "Example",
    recommendation: "continue",
    recommendationReason: "",
    findings: [],
    topFindingIds: [],
    followUpSuggestions: [],
    sources: [{
      id: "source-1",
      title: "隐私政策",
      url: "https://example.com/privacy",
      mediaType: "html",
      normalizedText: "正文",
      fingerprint: "fingerprint",
      sections: [],
      fetchedAt: new Date().toISOString(),
      status: "ready",
      ...source
    }],
    coverageGaps: [],
    actionChecklist: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    saved: false,
    versions: { knowledge: "test", prompts: "test", model: "test" }
  };
}

describe("resultSourceLabel", () => {
  it("uses the matched source URL when the model omits evidence.url", () => {
    const result = resultWithSource({});
    expect(resultSourceLabel(result, {
      sourceId: "source-1",
      sectionId: "section-1",
      quote: "平台可能收集信息",
      verified: true
    })).toBe("example.com");
  });

  it("labels URL-less user-provided material as manual material", () => {
    const result = resultWithSource({
      url: undefined,
      mediaType: "text"
    });
    expect(resultSourceLabel(result, {
      sourceId: "source-1",
      sectionId: "section-1",
      quote: "用户提供的文本",
      verified: true
    })).toBe("手动提供的材料");
  });

  it("does not guess that an unknown source is manual", () => {
    const result = resultWithSource({});
    expect(resultSourceLabel(result, {
      sourceId: "missing-source",
      sectionId: "section-1",
      quote: "无法关联到来源",
      verified: false
    })).toBe("来源快照");
  });
});
