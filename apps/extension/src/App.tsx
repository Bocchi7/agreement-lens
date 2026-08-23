import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  AlertTriangle, ArrowLeft, BookOpen, Check, CheckCircle2, ChevronRight,
  Circle, CircleDollarSign, Database, ExternalLink, FileText, History, LoaderCircle,
  LockKeyhole, MessageCircle, Pencil, Plus, RefreshCw, Save, Search, Send, Shield,
  Sparkles, Trash2, Upload, UserRoundX, X
} from "lucide-react";
import type {
  AgentProgress, AnalysisResult, DiscoveredSource, Finding, JobStatus, UserContext, VersionComparison
} from "@agreement-lens/shared";
import { maxSourceDocuments } from "@agreement-lens/shared";
import { api, ApiError } from "./api";
import type { HistoryEntry } from "./api";
import type { PageSnapshot } from "./types";
import { evidenceSourceUrl, resultSourceLabel, uniqueSourceDocuments } from "./evidence-source";
import { permissionPatternsForSite } from "./frame-discovery";

type View = "overview" | "risks" | "sources" | "chat" | "versions";
type Phase = "loading" | "pair" | "permission" | "scanning" | "prepare" | "preparing" | "checking" | "running" | "result" | "history" | "offline" | "error";
type HistoryReturnState = {
  phase: Exclude<Phase, "history">;
  result: AnalysisResult | null;
  view: View;
};
type HistoryCheckState = "idle" | "loading" | "checking" | "unchanged" | "changed" | "failed" | "cancelled";
type CurrentHistory = HistoryEntry & { versionCount: number; versionConsistent: boolean; versionInfoAvailable: boolean };

const actionOptions: Array<{ value: UserContext["action"]; label: string }> = [
  { value: "register", label: "注册 / 重新同意" },
  { value: "pay", label: "付费 / 试用" },
  { value: "upload", label: "上传内容" },
  { value: "authorize", label: "授权数据" }
];
const concernOptions: Array<{ value: UserContext["concerns"][number]; label: string }> = [
  { value: "money", label: "费用" }, { value: "data", label: "数据" },
  { value: "content", label: "内容" }, { value: "account", label: "账号" },
  { value: "remedies", label: "维权" }
];
const redlineOptions = ["不能自动续费", "不能共享给第三方", "内容不能长期授权", "账号停用前必须通知"];
const categoryMeta = {
  money: { label: "费用", icon: CircleDollarSign },
  data: { label: "数据", icon: Database },
  content: { label: "内容", icon: FileText },
  account: { label: "账号", icon: UserRoundX },
  remedies: { label: "维权", icon: Shield }
};
const recommendationMeta = {
  continue: { label: "可以继续", tone: "positive" },
  adjust: { label: "先调整", tone: "warning" },
  pause: { label: "暂缓核实", tone: "danger" }
};

function demoSnapshot(): PageSnapshot {
  return {
    tabId: 1, pageUrl: "https://demo.example/membership", pageTitle: "云笺会员中心",
    origin: "https://demo.example", scannedAt: new Date().toISOString(),
    sources: [
      {
        id: crypto.randomUUID(), kind: "text", title: "云笺会员服务协议", selected: true, relation: "primary",
        text: "会员服务协议\n一、自动续费\n用户开通连续包月后，服务将在每个计费周期到期前自动续费并从原支付账户扣款。用户可在到期前二十四小时关闭。\n二、退款\n数字会员权益一经开通，不支持退款，法律另有规定的除外。\n三、协议更新\n平台有权根据服务变化修改本协议，重大变化将通过站内信通知。"
      },
      {
        id: crypto.randomUUID(), kind: "text", title: "云笺隐私政策", selected: true, relation: "primary",
        text: "隐私政策\n为提供个性化服务，我们可能收集设备信息和使用记录，并与提供分析服务的第三方共享部分数据。用户可在设置中关闭个性化推荐。"
      }
    ]
  };
}

function inferAction(page: PageSnapshot | null): UserContext["action"] {
  const text = `${page?.pageTitle ?? ""} ${(page?.sources ?? []).map((source) => source.title).join(" ")}`;
  if (/会员|付费|续费|试用|subscription|payment/i.test(text)) return "pay";
  if (/上传|创作|发布|投稿|upload|creator/i.test(text)) return "upload";
  if (/授权|隐私|数据|privacy|permission/i.test(text)) return "authorize";
  return "register";
}

