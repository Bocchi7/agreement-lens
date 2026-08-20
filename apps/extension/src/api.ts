import type {
  AnalysisResult, CreateAnalysisInput, FollowUpResponse, JobStatus, PairResponse, VersionComparison
} from "@agreement-lens/shared";

export interface VersionsResponse {
  analyses: Array<{ analysisId: string; createdAt: string; recommendation: string; fingerprints: string[] }>;
  comparisons: VersionComparison[];
}

export interface HistoryEntry {
  analysisId: string;
  serviceId: string;
  serviceName: string;
  pageUrl: string;
  createdAt: string;
  updatedAt: string;
  recommendation: AnalysisResult["recommendation"];
  saved: boolean;
  sourceCount: number;
  findingCount: number;
}

const baseUrl = "http://127.0.0.1:4317";

export class ApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "ApiError";
  }
}

async function token() {
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    return (await chrome.storage.local.get("pairToken")).pairToken as string | undefined;
  }
  return localStorage.getItem("pairToken") ?? undefined;
}

async function request<T>(path: string, init?: RequestInit, timeoutMs = 8_000): Promise<T> {
  const auth = await token();
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
      headers: {
        ...(init?.body !== undefined && init.body !== null ? { "content-type": "application/json" } : {}),
        ...(auth ? { authorization: `Bearer ${auth}` } : {}),
        ...init?.headers
      }
    });
  } catch (error) {
    if (error instanceof Error && /abort|timeout/i.test(`${error.name} ${error.message}`)) {
      throw new ApiError("请求本地分析服务超时。模型仍可能在推理，请稍后重试。");
    }
    throw new ApiError("无法连接本地分析服务。请确认后端已启动并保持运行。");
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(body.error ?? `请求失败 (${response.status})`, response.status);
  return body as T;
}

export const api = {
  health: () => request<{ ok: boolean }>("/health"),
  capabilities: () => request<{ modelConfigured: boolean; model: string }>("/v1/capabilities"),
  async pair(code: string) {
    const result = await request<PairResponse>("/v1/pair", { method: "POST", body: JSON.stringify({ code }) });
    if (typeof chrome !== "undefined" && chrome.storage?.local) await chrome.storage.local.set({ pairToken: result.token });
    else localStorage.setItem("pairToken", result.token);
    return result;
  },
  createAnalysis: (input: CreateAnalysisInput) => request<{ analysisId: string; jobId: string }>("/v1/analyses", { method: "POST", body: JSON.stringify(input) }),
  history: (limit = 50) => request<{ analyses: HistoryEntry[] }>(`/v1/analyses/history?limit=${Math.max(1, Math.min(100, Math.floor(limit)))}`),
  getJob: (id: string) => request<JobStatus>(`/v1/jobs/${id}`),
  getAnalysis: (id: string) => request<AnalysisResult>(`/v1/analyses/${id}`),
  followUp: (id: string, message: string, history: Array<{ role: "user" | "assistant"; text: string }>) => request<FollowUpResponse>(
    `/v1/analyses/${id}/follow-up`,
    { method: "POST", body: JSON.stringify({ message, history: history.slice(-12) }) },
    190_000
  ),
  addSources: (id: string, sources: CreateAnalysisInput["sources"]) => request<{ analysisId: string; jobId: string }>(`/v1/analyses/${id}/sources`, { method: "POST", body: JSON.stringify({ sources }) }),
  save: (id: string) => request<{ ok: boolean }>(`/v1/analyses/${id}/save`, { method: "POST" }),
  delete: (id: string) => request<{ ok: boolean }>(`/v1/analyses/${id}`, { method: "DELETE" }),
  versions: (serviceId: string) => request<VersionsResponse>(`/v1/services/${serviceId}/versions`),
  recheck: (serviceId: string) => request<{ analysisId: string; jobId: string }>(`/v1/services/${serviceId}/recheck`, { method: "POST" })
};
