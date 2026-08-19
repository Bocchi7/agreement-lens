import { randomUUID } from "node:crypto";
import { analysisResultSchema, type CreateAnalysisInput, type JobStatus } from "@agreement-lens/shared";
import type { AnalysisResult, VersionComparison } from "@agreement-lens/shared";
import { refineChangeRoute, routeChangedContent, runWorkflow } from "@agreement-lens/agent-core";
import type { MainAgentSession } from "@agreement-lens/agent-core";
import { getAgentSession, getJob, openKnowledge, saveAgentSession, saveResult, saveVersionComparison, updateJob } from "./db.js";
import { loadSourceGraph } from "./sources.js";
import { repoRoot } from "./config.js";
import path from "node:path";

const queue: Array<() => Promise<void>> = [];
let active = 0;
const maxConcurrency = 2;

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
  if (!current) return;
  updateJob({ ...current, ...patch, updatedAt: new Date().toISOString() });
}

function assertUsableSources(sources: Awaited<ReturnType<typeof loadSourceGraph>>) {
  if (sources.some((source) => source.normalizedText.trim().length > 80)) return;
  const detail = sources.map((source) => source.error).filter(Boolean)[0];
  throw new Error(detail
    ? `没有获取到可分析的协议正文：${detail}`
    : "没有获取到可分析的协议正文，请打开协议页面或手动粘贴文本后重试");
}

export function enqueueAnalysis(jobId: string, analysisId: string, serviceId: string, input: CreateAnalysisInput) {
  queue.push(async () => {
    try {
      setJob(jobId, { state: "fetching", progress: 10, message: "正在读取并整理协议来源" });
      const selected = input.sources.filter((source) => source.selected).slice(0, 8);
      const sources = await loadSourceGraph(selected, input.renderedHtml, 8, input.pageUrl);
      assertUsableSources(sources);
      setJob(jobId, { state: "analyzing", progress: 30, message: "来源已就绪，开始多视角分析" });
      let mainAgentSession: MainAgentSession | undefined;
      const result = await runWorkflow({
        analysisId, serviceId, serviceName: input.serviceName,
        sources, context: input.context, promptDir: path.join(repoRoot, "prompts"),
        onMainAgentSession: (session) => { mainAgentSession = session; }
      }, openKnowledge(), (progress) => setJob(jobId, {
        state: progress.stage, progress: progress.progress, message: progress.message
      }));
      saveResult(analysisResultSchema.parse(result));
      if (mainAgentSession) saveAgentSession(analysisId, mainAgentSession);
      setJob(jobId, { state: "complete", progress: 100, message: "分析完成" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "分析任务失败";
      setJob(jobId, { state: "failed", progress: 100, message: "分析失败", error: message });
    }
  });
  pump();
}

export function enqueueRecheck(
  jobId: string,
  analysisId: string,
  serviceId: string,
  input: CreateAnalysisInput,
  previousResult: AnalysisResult
) {
  queue.push(async () => {
    try {
      setJob(jobId, { state: "fetching", progress: 12, message: "正在重新抓取并计算内容指纹" });
      const selected = input.sources.filter((source) => source.selected).slice(0, 8);
      const sources = await loadSourceGraph(selected, input.renderedHtml, 8, input.pageUrl);
      assertUsableSources(sources);
      let route = routeChangedContent(previousResult.sources, sources);
      const now = new Date().toISOString();
      if (!route.changed) {
        const unchanged: AnalysisResult = {
          ...previousResult,
          id: analysisId,
          sources,
          createdAt: now,
          updatedAt: now,
          saved: true
        };
        saveResult(unchanged);
        const previousSession = getAgentSession(previousResult.id);
        if (previousSession) saveAgentSession(analysisId, previousSession);
        const comparison: VersionComparison = {
          id: randomUUID(),
          serviceId,
          previousAnalysisId: previousResult.id,
          currentAnalysisId: analysisId,
          changed: false,
          summary: "协议正文指纹未变化，本次未调用任何模型。",
          decisionImpact: "对你上次决定没有新增影响。",
          changedSections: [],
          createdAt: now
        };
        saveVersionComparison(comparison);
        setJob(jobId, { state: "complete", progress: 100, message: "正文未变化，已跳过模型分析" });
        return;
      }
      const knowledge = openKnowledge();
      route = await refineChangeRoute(route, previousResult.sources, sources, knowledge, path.join(repoRoot, "prompts"));
      setJob(jobId, {
        state: "analyzing",
        progress: 32,
        message: route.structural ? "检测到结构性变化，正在全面复核" : `正在复核 ${route.domains.length} 个受影响视角`
      });
      let mainAgentSession: MainAgentSession | undefined;
      const result = await runWorkflow({
        analysisId,
        serviceId,
        serviceName: input.serviceName,
        sources,
        context: input.context,
        promptDir: path.join(repoRoot, "prompts"),
        domains: route.domains,
        previousResult,
        saved: true,
        onMainAgentSession: (session) => { mainAgentSession = session; }
      }, knowledge, (progress) => setJob(jobId, {
        state: progress.stage, progress: progress.progress, message: progress.message
      }));
      saveResult(analysisResultSchema.parse(result));
      if (mainAgentSession) saveAgentSession(analysisId, mainAgentSession);
      const previousTitles = new Set(previousResult.findings.map((finding) => finding.title));
      const added = result.findings.filter((finding) => !previousTitles.has(finding.title)).map((finding) => finding.title);
      const comparison: VersionComparison = {
        id: randomUUID(),
        serviceId,
        previousAnalysisId: previousResult.id,
        currentAnalysisId: analysisId,
        changed: true,
        summary: added.length ? `新增或显著变化的风险：${added.slice(0, 3).join("、")}` : "条款内容有变化，风险结论已重新核验。",
        decisionImpact: previousResult.recommendation === result.recommendation
          ? `整体建议仍为“${result.recommendation}”，请重点查看变化章节。`
          : `整体建议由“${previousResult.recommendation}”变为“${result.recommendation}”。`,
        changedSections: route.changedSections,
        createdAt: now
      };
      saveVersionComparison(comparison);
      setJob(jobId, { state: "complete", progress: 100, message: "版本变化复核完成" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "版本复核失败";
      setJob(jobId, { state: "failed", progress: 100, message: "版本复核失败", error: message });
    }
  });
  pump();
}

export function newJob(analysisId: string): JobStatus {
  const now = new Date().toISOString();
  return { id: randomUUID(), analysisId, state: "queued", progress: 0, message: "任务已进入队列", createdAt: now, updatedAt: now };
}