function chromeAvailable() {
  return typeof chrome !== "undefined" && Boolean(chrome.runtime?.id);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}分${String(seconds).padStart(2, "0")}秒` : `${seconds}秒`;
}

type PersistedAnalysisState = {
  job?: JobStatus;
  jobId?: string;
  analysisId?: string;
  previousAnalysisId?: string;
  pageUrl?: string;
  sourceCount?: number;
};

function analysisStateKey(tabId: number) {
  return `analysis-state:${tabId}`;
}

function pageServiceId(pageUrl: string): string {
  try {
    return new URL(pageUrl).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

async function readAnalysisState(tabId: number): Promise<PersistedAnalysisState | null> {
  try {
    const key = analysisStateKey(tabId);
    if (chromeAvailable()) {
      const stored = await chrome.storage.session.get(key);
      return (stored[key] as PersistedAnalysisState | undefined) ?? null;
    }
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) as PersistedAnalysisState : null;
  } catch {
    return null;
  }
}

async function writeAnalysisState(tabId: number, state: PersistedAnalysisState): Promise<void> {
  try {
    const key = analysisStateKey(tabId);
    if (chromeAvailable()) {
      await chrome.storage.session.set({ [key]: state });
    } else {
      localStorage.setItem(key, JSON.stringify(state));
    }
  } catch {
    // The server remains the source of truth if session storage is unavailable.
  }
}

async function clearAnalysisState(tabId: number): Promise<void> {
  try {
    const key = analysisStateKey(tabId);
    if (chromeAvailable()) {
      await chrome.storage.session.remove(key);
    } else {
      localStorage.removeItem(key);
    }
  } catch {
    // Storage cleanup must not block the UI.
  }
}

async function waitForTabComplete(tabId: number, timeoutMs = 30_000): Promise<void> {
  const current = await chrome.tabs.get(tabId);
  if (current.status === "complete") return;
  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("原文页面加载超时"));
    }, timeoutMs);
    const listener = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
      window.clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function highlightInTab(tabId: number, quote: string): Promise<boolean> {
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["content.js"] });
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    } catch {
      return false;
    }
  }
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => [{ frameId: 0 }]);
      const frameIds = [...new Set((frames ?? []).map((frame) => frame.frameId))];
      const responses = await Promise.all(frameIds.map((frameId) =>
        chrome.tabs.sendMessage(tabId, { type: "HIGHLIGHT_EVIDENCE", quote }, { frameId }).catch(() => undefined)
      ));
      if (responses.some((response) => response?.found)) return true;
    } catch {
      // Dynamic agreement pages may not be ready immediately after the load event.
    }
    await new Promise((resolve) => window.setTimeout(resolve, 500));
  }
  return false;
}

async function currentSnapshot(): Promise<PageSnapshot | null> {
  if (!chromeAvailable()) return demoSnapshot();
  return chrome.runtime.sendMessage({ type: "GET_PAGE_STATE" });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: number | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = window.setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout !== undefined) window.clearTimeout(timeout);
  }
}

export function App() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [snapshot, setSnapshot] = useState<PageSnapshot | null>(null);
  const [sources, setSources] = useState<DiscoveredSource[]>([]);
  const [context, setContext] = useState<UserContext>({ action: "register", concerns: ["money", "data"], redlines: [], notes: "" });
  const [pairCode, setPairCode] = useState("246810");
  const [error, setError] = useState("");
  const [job, setJob] = useState<JobStatus | null>(null);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [view, setView] = useState<View>("overview");
  const [selectedFinding, setSelectedFinding] = useState<Finding | null>(null);
  const [manualText, setManualText] = useState("");
  const [manualUrl, setManualUrl] = useState("");
  const [manualOpen, setManualOpen] = useState(false);
  const [editingSourceId, setEditingSourceId] = useState<string | null>(null);
  const [chatInput, setChatInput] = useState("");
  const [messages, setMessages] = useState<Array<{ role: "user" | "assistant"; text: string }>>([]);
  const [versions, setVersions] = useState<{ analyses: Array<{ analysisId: string; createdAt: string; recommendation: string; fingerprints: string[] }>; comparisons: VersionComparison[] }>({ analyses: [], comparisons: [] });
  const [permissionTarget, setPermissionTarget] = useState<{ id: number; url: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [asking, setAsking] = useState(false);
  const [followUpProgress, setFollowUpProgress] = useState<AgentProgress | null>(null);
  const [askingSince, setAskingSince] = useState<number | null>(null);
  const [clock, setClock] = useState(Date.now());
  const [supplementing, setSupplementing] = useState(false);
  const [preserveResultWhileRunning, setPreserveResultWhileRunning] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [historyLoadingId, setHistoryLoadingId] = useState<string | null>(null);
  const [historyDeletingId, setHistoryDeletingId] = useState<string | null>(null);
  const [historyReturn, setHistoryReturn] = useState<HistoryReturnState | null>(null);
  const [historyMode, setHistoryMode] = useState(false);
  const [historyPageUrl, setHistoryPageUrl] = useState<string | null>(null);
  const [currentHistory, setCurrentHistory] = useState<CurrentHistory | null>(null);
  const [historyCheckState, setHistoryCheckState] = useState<HistoryCheckState>("idle");
  const [historyLookupLoading, setHistoryLookupLoading] = useState(false);
  const discoveryLockedRef = useRef(false);
  const scanInProgressRef = useRef(false);
  const historyLookupUrlRef = useRef("");
  const versionCheckKeyRef = useRef("");
  const versionCheckSourceSignatureRef = useRef("");
  const runningReturnRef = useRef<{ phase: "prepare" | "result"; result: AnalysisResult | null }>({ phase: "prepare", result: null });

  useEffect(() => {
    void (async () => {
      const page = await currentSnapshot();
      // An empty snapshot is provisional: login/register pages often render
      // their agreement links only after the user switches login modes.
      // Freeze discovery only after at least one candidate has been found.
      discoveryLockedRef.current = Boolean(page?.sources.length);
      setSnapshot(page);
      setSources(page?.sources ?? []);
      setContext((current) => ({ ...current, action: inferAction(page) }));
      if (page) void refreshCurrentHistory(page.pageUrl);
      try {
        await api.health();
      } catch {
        setPhase("offline");
        return;
      }
      if (page?.pendingRecheck) {
        const pendingJob = {
          id: page.pendingRecheck.jobId,
          analysisId: page.pendingRecheck.analysisId,
          kind: "recheck",
          state: "queued",
          progress: 0,
          message: "检测到已保存服务，正在自动复核版本",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        } satisfies JobStatus;
        await writeAnalysisState(page.tabId, {
          job: pendingJob,
          jobId: pendingJob.id,
          analysisId: pendingJob.analysisId,
          pageUrl: page.pageUrl,
          sourceCount: page.sources.length
        });
        setJob(pendingJob);
        setPhase("running");
        return;
      }
      if (!chromeAvailable()) {
        const existing = localStorage.getItem("pairToken");
        if (existing) {
          try {
            await api.capabilities();
            setPhase("prepare");
          } catch {
            localStorage.removeItem("pairToken");
            setPhase("pair");
          }
        } else {
          setPhase("pair");
        }
        return;
      }
      const stored = await chrome.storage.local.get("pairToken");
      if (!stored.pairToken) return setPhase("pair");
      try {
        await api.capabilities();
      } catch (cause) {
        if (cause instanceof ApiError && cause.status === 401) {
          await chrome.storage.local.remove("pairToken");
          return setPhase("pair");
        }
        return setPhase("offline");
      }
      if (!page) return setPhase("permission");
      const persisted = await readAnalysisState(page.tabId);
      if (persisted) {
        try {
          let previousAnalysis: AnalysisResult | undefined;
          if (persisted.previousAnalysisId) {
            previousAnalysis = await api.getAnalysis(persisted.previousAnalysisId).catch(() => undefined);
            if (previousAnalysis) setResult(previousAnalysis);
          }
          const restoredJob = persisted.jobId
            ? await api.getJob(persisted.jobId)
            : persisted.job;
          if (restoredJob?.kind === "version-check") {
            if (restoredJob.state === "complete") {
              setHistoryCheckState(/未变化/.test(restoredJob.message) ? "unchanged" : "changed");
              await clearAnalysisState(page.tabId);
              setJob(null);
              setPhase("prepare");
              return;
            }
            if (restoredJob.state === "failed") {
              setHistoryCheckState("failed");
              setError(restoredJob.error ?? "版本检查失败");
              setJob(restoredJob);
              setPhase("prepare");
              return;
            }
            setJob(restoredJob);
            setHistoryCheckState("checking");
            setPhase("checking");
            return;
          }
          if (restoredJob?.state === "complete" && restoredJob.analysisId) {
            const analysis = await api.getAnalysis(restoredJob.analysisId);
            discoveryLockedRef.current = true;
            setResult(analysis);
            setPreserveResultWhileRunning(false);
            setSources(page.sources);
            setJob(restoredJob);
            setPhase("result");
            return;
          }
          if (restoredJob?.state === "failed") {
            setJob(restoredJob);
            setError(restoredJob.error ?? "分析失败");
            setPreserveResultWhileRunning(false);
            setPhase(previousAnalysis ? "result" : "error");
            return;
          }
          if (restoredJob) {
            setJob(restoredJob);
            setPreserveResultWhileRunning(Boolean(previousAnalysis));
            runningReturnRef.current = { phase: previousAnalysis ? "result" : "prepare", result: previousAnalysis ?? null };
            setPhase("running");
            return;
          }
        } catch (cause) {
          if (cause instanceof ApiError && cause.status === 404) {
            await clearAnalysisState(page.tabId);
          } else {
            setError(cause instanceof Error ? cause.message : "无法恢复分析任务");
            setPhase("offline");
            return;
          }
        }
      }
      setPhase("prepare");
    })();
  }, []);

  useEffect(() => {
    if (!chromeAvailable()) return;
    const listener = (message: { type?: string; payload?: PageSnapshot }) => {
      if (message.type !== "PAGE_STATE_UPDATED" || !message.payload) return;
      if (discoveryLockedRef.current || scanInProgressRef.current) return;
      setSnapshot(message.payload);
      setSources(message.payload.sources);
      setContext((current) => ({ ...current, action: inferAction(message.payload ?? null) }));
      if (message.payload.sources.length) discoveryLockedRef.current = true;
      if (message.payload.sources.length && (phase === "permission" || phase === "prepare")) setPhase("prepare");
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [phase]);

  useEffect(() => {
    if (!chromeAvailable()) return;
    const refreshTarget = async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      setPermissionTarget(tab?.id && tab.url?.startsWith("http") ? { id: tab.id, url: tab.url } : null);
    };
    const onActivated = () => void refreshTarget();
    const onUpdated = (_tabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (changeInfo.url || changeInfo.status === "complete") void refreshTarget();
    };
    void refreshTarget();
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    return () => {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
  }, []);

  useEffect(() => {
    if (!["running", "checking"].includes(phase) || !job) return;
    const timer = window.setInterval(async () => {
      try {
        const next = await api.getJob(job.id);
        setJob(next);
        if (snapshot?.tabId !== undefined) {
          await writeAnalysisState(snapshot.tabId, {
            job: next,
            jobId: next.id,
              analysisId: next.analysisId,
              previousAnalysisId: preserveResultWhileRunning ? result?.id : undefined,
              pageUrl: snapshot.pageUrl,
              sourceCount: sources.length
          });
        }
        if (next.state === "complete") {
          if (phase === "checking" || next.kind === "version-check") {
            const currentSignature = sources.map((source) => `${source.id}:${source.url ?? ""}:${source.title}:${source.selected}`).join("|");
            if (versionCheckSourceSignatureRef.current && currentSignature !== versionCheckSourceSignatureRef.current) {
              versionCheckKeyRef.current = "";
              versionCheckSourceSignatureRef.current = "";
              setHistoryCheckState("idle");
            } else {
              setHistoryCheckState(/未变化/.test(next.message) ? "unchanged" : "changed");
            }
            if (snapshot?.tabId !== undefined) await clearAnalysisState(snapshot.tabId);
            setJob(null);
            setPhase("prepare");
            window.clearInterval(timer);
            return;
          }
          const analysis = await api.getAnalysis(next.analysisId);
          setResult(analysis);
          if (currentHistory) {
            if (/正文未变化|跳过模型分析/.test(next.message)) setHistoryCheckState("unchanged");
            else if (/版本变化|重新核验/.test(next.message)) setHistoryCheckState("changed");
          }
          setPreserveResultWhileRunning(false);
          if (snapshot?.tabId !== undefined) {
            await writeAnalysisState(snapshot.tabId, {
              job: next,
              jobId: next.id,
              analysisId: next.analysisId,
              pageUrl: snapshot.pageUrl,
              sourceCount: analysis.sources.length
            });
          }
          setPhase("result");
          window.clearInterval(timer);
        } else if (next.state === "failed") {
          if (currentHistory) setHistoryCheckState("failed");
          setError(next.error ?? "分析失败");
          setPreserveResultWhileRunning(false);
          setPhase(phase === "checking" ? "prepare" : preserveResultWhileRunning && result ? "result" : "error");
          window.clearInterval(timer);
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "无法读取任务状态");
        setPreserveResultWhileRunning(false);
        setPhase(preserveResultWhileRunning && result ? "result" : "offline");
        window.clearInterval(timer);
      }
    }, 700);
    return () => window.clearInterval(timer);
  }, [phase, job?.id, preserveResultWhileRunning, result?.id, currentHistory]);

  useEffect(() => {
    if (!asking || !result) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    const poll = window.setInterval(() => {
      void api.followUpProgress(result.id)
        .then((response) => setFollowUpProgress(response.progress))
        .catch(() => undefined);
    }, 1_000);
    void api.followUpProgress(result.id)
      .then((response) => setFollowUpProgress(response.progress))
      .catch(() => undefined);
    return () => {
      window.clearInterval(timer);
      window.clearInterval(poll);
    };
  }, [asking, result?.id]);

  async function pair() {
    try {
      setError("");
      await api.pair(pairCode);
      const page = await currentSnapshot();
      discoveryLockedRef.current = Boolean(page?.sources.length);
      setSnapshot(page);
      setSources(page?.sources ?? []);
      setContext((current) => ({ ...current, action: inferAction(page) }));
      if (page) void refreshCurrentHistory(page.pageUrl);
      setPhase(page ? "prepare" : "permission");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "配对失败");
    }
  }

  async function grantAndScan() {
    if (!chromeAvailable()) return;
    setError("");
    discoveryLockedRef.current = false;
    scanInProgressRef.current = true;
    setPhase("scanning");
    try {
      if (!permissionTarget) throw new Error("当前标签页不支持扫描，请切换到需要分析的网站后重试");
      const tab = permissionTarget;
      const granted = await chrome.permissions.request({ origins: permissionPatternsForSite(tab.url) });
      if (!granted) throw new Error("未获得当前站点的读取权限");
      const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id }).catch(() => [{ frameId: 0 }]);
      const scanFrame = async (frameId: number) => {
        await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [frameId] }, files: ["content.js"] });
        return chrome.tabs.sendMessage(tab.id, { type: "SCAN_PAGE" }, { frameId }) as Promise<{
          count?: number;
          snapshot?: PageSnapshot;
        }>;
      };
      const topFrameResponse = await scanFrame(0);
      await Promise.all((frames ?? [])
        .filter((frame) => frame.frameId !== 0)
        .map((frame) => scanFrame(frame.frameId).catch(() => undefined)));

      let page: PageSnapshot | null = null;
      for (let attempt = 0; attempt < 30; attempt++) {
        await new Promise((resolve) => window.setTimeout(resolve, 200));
        page = await currentSnapshot();
        if (page?.tabId === tab.id) break;
      }
      if (!page || page.tabId !== tab.id) page = topFrameResponse.snapshot ?? null;
      if (!page || page.tabId !== tab.id) throw new Error("扫描已执行，但没有收到当前页面的识别结果");
      discoveryLockedRef.current = Boolean(page.sources.length);
      setSnapshot(page);
      setSources(page.sources);
      setContext((current) => ({ ...current, action: inferAction(page) }));
      void refreshCurrentHistory(page.pageUrl);
      setPhase("prepare");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法扫描当前站点");
      setPhase("error");
    } finally {
      scanInProgressRef.current = false;
    }
  }

  function addManualText() {
    const text = manualText.trim();
    const url = manualUrl.trim();
    if (!text && !url) return;
    if (editingSourceId) {
      const currentSource = sources.find((source) => source.id === editingSourceId);
      if (!currentSource) return;
      if (currentSource.kind === "text") {
        if (!text) return;
        setSources((current) => current.map((source) =>
          source.id === editingSourceId
            ? { ...source, text, title: "手动补充文本" }
            : source
        ));
      } else {
        if (!isHttpUrl(url)) return;
        setSources((current) => current.map((source) =>
          source.id === editingSourceId
            ? {
                ...source,
                kind: (/\.pdf(?:$|\?)/i.test(url) ? "pdf" : "url") as "pdf" | "url",
                url,
                title: "手动补充链接",
                dataBase64: undefined,
                renderedHtml: undefined
              }
            : source
        ));
      }
      setEditingSourceId(null);
      setManualText("");
      setManualUrl("");
      setManualOpen(false);
      return;
    }
    setSources((current) => [...current,
      ...(isHttpUrl(url) ? [{
        id: crypto.randomUUID(), kind: /\.pdf(?:$|\?)/i.test(url) ? "pdf" as const : "url" as const,
        title: "手动补充链接", url, selected: true, relation: "manual" as const
      }] : []),
      ...(text ? [{
        id: crypto.randomUUID(), kind: "text" as const, title: "手动补充文本",
        text, selected: true, relation: "manual" as const
      }] : [])
    ]);
    setManualText("");
    setManualUrl("");
    setManualOpen(false);
  }

  function isManualFormValid(): boolean {
    const text = manualText.trim();
    const url = manualUrl.trim();
    if (editingSourceId) {
      const source = sources.find((item) => item.id === editingSourceId);
      return source?.kind === "text" ? Boolean(text) : isHttpUrl(url);
    }
    return (!url || isHttpUrl(url)) && Boolean(text || url);
  }

  function editManualSource(source: DiscoveredSource) {
    setEditingSourceId(source.id);
    setManualUrl(source.url ?? "");
    setManualText(source.text ?? "");
    setManualOpen(true);
  }

  function beginManualAdd() {
    setEditingSourceId(null);
    setManualText("");
    setManualUrl("");
    setManualOpen(true);
  }

  function cancelManualEdit() {
    setEditingSourceId(null);
    setManualText("");
    setManualUrl("");
    setManualOpen(false);
  }

  function removeManualSource(sourceId: string) {
    setSources((current) => current.filter((source) => source.id !== sourceId));
    if (editingSourceId === sourceId) {
      setEditingSourceId(null);
      setManualText("");
      setManualUrl("");
      setManualOpen(false);
    }
  }

  async function addPdfFiles(files: FileList | null) {
    if (!files) return;
    for (const file of [...files]) {
      if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) continue;
      if (file.size > 8_000_000) {
        setError(`${file.name} 超过 8 MB，暂不支持上传`);
        continue;
      }
      const dataBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error);
        reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
        reader.readAsDataURL(file);
      });
      setSources((current) => [...current, {
        id: crypto.randomUUID(), kind: "pdf", title: file.name,
        dataBase64, selected: true, relation: "manual"
      }]);
    }
  }

  async function startAnalysis() {
    if (!snapshot) {
      setError("当前页面信息尚未准备好，请重新扫描后再试");
      setPhase("error");
      return;
    }
    if (!sources.some((source) => source.selected)) {
      setError("请至少选择一份分析材料");
      setPhase("error");
      return;
    }
    try {
      setError("");
      setPhase("preparing");
      const selectedUrlSources = sources.filter((source) => source.selected && source.url && (source.kind === "url" || source.kind === "pdf"));
      let browserReaderAvailable = chromeAvailable();
      if (chromeAvailable() && selectedUrlSources.length > 0) {
        try {
          browserReaderAvailable = await withTimeout(
            chrome.permissions.request({ origins: ["http://*/*", "https://*/*"] }),
            10_000,
            "浏览器来源读取权限请求超时"
          );
        } catch (cause) {
          browserReaderAvailable = false;
          console.warn("[agreement-lens] browser source permission unavailable; using server URL loader", cause);
        }
      }
      await api.health();
      let preparedSources = sources;
      if (browserReaderAvailable && selectedUrlSources.length > 0) {
        let browserSources: { sources?: unknown[] } | undefined;
        try {
          browserSources = await withTimeout(
            chrome.runtime.sendMessage({
              type: "FETCH_AGREEMENT_SOURCES",
              tabId: snapshot.tabId,
              sources: selectedUrlSources.map((source) => ({
                id: source.id,
                title: source.title,
                url: source.url!,
                kind: source.kind as "url" | "pdf",
                relation: source.relation
              }))
            }),
            75_000,
            "浏览器读取协议来源超时，改由服务端读取原始 URL"
          ) as { sources?: unknown[] };
        } catch (cause) {
          console.warn("[agreement-lens] browser source acquisition unavailable; using server URL loader", cause);
        }
        type BrowserPreparedSource = {
          id: string;
          title?: string;
          url?: string;
          kind?: "url" | "pdf";
          relation?: "primary" | "direct" | "manual";
          renderedHtml?: string;
          dataBase64?: string;
          error?: string;
          deferToServer?: boolean;
        };
        const acquiredSources = (browserSources?.sources ?? []) as BrowserPreparedSource[];
        const fetched = new Map<string, BrowserPreparedSource>(
          acquiredSources.map((source) => [source.id, source])
        );
        const existingIds = new Set(sources.map((source) => source.id));
        const enrichedRoots = sources.map((source) => {
          const acquired = fetched.get(source.id);
          return acquired?.renderedHtml || acquired?.dataBase64
            ? { ...source, renderedHtml: acquired.renderedHtml, dataBase64: acquired.dataBase64 }
            : source;
        });
        const browserDiscovered = acquiredSources
          .filter((source) => !existingIds.has(source.id) && source.url && source.title && (source.renderedHtml || source.dataBase64))
          .map((source) => ({
            id: source.id,
            kind: source.kind ?? "url",
            title: source.title!,
            url: source.url!,
            renderedHtml: source.renderedHtml,
            dataBase64: source.dataBase64,
            selected: true,
            relation: source.relation ?? "direct"
          } satisfies DiscoveredSource));
        preparedSources = [...enrichedRoots, ...browserDiscovered].slice(0, 8);
      }
      const created = await api.createAnalysis({
        serviceName: snapshot.pageTitle, pageUrl: snapshot.pageUrl,
        sources: preparedSources, context
      });
      const pendingJob = {
        id: created.jobId, analysisId: created.analysisId, kind: "analysis", state: "queued",
        progress: 0, message: "任务已进入队列",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      } satisfies JobStatus;
      await writeAnalysisState(snapshot.tabId, {
        job: pendingJob,
        jobId: pendingJob.id,
        analysisId: pendingJob.analysisId,
        pageUrl: snapshot.pageUrl,
        sourceCount: preparedSources.filter((source) => source.selected).length
      });
      setJob(pendingJob);
      setPreserveResultWhileRunning(false);
      runningReturnRef.current = { phase: "prepare", result: null };
      setPhase("running");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法开始分析");
      setPhase(cause instanceof ApiError && cause.status === undefined ? "offline" : "error");
    }
  }

  async function ask() {
    if (!result || !chatInput.trim() || asking) return;
    const message = chatInput.trim();
    setChatInput("");
    setMessages((current) => [...current, { role: "user", text: message }]);
    setAsking(true);
    setAskingSince(Date.now());
    setFollowUpProgress({ status: "running", rounds: 0, retries: 0, message: "正在连接主Agent" });
    try {
      const response = await api.followUp(result.id, message, messages);
      setMessages((current) => [...current, { role: "assistant", text: response.answer }]);
    } catch (cause) {
      setMessages((current) => [...current, { role: "assistant", text: cause instanceof Error ? cause.message : "追问失败" }]);
    } finally {
      setAsking(false);
      setAskingSince(null);
    }
  }

  function openEvidence(finding: Finding) {
    setSelectedFinding(finding);
  }

  async function openSourceEvidence(finding: Finding) {
    const evidence = finding.evidence.find((item) => item.verified) ?? finding.evidence[0];
    if (!evidence) return;
    const sourceUrl = evidenceSourceUrl(result!, evidence);
    if (!sourceUrl || !chromeAvailable()) return;
    setError("");
    const targetUrl = evidence.page
      ? `${sourceUrl.replace(/#.*$/, "")}#page=${evidence.page}`
      : sourceUrl;
    const tab = await chrome.tabs.create({ url: targetUrl });
    if (!tab.id) return;
    try {
      await waitForTabComplete(tab.id);
      const found = await highlightInTab(tab.id, evidence.quote);
      if (!found && !evidence.page) setError("原文已打开，但页面内容与分析时的快照不完全一致，未能自动定位");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "原文已打开，但自动定位失败");
    }
  }

  async function loadVersions() {
    if (!result) return;
    try { setVersions(await api.versions(result.serviceId)); } catch { setVersions({ analyses: [], comparisons: [] }); }
  }

  async function refreshCurrentHistory(pageUrl: string) {
    const serviceId = pageServiceId(pageUrl);
    if (!serviceId) return;
    historyLookupUrlRef.current = pageUrl;
    setHistoryLookupLoading(true);
    try {
      const entries = (await api.history(100)).analyses;
      if (historyLookupUrlRef.current !== pageUrl) return;
      const entry = entries.find((candidate) => candidate.serviceId === serviceId) ?? null;
      if (entry) {
        const versionData = await api.versions(entry.serviceId).catch(() => null);
        const signatures = new Set((versionData?.analyses ?? []).map((version) => [...version.fingerprints].sort().join(":")));
        setCurrentHistory({
          ...entry,
          versionCount: versionData ? Math.max(1, signatures.size) : 0,
          versionConsistent: versionData ? signatures.size <= 1 : false,
          versionInfoAvailable: Boolean(versionData)
        });
      } else {
        setCurrentHistory(null);
      }
      setHistoryCheckState("idle");
    } catch {
      if (historyLookupUrlRef.current !== pageUrl) return;
      setCurrentHistory(null);
      setHistoryCheckState("idle");
    } finally {
      if (historyLookupUrlRef.current === pageUrl) setHistoryLookupLoading(false);
    }
  }

  async function beginVersionCheck() {
    if (!snapshot || !currentHistory || historyCheckState !== "idle" || !sources.some((source) => source.selected)) return;
    const key = `${snapshot.pageUrl}:${sources.filter((source) => source.selected).map((source) => `${source.url ?? source.id}:${source.title}`).join("|")}`;
    if (versionCheckKeyRef.current === key) return;
    versionCheckKeyRef.current = key;
    versionCheckSourceSignatureRef.current = sources.map((source) => `${source.id}:${source.url ?? ""}:${source.title}:${source.selected}`).join("|");
    try {
      const created = await api.recheck(currentHistory.serviceId, {
        serviceName: snapshot.pageTitle,
        pageUrl: snapshot.pageUrl,
        sources: sources.filter((source) => source.selected),
        context,
        checkOnly: true
      });
      const pendingJob = {
        id: created.jobId,
        analysisId: created.analysisId,
        kind: "version-check",
        state: "queued",
        progress: 0,
        message: "正在检查协议版本是否变化",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      } satisfies JobStatus;
      await writeAnalysisState(snapshot.tabId, {
        job: pendingJob,
        jobId: pendingJob.id,
        analysisId: pendingJob.analysisId,
        pageUrl: snapshot.pageUrl,
        sourceCount: sources.filter((source) => source.selected).length
      });
      setHistoryCheckState("checking");
      setJob(pendingJob);
      runningReturnRef.current = { phase: "prepare", result: null };
      setPhase("checking");
    } catch (cause) {
      versionCheckKeyRef.current = "";
      setHistoryCheckState("failed");
      setError(cause instanceof Error ? cause.message : "版本检查失败");
    }
  }

  useEffect(() => {
    if (phase !== "prepare" || !currentHistory || historyCheckState !== "idle") return;
    void beginVersionCheck();
  }, [phase, currentHistory?.analysisId, sources.map((source) => `${source.id}:${source.selected}`).join("|")]);

  useEffect(() => {
    if (phase !== "prepare" || !currentHistory || historyCheckState === "checking") return;
    const signature = sources.map((source) => `${source.id}:${source.url ?? ""}:${source.title}:${source.selected}`).join("|");
    if (versionCheckSourceSignatureRef.current && signature !== versionCheckSourceSignatureRef.current) {
      versionCheckKeyRef.current = "";
      setHistoryCheckState("idle");
    }
  }, [phase, currentHistory?.analysisId, historyCheckState, sources.map((source) => `${source.id}:${source.url ?? ""}:${source.title}:${source.selected}`).join("|")]);

  async function refreshHistory() {
    setHistoryLoading(true);
    setHistoryError("");
    try {
      setHistoryEntries((await api.history()).analyses);
    } catch (cause) {
      setHistoryError(cause instanceof Error ? cause.message : "无法读取历史分析");
    } finally {
      setHistoryLoading(false);
    }
  }

  async function deleteHistoryEntry(entry: HistoryEntry) {
    if (!window.confirm(`确定删除“${entry.serviceName || historyDomain(entry.pageUrl)}”的这条历史分析吗？`)) return;
    setHistoryDeletingId(entry.analysisId);
    setHistoryError("");
    try {
      await api.delete(entry.analysisId);
      if (currentHistory?.analysisId === entry.analysisId) {
        setCurrentHistory(null);
        setHistoryCheckState("idle");
      }
      if (historyMode && result?.id === entry.analysisId) {
        setResult(null);
        setHistoryMode(false);
        setHistoryPageUrl(null);
        setPhase("history");
      }
      await refreshHistory();
      if (snapshot?.pageUrl) void refreshCurrentHistory(snapshot.pageUrl);
      if (chromeAvailable()) {
        const remaining = (await api.history(100)).analyses;
        if (!remaining.some((item) => item.serviceId === entry.serviceId)) {
          const stored = await chrome.storage.local.get("savedServices");
          const savedServices = { ...(stored.savedServices ?? {}) } as Record<string, string>;
          for (const [host, serviceId] of Object.entries(savedServices)) {
            if (serviceId === entry.serviceId) delete savedServices[host];
          }
          await chrome.storage.local.set({ savedServices });
        }
      }
    } catch (cause) {
      setHistoryError(cause instanceof Error ? cause.message : "无法删除这条历史分析");
    } finally {
      setHistoryDeletingId(null);
    }
  }

  async function openHistory() {
    if (phase !== "history" && !historyMode) {
      setHistoryReturn({ phase, result, view });
    }
    setHistoryMode(false);
    setHistoryPageUrl(null);
    setPhase("history");
    await refreshHistory();
  }

  function returnFromHistory() {
    if (!historyReturn) {
      setPhase(snapshot ? (result ? "result" : "prepare") : "permission");
      return;
    }
    setResult(historyReturn.result);
    setView(historyReturn.view);
    setHistoryMode(false);
    setHistoryPageUrl(null);
    setHistoryReturn(null);
    setPhase(historyReturn.phase);
  }

  async function openHistoryEntry(entry: HistoryEntry) {
    setHistoryLoadingId(entry.analysisId);
    setHistoryError("");
    try {
      const analysis = await api.getAnalysis(entry.analysisId);
      setResult(analysis);
      setView("overview");
      setMessages([]);
      setSelectedFinding(null);
      setError("");
      setHistoryMode(true);
      setHistoryPageUrl(entry.pageUrl);
      setPhase("result");
    } catch (cause) {
      setHistoryError(cause instanceof Error ? cause.message : "无法读取这条历史分析");
    } finally {
      setHistoryLoadingId(null);
    }
  }

  async function openCurrentHistory() {
    if (!currentHistory) return;
    if (job?.kind === "version-check" && historyCheckState === "checking") await cancelRunningJob();
    setHistoryReturn({ phase: "prepare", result: null, view: "overview" });
    await openHistoryEntry(currentHistory);
  }

  async function cancelRunningJob() {
    if (!job) return;
    try {
      const cancelled = await api.cancelJob(job.id);
      setJob(cancelled);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法中断当前任务");
      return;
    }
    if (snapshot?.tabId !== undefined) await clearAnalysisState(snapshot.tabId);
    const previous = runningReturnRef.current;
    setPreserveResultWhileRunning(false);
    setHistoryCheckState(job.kind === "version-check" ? "cancelled" : "idle");
    versionCheckKeyRef.current = "";
    setError("");
    setResult(previous.result);
    setPhase(previous.phase);
  }

  async function recheck() {
    if (!result || phase === "running" || historyMode) return;
    try {
      const created = await api.recheck(result.serviceId, {
        serviceName: snapshot?.pageTitle ?? result.serviceName,
        pageUrl: snapshot?.pageUrl ?? result.sources[0]?.url ?? `https://${result.serviceId}`,
        sources: result.sources.map((source) => ({
          id: source.id,
          kind: source.mediaType === "pdf" ? "pdf" : source.mediaType === "text" ? "text" : "url",
          title: source.title,
          url: source.url,
          text: source.mediaType === "text" ? source.normalizedText : undefined,
          selected: true,
          relation: "primary"
        }))
      });
      const pendingJob = {
        id: created.jobId, analysisId: created.analysisId, kind: "recheck", state: "queued",
        progress: 0, message: "版本复核已进入队列",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      } satisfies JobStatus;
      if (snapshot?.tabId !== undefined) {
        await writeAnalysisState(snapshot.tabId, {
          job: pendingJob,
          jobId: pendingJob.id,
          analysisId: pendingJob.analysisId,
          previousAnalysisId: result.id,
          pageUrl: snapshot.pageUrl,
          sourceCount: result.sources.length
        });
      }
      setJob(pendingJob);
      runningReturnRef.current = { phase: "result", result };
      setCurrentHistory({
        analysisId: result.id,
        serviceId: result.serviceId,
        serviceName: result.serviceName,
        pageUrl: snapshot?.pageUrl ?? result.sources[0]?.url ?? `https://${result.serviceId}`,
        createdAt: result.createdAt,
        updatedAt: result.updatedAt,
        recommendation: result.recommendation,
        saved: result.saved,
        sourceCount: result.sources.length,
        findingCount: result.findings.length,
        versionCount: 1,
        versionConsistent: true,
        versionInfoAvailable: true
      });
      setHistoryCheckState("checking");
      setPreserveResultWhileRunning(true);
      setPhase("running");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法开始版本复核");
      setPhase("error");
    }
  }

  async function addRelatedSources(related: Array<{ title: string; url: string }>) {
    if (!result || !related.length || supplementing || preserveResultWhileRunning) return;
    setError("");
    setSupplementing(true);
    try {
      const remaining = Math.max(0, maxSourceDocuments - result.sources.length);
      const requestedSources: DiscoveredSource[] = related.slice(0, Math.min(8, remaining)).map((item) => ({
        id: crypto.randomUUID(),
        kind: /\.pdf(?:$|\?)/i.test(item.url) ? "pdf" : "url",
        title: item.title,
        url: item.url,
        selected: true,
        relation: "direct"
      } satisfies DiscoveredSource));
      if (!requestedSources.length) throw new Error(`当前分析已达到 ${maxSourceDocuments} 份材料上限`);

      let preparedSources = requestedSources;
      if (chromeAvailable()) {
        let browserReaderAvailable = false;
        try {
          browserReaderAvailable = await withTimeout(
            chrome.permissions.request({ origins: ["http://*/*", "https://*/*"] }),
            10_000,
            "浏览器来源读取权限请求超时"
          );
        } catch (cause) {
          console.warn("[agreement-lens] supplemental browser permission unavailable; using server URL loader", cause);
        }
        let browserSources: { sources?: unknown[] } | undefined;
        if (browserReaderAvailable) {
          try {
            browserSources = await withTimeout(
              chrome.runtime.sendMessage({
                type: "FETCH_AGREEMENT_SOURCES",
                tabId: snapshot?.tabId,
                sources: requestedSources.map((source) => ({
                  id: source.id,
                  title: source.title,
                  url: source.url!,
                  kind: source.kind as "url" | "pdf",
                  relation: source.relation
                }))
              }),
              75_000,
              "浏览器读取补充协议超时，改由服务端读取原始 URL"
            ) as { sources?: unknown[] };
          } catch (cause) {
            console.warn("[agreement-lens] supplemental browser acquisition unavailable; using server URL loader", cause);
          }
        }
        type BrowserPreparedSource = {
          id: string;
          title?: string;
          url?: string;
          kind?: "url" | "pdf";
          relation?: "primary" | "direct" | "manual";
          renderedHtml?: string;
          dataBase64?: string;
          error?: string;
          deferToServer?: boolean;
        };
        const acquired = (browserSources?.sources ?? []) as BrowserPreparedSource[];
        const acquiredById = new Map(acquired.map((source) => [source.id, source]));
        const includedUrls = new Set(result.sources.map((source) => source.url).filter((url): url is string => Boolean(url)));
        preparedSources = requestedSources
          .filter((source) => source.url && !includedUrls.has(source.url))
          .map((source) => {
            const fetched = acquiredById.get(source.id);
            return fetched?.renderedHtml || fetched?.dataBase64
              ? {
                ...source,
                renderedHtml: fetched.renderedHtml,
                dataBase64: fetched.dataBase64
              }
              : source;
          })
          .slice(0, remaining);
      }
      if (!preparedSources.length) throw new Error("所选补充材料已包含在当前分析中");

      const created = await api.addSources(result.id, preparedSources);
      const pendingJob = {
        id: created.jobId, analysisId: created.analysisId, kind: "analysis", state: "queued",
        progress: 0, message: "补充材料已进入队列",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      } satisfies JobStatus;
      if (snapshot?.tabId !== undefined) {
        await writeAnalysisState(snapshot.tabId, {
          job: pendingJob,
          jobId: pendingJob.id,
          analysisId: pendingJob.analysisId,
          previousAnalysisId: result.id,
          pageUrl: snapshot.pageUrl,
          sourceCount: result.sources.length + preparedSources.length
        });
      }
      setJob(pendingJob);
      runningReturnRef.current = { phase: "result", result };
      setPreserveResultWhileRunning(true);
      setPhase("running");
    } catch (cause) {
      setError(`补充材料失败：${cause instanceof Error ? cause.message : "未知错误"}`);
      setPhase("result");
    } finally {
      setSupplementing(false);
    }
  }

  async function saveAnalysis() {
    if (!result) return;
    setSaving(true);
    setError("");
    try {
      await api.save(result.id);
      const pageUrl = historyMode ? historyPageUrl : snapshot?.pageUrl;
      const host = new URL(pageUrl ?? `https://${result.serviceId}`).hostname.replace(/^www\./, "");
      if (chromeAvailable() && !historyMode) {
        const stored = await chrome.storage.local.get("savedServices");
        await chrome.storage.local.set({
          savedServices: { ...(stored.savedServices ?? {}), [host]: result.serviceId }
        });
      }
      setResult({ ...result, saved: true });
      if (historyMode) void refreshHistory();
    } catch (cause) {
      setError(`保存失败：${cause instanceof Error ? cause.message : "未知错误"}`);
    } finally {
      setSaving(false);
    }
  }

  const topFindings = useMemo(() => result?.topFindingIds.map((id) => result.findings.find((item) => item.id === id)).filter(Boolean) as Finding[] ?? [], [result]);
  const historyLauncher = phase === "pair" || phase === "loading" || phase === "offline" ? undefined : openHistory;

  if (phase === "loading") return <Shell><Centered><LoaderCircle className="spin" /><p>正在连接当前页面</p></Centered></Shell>;
  if (phase === "pair") return <Shell><PairScreen code={pairCode} setCode={setPairCode} onPair={pair} error={error} /></Shell>;
  if (phase === "permission") return <Shell onOpenHistory={historyLauncher}><PermissionScreen onGrant={grantAndScan} /></Shell>;
  if (phase === "scanning") return <Shell onOpenHistory={historyLauncher}><Centered><LoaderCircle className="spin" /><p className="eyebrow">正在读取当前站点</p><h2>扫描协议入口</h2></Centered></Shell>;
  if (phase === "preparing") return <Shell onOpenHistory={historyLauncher}><Centered><LoaderCircle className="spin" /><p className="eyebrow">正在准备分析</p><h2>读取协议原文</h2><p>正在获取所选页面并整理分析材料。</p></Centered></Shell>;
  if (phase === "running" && job && !(preserveResultWhileRunning && result)) return <Shell onOpenHistory={historyLauncher}><RunningScreen job={job} sources={sources} currentHistory={currentHistory} historyCheckState={historyCheckState} onCancel={() => void cancelRunningJob()} /></Shell>;
  if (phase === "offline") return <Shell offline><OfflineScreen detail={error} /></Shell>;
  if (phase === "error") return <Shell onOpenHistory={historyLauncher}><Centered><AlertTriangle size={30} /><h2>操作失败</h2><p>{error}</p><button className="primary" onClick={() => { setError(""); setPhase(snapshot ? "prepare" : "permission"); }}><RefreshCw size={16} />返回并重试</button></Centered></Shell>;
  if (phase === "history") return <Shell onOpenHistory={historyLauncher}><HistoryScreen entries={historyEntries} loading={historyLoading} error={historyError} loadingId={historyLoadingId} deletingId={historyDeletingId} onRetry={() => void refreshHistory()} onOpen={openHistoryEntry} onDelete={deleteHistoryEntry} onBack={returnFromHistory} hasReturn={Boolean(historyReturn)} /></Shell>;
  if ((phase === "result" || (phase === "running" && preserveResultWhileRunning)) && result) {
    return <Shell onOpenHistory={historyLauncher}>
      <ResultHeader result={result} saving={saving} historyMode={historyMode} onHistory={() => historyMode ? returnFromHistory() : void openHistory()} onSave={() => void saveAnalysis()} />
      {(supplementing || (phase === "running" && job)) && <section className="supplement-progress"><LoaderCircle className="spin" size={16} /><div><strong>{supplementing ? "正在读取补充材料" : job?.message ?? "正在深入分析"}</strong><p>{supplementing ? "原分析结果会保留，读取完成后再启动分析。" : `当前进度 ${job?.progress ?? 0}%`}</p></div>{job && <button className="icon-button compact-icon" title="中断当前任务" onClick={() => void cancelRunningJob()}><X size={15} /></button>}</section>}
      {error && <p className="inline-error result-error">{error}</p>}
      <nav className="tabs">
        {([
          ["overview", Sparkles, "总览"], ["risks", AlertTriangle, "风险"],
          ["sources", BookOpen, "来源"], ["chat", MessageCircle, "对话"], ["versions", History, "版本"]
        ] as const).map(([key, Icon, label]) =>
          <button key={key} className={view === key ? "active" : ""} onClick={() => { setView(key); if (key === "versions") void loadVersions(); }}>
            <Icon size={17} /><span>{label}</span>
          </button>
        )}
      </nav>
      <main className="result-body">
        {view === "overview" && <Overview result={result} topFindings={topFindings} openEvidence={openEvidence} setView={setView} />}
        {view === "risks" && <RiskList findings={result.findings} openEvidence={openEvidence} />}
        {view === "sources" && <SourcesView result={result} supplementing={supplementing || (phase === "running" && preserveResultWhileRunning)} readOnly={historyMode} onAddRelated={addRelatedSources} />}
        {view === "chat" && <ChatView messages={messages} suggestions={result.followUpSuggestions ?? []} input={chatInput} setInput={setChatInput} ask={ask} asking={asking} progress={followUpProgress} elapsedMs={askingSince ? clock - askingSince : 0} />}
        {view === "versions" && <VersionsView versions={versions} onRecheck={recheck} busy={phase === "running" || historyMode} />}
      </main>
      {selectedFinding && <EvidenceDrawer result={result} finding={selectedFinding} onClose={() => setSelectedFinding(null)} onOpenSource={() => void openSourceEvidence(selectedFinding)} />}
    </Shell>;
  }
  return <Shell onOpenHistory={historyLauncher}>
    <PrepareScreen
      snapshot={snapshot} sources={sources} setSources={setSources}
      context={context} setContext={setContext} start={startAnalysis}
      rescan={grantAndScan}
      manualOpen={manualOpen} manualFormValid={isManualFormValid()}
      manualText={manualText} setManualText={setManualText}
      manualUrl={manualUrl} setManualUrl={setManualUrl}
      editingSourceId={editingSourceId}
      onEditManual={editManualSource}
      onRemoveManual={removeManualSource}
      onBeginManualAdd={beginManualAdd}
      onCancelManualEdit={cancelManualEdit}
      addManualText={addManualText} addPdfFiles={addPdfFiles}
      currentHistory={currentHistory} historyCheckState={historyCheckState}
      historyLoading={historyLookupLoading} onOpenHistoryEntry={() => void openCurrentHistory()} onCancel={historyCheckState === "checking" ? () => void cancelRunningJob() : undefined}
    />
  </Shell>;
}

