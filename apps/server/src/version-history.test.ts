import { describe, expect, it } from "vitest";
import { compactVersionHistory } from "./version-history.js";

describe("version history", () => {
  it("collapses repeated no-op rechecks with the same source fingerprints", () => {
    const compacted = compactVersionHistory([
      { analysisId: "newest", createdAt: "2026-08-19T15:00:00Z", recommendation: "adjust", fingerprints: ["b", "a"] },
      { analysisId: "duplicate", createdAt: "2026-08-19T14:59:00Z", recommendation: "adjust", fingerprints: ["a", "b"] },
      { analysisId: "changed", createdAt: "2026-08-19T14:00:00Z", recommendation: "pause", fingerprints: ["a", "c"] }
    ], [
      {
        id: "comparison-newest",
        serviceId: "example.com",
        previousAnalysisId: "duplicate",
        currentAnalysisId: "newest",
        changed: false,
        summary: "未变化",
        decisionImpact: "无新增影响",
        changedSections: [],
        createdAt: "2026-08-19T15:00:00Z"
      },
      {
        id: "comparison-duplicate",
        serviceId: "example.com",
        previousAnalysisId: "changed",
        currentAnalysisId: "duplicate",
        changed: false,
        summary: "未变化",
        decisionImpact: "无新增影响",
        changedSections: [],
        createdAt: "2026-08-19T14:59:00Z"
      }
    ]);

    expect(compacted.analyses.map((analysis) => analysis.analysisId)).toEqual(["newest", "changed"]);
    expect(compacted.comparisons.map((comparison) => comparison.id)).toEqual(["comparison-newest"]);
  });
});
