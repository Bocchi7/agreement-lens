import {
  createAnalysisSchema,
  discoveredSourceSchema,
  maxSourceDocuments,
  userContextSchema,
  type CreateAnalysisInput,
  type UserContext
} from "@agreement-lens/shared";
import { z } from "zod";

const supplementalRequestSchema = z.object({
  sources: z.array(discoveredSourceSchema).min(1).max(8),
  context: userContextSchema.optional()
});

function sourceKey(source: CreateAnalysisInput["sources"][number]): string {
  if (!source.url) return `id:${source.id}`;
  try {
    const url = new URL(source.url);
    if (url.hash && !/^#(?:!\/|\/)/.test(url.hash)) url.hash = "";
    return `url:${url.href}`;
  } catch {
    return `url:${source.url}`;
  }
}

export type SupplementalMergeResult =
  | { success: true; data: CreateAnalysisInput; addedCount: number }
  | { success: false; error: string; details?: unknown };

export function mergeSupplementalSources(
  previousRequest: unknown,
  previousContext: UserContext,
  body: unknown
): SupplementalMergeResult {
  const previous = createAnalysisSchema.safeParse(previousRequest);
  if (!previous.success) {
    return { success: false, error: "原分析请求格式已失效", details: previous.error.flatten() };
  }
  const supplemental = supplementalRequestSchema.safeParse(body);
  if (!supplemental.success) {
    return { success: false, error: "补充材料格式不正确", details: supplemental.error.flatten() };
  }

  const sources = [...previous.data.sources];
  const seen = new Set(sources.map(sourceKey));
  for (const source of supplemental.data.sources) {
    const key = sourceKey(source);
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push(source);
  }
  const addedCount = sources.length - previous.data.sources.length;
  if (addedCount === 0) return { success: false, error: "所选补充材料已包含在当前分析中" };
  if (sources.length > maxSourceDocuments) {
    return {
      success: false,
      error: `补充后共有 ${sources.length} 份材料，当前最多支持 ${maxSourceDocuments} 份`
    };
  }

  const context = supplemental.data.context ?? previousContext;
  const merged = createAnalysisSchema.safeParse({ ...previous.data, sources, context });
  return merged.success
    ? { success: true, data: merged.data, addedCount }
    : { success: false, error: "补充材料格式不正确", details: merged.error.flatten() };
}