function Shell({ children, offline = false, onOpenHistory }: { children: React.ReactNode; offline?: boolean; onOpenHistory?: () => void }) {
  return <div className="app"><header className="brand"><div className="brand-mark"><Search size={18} /></div><div><strong>协议明镜</strong><span>Agreement Lens</span></div>{onOpenHistory && <button className="icon-button history-launcher" title="最近分析" onClick={() => void onOpenHistory()}><History size={17} /></button>}<i className={`status-dot ${offline ? "offline" : ""}`} title={offline ? "本地分析服务未连接" : "本地分析服务已连接"} /></header>{children}</div>;
}

function Centered({ children }: { children: React.ReactNode }) { return <main className="centered">{children}</main>; }

function PairScreen({ code, setCode, onPair, error }: { code: string; setCode: (value: string) => void; onPair: () => void; error: string }) {
  return <main className="pair-screen">
    <div className="pair-symbol"><LockKeyhole size={27} /></div>
    <p className="eyebrow">首次使用</p><h1>连接本地分析服务</h1>
    <p className="muted">协议正文只发送到你电脑上运行的服务。输入终端中显示的六位配对码。</p>
    <label className="field"><span>配对码</span><input autoFocus value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} onKeyDown={(e) => e.key === "Enter" && onPair()} /></label>
    {error && <p className="inline-error">{error}</p>}
    <button className="primary wide" onClick={onPair} disabled={code.length !== 6}>连接 <ChevronRight size={17} /></button>
  </main>;
}

