import { randomBytes, randomUUID } from "node:crypto";
import Fastify from "fastify";
import cors from "@fastify/cors";
import {
  createAnalysisSchema,
  followUpSchema,
  maxSourceDocuments,
  type AgentProgress,
  type CreateAnalysisInput,
  type PairResponse,
  userContextSchema
} from "@agreement-lens/shared";
import { answerFollowUp } from "@agreement-lens/agent-core";
import {
  cancelJob, cleanupExpired, createAnalysisRecord, db, deleteAnalysis, getAgentSession, getAnalysis,
  getAnalysisRequest, getJob, getVersionComparisons, listRecentAnalyses, openKnowledge,
  saveAgentSession, setSaved
} from "./db.js";
import { abortJob, enqueueAnalysis, enqueueRecheck, enqueueVersionCheck, newJob } from "./jobs.js";
import { allowedExtensionId, serverPort } from "./config.js";
import { repoRoot } from "./config.js";
import { mergeSupplementalSources } from "./supplemental-sources.js";
import { compactVersionHistory } from "./version-history.js";
import path from "node:path";

const app = Fastify({ logger: true, bodyLimit: 80_000_000 });
const followUpProgress = new Map<string, {
  progress: AgentProgress;
  startedAt: string;
}>();

await app.register(cors, {
  origin(origin, callback) {
    if (!origin || origin === "http://localhost:5173" || origin === "http://127.0.0.1:5173") return callback(null, true);
    if (origin.startsWith("chrome-extension://") && (!allowedExtensionId || origin.endsWith(allowedExtensionId))) return callback(null, true);
    callback(new Error("Origin not allowed"), false);
  }
});

function bearer(request: { headers: Record<string, unknown> }) {
  const value = request.headers.authorization;
  return typeof value === "string" && value.startsWith("Bearer ") ? value.slice(7) : "";
}

app.addHook("preHandler", async (request, reply) => {
  if (request.url === "/health" || request.url === "/v1/pair" || request.method === "OPTIONS") return;
  const token = bearer(request);
  const row = db.prepare("SELECT token, extension_origin FROM pair_tokens WHERE token=? AND expires_at>?")
    .get(token, new Date().toISOString()) as { token: string; extension_origin: string | null } | undefined;
  if (!row) return reply.code(401).send({ error: "请先与本地分析服务配对" });
  const origin = request.headers.origin;
  if (row.extension_origin && origin && row.extension_origin !== origin) {
    return reply.code(403).send({ error: "配对令牌与当前扩展来源不匹配" });
  }
  if (origin && !origin.startsWith("chrome-extension://") && !origin.startsWith("http://localhost:") && !origin.startsWith("http://127.0.0.1:")) {
    return reply.code(403).send({ error: "来源校验失败" });
  }
});

app.get("/health", async () => ({ ok: true, version: "0.1.0", time: new Date().toISOString() }));

app.get("/v1/capabilities", async () => ({
  modelConfigured: Boolean(process.env.OPENAI_API_KEY),
  model: process.env.MODEL_NAME ?? "deterministic-demo-v1",
  pdf: true,
  ocr: false,
  knowledgeSearch: true,
  knowledgeShell: true,
  maxSourceDocuments
}));

app.post("/v1/pair", async (request, reply) => {
  const body = (request.body ?? {}) as { code?: string };
  const expected = process.env.PAIR_CODE ?? "246810";
  if (body.code !== expected) return reply.code(401).send({ error: "配对码不正确" });
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + 30 * 86400_000).toISOString();
  db.prepare("INSERT INTO pair_tokens (token, extension_origin, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .run(token, request.headers.origin ?? null, expiresAt, new Date().toISOString());
  return { token, expiresAt } satisfies PairResponse;
});

app.post("/v1/analyses", async (request, reply) => {
  const parsed = createAnalysisSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "分析请求格式不正确", details: parsed.error.flatten() });
  const input = parsed.data;
  const analysisId = randomUUID();
  const serviceId = new URL(input.pageUrl).hostname.replace(/^www\./, "");
  const job = newJob(analysisId);
  createAnalysisRecord({
    id: analysisId, serviceId, serviceName: input.serviceName,
    pageUrl: input.pageUrl, context: input.context, request: input, job
  });
  enqueueAnalysis(job.id, analysisId, serviceId, input);
  return reply.code(202).send({ analysisId, jobId: job.id });
});

app.get("/v1/analyses/history", async (request) => {
  const rawLimit = Number((request.query as { limit?: string } | undefined)?.limit ?? 50);
  const limit = Number.isFinite(rawLimit) ? rawLimit : 50;
  return { analyses: listRecentAnalyses(limit) };
});

