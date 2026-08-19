import type { AnalysisResult, Finding, SourceDocument } from "@agreement-lens/shared";

function sourceDisplayKey(source: SourceDocument): string {
  if (!source.url) return `fingerprint:${source.fingerprint}`;
  try {
    const url = new URL(source.url);
    return `url:${url.hostname.toLocaleLowerCase()}${url.port ? `:${url.port}` : ""}${url.pathname.replace(/\/+$/, "")}${url.search}${url.hash}`;
  } catch {
    return `url:${source.url}`;
  }
}

function sourceDisplayPreference(source: SourceDocument): number {
  return (source.url?.startsWith("https://") ? 4 : 0)
    + (source.status === "ready" ? 2 : 0)
    + Math.min(source.normalizedText.length / 1_000_000, 1);
}

export function uniqueSourceDocuments(sources: SourceDocument[]): SourceDocument[] {
  const byKey = new Map<string, SourceDocument>();
  for (const source of sources) {
    const key = sourceDisplayKey(source);
    const existing = byKey.get(key);
    if (!existing || sourceDisplayPreference(source) > sourceDisplayPreference(existing)) {
      byKey.set(key, source);
    }
  }
  return [...byKey.values()];
}

export function evidenceSource(
  result: AnalysisResult,
  evidence?: Finding["evidence"][number]
): SourceDocument | undefined {
  if (!evidence) return undefined;
  return result.sources.find((source) => source.id === evidence.sourceId);
}

export function evidenceSourceUrl(
  result: AnalysisResult,
  evidence?: Finding["evidence"][number]
): string | undefined {
  if (!evidence) return undefined;
  return evidence.url ?? evidenceSource(result, evidence)?.url;
}

export function resultSourceLabel(
  result: AnalysisResult,
  evidence?: Finding["evidence"][number]
): string {
  if (!evidence) return "未能定位来源";

  const source = evidenceSource(result, evidence);
  const url = evidenceSourceUrl(result, evidence);
  if (url) {
    try {
      const host = new URL(url).hostname;
      return `${evidence.page ? `第 ${evidence.page} 页 · ` : ""}${host || "网页来源"}`;
    } catch {
      return `${evidence.page ? `第 ${evidence.page} 页 · ` : ""}网页来源`;
    }
  }

  // A URL-less text/PDF source is the only case that represents material
  // explicitly supplied by the user. Unknown references should not be
  // presented as manual material.
  if (source?.mediaType === "text" || source?.mediaType === "pdf") {
    return "手动提供的材料";
  }
  return "来源快照";
}