function PermissionScreen({ onGrant }: { onGrant: () => void }) {
  return <Centered><div className="pair-symbol"><Shield size={28} /></div><h2>允许读取当前站点</h2><p>授权后自动发现用户协议和隐私政策链接。权限仅针对当前站点。</p><button className="primary" onClick={onGrant}>允许并扫描 <ChevronRight size={17} /></button></Centered>;
}

function HistoryScreen({
  entries, loading, error, loadingId, deletingId, onRetry, onOpen, onDelete, onBack, hasReturn
}: {
  entries: HistoryEntry[];
  loading: boolean;
  error: string;
  loadingId: string | null;
  deletingId: string | null;
  onRetry: () => void;
  onOpen: (entry: HistoryEntry) => void;
  onDelete: (entry: HistoryEntry) => void;
  onBack: () => void;
  hasReturn: boolean;
}) {
  return <main className="history-screen">
    <section className="history-heading">
      <div>
        <p className="eyebrow">分析记录</p>
        <h1>最近分析</h1>
        <p>这里保留不同网页的已完成分析，收起侧边栏后也可以从这里继续查看。</p>
      </div>
      {hasReturn && <button className="icon-button" title="返回当前页面" onClick={onBack}><ArrowLeft size={18} /></button>}
    </section>
    {loading && <div className="history-status"><LoaderCircle size={19} className="spin" /><span>正在读取历史分析</span></div>}
    {error && <div className="history-status error"><AlertTriangle size={18} /><span>{error}</span><button className="text-button" onClick={onRetry}><RefreshCw size={14} />重试</button></div>}
    {!loading && !error && entries.length === 0 && <div className="history-empty"><History size={28} /><strong>还没有完成的分析</strong><p>完成一次协议分析后，它会出现在这里。</p></div>}
    {!loading && entries.length > 0 && <section className="history-list">{entries.map((entry) => {
      const meta = recommendationMeta[entry.recommendation];
      const domain = historyDomain(entry.pageUrl);
      const isLoading = loadingId === entry.analysisId;
      const isDeleting = deletingId === entry.analysisId;
      return <div className="history-row" key={entry.analysisId}>
        <button className="history-row-open" onClick={() => void onOpen(entry)} disabled={Boolean(loadingId || deletingId)}>
          <span className={`history-recommendation ${meta.tone}`}><Shield size={15} /></span>
          <span className="history-main"><strong>{entry.serviceName || domain}</strong><small title={entry.pageUrl}>{domain || entry.pageUrl}</small><span>{formatHistoryDate(entry.updatedAt || entry.createdAt)} · {entry.sourceCount} 份材料 · {entry.findingCount} 项告警</span></span>
          <span className="history-row-end">{isLoading ? <LoaderCircle size={16} className="spin" /> : <ChevronRight size={17} />}</span>
        </button>
        <button className="icon-button compact-icon history-delete" title="删除历史分析" onClick={() => onDelete(entry)} disabled={Boolean(loadingId || deletingId)}>{isDeleting ? <LoaderCircle size={15} className="spin" /> : <Trash2 size={15} />}</button>
      </div>;
    })}</section>}
  </main>;
}

