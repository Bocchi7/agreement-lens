import { createHash, randomUUID } from "node:crypto";
import {
  type AnalysisResult,
  type Finding,
  type SourceDocument,
  type UserContext,
  severityWeight
} from "@agreement-lens/shared";
import {
  modelConfigFromEnv,
  runModelIntegrator,
  runModelFollowUp,
  runModelChangeRouter,
  runModelSpecialist,
  runModelVerifier
} from "./model.js";
import type { MainAgentSession } from "./model.js";

export { modelConfigFromEnv } from "./model.js";
export type { MainAgentSession } from "./model.js";

export interface KnowledgeHit {
  id: string;
  title: string;
  excerpt: string;
  score: number;
}

export interface KnowledgeTool {
  search(query: string, limit?: number): KnowledgeHit[];
  shell?(command: string): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; truncated: boolean }>;
  version?: string;
}

export interface WorkflowInput {
  analysisId: string;
  serviceId: string;
  serviceName: string;
  sources: SourceDocument[];
  context: UserContext;
  saved?: boolean;
  promptDir?: string;
  domains?: Domain[];
  previousResult?: AnalysisResult;
  onMainAgentSession?: (session: MainAgentSession) => void;
}

export interface WorkflowProgress {
  stage: "analyzing" | "verifying" | "integrating";
  progress: number;
  message: string;
}

export type Domain = "fees" | "privacy" | "content" | "rights";

const patterns: Record<Domain, Array<{
  category: Finding["category"];
  title: string;
  regex: RegExp;
  severity: Finding["severity"];
  platformAction: string;
  impact: string;
  action: string;
}>> = {
  fees: [
    { category: "money", title: "自动续费或连续扣款", regex: /自动续费|连续包月|自动扣款|auto(?:matic)?(?:ally)? renew|recurring (?:payment|charge)/i, severity: "high", platformAction: "在当前周期结束后自动续订并扣款", impact: "若未及时取消，可能产生非预期费用", action: "确认关闭路径、提前设置取消提醒并保留取消凭证" },
    { category: "money", title: "退款条件受限", regex: /不予退款|不支持退款|概不退款|non-?refundable|no refunds?/i, severity: "high", platformAction: "限制或排除退款", impact: "购买后即使服务不符合预期也可能难以追回款项", action: "付款前核对试用、退款窗口和例外条件" },
    { category: "money", title: "价格或服务费可调整", regex: /调整.{0,12}(价格|费用)|价格.{0,12}(变更|调整)|change.{0,12}(price|fees?)/i, severity: "medium", platformAction: "按条款调整价格或收费方式", impact: "未来使用成本可能上升", action: "确认变价通知方式及不同意后的退出选择" }
  ],
  privacy: [
    { category: "data", title: "个人信息可能向第三方共享", regex: /共享.{0,20}(个人信息|数据)|第三方.{0,20}(共享|提供)|share.{0,20}(personal (?:information|data)|third part)/i, severity: "high", platformAction: "向合作方或第三方提供用户数据", impact: "数据使用范围扩大，后续控制和追踪更困难", action: "查看第三方清单、共享目的及关闭授权入口" },
    { category: "data", title: "收集范围较广", regex: /设备信息|位置信息|通讯录|生物识别|device information|precise location|contacts/i, severity: "medium", platformAction: "收集设备、位置或其他敏感信息", impact: "可能超出完成核心功能所必需的范围", action: "仅授予当前功能必需的权限" },
    { category: "data", title: "数据可能跨境处理", regex: /跨境|境外.{0,10}(存储|处理)|cross-border|outside.{0,10}(country|jurisdiction)/i, severity: "high", platformAction: "在境外传输、存储或处理数据", impact: "数据适用的保护规则和救济路径可能变化", action: "确认接收方、目的地、保存期限和退出方式" }
  ],
  content: [
    { category: "content", title: "用户内容授权范围较宽", regex: /永久.{0,20}(许可|授权)|不可撤销.{0,20}(许可|授权)|perpetual.{0,20}licen[cs]e|irrevocable.{0,20}licen[cs]e/i, severity: "high", platformAction: "取得长期或不可撤销的内容使用许可", impact: "上传内容可能在注销后仍被平台使用", action: "避免上传不希望被长期使用的原创或敏感内容" },
    { category: "account", title: "平台可单方暂停或终止账号", regex: /暂停.{0,10}(账户|账号|服务)|终止.{0,10}(账户|账号|服务)|suspend.{0,12}(account|service)|terminate.{0,12}(account|service)/i, severity: "high", platformAction: "在特定或宽泛条件下停用账号", impact: "可能失去服务、数据或已购权益", action: "备份重要数据并核对申诉、余额处置规则" },
    { category: "content", title: "内容删除或处置权较宽", regex: /删除.{0,12}(内容|信息)|移除.{0,12}(内容|信息)|remove.{0,12}(content|material)|delete.{0,12}(content|material)/i, severity: "medium", platformAction: "删除、屏蔽或限制用户内容", impact: "内容可用性和传播可能受平台判断影响", action: "保留重要内容副本并了解申诉渠道" }
  ],
  rights: [
    { category: "remedies", title: "协议可单方变更", regex: /有权.{0,12}(修改|变更).{0,12}(协议|条款)|随时.{0,8}(修改|变更)|modify.{0,12}(terms|agreement).{0,12}(any time|sole discretion)/i, severity: "high", platformAction: "单方更新协议并可能以继续使用视为接受", impact: "你的权利义务可能在缺少显著确认时发生变化", action: "保存当前版本并确认重大变更通知与退出期限" },
    { category: "remedies", title: "争议解决地点或方式受限", regex: /仲裁|管辖法院|争议.{0,12}(提交|解决)|binding arbitration|exclusive jurisdiction/i, severity: "high", platformAction: "指定仲裁、法院或特定争议程序", impact: "维权成本、地点和可选方式可能受到限制", action: "确认适用地点、费用承担及是否存在退出仲裁期限" },
    { category: "remedies", title: "责任限制较强", regex: /不承担.{0,16}责任|责任上限|间接损失|limitation of liability|not (?:be )?liable/i, severity: "medium", platformAction: "限制平台赔偿责任或排除部分损失", impact: "发生损失时可获得的补偿可能有限", action: "评估高价值使用场景并保留交易与沟通记录" }
  ]
};

