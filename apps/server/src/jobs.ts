import { randomUUID } from "node:crypto";
import { analysisResultSchema, maxSourceDocuments, type AnalysisInputSnapshot, type CreateAnalysisInput, type JobStatus } from "@agreement-lens/shared";
import type { AnalysisResult, VersionComparison } from "@agreement-lens/shared";
import { routeChangedContent, runWorkflow } from "@agreement-lens/agent-core";
import type { MainAgentSession } from "@agreement-lens/agent-core";
import { discardAnalysisRecordForJob, getAgentSession, getJob, openKnowledge, saveAgentSession, saveAgentTraceEvent, saveResult, saveVersionComparison, updateJob } from "./db.js";
import { loadSourceGraph } from "./sources.js";
import { createSourceReader } from "./related-source.js";
import { repoRoot } from "./config.js";
import path from "node:path";

const queue: Array<() => Promise<void>> = [];
let active = 0;
const maxConcurrency = 2;
const jobControllers = new Map<string, AbortController>();

export function abortJob(jobId: string): void {
  jobControllers.get(jobId)?.abort();
}

async function runWithJobSignal(jobId: string, task: (signal: AbortSignal) => Promise<void>): Promise<void> {
  if (isCancelled(jobId)) return;
  const controller = new AbortController();
  jobControllers.set(jobId, controller);
  try {
    await task(controller.signal);
  } finally {
    if (jobControllers.get(jobId) === controller) jobControllers.delete(jobId);
  }
}

function analysisInputSnapshot(input: CreateAnalysisInput): AnalysisInputSnapshot {
  return {
    pageUrl: input.pageUrl,
    sources: input.sources
      .filter((source) => source.selected)
      .map(({ dataBase64: _dataBase64, renderedHtml: _renderedHtml, ...source }) => source),
    context: input.context,
    ...(input.model ? { model: input.model } : {}),
    ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {})
  };
}

function pump() {
  while (active < maxConcurrency && queue.length) {
    const task = queue.shift();
    if (!task) return;
    active++;
    void task().finally(() => {
      active--;
      pump();
    });
  }
}

function setJob(jobId: string, patch: Partial<JobStatus>) {
  const current = getJob(jobId);
  if (!current || current.state === "cancelled") return;
  updateJob({ ...current, ...patch, updatedAt: new Date().toISOString() });
}

function isCancelled(jobId: string): boolean {
  return getJob(jobId)?.state === "cancelled";
}

function assertUsableSources(sources: Awaited<ReturnType<typeof loadSourceGraph>>) {
  const hasUsableSource = sources.some((source) => {
    const length = source.normalizedText.trim().length;
    return source.mediaType === "text" || source.mediaType === "pdf"
      ? length > 80
      : length >= 300;
  });
  if (hasUsableSource) return;
  const detail = sources.map((source) => source.error).filter(Boolean)[0]
    ?? (sources.length
      ? `来源正文过短（最长 ${Math.max(...sources.map((source) => source.normalizedText.trim().length), 0)} 字），可能仍依赖动态渲染`
      : undefined);
  throw new Error(detail
    ? `没有获取到可分析的协议正文：${detail}`
    : "没有获取到可分析的协议正文，请打开协议页面或手动粘贴文本后重试");
}

function createTrackedSourceReader(sources: Awaited<ReturnType<typeof loadSourceGraph>>) {
  const sourceReader = createSourceReader(sources);
  const readRelatedSourceIds = new Set<string>();
  const readSource = async (request: Parameters<typeof sourceReader>[0]) => {
    const result = await sourceReader(request);
    if (result.source.sourceRole === "related") {
      readRelatedSourceIds.add(result.source.id);
    }
    return result;
  };
  return { readSource, readRelatedSourceIds };
}

function visibleAnalysisSources(
  sources: Awaited<ReturnType<typeof loadSourceGraph>>,
  readRelatedSourceIds: Set<string>
) {
  return sources.filter((source) =>
    source.sourceRole !== "related" || readRelatedSourceIds.has(source.id)
  );
}