function historyDomain(pageUrl: string): string {
  try {
    return new URL(pageUrl).hostname.replace(/^www\./, "");
  } catch {
    return pageUrl;
  }
}

function formatHistoryDate(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? "时间未知" : new Date(timestamp).toLocaleString("zh-CN", {
    month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit"
  });
}

function OfflineScreen({ detail }: { detail?: string }) {
  return <Centered><div className="pair-symbol offline-symbol"><AlertTriangle size={28} /></div><p className="eyebrow">后端未连接</p><h2>先启动本地分析服务</h2><p>{detail || "扩展目前无法访问 127.0.0.1:4317。启动后保持终端运行，再重新检测。"}</p><code className="command-box">pnpm server:start</code><button className="primary" onClick={() => location.reload()}><RefreshCw size={16} />重新检测</button></Centered>;
}

function PrepareScreen(props: {
  snapshot: PageSnapshot | null; sources: DiscoveredSource[]; setSources: React.Dispatch<React.SetStateAction<DiscoveredSource[]>>;
  context: UserContext; setContext: React.Dispatch<React.SetStateAction<UserContext>>; start: () => void;
  rescan: () => void;
  manualOpen: boolean; manualText: string; setManualText: (v: string) => void; addManualText: () => void;
  manualUrl: string; setManualUrl: (v: string) => void; addPdfFiles: (files: FileList | null) => void;
  editingSourceId: string | null; onEditManual: (source: DiscoveredSource) => void; onRemoveManual: (sourceId: string) => void;
  onBeginManualAdd: () => void; onCancelManualEdit: () => void; manualFormValid: boolean;
  currentHistory: CurrentHistory | null; historyCheckState: HistoryCheckState; historyLoading: boolean;
  onOpenHistoryEntry: () => void; onCancel?: () => void;
}) {
  const { snapshot, sources, setSources, context, setContext } = props;
  const currentVersionSummary = props.historyCheckState === "checking"
    ? "正在检查当前协议是否变化"
    : props.historyCheckState === "unchanged"
      ? "当前协议材料与历史分析一致"
      : props.historyCheckState === "changed"
        ? "当前协议材料与历史分析不一致，可能发生变化"
        : props.historyCheckState === "failed"
          ? "版本检查失败，请重试"
          : props.historyCheckState === "cancelled"
            ? "版本检查已中断，点击开始分析可直接分析"
            : "正在检查当前协议版本";
  return <main className="prepare">
    <section className="page-intro"><p className="eyebrow">当前页面</p><h1>{snapshot?.pageTitle ?? "未识别页面"}</h1><p className="page-url">{snapshot?.pageUrl}</p><div className="scan-summary"><CheckCircle2 size={17} /><span>发现 {sources.length} 份可能相关的规则</span></div></section>
    {props.historyLoading && <div className="history-preview loading"><LoaderCircle size={16} className="spin" /><span>正在查找当前网页的历史分析</span></div>}
    {!props.historyLoading && props.currentHistory && <button className="history-preview" type="button" onClick={props.onOpenHistoryEntry}>
      <span className="history-preview-icon"><History size={17} /></span>
      <span className="history-preview-main"><strong>已有历史分析</strong><small>{formatHistoryDate(props.currentHistory.updatedAt || props.currentHistory.createdAt)} · {props.currentHistory.sourceCount} 份材料 · {props.currentHistory.findingCount} 项告警</small><em><span>{currentVersionSummary}</span></em></span>
      <ChevronRight size={17} />
    </button>}
    {props.historyCheckState === "checking" && props.onCancel && <button className="text-button history-check-cancel" onClick={props.onCancel}><X size={14} />中断版本检查</button>}
    <section className="section"><div className="section-heading"><div><span className="step">1</span><h2>确认分析材料</h2></div><button className="icon-button" title="重新扫描" onClick={props.rescan}><RefreshCw size={16} /></button></div>
      <div className="source-list">{sources.map((source) =>
        <div className="source-row" key={source.id}>
          <input type="checkbox" checked={source.selected} aria-label={`选择 ${source.title}`} onChange={(e) => setSources((items) => items.map((item) => item.id === source.id ? { ...item, selected: e.target.checked } : item))} />
          <span className="checkbox-ui"><Check size={13} /></span>
          <FileText size={17} />
          <span className="source-info">
            <strong>{source.title}</strong>
            {source.kind === "text"
              ? <small title={source.text ?? ""}>{source.text ?? "已提供文本"}</small>
              : <a className="source-link" href={source.url} target="_blank" rel="noreferrer" title="打开材料页面" onClick={(event) => event.stopPropagation()}>{source.url}</a>}
          </span>
          {source.relation === "manual" && <span className="source-controls">
            {(source.kind === "url" || source.kind === "text") && <button type="button" className="icon-button compact-icon" title="修改手动材料" onClick={() => props.onEditManual(source)}><Pencil size={14} /></button>}
            <button type="button" className="icon-button compact-icon danger-icon" title="删除手动材料" onClick={() => props.onRemoveManual(source.id)}><Trash2 size={14} /></button>
          </span>}
        </div>
      )}</div>
      <div className="source-actions">
        <button className="text-button" onClick={props.onBeginManualAdd}><Plus size={16} />补充链接或文本</button>
        <label className="text-button upload-button"><Upload size={16} />上传 PDF<input type="file" accept="application/pdf,.pdf" multiple onChange={(event) => void props.addPdfFiles(event.target.files)} /></label>
      </div>
      {props.manualOpen &&
        <div className="manual-box"><input type="url" placeholder="https://example.com/terms" value={props.manualUrl} onChange={(e) => props.setManualUrl(e.target.value)} /><textarea placeholder="或粘贴协议、补充规则和相关说明" value={props.manualText} onChange={(e) => props.setManualText(e.target.value)} /><div><button className="ghost" onClick={props.onCancelManualEdit}>取消</button><button className="small-primary" disabled={!props.manualFormValid} onClick={props.addManualText}>{props.editingSourceId ? "保存修改" : "加入材料"}</button></div></div>}
    </section>
    <section className="section"><div className="section-heading"><div><span className="step">2</span><h2>这次你准备做什么</h2></div></div>
      <div className="segmented">{actionOptions.map((option) => <button key={option.value} className={context.action === option.value ? "active" : ""} onClick={() => setContext({ ...context, action: option.value })}>{option.label}</button>)}</div>
    </section>
    <section className="section"><div className="section-heading"><div><span className="step">3</span><h2>你更在意哪些问题</h2></div></div>
      <div className="chips">{concernOptions.map((option) => <button key={option.value} className={context.concerns.includes(option.value) ? "selected" : ""} onClick={() => setContext({ ...context, concerns: context.concerns.includes(option.value) ? context.concerns.filter((item) => item !== option.value) : [...context.concerns, option.value] })}>{option.label}</button>)}</div>
      <p className="sub-label">个人底线（可多选）</p>
      <div className="redline-list">{redlineOptions.map((redline) => <label key={redline}><input type="checkbox" checked={context.redlines.includes(redline)} onChange={(event) => setContext({ ...context, redlines: event.target.checked ? [...context.redlines, redline] : context.redlines.filter((item) => item !== redline) })} /><span className="checkbox-ui"><Check size={13} /></span>{redline}</label>)}</div>
      <label className="field compact"><span>个人底线或补充情况（可选）</span><textarea placeholder="例如：内容不能用于训练模型" value={context.notes} onChange={(e) => setContext({ ...context, notes: e.target.value, redlines: [...context.redlines.filter((item) => redlineOptions.includes(item)), ...(e.target.value ? [e.target.value] : [])] })} /></label>
    </section>
    <div className="sticky-action"><div><strong>{sources.filter((source) => source.selected).length}</strong><span>份材料</span></div><button className="primary" disabled={props.historyLoading || props.historyCheckState === "checking" || !sources.some((source) => source.selected)} onClick={props.start}>{props.historyLoading ? <LoaderCircle size={17} className="spin" /> : <Sparkles size={17} />}{props.historyLoading ? "正在查找历史" : "开始分析"}</button></div>
  </main>;
}