function normalizeEvidenceText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function evidenceTerms(text: string): string[] {
  const english = text.toLowerCase().match(/[a-z][a-z-]{2,}/g) ?? [];
  const chinese = text.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  return [...new Set([...english, ...chinese].filter((term) => term.length >= 2))];
}

function conciseQuote(text: string, matchIndex: number, matchLength: number, relevance = ""): string {
  const normalized = normalizeEvidenceText(text);
  const start = Math.max(0, Math.min(matchIndex, normalized.length));
  const end = Math.max(start + 1, Math.min(normalized.length, start + Math.max(1, matchLength)));
  const boundaries = /[。！？!?；;]/g;
  const sentences: Array<{ start: number; end: number; text: string }> = [];
  let sentenceStart = 0;
  let boundary: RegExpExecArray | null;
  while ((boundary = boundaries.exec(normalized))) {
    const sentenceEnd = boundary.index + 1;
    const value = normalized.slice(sentenceStart, sentenceEnd).trim();
    if (value) sentences.push({ start: sentenceStart, end: sentenceEnd, text: value });
    sentenceStart = sentenceEnd;
  }
  const tail = normalized.slice(sentenceStart).trim();
  if (tail) sentences.push({ start: sentenceStart, end: normalized.length, text: tail });

  const overlapping = sentences.filter((sentence) => sentence.end > start && sentence.start < end);
  const candidates = overlapping.length ? overlapping : sentences.filter((sentence) => sentence.end > start).slice(0, 1);
  const terms = evidenceTerms(relevance);
  const selected = candidates
    .map((sentence) => ({
      ...sentence,
      score: terms.reduce((score, term) => score + (sentence.text.toLowerCase().includes(term.toLowerCase()) ? term.length : 0), 0)
    }))
    .sort((left, right) => right.score - left.score || left.text.length - right.text.length)[0];
  const preferred = selected?.text || normalized.slice(Math.max(0, start - 60), Math.min(normalized.length, end + 120)).trim();
  if (preferred.length <= 260) return preferred;

  const focusTerm = terms.find((term) => preferred.toLowerCase().includes(term.toLowerCase()));
  const focus = focusTerm
    ? preferred.toLowerCase().indexOf(focusTerm.toLowerCase()) + Math.floor(focusTerm.length / 2)
    : Math.min(Math.max(0, start - (selected?.start ?? start)), preferred.length - 1);
  const windowStart = Math.max(0, Math.min(preferred.length - 260, focus - 90));
  return preferred.slice(windowStart, windowStart + 260).trim();
}

