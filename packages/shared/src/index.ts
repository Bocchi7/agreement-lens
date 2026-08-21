import { z } from "zod";

const charsetAliases: Record<string, string> = {
  "gb2312": "gb18030",
  "gb_2312-80": "gb18030",
  "x-gbk": "gbk",
  "iso-8859-1": "windows-1252"
};

function declaredCharset(contentType: string, bytes: Uint8Array): string {
  const headerCharset = contentType.match(/charset\s*=\s*["']?\s*([^;"'\s]+)/i)?.[1];
  if (headerCharset) return headerCharset;

  // The meta declaration is ASCII, so it can be inspected before decoding the
  // rest of the document.
  const head = new TextDecoder("windows-1252").decode(bytes.subarray(0, 8192));
  return head.match(/<meta\b[^>]*charset\s*=\s*["']?\s*([^"'\s/>]+)/i)?.[1]
    ?? head.match(/<meta\b[^>]*content\s*=\s*["'][^"']*charset\s*=\s*([^"'\s;>]+)/i)?.[1]
    ?? "utf-8";
}

export function decodeHtmlBytes(bytes: Uint8Array, contentType = ""): string {
  const declared = declaredCharset(contentType, bytes).toLocaleLowerCase();
  const charset = charsetAliases[declared] ?? declared;
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

export const actionTypes = ["register", "pay", "upload", "authorize", "other"] as const;
export const riskCategories = ["money", "data", "content", "account", "remedies"] as const;
export const severities = ["low", "medium", "high", "critical"] as const;
export const recommendations = ["continue", "adjust", "pause"] as const;
export const maxSourceDocuments = 32;

export const userContextSchema = z.object({
  action: z.enum(actionTypes).default("register"),
  concerns: z.array(z.enum(riskCategories)).default([]),
  redlines: z.array(z.string().max(300)).default([]),
  notes: z.string().max(2000).default("")
});
export type UserContext = z.infer<typeof userContextSchema>;

export const discoveredSourceSchema = z.object({
  id: z.string(),
  kind: z.enum(["url", "text", "pdf"]),
  title: z.string(),
  url: z.string().url().optional(),
  text: z.string().optional(),
  dataBase64: z.string().max(12_000_000).optional(),
  renderedHtml: z.string().max(2_000_000).optional(),
  selected: z.boolean().default(true),
  relation: z.enum(["primary", "direct", "manual"]).default("primary")
});
export type DiscoveredSource = z.infer<typeof discoveredSourceSchema>;

export const sourceSectionSchema = z.object({
  id: z.string(),
  heading: z.string(),
  content: z.string(),
  page: z.number().int().positive().optional(),
  anchor: z.string().optional()
});
export type SourceSection = z.infer<typeof sourceSectionSchema>;

export const sourceDocumentSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string().optional(),
  mediaType: z.enum(["html", "pdf", "text"]),
  normalizedText: z.string(),
  fingerprint: z.string(),
  sections: z.array(sourceSectionSchema),
  linkedSources: z.array(z.object({ title: z.string(), url: z.string().url() })).optional(),
  snapshotPath: z.string().optional(),
  fetchedAt: z.string(),
  status: z.enum(["ready", "partial", "failed"]),
  error: z.string().optional()
});
export type SourceDocument = z.infer<typeof sourceDocumentSchema>;

export const analysisInputSourceSchema = discoveredSourceSchema.omit({
  dataBase64: true,
  renderedHtml: true
});
export const analysisInputSchema = z.object({
  pageUrl: z.string().url(),
  sources: z.array(analysisInputSourceSchema),
  context: userContextSchema
});
export type AnalysisInputSnapshot = z.infer<typeof analysisInputSchema>;

export const evidenceReferenceSchema = z.object({
  sourceId: z.string(),
  sectionId: z.string(),
  quote: z.string(),
  page: z.number().int().positive().optional(),
  url: z.string().optional(),
  verified: z.boolean().default(false)
});
export type EvidenceReference = z.infer<typeof evidenceReferenceSchema>;

export const findingSchema = z.object({
  id: z.string(),
  category: z.enum(riskCategories),
  title: z.string(),
  trigger: z.string(),
  platformAction: z.string(),
  userImpact: z.string(),
  severity: z.enum(severities),
  confidence: z.number().min(0).max(1),
  actions: z.array(z.string()),
  evidence: z.array(evidenceReferenceSchema),
  knowledgeRefs: z.array(z.string()).default([]),
  uncertainty: z.string().default(""),
  status: z.enum(["verified", "needs_verification", "rejected"]).default("needs_verification")
});
export type Finding = z.infer<typeof findingSchema>;

export const coverageGapSchema = z.object({
  sourceId: z.string().optional(),
  title: z.string(),
  detail: z.string(),
  impact: z.enum(["low", "medium", "high"])
});
export type CoverageGap = z.infer<typeof coverageGapSchema>;

export const analysisResultSchema = z.object({
  id: z.string(),
  serviceId: z.string(),
  serviceName: z.string(),
  recommendation: z.enum(recommendations),
  recommendationReason: z.string(),
  findings: z.array(findingSchema),
  topFindingIds: z.array(z.string()).max(3),
  followUpSuggestions: z.array(z.string().max(200)).max(5).default([]),
  sources: z.array(sourceDocumentSchema),
  analysisInput: analysisInputSchema.optional(),
  coverageGaps: z.array(coverageGapSchema),
  actionChecklist: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
  saved: z.boolean(),
  versions: z.object({
    knowledge: z.string(),
    prompts: z.string(),
    model: z.string()
  })
});
export type AnalysisResult = z.infer<typeof analysisResultSchema>;

export const versionComparisonSchema = z.object({
  id: z.string(),
  serviceId: z.string(),
  previousAnalysisId: z.string(),
  currentAnalysisId: z.string(),
  changed: z.boolean(),
  summary: z.string(),
  decisionImpact: z.string(),
  changedSections: z.array(z.string()),
  createdAt: z.string()
});
export type VersionComparison = z.infer<typeof versionComparisonSchema>;

export const agentProgressSchema = z.object({
  status: z.enum(["idle", "running", "completed", "failed"]),
  rounds: z.number().int().min(0),
  retries: z.number().int().min(0),
  message: z.string().optional(),
  error: z.string().optional()
});
export type AgentProgress = z.infer<typeof agentProgressSchema>;

export const jobStatusSchema = z.object({
  id: z.string(),
  analysisId: z.string(),
  kind: z.enum(["analysis", "recheck", "version-check"]).default("analysis"),
  state: z.enum(["queued", "fetching", "analyzing", "verifying", "integrating", "complete", "failed", "cancelled"]),
  progress: z.number().int().min(0).max(100),
  message: z.string(),
  error: z.string().optional(),
  agents: z.record(agentProgressSchema).optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type JobStatus = z.infer<typeof jobStatusSchema>;

export const createAnalysisSchema = z.object({
  serviceName: z.string().min(1).max(200),
  pageUrl: z.string().url(),
  sources: z.array(discoveredSourceSchema).min(1).max(maxSourceDocuments),
  context: userContextSchema,
  renderedHtml: z.string().max(2_000_000).optional()
});
export type CreateAnalysisInput = z.infer<typeof createAnalysisSchema>;

export const followUpSchema = z.object({
  message: z.string().min(1).max(4000),
  history: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    text: z.string().min(1).max(8000)
  })).max(12).default([]),
  contextPatch: userContextSchema.partial().optional()
});

export interface FollowUpResponse {
  answer: string;
  analysis?: AnalysisResult;
}

export interface PairResponse {
  token: string;
  expiresAt: string;
}

export const severityWeight: Record<(typeof severities)[number], number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4
};
