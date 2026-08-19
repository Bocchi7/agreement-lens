import type { VersionComparison } from "@agreement-lens/shared";

export interface VersionHistoryEntry {
  analysisId: string;
  createdAt: string;
  recommendation: string;
  fingerprints: string[];
}

export function compactVersionHistory(
  analyses: VersionHistoryEntry[],
  comparisons: VersionComparison[]
): { analyses: VersionHistoryEntry[]; comparisons: VersionComparison[] } {
  const seenFingerprints = new Set<string>();
  const retained = analyses.filter((analysis) => {
    const signature = [...analysis.fingerprints].sort().join(":");
    if (seenFingerprints.has(signature)) return false;
    seenFingerprints.add(signature);
    return true;
  });
  const retainedIds = new Set(retained.map((analysis) => analysis.analysisId));
  return {
    analyses: retained,
    comparisons: comparisons.filter((comparison) => retainedIds.has(comparison.currentAnalysisId))
  };
}