function sectionFor(source: SourceDocument, index: number) {
  let offset = 0;
  for (const section of source.sections) {
    const next = offset + section.content.length;
    if (index <= next) return section;
    offset = next + 1;
  }
  return source.sections[0];
}

function runSpecialist(domain: Domain, sources: SourceDocument[], knowledge: KnowledgeTool): Finding[] {
  const findings: Finding[] = [];
  for (const source of sources) {
    for (const rule of patterns[domain]) {
      const match = rule.regex.exec(source.normalizedText);
      if (!match || match.index === undefined) continue;
      const matchedText = match[0].replace(/\s+/g, " ").trim();
      const section = source.sections.find((item) => item.content.replace(/\s+/g, " ").includes(matchedText))
        ?? sectionFor(source, match.index);
      if (!section) continue;
      const sectionText = section.content.replace(/\s+/g, " ");
      const sectionMatchIndex = sectionText.toLowerCase().indexOf(matchedText.toLowerCase());
      const quote = sectionMatchIndex >= 0
        ? conciseQuote(sectionText, sectionMatchIndex, matchedText.length, `${rule.title} ${rule.platformAction}`)
        : conciseQuote(source.normalizedText, match.index, match[0].length, `${rule.title} ${rule.platformAction}`);
      const knowledgeQuery = rule.title
        .replace(/或|以及|可能|较宽|较强|范围|平台|用户|协议可|单方/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const knowledgeHits = knowledge.search(knowledgeQuery || rule.title, 2);
      findings.push({
        id: randomUUID(),
        category: rule.category,
        title: rule.title,
        trigger: `当你${domain === "fees" ? "购买、试用或续订服务" : domain === "privacy" ? "授权或使用相关功能" : domain === "content" ? "上传内容或持续使用账号" : "接受协议并发生争议或条款更新"}时`,
        platformAction: rule.platformAction,
        userImpact: rule.impact,
        severity: rule.severity,
        confidence: 0.82,
        actions: [rule.action],
        evidence: [{
          sourceId: source.id,
          sectionId: section.id,
          quote,
          page: section.page,
          url: source.url,
          verified: false
        }],
        knowledgeRefs: knowledgeHits.map((hit) => hit.id),
        uncertainty: "",
        status: "needs_verification"
      });
    }
  }
  return findings;
}

function verify(findings: Finding[], sources: SourceDocument[]): Finding[] {
  const sourceMap = new Map(sources.map((source) => [source.id, source]));
  return findings.map((finding) => {
    const evidence = finding.evidence.map((item) => {
      const source = sourceMap.get(item.sourceId);
      const normalizedQuote = normalizeEvidenceText(item.quote);
      if (!source || !normalizedQuote) return { ...item, verified: false };
      const section = source.sections.find((candidate) => normalizeEvidenceText(candidate.content).includes(normalizedQuote));
      const sourceText = normalizeEvidenceText(source.normalizedText);
      if (!section && !sourceText.includes(normalizedQuote)) return { ...item, verified: false };
      const evidenceText = normalizeEvidenceText(section?.content ?? sourceText);
      const index = evidenceText.indexOf(normalizedQuote);
      return {
        ...item,
        sectionId: section?.id ?? item.sectionId,
        quote: conciseQuote(evidenceText, Math.max(0, index), normalizedQuote.length, `${finding.title} ${finding.platformAction}`),
        page: section?.page ?? item.page,
        url: source.url ?? item.url,
        verified: true
      };
    });
    const verified = evidence.length > 0 && evidence.every((item) => item.verified);
    return {
      ...finding,
      evidence,
      confidence: verified ? finding.confidence : Math.min(finding.confidence, 0.45),
      uncertainty: verified ? finding.uncertainty : "未能在来源快照中逐字核对该引用",
      status: verified ? "verified" : "needs_verification"
    };
  });
}

function dedupe(findings: Finding[]): Finding[] {
  const seen = new Map<string, Finding>();
  for (const finding of findings) {
    const key = `${finding.category}:${finding.title}`;
    const existing = seen.get(key);
    if (!existing || severityWeight[finding.severity] > severityWeight[existing.severity]) seen.set(key, finding);
  }
  return [...seen.values()];
}

function domainForCategory(category: Finding["category"]): Domain {
  if (category === "money") return "fees";
  if (category === "data") return "privacy";
  if (category === "content" || category === "account") return "content";
  return "rights";
}

function summarizeModelFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || "模型调用失败");
  if (/timeout|timed out|aborted/i.test(message)) return "请求超时";
  if (/exceeded \d+ tool rounds/i.test(message)) return "工具调用超过上限";
  if (/invalid enum|invalid_type|required|schema validation|unexpected token|Expected (?:number|array|string|boolean)/i.test(message)) {
    const detail = message.match(/Expected [^,\n]+, received [^,\n]+/i)?.[0];
    return detail ? `返回格式不符合约定：${detail}` : "返回格式不符合约定";
  }
  if (/invalid token|unauthorized|authentication|api key|401/i.test(message)) return "鉴权失败";
  const firstLine = message.split(/\r?\n/)[0] ?? "";
  return firstLine.replace(/\s+/g, " ").slice(0, 120) || "模型调用失败";
}