function RunningScreen({ job, sources, currentHistory, historyCheckState, onCancel }: { job: JobStatus; sources: DiscoveredSource[]; currentHistory: HistoryEntry | null; historyCheckState: HistoryCheckState; onCancel: () => void }) {
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const agentDefinitions = [
    ["fees", "费用"],
    ["privacy", "隐私与数据"],
    ["content", "内容与账号"],
    ["rights", "权利与变更"],
    ["verifier", "证据核验"],
    ["main", "结论整合"],
    ["router", "版本路由"]
  ] as const;
  return <main className="running"><div className="radar"><span /><Search size={28} /></div><p className="eyebrow">{currentHistory && historyCheckState !== "changed" ? "正在核验历史版本" : `正在分析 ${sources.length} 份材料`}</p><h1>{job.message}</h1><p className="running-elapsed">已等待 {formatElapsed(clock - new Date(job.createdAt).getTime())}</p>{currentHistory && historyCheckState !== "changed" && <div className="running-history"><History size={15} /><span>已找到历史分析，先比较协议正文；未变化时直接复用，不会重复调用模型。</span></div>}<div className="progress-track"><i style={{ width: `${job.progress}%` }} /></div><span className="progress-number">{job.progress}%</span><div className="agent-grid">{agentDefinitions.map(([key, name]) => {
    const progress = job.agents?.[key];
    const status = progress?.status ?? "idle";
    const Icon = status === "completed" ? Check : status === "failed" ? AlertTriangle : status === "running" ? LoaderCircle : Circle;
    const details = progress ? `交互 ${progress.rounds} 轮 · 重试 ${progress.retries} 次` : "尚未开始";
    return <div className={status === "completed" ? "done" : status === "failed" ? "failed" : status === "running" ? "active" : ""} key={key}><Icon size={14} className={status === "running" ? "spin" : undefined} /><span><strong>{name}</strong><small>{details}</small></span></div>;
  })}</div><button className="cancel-analysis" onClick={onCancel}><X size={15} />中断并返回</button><p className="muted small">关闭侧边栏不会中断任务</p></main>;
}