export function enqueueAnalysis(jobId: string, analysisId: string, serviceId: string, input: CreateAnalysisInput) {
  queue.push(() => runWithJobSignal(jobId, async (signal) => {
    try {
      setJob(jobId, { state: "fetching", progress: 10, message: "正在读取并整理协议来源" });
      const selected = input.sources.filter((source) => source.selected).slice(0, maxSourceDocuments);
      const sources = await loadSourceGraph(selected, input.renderedHtml, maxSourceDocuments, input.pageUrl);
      if (isCancelled(jobId)) return;
      assertUsableSources(sources);
      const { readSource, readRelatedSourceIds } = createTrackedSourceReader(sources);
      setJob(jobId, { state: "analyzing", progress: 30, message: "来源已就绪，开始多视角分析" });
      let mainAgentSession: MainAgentSession | undefined;
      const analysisStartedAt = Date.now();
      const workflowResult = await runWorkflow({
        analysisId, serviceId, serviceName: input.serviceName,
        sources, context: input.context, signal, promptDir: path.join(repoRoot, "prompts"),
        readSource,
        analysisInput: analysisInputSnapshot(input),
        onMainAgentSession: (session) => { mainAgentSession = session; },
        onTrace: (event) => saveAgentTraceEvent(analysisId, event)
      }, openKnowledge(), (progress) => setJob(jobId, {
        state: progress.stage, progress: progress.progress, message: progress.message, agents: progress.agents
      }));
      if (isCancelled(jobId)) return;
      const result = {
        ...workflowResult,
        // Keep pre-registered citations in the model catalog, but only expose
        // related sources that an Agent actually read during this run.
        sources: visibleAnalysisSources(workflowResult.sources, readRelatedSourceIds),
        analysisDurationMs: Date.now() - analysisStartedAt
      };
      saveResult(analysisResultSchema.parse(result));
      if (mainAgentSession) saveAgentSession(analysisId, mainAgentSession);
      setJob(jobId, { state: "complete", progress: 100, message: "分析完成" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "分析任务失败";
      setJob(jobId, { state: "failed", progress: 100, message: "分析失败", error: message });
    }
  }));
  pump();
}

export function enqueueRecheck(
  jobId: string,
  analysisId: string,
  serviceId: string,
  input: CreateAnalysisInput,
  previousResult: AnalysisResult
) {
  queue.push(() => runWithJobSignal(jobId, async (signal) => {
    try {
      setJob(jobId, { state: "fetching", progress: 12, message: "正在重新抓取并计算内容指纹" });
      const selected = input.sources.filter((source) => source.selected).slice(0, maxSourceDocuments);
      const sources = await loadSourceGraph(selected, input.renderedHtml, maxSourceDocuments, input.pageUrl);
      if (isCancelled(jobId)) return;
      assertUsableSources(sources);
      const { readSource, readRelatedSourceIds } = createTrackedSourceReader(sources);
      let route = routeChangedContent(previousResult.sources, sources);
      const now = new Date().toISOString();
      if (!route.changed) {
        // A no-op recheck is not a new agreement version. Reuse the previous
        // analysis record so repeated clicks do not grow the version history.
        discardAnalysisRecordForJob(jobId, analysisId, previousResult.id);
        setJob(jobId, { state: "complete", progress: 100, message: "正文未变化，已跳过模型分析" });
        return;
      }
      if (isCancelled(jobId)) return;
      setJob(jobId, {
        state: "analyzing",
        progress: 32,
        message: "检测到原文变化，正在基于新材料重新分析"
      });
      const knowledge = openKnowledge();
      let mainAgentSession: MainAgentSession | undefined;
      const analysisStartedAt = Date.now();
      const workflowResult = await runWorkflow({
        analysisId,
        serviceId,
        serviceName: input.serviceName,
        sources,
        context: input.context,
        signal,
        readSource,
        promptDir: path.join(repoRoot, "prompts"),
        analysisInput: analysisInputSnapshot(input),
        saved: true,
        onMainAgentSession: (session) => { mainAgentSession = session; },
        onTrace: (event) => saveAgentTraceEvent(analysisId, event)
      }, knowledge, (progress) => setJob(jobId, {
        state: progress.stage,
        progress: progress.progress,
        message: progress.message,
        agents: {
          ...(getJob(jobId)?.agents ?? {}),
          ...(progress.agents ?? {})
        }
      }));
      if (isCancelled(jobId)) return;
      const result = {
        ...workflowResult,
        sources: visibleAnalysisSources(workflowResult.sources, readRelatedSourceIds),
        analysisDurationMs: Date.now() - analysisStartedAt
      };
      saveResult(analysisResultSchema.parse(result));
      if (mainAgentSession) saveAgentSession(analysisId, mainAgentSession);
      const comparison: VersionComparison = {
        id: randomUUID(),
        serviceId,
        previousAnalysisId: previousResult.id,
        currentAnalysisId: analysisId,
        changed: true,
        summary: route.changedSections.length
          ? `原文变化位置：${route.changedSections.slice(0, 3).join("、")}${route.changedSections.length > 3 ? "等" : ""}`
          : "协议原文材料发生变化，已基于新材料重新分析。",
        decisionImpact: "本次结论完全基于当前抓取的协议原文重新生成，未复用历史分析结论。",
        changedSections: route.changedSections,
        createdAt: now
      };
      saveVersionComparison(comparison);
      setJob(jobId, { state: "complete", progress: 100, message: "版本变化复核完成" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "版本复核失败";
      setJob(jobId, { state: "failed", progress: 100, message: "版本复核失败", error: message });
    }
  }));
  pump();
}

export function enqueueVersionCheck(
  jobId: string,
  analysisId: string,
  serviceId: string,
  input: CreateAnalysisInput,
  previousResult: AnalysisResult
) {
  queue.push(() => runWithJobSignal(jobId, async (signal) => {
    try {
      setJob(jobId, { state: "fetching", progress: 12, message: "正在检查协议版本是否变化" });
      const selected = input.sources.filter((source) => source.selected).slice(0, maxSourceDocuments);
      const sources = await loadSourceGraph(selected, input.renderedHtml, maxSourceDocuments, input.pageUrl);
      if (isCancelled(jobId)) return;
      assertUsableSources(sources);
      const changed = routeChangedContent(previousResult.sources, sources).changed;
      discardAnalysisRecordForJob(jobId, analysisId, previousResult.id);
      setJob(jobId, {
        state: "complete",
        progress: 100,
        message: changed ? "检测到协议版本变化，请点击开始分析" : "协议版本未变化，可直接沿用历史分析"
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "版本检查失败";
      setJob(jobId, { state: "failed", progress: 100, message: "版本检查失败", error: message });
    }
  }));
  pump();
}

export function newJob(analysisId: string, kind: JobStatus["kind"] = "analysis"): JobStatus {
  const now = new Date().toISOString();
  return { id: randomUUID(), analysisId, kind, state: "queued", progress: 0, message: "任务已进入队列", createdAt: now, updatedAt: now };
}