function rebindFinding(finding: Finding, sources: SourceDocument[]): Finding | undefined {
  const evidence = finding.evidence.map((reference) => {
    const quote = normalizeEvidenceText(reference.quote);
    for (const source of sources) {
      const section = source.sections.find((item) => normalizeEvidenceText(item.content).includes(quote));
      if (section) {
        const sectionText = normalizeEvidenceText(section.content);
        return {
          ...reference,
          sourceId: source.id,
          sectionId: section.id,
          quote: conciseQuote(sectionText, sectionText.indexOf(quote), quote.length, `${finding.title} ${finding.platformAction}`),
          page: section.page,
          url: source.url,
          verified: true
        };
      }
    }
    return { ...reference, verified: false };
  });
  if (!evidence.length || evidence.some((item) => !item.verified)) return;
  return { ...finding, id: randomUUID(), evidence, status: "verified" };
}

function recommendationFor(findings: Finding[], context: UserContext, gaps: AnalysisResult["coverageGaps"]) {
  const verified = findings.filter((finding) => finding.status === "verified");
  const redlineConflict = context.redlines.some((redline) => {
    const normalized = redline.toLowerCase().replace(/不能|不允许|拒绝|不要|禁止|不得|必须/g, " ");
    const tokens = normalized.split(/\s+|，|、|。|；|;|：|:/).filter((token) => token.length >= 2);
    return verified.some((finding) => tokens.some((token) => `${finding.title}${finding.userImpact}`.toLowerCase().includes(token)));
  });
  if (redlineConflict || verified.some((finding) => finding.severity === "critical") || gaps.some((gap) => gap.impact === "high")) {
    return { recommendation: "pause" as const, reason: redlineConflict ? "发现可能触及你个人底线的条款，建议核实或调整后再决定。" : "存在高影响风险或关键材料缺口，暂不宜直接确认。" };
  }
  if (verified.some((finding) => finding.severity === "high")) {
    return { recommendation: "adjust" as const, reason: "发现需要先确认设置、权限或退出路径的高影响条款。" };
  }
  return { recommendation: "continue" as const, reason: "当前已核验材料中未发现阻止继续的高影响风险，但仍应结合实际使用场景判断。" };
}