app.get("/v1/jobs/:id", async (request, reply) => {
  const job = getJob((request.params as { id: string }).id);
  return job ?? reply.code(404).send({ error: "任务不存在" });
});

app.post("/v1/jobs/:id/cancel", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const job = cancelJob(id);
  abortJob(id);
  return job ?? reply.code(404).send({ error: "任务不存在" });
});

app.get("/v1/analyses/:id", async (request, reply) => {
  const result = getAnalysis((request.params as { id: string }).id);
  return result ?? reply.code(404).send({ error: "分析尚未完成或不存在" });
});

app.get("/v1/analyses/:id/follow-up/progress", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  if (!getAnalysis(id)) return reply.code(404).send({ error: "分析不存在" });
  return followUpProgress.get(id) ?? {
    progress: { status: "idle", rounds: 0, retries: 0, message: "尚未开始追问" },
    startedAt: new Date().toISOString()
  };
});

app.post("/v1/analyses/:id/follow-up", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const result = getAnalysis(id);
  if (!result) return reply.code(404).send({ error: "分析不存在" });
  const parsed = followUpSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "追问内容格式不正确" });
  if (parsed.data.contextPatch && Object.keys(parsed.data.contextPatch).length) {
    const previous = getAnalysisRequest(id);
    if (!previous) return reply.code(404).send({ error: "分析请求不存在" });
    const context = userContextSchema.parse({ ...previous.context, ...parsed.data.contextPatch });
    const input = createAnalysisSchema.parse({ ...(previous.request as CreateAnalysisInput), context });
    const analysisId = randomUUID();
    const job = newJob(analysisId);
    createAnalysisRecord({
      id: analysisId,
      serviceId: previous.serviceId,
      serviceName: previous.serviceName,
      pageUrl: previous.pageUrl,
      context,
      request: input,
      job
    });
    enqueueAnalysis(job.id, analysisId, previous.serviceId, input);
    return reply.code(202).send({
      answer: "你补充的事实可能改变结论，已启动重新分析。",
      analysis: result,
      analysisId,
      jobId: job.id
    });
  }
  try {
    const startedAt = new Date().toISOString();
    followUpProgress.set(id, {
      startedAt,
      progress: { status: "running", rounds: 0, retries: 0, message: "正在连接主Agent" }
    });
    const response = await answerFollowUp(
      result,
      parsed.data.message,
      getAgentSession(id),
      openKnowledge(),
      path.join(repoRoot, "prompts"),
      (progress) => {
        const current = followUpProgress.get(id);
        followUpProgress.set(id, {
          startedAt: current?.startedAt ?? startedAt,
          progress: {
            status: "running",
            rounds: progress.rounds ?? current?.progress.rounds ?? 0,
            retries: progress.retries ?? current?.progress.retries ?? 0,
            message: progress.message ?? current?.progress.message
          }
        });
      }
    );
    if (response.session) saveAgentSession(id, response.session);
    const current = followUpProgress.get(id);
    followUpProgress.set(id, {
      startedAt: current?.startedAt ?? startedAt,
      progress: {
        status: "completed",
        rounds: current?.progress.rounds ?? 0,
        retries: current?.progress.retries ?? 0,
        message: "回答生成完成"
      }
    });
    setTimeout(() => followUpProgress.delete(id), 10 * 60_000).unref();
    return { answer: response.answer, analysis: result };
  } catch (error) {
    const message = error instanceof Error ? error.message : "追问模型调用失败";
    const current = followUpProgress.get(id);
    followUpProgress.set(id, {
      startedAt: current?.startedAt ?? new Date().toISOString(),
      progress: {
        status: "failed",
        rounds: current?.progress.rounds ?? 0,
        retries: current?.progress.retries ?? 0,
        message: "追问失败",
        error: /abort|timeout/i.test(message) ? "模型响应超时" : message
      }
    });
    setTimeout(() => followUpProgress.delete(id), 10 * 60_000).unref();
    return reply.code(502).send({
      error: /abort|timeout/i.test(message) ? "追问模型响应超时，请稍后重试。" : `追问模型调用失败：${message}`
    });
  }
});

app.post("/v1/analyses/:id/sources", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const previous = getAnalysisRequest(id);
  if (!previous) return reply.code(404).send({ error: "分析不存在" });
  const merged = mergeSupplementalSources(previous.request, previous.context, request.body ?? {});
  if (!merged.success) {
    request.log.warn({
      analysisId: id,
      existingSourceCount: (previous.request as CreateAnalysisInput).sources?.length ?? 0,
      error: merged.error,
      details: merged.details
    }, "supplemental source validation failed");
    return reply.code(400).send({ error: merged.error, details: merged.details });
  }
  const analysisId = randomUUID();
  const job = newJob(analysisId);
  createAnalysisRecord({
    id: analysisId, serviceId: previous.serviceId, serviceName: previous.serviceName,
    pageUrl: previous.pageUrl, context: merged.data.context, request: merged.data, job
  });
  enqueueAnalysis(job.id, analysisId, previous.serviceId, merged.data);
  return reply.code(202).send({ analysisId, jobId: job.id });
});

