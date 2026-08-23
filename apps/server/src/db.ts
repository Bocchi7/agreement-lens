import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { AnalysisInputSnapshot, AnalysisResult, CreateAnalysisInput, JobStatus, UserContext, VersionComparison } from "@agreement-lens/shared";
import { dedupeFindings } from "@agreement-lens/agent-core";
import type { MainAgentSession } from "@agreement-lens/agent-core";
import { appDbPath, dataDir, knowledgeDbPath, snapshotDir } from "./config.js";
import { runKnowledgeShell } from "./knowledge-shell.js";

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(snapshotDir, { recursive: true });

export const db = new Database(appDbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS pair_tokens (
    token TEXT PRIMARY KEY,
    extension_origin TEXT,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS analyses (
    id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL,
    service_name TEXT NOT NULL,
    page_url TEXT NOT NULL,
    context_json TEXT NOT NULL,
    request_json TEXT NOT NULL,
    result_json TEXT,
    saved INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    analysis_id TEXT NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'analysis',
    state TEXT NOT NULL,
    progress INTEGER NOT NULL,
    message TEXT NOT NULL,
    error TEXT,
    agents_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS agent_sessions (
    analysis_id TEXT PRIMARY KEY REFERENCES analyses(id) ON DELETE CASCADE,
    session_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS services (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    page_url TEXT NOT NULL,
    latest_analysis_id TEXT,
    source_fingerprint TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS versions (
    id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL,
    previous_analysis_id TEXT NOT NULL,
    current_analysis_id TEXT NOT NULL,
    comparison_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);
try {
  db.exec("ALTER TABLE jobs ADD COLUMN agents_json TEXT");
} catch {
  // Existing databases already have this column.
}
try {
  db.exec("ALTER TABLE jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'analysis'");
} catch {
  // Existing databases already have this column.
}

export function createAnalysisRecord(record: {
  id: string; serviceId: string; serviceName: string; pageUrl: string;
  context: UserContext; request: unknown; job: JobStatus;
}) {
  db.prepare(`INSERT INTO analyses
    (id, service_id, service_name, page_url, context_json, request_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(record.id, record.serviceId, record.serviceName, record.pageUrl, JSON.stringify(record.context), JSON.stringify(record.request), record.job.createdAt, record.job.updatedAt);
  db.prepare(`INSERT INTO jobs (id, analysis_id, kind, state, progress, message, agents_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      record.job.id,
      record.id,
      record.job.kind,
      record.job.state,
      record.job.progress,
      record.job.message,
      record.job.agents ? JSON.stringify(record.job.agents) : null,
      record.job.createdAt,
      record.job.updatedAt
    );
}

export function updateJob(job: JobStatus) {
  db.prepare("UPDATE jobs SET state=?, progress=?, message=?, error=?, agents_json=?, updated_at=? WHERE id=?")
    .run(
      job.state,
      job.progress,
      job.message,
      job.error ?? null,
      job.agents ? JSON.stringify(job.agents) : null,
      job.updatedAt,
      job.id
    );
}

export function discardAnalysisRecordForJob(jobId: string, discardedAnalysisId: string, replacementAnalysisId: string) {
  db.transaction(() => {
    db.prepare("UPDATE jobs SET analysis_id=? WHERE id=?").run(replacementAnalysisId, jobId);
    db.prepare("DELETE FROM analyses WHERE id=?").run(discardedAnalysisId);
  })();
}

export function getJob(id: string): JobStatus | undefined {
  const row = db.prepare("SELECT * FROM jobs WHERE id=?").get(id) as Record<string, unknown> | undefined;
  if (!row) return;
  return {
    id: row.id as string, analysisId: row.analysis_id as string,
    kind: (row.kind as JobStatus["kind"] | undefined) ?? "analysis",
    state: row.state as JobStatus["state"], progress: row.progress as number,
    message: row.message as string, error: row.error as string | undefined,
    agents: row.agents_json ? JSON.parse(row.agents_json as string) : undefined,
    createdAt: row.created_at as string, updatedAt: row.updated_at as string
  };
}

export function cancelJob(id: string): JobStatus | undefined {
  const current = getJob(id);
  if (!current || ["complete", "failed", "cancelled"].includes(current.state)) return current;
  const next: JobStatus = {
    ...current,
    state: "cancelled",
    progress: current.progress,
    message: "分析已中断",
    updatedAt: new Date().toISOString()
  };
  db.prepare("UPDATE jobs SET state=?, message=?, updated_at=? WHERE id=?")
    .run(next.state, next.message, next.updatedAt, id);
  return next;
}

export function saveResult(result: AnalysisResult) {
  db.prepare("UPDATE analyses SET result_json=?, updated_at=? WHERE id=?")
    .run(JSON.stringify(result), result.updatedAt, result.id);
  db.prepare(`INSERT INTO services (id, name, page_url, latest_analysis_id, source_fingerprint, created_at, updated_at)
    SELECT service_id, service_name, page_url, id, ?, created_at, updated_at FROM analyses WHERE id=?
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, page_url=excluded.page_url,
    latest_analysis_id=excluded.latest_analysis_id, source_fingerprint=excluded.source_fingerprint, updated_at=excluded.updated_at`)
    .run(result.sources.map((source) => source.fingerprint).sort().join(":"), result.id);
}

export function saveAgentSession(analysisId: string, session: MainAgentSession) {
  db.prepare(`INSERT INTO agent_sessions (analysis_id, session_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(analysis_id) DO UPDATE SET session_json=excluded.session_json, updated_at=excluded.updated_at`)
    .run(analysisId, JSON.stringify(session), new Date().toISOString());
}

export function getAgentSession(analysisId: string): MainAgentSession | undefined {
  const row = db.prepare("SELECT session_json FROM agent_sessions WHERE analysis_id=?").get(analysisId) as { session_json: string } | undefined;
  return row ? JSON.parse(row.session_json) as MainAgentSession : undefined;
}

function compactDuplicateFindings(result: AnalysisResult): AnalysisResult {
  const findings = dedupeFindings(result.findings);
  if (findings.length === result.findings.length) return result;
  const validIds = new Set(findings.map((finding) => finding.id));
  const topFindingIds = [
    ...result.topFindingIds.filter((id) => validIds.has(id)),
    ...findings.filter((finding) => finding.status === "verified").map((finding) => finding.id)
  ].filter((id, index, ids) => ids.indexOf(id) === index).slice(0, 3);
  return { ...result, findings, topFindingIds };
}

export function getAnalysis(id: string): AnalysisResult | undefined {
  const row = db.prepare("SELECT result_json, request_json FROM analyses WHERE id=?").get(id) as { result_json: string | null; request_json: string } | undefined;
  if (!row?.result_json) return;
  const result = compactDuplicateFindings(JSON.parse(row.result_json) as AnalysisResult);
  if (!result.analysisInput && row.request_json) {
    const request = JSON.parse(row.request_json) as CreateAnalysisInput;
    result.analysisInput = {
      pageUrl: request.pageUrl,
      sources: request.sources
        .filter((source) => source.selected)
        .map(({ dataBase64: _dataBase64, renderedHtml: _renderedHtml, ...source }) => source),
      context: request.context
    } satisfies AnalysisInputSnapshot;
  }
  return result;
}

export function listRecentAnalyses(limit = 50) {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const rows = db.prepare(`
    SELECT id, service_id, service_name, page_url, result_json, saved, created_at, updated_at
    FROM analyses
    WHERE result_json IS NOT NULL
    ORDER BY updated_at DESC, created_at DESC
    LIMIT ?
  `).all(safeLimit) as Array<{
    id: string;
    service_id: string;
    service_name: string;
    page_url: string;
    result_json: string;
    saved: number;
    created_at: string;
    updated_at: string;
  }>;
  return rows.flatMap((row) => {
    try {
      const result = JSON.parse(row.result_json) as AnalysisResult;
      return [{
        analysisId: row.id,
        serviceId: row.service_id,
        serviceName: row.service_name,
        pageUrl: row.page_url,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        recommendation: result.recommendation,
        saved: Boolean(row.saved),
        sourceCount: result.sources.length,
        findingCount: result.findings.length
      }];
    } catch {
      return [];
    }
  });
}

export function getAnalysisRequest(id: string) {
  const row = db.prepare("SELECT * FROM analyses WHERE id=?").get(id) as Record<string, unknown> | undefined;
  if (!row) return;
  return {
    serviceId: row.service_id as string,
    serviceName: row.service_name as string,
    pageUrl: row.page_url as string,
    context: JSON.parse(row.context_json as string) as UserContext,
    request: JSON.parse(row.request_json as string)
  };
}

export function setSaved(id: string, saved: boolean) {
  db.prepare("UPDATE analyses SET saved=?, updated_at=? WHERE id=?").run(saved ? 1 : 0, new Date().toISOString(), id);
  const result = getAnalysis(id);
  if (result) {
    result.saved = saved;
    result.updatedAt = new Date().toISOString();
    saveResult(result);
  }
}

export function deleteAnalysis(id: string) {
  const result = getAnalysis(id);
  const row = db.prepare("SELECT service_id FROM analyses WHERE id=?").get(id) as { service_id: string } | undefined;
  db.prepare("DELETE FROM analyses WHERE id=?").run(id);
  db.prepare("DELETE FROM versions WHERE previous_analysis_id=? OR current_analysis_id=?").run(id, id);
  if (row) {
    const latest = db.prepare(`
      SELECT id, result_json FROM analyses
      WHERE service_id=? AND result_json IS NOT NULL
      ORDER BY created_at DESC LIMIT 1
    `).get(row.service_id) as { id: string; result_json: string } | undefined;
    if (!latest) {
      db.prepare("DELETE FROM services WHERE id=?").run(row.service_id);
    } else {
      const latestResult = JSON.parse(latest.result_json) as AnalysisResult;
      db.prepare("UPDATE services SET latest_analysis_id=?, source_fingerprint=?, updated_at=? WHERE id=?")
        .run(
          latest.id,
          latestResult.sources.map((source) => source.fingerprint).sort().join(":"),
          new Date().toISOString(),
          row.service_id
        );
    }
  }
  for (const source of result?.sources ?? []) {
    if (!source.snapshotPath) continue;
    const target = path.resolve(snapshotDir, source.snapshotPath);
    if (!target.startsWith(`${path.resolve(snapshotDir)}${path.sep}`)) continue;
    try {
      fs.rmSync(target, { recursive: true, force: true });
      const parent = path.dirname(target);
      if (parent !== snapshotDir && fs.existsSync(parent) && fs.readdirSync(parent).length === 0) fs.rmdirSync(parent);
    } catch {
      // Cleanup is best-effort; database deletion must still succeed.
    }
  }
}

export function saveVersionComparison(comparison: VersionComparison) {
  db.prepare(`INSERT INTO versions
    (id, service_id, previous_analysis_id, current_analysis_id, comparison_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(
      comparison.id,
      comparison.serviceId,
      comparison.previousAnalysisId,
      comparison.currentAnalysisId,
      JSON.stringify(comparison),
      comparison.createdAt
    );
}

export function getVersionComparisons(serviceId: string): VersionComparison[] {
  return (db.prepare("SELECT comparison_json FROM versions WHERE service_id=? ORDER BY created_at DESC")
    .all(serviceId) as Array<{ comparison_json: string }>)
    .map((row) => JSON.parse(row.comparison_json) as VersionComparison);
}

export interface KnowledgeStore {
  search(query: string, limit?: number): Array<{ id: string; title: string; excerpt: string; score: number }>;
  shell(command: string): ReturnType<typeof runKnowledgeShell>;
  version?: string;
}

export function openKnowledge(): KnowledgeStore {
  if (!fs.existsSync(knowledgeDbPath)) return { search: () => [], shell: runKnowledgeShell };
  const knowledge = new Database(knowledgeDbPath, { readonly: true, fileMustExist: true });
  const versionRow = knowledge.prepare("SELECT value FROM metadata WHERE key='version'").get() as { value: string } | undefined;
  return {
    search(query, limit = 5) {
      const safe = query.replace(/[^\p{L}\p{N}\s]/gu, " ").trim();
      if (!safe) return [];
      try {
        const matchQuery = safe.split(/\s+/).filter((term) => term.length > 1).map((term) => `"${term.replace(/"/g, "")}"`).join(" OR ");
        if (!matchQuery) return [];
        return knowledge.prepare(`
          SELECT id, title, snippet(knowledge_fts, 2, '', '', ' … ', 24) AS excerpt,
                 bm25(knowledge_fts) AS rank
          FROM knowledge_fts WHERE knowledge_fts MATCH ? ORDER BY rank LIMIT ?
        `).all(matchQuery, limit).map((row: any) => ({ ...row, score: -row.rank }));
      } catch {
        return [];
      }
    },
    shell: runKnowledgeShell,
    version: versionRow?.value
  };
}

export function cleanupExpired() {
  const cutoff = new Date(Date.now() - 7 * 86400_000).toISOString();
  const expired = db.prepare("SELECT id FROM analyses WHERE saved=0 AND created_at < ?").all(cutoff) as Array<{ id: string }>;
  for (const row of expired) deleteAnalysis(row.id);
  db.prepare("DELETE FROM pair_tokens WHERE expires_at < ?").run(new Date().toISOString());
}