export async function runWorkflow(
  input: WorkflowInput,
  knowledge: KnowledgeTool,
  onProgress?: (progress: WorkflowProgress) => void
): Promise<AnalysisResult> {
  onProgress?.({ stage: "analyzing", progress: 35, message: "四个专业视角正在并行分析" });
  const modelConfig = modelConfigFromEnv();
  const modelFailures: string[] = [];
  const selectedDomains = input.domains?.length ? input.domains : Object.keys(patterns) as Domain[];
  const groups = await Promise.all(selectedDomains.map(async (domain) => {
    if (!modelConfig) return runSpecialist(domain, input.sources, knowledge);
    try {
      const roleModel = process.env[`MODEL_${domain.toUpperCase()}`];
      return await runModelSpecialist({
        role: domain,
        sources: input.sources,
        context: input.context,
        knowledge,
        promptDir: input.promptDir,
        config: { ...modelConfig, model: roleModel ?? modelConfig.model }
      });
    } catch (error) {
      console.warn(`[agent-core] ${domain} specialist failed`, error);
      modelFailures.push(`${domain}: ${summarizeModelFailure(error)}`);
      return [];
    }
  }));
  if (modelConfig && modelFailures.length) {
    throw new Error(`模型分析失败：${[...new Set(modelFailures)].join("；")}`);
  }
  onProgress?.({ stage: "verifying", progress: 72, message: "正在逐条核对原文证据" });
  const preserved = input.previousResult
    ? input.previousResult.findings
      .filter((finding) => !selectedDomains.includes(domainForCategory(finding.category)))
      .map((finding) => rebindFinding(finding, input.sources))
      .filter((finding): finding is Finding => Boolean(finding))
    : [];
  let findings = verify(dedupe([...preserved, ...groups.flat()]), input.sources);
  const verifierEnabled = process.env.MODEL_VERIFIER_ENABLED === "true";
  if (modelConfig && findings.length && verifierEnabled) {
    try {
      const decisions = await runModelVerifier({
        findings,
        sources: input.sources,
        knowledge,
        promptDir: input.promptDir,
        config: { ...modelConfig, model: process.env.MODEL_VERIFIER ?? modelConfig.model }
      });
      const decisionMap = new Map(decisions.map((decision) => [decision.findingId, decision]));
      findings = findings.map((finding) => {
        const decision = decisionMap.get(finding.id);
        if (!decision || finding.evidence.some((evidence) => !evidence.verified)) return finding;
        return {
          ...finding,
          status: decision.status,
          confidence: Math.min(finding.confidence, decision.confidence),
          uncertainty: decision.uncertainty
        };
      });
    } catch (error) {
      console.warn("[agent-core] verifier failed", error);
      throw new Error(`模型复核失败：${summarizeModelFailure(error)}`);
    }
  }
  findings = findings
    .filter((finding) => finding.status !== "rejected")
    .sort((a, b) => severityWeight[b.severity] - severityWeight[a.severity] || b.confidence - a.confidence);
  const gaps: AnalysisResult["coverageGaps"] = input.sources.filter((source) => source.status !== "ready").map((source) => ({
    sourceId: source.id,
    title: `${source.title}未完整解析`,
    detail: source.error ?? "该来源只能部分读取，相关结论可能不完整。",
    impact: "high" as const
  }));
  onProgress?.({ stage: "integrating", progress: 90, message: "主分析器正在整合结论与行动建议" });
  const policyDecision = recommendationFor(findings, input.context, gaps);
  let decision = {
    recommendation: policyDecision.recommendation,
    reason: policyDecision.reason,
    topFindingIds: findings.filter((finding) => finding.status === "verified").slice(0, 3).map((finding) => finding.id),
    actionChecklist: [...new Set(findings.slice(0, 4).flatMap((finding) => finding.actions))],
    followUpSuggestions: [] as string[]
  };
  if (modelConfig) {
    try {
      const proposal = await runModelIntegrator({
        findings,
        context: input.context,
        sources: input.sources,
        knowledge,
        promptDir: input.promptDir,
        config: { ...modelConfig, model: process.env.MODEL_MAIN ?? modelConfig.model }
      });
      input.onMainAgentSession?.(proposal.session);
      const rank = { continue: 0, adjust: 1, pause: 2 };
      const recommendation = rank[policyDecision.recommendation] > rank[proposal.recommendation]
        ? policyDecision.recommendation
        : proposal.recommendation;
      decision = {
        recommendation,
        reason: recommendation === proposal.recommendation ? proposal.recommendationReason : policyDecision.reason,
        topFindingIds: proposal.topFindingIds.filter((id) => findings.some((finding) => finding.id === id && finding.status === "verified")).slice(0, 3),
        actionChecklist: proposal.actionChecklist,
        followUpSuggestions: proposal.followUpSuggestions
      };
    } catch (error) {
      console.warn("[agent-core] integrator failed", error);
      throw new Error(`主模型整合失败：${summarizeModelFailure(error)}`);
    }
  }
  const now = new Date().toISOString();
  return {
    id: input.analysisId,
    serviceId: input.serviceId,
    serviceName: input.serviceName,
    recommendation: decision.recommendation,
    recommendationReason: decision.reason,
    findings,
    topFindingIds: decision.topFindingIds.length ? decision.topFindingIds : findings.filter((finding) => finding.status === "verified").slice(0, 3).map((finding) => finding.id),
    followUpSuggestions: decision.followUpSuggestions,
    sources: input.sources,
    coverageGaps: gaps,
    actionChecklist: decision.actionChecklist,
    createdAt: now,
    updatedAt: now,
    saved: input.saved ?? false,
    versions: {
      knowledge: knowledge.version ?? "local-knowledge-v1",
      prompts: process.env.PROMPT_VERSION ?? "2026-08-14",
      model: modelConfig
        ? JSON.stringify({
          default: modelConfig.model,
          fees: process.env.MODEL_FEES ?? modelConfig.model,
          privacy: process.env.MODEL_PRIVACY ?? modelConfig.model,
          content: process.env.MODEL_CONTENT ?? modelConfig.model,
          rights: process.env.MODEL_RIGHTS ?? modelConfig.model,
          verifier: process.env.MODEL_VERIFIER ?? modelConfig.model,
          main: process.env.MODEL_MAIN ?? modelConfig.model,
          router: process.env.MODEL_ROUTER ?? modelConfig.model
        })
        : "deterministic-demo-v1"
    }
  };
}