function ResultHeader({ result, saving, historyMode, onHistory, onSave }: { result: AnalysisResult; saving: boolean; historyMode: boolean; onHistory: () => void; onSave: () => void }) {
  const meta = recommendationMeta[result.recommendation];
  return <header className="result-header"><div><p>{historyMode ? "历史分析 · " : ""}{result.serviceName}</p><h1 className={meta.tone}>{meta.label}</h1></div><div className="header-actions">{historyMode && <button className="icon-button light" title="返回最近分析" onClick={onHistory}><ArrowLeft size={17} /></button>}<button className="icon-button light" disabled={saving || result.saved} title={result.saved ? "已保存" : saving ? "正在保存" : "保存本次分析"} onClick={onSave}>{saving ? <LoaderCircle size={17} className="spin" /> : result.saved ? <Check size={17} /> : <Save size={17} />}</button></div></header>;
}

function Overview({ result, topFindings, openEvidence, setView }: { result: AnalysisResult; topFindings: Finding[]; openEvidence: (finding: Finding) => void; setView: (view: View) => void }) {
  return <><section className="decision"><p>{result.recommendationReason}</p>{result.actionChecklist.length > 0 && <div className="checklist"><strong>确认前建议</strong>{result.actionChecklist.slice(0, 3).map((item) => <span key={item}><CheckCircle2 size={16} />{item}</span>)}</div>}</section>
    <AnalysisInputView input={result.analysisInput} />
    <section className="result-section"><div className="result-title"><div><AlertTriangle size={18} /><h2>重点告警</h2></div><button onClick={() => setView("risks")}>查看全部 {result.findings.length}</button></div>
      <div className="finding-list">{topFindings.map((finding, index) => <FindingRow key={finding.id} finding={finding} index={index + 1} onClick={() => openEvidence(finding)} />)}</div>
      {!topFindings.length && <div className="empty-inline"><CheckCircle2 size={22} /><span>已读材料中暂未发现可核验的重点告警</span></div>}
    </section>
    {result.coverageGaps.length > 0 && <section className="coverage"><AlertTriangle size={17} /><div><strong>仍有 {result.coverageGaps.length} 项待核实</strong><p>{coverageGapSummary(result.coverageGaps[0])}</p></div></section>}
  </>;
}

function AnalysisInputView({ input }: { input: AnalysisResult["analysisInput"] }) {
  const action = actionOptions.find((item) => item.value === input?.context.action)?.label ?? input?.context.action;
  const concerns = input?.context.concerns.map((concern) => concernOptions.find((item) => item.value === concern)?.label ?? concern) ?? [];
  return <details className="analysis-input">
    <summary><FileText size={16} /><strong>本次分析设置</strong><span>查看材料与关注点</span><ChevronRight size={16} /></summary>
    {!input
      ? <p className="analysis-input-empty">这条历史分析未保存当时的分析设置。</p>
      : <div className="analysis-input-body">
        <div className="analysis-input-group"><strong>确认分析材料 · {input.sources.length} 份</strong><div className="analysis-input-sources">{input.sources.map((source) => <div className="analysis-input-source" key={source.id}><span>{source.title}</span>{source.url ? <a href={source.url} target="_blank" rel="noreferrer" title="打开当时选择的材料">{source.url}</a> : <small>{source.text?.replace(/\s+/g, " ").trim().slice(0, 180) || "手动提供的文本"}</small>}</div>)}</div></div>
        <div className="analysis-input-group"><strong>这次你准备做什么</strong><p>{action || "未记录"}</p></div>
        <div className="analysis-input-group"><strong>你更在意哪些问题</strong><p>{concerns.length ? concerns.join("、") : "未特别指定"}</p></div>
        {input.context.redlines.length > 0 && <div className="analysis-input-group"><strong>不能接受的情况</strong><p>{input.context.redlines.join("、")}</p></div>}
        {input.context.notes && <div className="analysis-input-group"><strong>补充说明</strong><p>{input.context.notes}</p></div>}
      </div>}
  </details>;
}