app.post("/v1/analyses/:id/save", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  if (!getAnalysis(id)) return reply.code(404).send({ error: "分析不存在" });
  setSaved(id, true);
  return { ok: true };
});

app.delete("/v1/analyses/:id", async (request) => {
  deleteAnalysis((request.params as { id: string }).id);
  return { ok: true };
});

app.post("/v1/services/:id/recheck", async (request, reply) => {
  const serviceId = (request.params as { id: string }).id;
  const service = db.prepare("SELECT latest_analysis_id FROM services WHERE id=?").get(serviceId) as { latest_analysis_id: string } | undefined;
  if (!service) return reply.code(404).send({ error: "服务不存在" });
  const active = db.prepare(`
    SELECT j.id AS job_id, j.analysis_id
    FROM jobs j
    JOIN analyses a ON a.id=j.analysis_id
    WHERE a.service_id=? AND j.state IN ('queued','fetching','analyzing','verifying','integrating')
    ORDER BY j.created_at DESC LIMIT 1
  `).get(serviceId) as { job_id: string; analysis_id: string } | undefined;
  if (active) return reply.code(202).send({ analysisId: active.analysis_id, jobId: active.job_id });
  const previous = getAnalysisRequest(service.latest_analysis_id);
  const previousResult = getAnalysis(service.latest_analysis_id);
  if (!previous || !previousResult) return reply.code(404).send({ error: "历史分析不存在" });
  const body = request.body && typeof request.body === "object"
    ? request.body as Partial<CreateAnalysisInput> & { checkOnly?: boolean }
    : {};
  const inputCandidate = {
    ...(previous.request as CreateAnalysisInput),
    ...(typeof body.pageUrl === "string" ? { pageUrl: body.pageUrl } : {}),
    ...(typeof body.serviceName === "string" ? { serviceName: body.serviceName } : {}),
    ...(Array.isArray(body.sources) ? { sources: body.sources } : {}),
    ...(body.context && typeof body.context === "object" ? { context: body.context } : {}),
    ...(typeof body.renderedHtml === "string" ? { renderedHtml: body.renderedHtml } : {})
  };
  const parsedInput = createAnalysisSchema.safeParse(inputCandidate);
  if (!parsedInput.success) {
    request.log.warn({ serviceId, details: parsedInput.error.flatten() }, "version recheck input invalid");
    return reply.code(400).send({ error: "版本复核材料格式不正确", details: parsedInput.error.flatten() });
  }
  const input = parsedInput.data;
  const analysisId = randomUUID();
  const checkOnly = body.checkOnly === true;
  const job = newJob(analysisId, checkOnly ? "version-check" : "recheck");
  createAnalysisRecord({
    id: analysisId, serviceId, serviceName: previous.serviceName,
    pageUrl: previous.pageUrl, context: previous.context, request: input, job
  });
  if (checkOnly) enqueueVersionCheck(job.id, analysisId, serviceId, input, previousResult);
  else enqueueRecheck(job.id, analysisId, serviceId, input, previousResult);
  return reply.code(202).send({ analysisId, jobId: job.id });
});

app.get("/v1/services/:id/versions", async (request) => {
  const serviceId = (request.params as { id: string }).id;
  const rows = db.prepare("SELECT id, result_json, created_at FROM analyses WHERE service_id=? AND result_json IS NOT NULL ORDER BY created_at DESC")
    .all(serviceId) as Array<{ id: string; result_json: string; created_at: string }>;
  const analyses = rows.map((row) => {
    const result = JSON.parse(row.result_json);
    return {
      analysisId: row.id, createdAt: row.created_at,
      recommendation: result.recommendation,
      fingerprints: result.sources.map((source: { fingerprint: string }) => source.fingerprint)
    };
  });
  return compactVersionHistory(analyses, getVersionComparisons(serviceId));
});

cleanupExpired();
setInterval(cleanupExpired, 12 * 3600_000).unref();

try {
  await app.listen({ host: "127.0.0.1", port: serverPort });
  console.log(`Agreement Lens server listening at http://127.0.0.1:${serverPort}`);
  console.log(`Pair code: ${process.env.PAIR_CODE ?? "246810"}`);
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