export interface ChangeRoute {
  changed: boolean;
  domains: Domain[];
  confidence: number;
  structural: boolean;
  changedSections: string[];
}

function changedSpanLength(before: string, after: string): number {
  let prefix = 0;
  const maxPrefix = Math.min(before.length, after.length);
  while (prefix < maxPrefix && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  const maxSuffix = Math.min(before.length - prefix, after.length - prefix);
  while (suffix < maxSuffix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  return Math.max(before.length - prefix - suffix, after.length - prefix - suffix);
}

export function routeChangedContent(previous: SourceDocument[], current: SourceDocument[]): ChangeRoute {
  const previousMap = new Map(previous.map((source) => [source.url ?? source.title, source]));
  const changedSections: string[] = [];
  let previousLength = 0;
  let deltaLength = 0;
  let combined = "";
  for (const source of current) {
    const old = previousMap.get(source.url ?? source.title);
    previousLength += old?.normalizedText.length ?? 0;
    if (old?.fingerprint === source.fingerprint) continue;
    const oldSections = new Map(old?.sections.map((section) => [section.heading, section.content]) ?? []);
    for (const section of source.sections) {
      if (oldSections.get(section.heading) === section.content) continue;
      changedSections.push(`${source.title} / ${section.heading}`);
      combined += `\n${section.heading}\n${section.content}`;
      deltaLength += changedSpanLength(oldSections.get(section.heading) ?? "", section.content);
    }
  }
  for (const source of previous) {
    if (current.some((item) => (item.url ?? item.title) === (source.url ?? source.title))) continue;
    changedSections.push(`${source.title} / 已移除`);
    combined += `\n${source.normalizedText}`;
    deltaLength += source.normalizedText.length;
  }
  if (!changedSections.length) {
    return { changed: false, domains: [], confidence: 1, structural: false, changedSections: [] };
  }
  const structural = (previousLength > 500 && deltaLength / previousLength > 0.35) || changedSections.length > 12;
  const signals: Record<Domain, RegExp> = {
    fees: /费用|价格|付款|退款|续费|会员|charge|price|refund|renew/i,
    privacy: /信息|数据|隐私|共享|权限|跨境|data|privacy|share|permission/i,
    content: /内容|账号|账户|许可|授权|删除|终止|content|account|licen[cs]e|terminate/i,
    rights: /变更|通知|争议|仲裁|管辖|责任|赔偿|change|notice|dispute|liability/i
  };
  const matched = (Object.keys(signals) as Domain[]).filter((domain) => signals[domain].test(combined));
  const domains = structural || !matched.length ? Object.keys(signals) as Domain[] : matched;
  return {
    changed: true,
    domains,
    confidence: structural || !matched.length ? 0.45 : 0.82,
    structural: structural || !matched.length,
    changedSections: changedSections.slice(0, 30)
  };
}

export async function refineChangeRoute(
  route: ChangeRoute,
  previous: SourceDocument[],
  current: SourceDocument[],
  knowledge: KnowledgeTool,
  promptDir?: string
): Promise<ChangeRoute> {
  const modelConfig = modelConfigFromEnv();
  if (!route.changed || !modelConfig) return route;
  try {
    const proposal = await runModelChangeRouter({
      deterministicRoute: route,
      previousSources: previous,
      currentSources: current,
      knowledge,
      promptDir,
      config: { ...modelConfig, model: process.env.MODEL_ROUTER ?? modelConfig.model }
    });
    const allDomains: Domain[] = ["fees", "privacy", "content", "rights"];
    const structural = route.structural || proposal.structural || proposal.confidence < 0.6;
    return {
      ...route,
      structural,
      confidence: Math.min(route.confidence, proposal.confidence),
      domains: structural ? allDomains : [...new Set([...route.domains, ...proposal.domains])]
    };
  } catch {
    return route;
  }
}

export async function answerFollowUp(
  result: AnalysisResult,
  message: string,
  session: MainAgentSession | undefined,
  knowledge?: KnowledgeTool,
  promptDir?: string
): Promise<{ answer: string; session?: MainAgentSession }> {
  const modelConfig = modelConfigFromEnv();
  if (modelConfig && knowledge) {
    return runModelFollowUp({
      result,
      message,
      session,
      sources: result.sources,
      knowledge,
      promptDir,
      config: { ...modelConfig, model: process.env.MODEL_MAIN ?? modelConfig.model }
    });
  }
  const normalized = message.toLowerCase();
  const relevant = result.findings.filter((finding) =>
    normalized.includes(finding.category) ||
    [...finding.title, finding.userImpact].some((text) => text.toLowerCase().split(/\s+/).some((token) => token.length > 1 && normalized.includes(token)))
  );
  const selected = relevant.length ? relevant : result.findings.slice(0, 3);
  if (!selected.length) return { answer: "当前材料中没有已核验的相关告警。你可以补充具体条款、链接或你的使用场景，我会据此重新判断。" };
  return { answer: selected.map((finding) => {
    const evidence = finding.evidence.find((item) => item.verified);
    return `【${finding.title}】${finding.userImpact}。建议：${finding.actions.join("；")}。${evidence ? `依据：“${evidence.quote}”` : "该项仍需补充原文核实。"}`
  }).join("\n\n") };
}

export function contentFingerprint(text: string): string {
  return createHash("sha256").update(text.replace(/\s+/g, " ").trim()).digest("hex");
}