function FindingRow({ finding, index, onClick }: { finding: Finding; index: number; onClick: () => void }) {
  const meta = categoryMeta[finding.category]; const Icon = meta.icon;
  return <button className={`finding-row ${finding.status !== "verified" ? "pending" : ""}`} onClick={onClick}><span className={`risk-index ${finding.severity}`}>{finding.status === "verified" ? index : "?"}</span><span className="finding-main"><span className="finding-meta"><Icon size={14} />{meta.label} · {finding.status !== "verified" ? "待核实" : finding.severity === "high" || finding.severity === "critical" ? "高影响" : finding.severity === "medium" ? "中等影响" : "低影响"}</span><strong>{finding.title}</strong><p>{finding.userImpact}</p></span><ChevronRight size={17} /></button>;
}

function RiskList({ findings, openEvidence }: { findings: Finding[]; openEvidence: (finding: Finding) => void }) {
  return <section className="result-section no-top"><div className="view-heading"><h2>全部风险</h2><span>{findings.length} 项</span></div><div className="finding-list">{findings.map((finding, index) => <FindingRow key={finding.id} finding={finding} index={index + 1} onClick={() => openEvidence(finding)} />)}</div></section>;
}

function SourcesView({ result, supplementing, readOnly, onAddRelated }: { result: AnalysisResult; supplementing: boolean; readOnly: boolean; onAddRelated: (sources: Array<{ title: string; url: string }>) => void }) {
  const sources = uniqueSourceDocuments(result.sources);
  const included = new Set(sources.map((source) => source.url).filter(Boolean));
  const remaining = Math.max(0, maxSourceDocuments - sources.length);
  const related = sources.flatMap((source) => source.linkedSources ?? [])
    .filter((item) => !included.has(item.url))
    .filter((item, index, all) => all.findIndex((other) => other.url === item.url) === index)
    .slice(0, Math.min(8, remaining));
  return <section className="result-section no-top"><div className="view-heading"><h2>分析来源</h2><span>{sources.length} 份</span></div>{sources.map((source) => <div className="source-detail" key={source.id}><div className={`source-status ${source.status}`}><FileText size={17} /></div><div><strong>{source.title}</strong>{source.url && <small className="source-detail-url" title={source.url}>{source.url}</small>}<p>{source.normalizedText.length > 0 ? `${source.sections.length} 个章节 · ${source.normalizedText.length.toLocaleString()} 字` : source.status === "failed" ? "读取失败" : "未取得有效正文"}</p><small>{source.status === "ready" ? "已完整读取并生成内容指纹" : source.error}</small></div>{source.url && <button title="打开来源" onClick={() => chromeAvailable() && chrome.tabs.create({ url: source.url })}><ExternalLink size={15} /></button>}</div>)}{related.length > 0 && <div className="related-box"><div><strong>发现 {related.length} 份更深层关联材料</strong><p>{related.map((item) => item.title).join("、")}</p></div>{readOnly ? <small className="read-only-note">历史分析仅供查看，返回当前页面后可补充材料。</small> : <button disabled={supplementing} onClick={() => onAddRelated(related)}>{supplementing ? <><LoaderCircle className="spin" size={13} />正在处理</> : "确认并继续读取"}</button>}</div>}</section>;
}

function ChatView({ messages, suggestions, input, setInput, ask, asking, progress, elapsedMs }: { messages: Array<{ role: "user" | "assistant"; text: string }>; suggestions: string[]; input: string; setInput: (v: string) => void; ask: () => void; asking: boolean; progress: AgentProgress | null; elapsedMs: number }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, asking]);
  return <section className="chat-view"><div className="chat-stream">{messages.length === 0 && <div className="chat-empty"><MessageCircle size={25} /><strong>继续追问这份协议</strong><p>可以问某项条款对你的具体影响，回答会附上当前来源中的依据。</p>{suggestions.length > 0 && <div className="suggestions">{suggestions.map((text) => <button key={text} onClick={() => setInput(text)}>{text}</button>)}</div>}</div>}{messages.map((message, index) => <div className={`message ${message.role}`} key={index}>{message.role === "assistant" ? <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a> }}>{message.text}</ReactMarkdown> : message.text}</div>)}{asking && <div className="follow-up-status"><LoaderCircle size={15} className="spin" /><span>已等待 {formatElapsed(elapsedMs)} · 交互 {progress?.rounds ?? 0} 轮 · 重试 {progress?.retries ?? 0} 次</span><small>{progress?.message ?? "正在等待模型响应"}</small></div>}{asking && <div className="message assistant thinking" aria-label="Agent 正在回答"><span /><span /><span /></div>}<div ref={endRef} /></div><div className="chat-composer"><textarea rows={1} value={input} disabled={asking} placeholder={asking ? "Agent 正在回答" : "追问条款或补充你的情况"} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(); } }} /><button title={asking ? "正在回答" : "发送"} disabled={asking || !input.trim()} onClick={ask}>{asking ? <LoaderCircle size={17} className="spin" /> : <Send size={17} />}</button></div></section>;
}

function VersionsView({ versions, onRecheck, busy }: { versions: { analyses: Array<{ analysisId: string; createdAt: string; recommendation: string; fingerprints: string[] }>; comparisons: VersionComparison[] }; onRecheck: () => void; busy: boolean }) {
  return <section className="result-section no-top"><div className="view-heading"><h2>版本记录</h2><button className="recheck-button" onClick={onRecheck} disabled={busy}><RefreshCw size={14} className={busy ? "spin" : undefined} />{busy ? "正在复核" : "立即复核"}</button></div>{versions.comparisons[0] && <div className={`version-impact ${versions.comparisons[0].changed ? "changed" : ""}`}><strong>{versions.comparisons[0].changed ? "上次变化对你的影响" : "上次检查没有变化"}</strong><p>{versions.comparisons[0].decisionImpact}</p><small>{versions.comparisons[0].summary}</small></div>}{versions.analyses.length < 2 && <div className="version-empty"><History size={25} /><strong>正在守候下一次变化</strong><p>再次复核时会先比较正文指纹，没有变化就不会调用模型。</p></div>}{versions.analyses.map((version, index) => <div className="version-row" key={version.analysisId}><span className={index === 0 ? "current" : ""} /><div><strong>{index === 0 ? "当前版本" : "历史版本"}</strong><p>{new Date(version.createdAt).toLocaleString("zh-CN")}</p></div><small>{recommendationMeta[version.recommendation as keyof typeof recommendationMeta]?.label}</small></div>)}</section>;
}

function EvidenceDrawer({ result, finding, onClose, onOpenSource }: { result: AnalysisResult; finding: Finding; onClose: () => void; onOpenSource: () => void }) {
  const evidence = finding.evidence.find((item) => item.verified) ?? finding.evidence[0];
  return <div className="drawer-backdrop" onClick={onClose}><aside className="evidence-drawer" onClick={(e) => e.stopPropagation()}><header><button className="icon-button" title="返回" onClick={onClose}><ArrowLeft size={18} /></button><span>告警详情</span><button className="icon-button" title="关闭" onClick={onClose}><X size={18} /></button></header><div className="drawer-content"><span className={`severity-label ${finding.severity}`}>{finding.status !== "verified" ? "待核实" : finding.severity === "high" ? "高影响" : finding.severity === "medium" ? "中等影响" : "低影响"}</span><h2>{finding.title}</h2><dl><dt>什么时候触发</dt><dd>{finding.trigger}</dd><dt>平台可能做什么</dt><dd>{finding.platformAction}</dd><dt>对你的影响</dt><dd>{finding.userImpact}</dd></dl><div className="evidence-quote"><div><BookOpen size={16} /><strong>原文证据</strong>{evidence?.verified && <span><Check size={12} />已核验</span>}</div><blockquote>{focusedEvidenceQuote(finding, evidence?.quote) ?? "暂无可核验引用"}</blockquote><small>{resultSourceLabel(result, evidence)}</small>{evidenceSourceUrl(result, evidence) && <button className="open-source" onClick={onOpenSource}><ExternalLink size={14} />打开并定位原文</button>}</div><div className="actions-box"><strong>你可以这样做</strong>{finding.actions.map((action) => <p key={action}><CheckCircle2 size={16} />{action}</p>)}</div>{finding.uncertainty && <p className="uncertainty">{finding.uncertainty}</p>}</div></aside></div>;
}

function focusedEvidenceQuote(finding: Finding, quote?: string): string | undefined {
  if (!quote) return;
  const normalized = quote.replace(/\s+/g, " ").trim();
  if (normalized.length <= 260) return normalized;
  const relevance = `${finding.title} ${finding.platformAction}`.toLocaleLowerCase();
  const englishTerms = relevance.match(/[a-z][a-z-]{2,}/g) ?? [];
  const chineseRuns = relevance.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  const chineseTerms = chineseRuns.flatMap((run) =>
    [...run].slice(0, -1).map((character, index) => `${character}${run[index + 1]}`)
  );
  const terms = [...new Set([...englishTerms, ...chineseTerms])];
  const sentences = normalized.match(/[^。！？!?；;]+[。！？!?；;]?/g)?.map((sentence) => sentence.trim()).filter(Boolean) ?? [normalized];
  const selected = sentences
    .map((sentence) => ({
      sentence,
      score: terms.reduce((score, term) => score + (sentence.toLocaleLowerCase().includes(term) ? term.length : 0), 0)
    }))
    .sort((left, right) => right.score - left.score || left.sentence.length - right.sentence.length)[0]?.sentence ?? normalized;
  if (selected.length <= 260) return selected;
  const focusTerm = terms.find((term) => selected.toLocaleLowerCase().includes(term));
  const focus = focusTerm ? selected.toLocaleLowerCase().indexOf(focusTerm) : 0;
  return selected.slice(Math.max(0, Math.min(selected.length - 260, focus - 80)), Math.max(0, Math.min(selected.length - 260, focus - 80)) + 260).trim();
}

function coverageGapSummary(gap?: AnalysisResult["coverageGaps"][number]): string {
  if (!gap) return "";
  if (/模型|分析器/.test(gap.title)) return "部分模型视角未完成，本次已使用本地分析器补充结果。";
  return gap.detail.replace(/\s+/g, " ").slice(0, 180);
}
