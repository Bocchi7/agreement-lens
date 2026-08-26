import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { decodeHtmlBytes, maxSourceDocuments, type DiscoveredSource, type SourceDocument, type SourceSection } from "@agreement-lens/shared";
import { contentFingerprint } from "@agreement-lens/agent-core";
import { sanitizeRenderedHtml, validateRemoteUrl } from "./security.js";
import { snapshotDir } from "./config.js";

function isInteractiveAccountUrl(url: URL): boolean {
  const value = `${url.hostname}${url.pathname}`.toLowerCase();
  return /(^|\.)login\.(live|microsoftonline)\.com$/.test(url.hostname.toLowerCase())
    || /\/(?:oauth2?|authorize|signin|sign-in|login)(?:\/|$)/i.test(value)
    || ["client_id", "redirect_uri", "response_type"].some((name) => url.searchParams.has(name));
}

function isAccountDashboardLink(label: string, url: URL): boolean {
  return /(?:privacy\s+dashboard|隐私仪表板)/i.test(label)
    || (url.hostname.toLowerCase() === "account.microsoft.com" && /^\/privacy\/?$/i.test(url.pathname));
}

function isHistoricalVersionLink(label: string, url: URL): boolean {
  const path = `${url.pathname}${url.search}`.toLocaleLowerCase();
  const text = `${label} ${path}`;
  return /历史版本|历史条款|旧版|上一版|previous|histor(?:y|ical)|archive|archived/.test(text)
    || /(?:^|[/_-])old(?:[/_-]|$)/.test(path)
    || /(?:^|[?&])(?:version|revision|history)=/i.test(url.search);
}

function agreementVersionFamily(label: string, url: URL): string | undefined {
  const value = `${label} ${url.pathname}`.toLocaleLowerCase();
  if (/隐私|privacy|personal[-_ ]?(?:data|information)/.test(value)) return "privacy";
  if (/社区规范|community[-_ ]?guidelines?/.test(value)) return "community";
  if (/续费|subscription|auto[-_ ]?renew/.test(value)) return "subscription";
  if (/协议|条款|terms?|agreement|conditions?/.test(value)) return "terms";
  return undefined;
}

function normalize(text: string): string {
  return text.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function canonicalAgreementUrl(url: URL): string {
  const normalized = new URL(url.href);
  normalized.hostname = normalized.hostname.toLocaleLowerCase();
  if ((normalized.protocol === "http:" && normalized.port === "80") || (normalized.protocol === "https:" && normalized.port === "443")) normalized.port = "";
  if (normalized.hash && !/^#(?:!\/|\/)/.test(normalized.hash)) normalized.hash = "";
  for (const key of [...normalized.searchParams.keys()]) {
    if (/^(?:utm_[^=]*|spm|from|source|src|ref|referer|referrer|campaign|campaignid|clickid|click_id|adid|ad_id|fbclid|gclid|msclkid|yclid|igshid|share_token)$/i.test(key)
      || (/^_\d{10,}$/.test(key) && !normalized.searchParams.get(key))) normalized.searchParams.delete(key);
  }
  normalized.searchParams.sort();
  normalized.pathname = normalized.pathname.replace(/\/{2,}/g, "/");
  if (normalized.pathname.length > 1) normalized.pathname = normalized.pathname.replace(/\/+$/, "");
  return normalized.href;
}

function sourceUrlIdentity(value: string): string {
  try {
    const url = new URL(canonicalAgreementUrl(new URL(value)));
    // HTTP and HTTPS copies of the same agreement are commonly exposed
    // together. Treat them as one source while preferring HTTPS below.
    const protocolIndependent = `${url.hostname.toLocaleLowerCase()}${url.port ? `:${url.port}` : ""}${url.pathname}${url.search}${url.hash}`;
    return protocolIndependent.replace(/\/+$/, "") || "/";
  } catch {
    return value;
  }
}

function discoveredSourcePreference(source: DiscoveredSource): number {
  return (source.url?.startsWith("https://") ? 4 : 0)
    + (source.renderedHtml ? 2 : 0)
    + (source.relation === "primary" ? 1 : 0);
}

function deduplicateDiscoveredSources(sources: DiscoveredSource[]): DiscoveredSource[] {
  const byIdentity = new Map<string, DiscoveredSource>();
  for (const source of sources) {
    const identity = source.url ? `url:${sourceUrlIdentity(source.url)}` : `id:${source.id}`;
    const existing = byIdentity.get(identity);
    if (!existing || discoveredSourcePreference(source) > discoveredSourcePreference(existing)) {
      byIdentity.set(identity, source);
    }
  }
  return [...byIdentity.values()];
}

function sourceErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "来源读取失败";
  if (/fetch failed|ETIMEDOUT|ECONNRESET|ENETUNREACH/i.test(message)) {
    return "后端无法访问该站点，浏览器回退也未成功";
  }
  if (/timeout|timed out|aborted/i.test(message)) return "来源页面加载超时";
  return message;
}

function sectionsFromDocument(document: Document): SourceSection[] {
  const nodes = [...document.querySelectorAll("h1,h2,h3,h4,p,li,tr")]
    .filter((node) => /^H[1-4]$/.test(node.tagName) || !node.querySelector("p,li,tr"));
  const sections: SourceSection[] = [];
  let heading = "正文";
  let buffer: string[] = [];
  const flush = () => {
    const content = normalize(buffer.join("\n"));
    if (content) sections.push({ id: randomUUID(), heading, content });
    buffer = [];
  };
  for (const node of nodes) {
    const text = normalize(node.textContent ?? "");
    if (!text) continue;
    if (/^H[1-4]$/.test(node.tagName)) {
      flush();
      heading = text.slice(0, 160);
    } else {
      buffer.push(text);
      if (buffer.join("").length > 5000) flush();
    }
  }
  flush();
  return sections;
}

function sectionsRepresentText(sections: SourceSection[], normalizedText: string): boolean {
  if (!normalizedText) return false;
  const sectionLength = sections.reduce((total, section) => total + section.content.length, 0);
  return sectionLength >= normalizedText.length * 0.75
    && sectionLength <= normalizedText.length * 1.5;
}

function parseHtml(id: string, title: string, html: string, url?: string): SourceDocument {
  const clean = sanitizeRenderedHtml(html);
  const dom = new JSDOM(clean, { url: url ?? "https://local.invalid/" });
  const reader = new Readability(dom.window.document.cloneNode(true) as Document).parse();
  const fallbackSections = sectionsFromDocument(dom.window.document);
  const linkedSources = [...dom.window.document.querySelectorAll<HTMLAnchorElement>("a[href]")]
    .map((link) => {
      const label = normalize(link.textContent ?? link.title ?? "");
      try {
        const target = new URL(link.href, url ?? "https://local.invalid/");
        return matchesAgreementLink(label || target.pathname)
          && ["http:", "https:"].includes(target.protocol)
          && !isInteractiveAccountUrl(target)
          && !isAccountDashboardLink(label, target)
          && !isHistoricalVersionLink(label, target)
          ? { title: label || target.pathname.split("/").pop() || "关联规则", url: canonicalAgreementUrl(target) }
          : undefined;
      } catch {
        return undefined;
      }
    })
    .filter((item): item is { title: string; url: string } => Boolean(item))
    .filter((item, index, all) => all.findIndex((other) => other.url === item.url) === index)
    .slice(0, 12);
  const fallbackText = fallbackSections.map((section) => `${section.heading}\n${section.content}`).join("\n\n");
  const normalizedText = normalize(reader?.textContent && reader.textContent.length > 300 ? reader.textContent : fallbackText || dom.window.document.body?.textContent || "");
  let sections = fallbackSections;
  if (reader?.content && !sectionsRepresentText(sections, normalizedText)) {
    const readerDom = new JSDOM(reader.content, { url: url ?? "https://local.invalid/" });
    const readerSections = sectionsFromDocument(readerDom.window.document);
    if (sectionsRepresentText(readerSections, normalizedText)) sections = readerSections;
  }
  if (!sectionsRepresentText(sections, normalizedText)) {
    sections = [{ id: randomUUID(), heading: reader?.title || title, content: normalizedText }];
  }
  return {
    id, title: reader?.title || title, url, mediaType: "html", normalizedText,
    fingerprint: contentFingerprint(normalizedText), sections,
    linkedSources,
    fetchedAt: new Date().toISOString(), status: normalizedText.length > 80 ? "ready" : "partial",
    error: normalizedText.length > 80 ? undefined : "页面正文过短，可能依赖动态渲染"
  };
}

type NetEaseTermsKind = "service" | "privacy" | "children";

const netEaseTermsRoutes: Record<NetEaseTermsKind, string> = {
  service: "https://y.music.163.com/g/yida/36a81250504747a19283b29e4e9ff38c",
  privacy: "https://y.music.163.com/g/yida/6a5be9e3502947a9b794fc01932a83a3",
  children: "https://y.music.163.com/g/yida/b70f764b084a41a0b69e5c641158514f"
};

function netEaseTermsKind(url: URL): NetEaseTermsKind | undefined {
  if (url.hostname.toLocaleLowerCase() !== "st.music.163.com") return undefined;
  const match = url.pathname.match(/^\/official-terms\/(service|privacy|children)\/?$/i);
  return match?.[1]?.toLocaleLowerCase() as NetEaseTermsKind | undefined;
}

function extractNetEaseTermsRoute(script: string, kind: NetEaseTermsKind): string | undefined {
  const labels: Record<NetEaseTermsKind, string> = {
    service: "网易云音乐服务条款中文",
    privacy: "网易云音乐隐私政策中文",
    children: "网易云音乐儿童个人信息保护规则及监护人须知"
  };
  const escapedLabel = labels[kind].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = script.match(new RegExp(
    `["']${escapedLabel}["']\\s*:\\s*["'](https://y\\.music\\.163\\.com/[^"']+)["']`,
    "u"
  ));
  return match?.[1];
}

function isMeituanRuleCenterUrl(url: URL): boolean {
  return url.hostname.toLocaleLowerCase() === "rules-center.meituan.com"
    && /^\/(?:rules-detail|rule-detail)\/\d+(?:\/\d+)?\/?$/i.test(url.pathname);
}

function meituanRuleId(url: URL): number | undefined {
  const match = url.pathname.match(/^\/(?:rules-detail|rule-detail)\/(\d+)/i);
  const id = match?.[1] ? Number(match[1]) : NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

function escapeHtmlText(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[character] ?? character));
}

async function fetchMeituanRuleCenterHtml(url: URL): Promise<{ html: string; title: string } | undefined> {
  if (!isMeituanRuleCenterUrl(url)) return undefined;
  const sourceId = meituanRuleId(url);
  if (!sourceId) return undefined;
  const response = await fetch("https://rules-center.meituan.com/cap-rules-center/us/api/unionRule/queryUnionRuleDetail", {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": "AgreementLens/0.1 (+local research project)"
    },
    body: JSON.stringify({
      sourceId,
      type: Number(url.pathname.match(/^\/rule-detail\/\d+\/(\d+)/i)?.[1] ?? 1)
    })
  });
  if (!response.ok) throw new Error(`美团规则中心接口返回 HTTP ${response.status}`);
  const payload = await response.json() as {
    code?: number;
    data?: {
      unionRuleDTO?: {
        title?: string;
        subTitle?: string;
        detail?: string;
        publishTime?: string | number;
        version?: string;
      };
    };
  };
  const rule = payload.data?.unionRuleDTO;
  if (payload.code !== 0 || !rule?.detail?.trim()) throw new Error("美团规则中心接口未返回协议正文");
  const published = rule.publishTime
    ? `<p>发布日期：${escapeHtmlText(String(rule.publishTime))}</p>`
    : "";
  const title = rule.title ?? rule.subTitle ?? "美团规则";
  return {
    title,
    html: `<main>
      <h1>${escapeHtmlText(title)}</h1>
      ${published}
      <section>${rule.detail}</section>
    </main>`
  };
}

async function fetchNetEaseOfficialTermsHtml(url: URL): Promise<string | undefined> {
  const kind = netEaseTermsKind(url);
  if (!kind) return undefined;

  const response = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    headers: {
      "user-agent": "Mozilla/5.0 AgreementLens/0.1",
      accept: "text/html,application/xhtml+xml"
    }
  });
  if (!response.ok) throw new Error(`网易云音乐协议页面返回 HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const html = decodeHtmlBytes(bytes, response.headers.get("content-type") ?? "text/html");
  const dom = new JSDOM(html, { url: url.href });
  const scriptSrc = [...dom.window.document.querySelectorAll<HTMLScriptElement>("script[src]")]
    .map((script) => script.getAttribute("src"))
    .find((src) => src && /\.js(?:[?#]|$)/i.test(src));

  let termsUrl = netEaseTermsRoutes[kind];
  if (scriptSrc) {
    const appScriptResponse = await fetch(new URL(scriptSrc, url), {
      signal: AbortSignal.timeout(15_000),
      headers: { "user-agent": "Mozilla/5.0 AgreementLens/0.1" }
    });
    if (appScriptResponse.ok) {
      const appScript = await appScriptResponse.text();
      termsUrl = extractNetEaseTermsRoute(appScript, kind) ?? termsUrl;
    }
  }

  const termsResponse = await fetch(termsUrl, {
    signal: AbortSignal.timeout(15_000),
    headers: {
      "user-agent": "Mozilla/5.0 AgreementLens/0.1",
      accept: "text/html,application/xhtml+xml"
    }
  });
  if (!termsResponse.ok) throw new Error(`网易云音乐协议正文返回 HTTP ${termsResponse.status}`);
  const termsBytes = new Uint8Array(await termsResponse.arrayBuffer());
  return decodeHtmlBytes(termsBytes, termsResponse.headers.get("content-type") ?? "text/html");
}

async function fetchJdPrivacyApiHtml(url: URL): Promise<string | undefined> {
  if (url.hostname.toLowerCase() !== "about.jd.com" || !/^\/privacy\/?$/i.test(url.pathname)) {
    return undefined;
  }
  const response = await fetch("https://services.jd.com/neos/data/?id=about_privacy", {
    signal: AbortSignal.timeout(15_000),
    headers: {
      accept: "application/json",
      "x-source-id": "0",
      "x-source": "2"
    }
  });
  if (!response.ok) throw new Error(`京东隐私政策接口返回 HTTP ${response.status}`);
  const payload = await response.json() as {
    code?: number;
    data?: { title?: string; subTitle?: string; date?: string; dateEff?: string; tips?: string; content?: string };
  };
  if (payload.code !== 0 || !payload.data?.content) throw new Error("京东隐私政策接口未返回正文");
  const data = payload.data;
  return `<main>
    <h1>${data.title ?? "京东基本功能隐私政策"}</h1>
    <p>版本更新日期：${data.date ?? "未提供"}</p>
    <p>版本生效日期：${data.dateEff ?? "未提供"}</p>
    <section>${data.tips ?? ""}</section>
    <section>${data.content}</section>
  </main>`;
}

async function persistSnapshot(
  source: SourceDocument,
  raw: Uint8Array | string,
  responseMeta?: { status: number; headers: Record<string, string> }
): Promise<SourceDocument> {
  const sourceDir = path.join(
    snapshotDir,
    source.id.replace(/[^a-zA-Z0-9_-]/g, "_"),
    `${source.fetchedAt.replace(/[:.]/g, "-")}-${source.fingerprint.slice(0, 12)}`
  );
  await fs.mkdir(sourceDir, { recursive: true });
  const extension = source.mediaType === "pdf" ? "pdf" : source.mediaType === "html" ? "html" : "txt";
  await fs.writeFile(path.join(sourceDir, `raw.${extension}`), raw);
  await fs.writeFile(path.join(sourceDir, "normalized.json"), JSON.stringify({
    id: source.id,
    title: source.title,
    url: source.url,
    mediaType: source.mediaType,
    fingerprint: source.fingerprint,
    fetchedAt: source.fetchedAt,
    sections: source.sections
  }, null, 2));
  await fs.writeFile(path.join(sourceDir, "response.json"), JSON.stringify(responseMeta ?? {
    status: 200,
    headers: { "content-type": source.mediaType === "pdf" ? "application/pdf" : "text/plain" }
  }, null, 2));
  return { ...source, snapshotPath: path.relative(snapshotDir, sourceDir) };
}

async function parsePdf(id: string, title: string, bytes: Uint8Array, url?: string): Promise<SourceDocument> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // PDF.js transfers and detaches the supplied ArrayBuffer. Parse a copy so
  // the original bytes remain available for the immutable raw snapshot.
  const pdf = await pdfjs.getDocument({ data: Uint8Array.from(bytes) }).promise;
  const sections: SourceSection[] = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = normalize(content.items.map((item: any) => item.str ?? "").join(" "));
    if (text) sections.push({ id: randomUUID(), heading: `第 ${pageNumber} 页`, content: text, page: pageNumber });
  }
  const normalizedText = sections.map((section) => section.content).join("\n\n");
  return {
    id, title, url, mediaType: "pdf", normalizedText, sections,
    fingerprint: contentFingerprint(normalizedText), fetchedAt: new Date().toISOString(),
    status: normalizedText.length > 80 ? "ready" : "partial",
    error: normalizedText.length > 80 ? undefined : "PDF 未提取到足够文字，可能是扫描件"
  };
}

export async function loadSource(source: DiscoveredSource, renderedHtml?: string, redirects = 0): Promise<SourceDocument> {
  try {
    if (source.kind === "text") {
      const text = normalize(source.text ?? "");
      return persistSnapshot({
        id: source.id, title: source.title, mediaType: "text", normalizedText: text,
        fingerprint: contentFingerprint(text), fetchedAt: new Date().toISOString(),
        sections: [{ id: randomUUID(), heading: source.title, content: text }],
        status: text.length > 20 ? "ready" : "partial", error: text.length > 20 ? undefined : "粘贴文本过短"
      }, text);
    }
    if (source.kind === "pdf" && source.dataBase64) {
      const bytes = Uint8Array.from(Buffer.from(source.dataBase64, "base64"));
      return persistSnapshot(await parsePdf(source.id, source.title, bytes, source.url), bytes);
    }
    const specialUrl = source.url ? new URL(source.url) : undefined;
    if (specialUrl && source.kind === "url" && isMeituanRuleCenterUrl(specialUrl)) {
      const meituanHtml = await fetchMeituanRuleCenterHtml(specialUrl);
      if (meituanHtml) {
        return persistSnapshot(parseHtml(source.id, meituanHtml.title, meituanHtml.html, source.url), meituanHtml.html, {
          status: 200,
          headers: {
            "content-type": "text/html",
            "x-agreement-lens-source": "meituan-rule-center-api"
          }
        });
      }
    }
    if (source.renderedHtml && source.kind === "url") {
      return persistSnapshot(parseHtml(source.id, source.title, source.renderedHtml, source.url), source.renderedHtml, {
        status: 200,
        headers: { "content-type": "text/html", "x-agreement-lens-source": "extension-fetch" }
      });
    }
    if (renderedHtml && source.kind === "url") {
      return persistSnapshot(parseHtml(source.id, source.title, renderedHtml, source.url), renderedHtml, {
        status: 200,
        headers: { "content-type": "text/html", "x-agreement-lens-source": "rendered-dom" }
      });
    }
    if (!source.url) throw new Error("来源缺少 URL");
    const url = await validateRemoteUrl(source.url);
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
      headers: { "user-agent": "AgreementLens/0.1 (+local research project)", accept: "text/html,application/pdf,text/plain" }
    });
    if (response.status >= 300 && response.status < 400) {
      if (redirects >= 5) throw new Error("来源重定向次数过多");
      const location = response.headers.get("location");
      if (!location) throw new Error("重定向缺少目标");
      const redirected = new URL(location, url);
      await validateRemoteUrl(redirected.href);
      const redirectedDocument = await loadSource({ ...source, url: redirected.href }, renderedHtml, redirects + 1);
      // Keep the URL the user selected as the source identity. The final
      // redirect target is still used for fetching, but replacing the URL in
      // the result makes manually supplied materials appear to change.
      return source.url ? { ...redirectedDocument, url: source.url } : redirectedDocument;
    }
    if (!response.ok) throw new Error(`来源返回 HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("pdf") || source.kind === "pdf" || url.pathname.toLowerCase().endsWith(".pdf")) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      return persistSnapshot(await parsePdf(source.id, source.title, bytes, source.url), bytes, {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries())
      });
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const html = decodeHtmlBytes(bytes, contentType);
    const parsed = parseHtml(source.id, source.title, html, source.url);
    if (parsed.normalizedText.length < 1000) {
      const meituanHtml = await fetchMeituanRuleCenterHtml(url);
      if (meituanHtml) {
        return persistSnapshot(parseHtml(source.id, meituanHtml.title, meituanHtml.html, source.url), meituanHtml.html, {
          status: response.status,
          headers: {
            ...Object.fromEntries(response.headers.entries()),
            "x-agreement-lens-source": "meituan-rule-center-api"
          }
        });
      }
      const netEaseHtml = await fetchNetEaseOfficialTermsHtml(url);
      if (netEaseHtml) {
        return persistSnapshot(parseHtml(source.id, source.title, netEaseHtml, source.url), netEaseHtml, {
          status: response.status,
          headers: {
            ...Object.fromEntries(response.headers.entries()),
            "x-agreement-lens-source": "netease-official-terms"
          }
        });
      }
      const dynamicHtml = await fetchJdPrivacyApiHtml(url);
      if (dynamicHtml) {
        return persistSnapshot(parseHtml(source.id, source.title, dynamicHtml, source.url), dynamicHtml, {
          status: response.status,
          headers: {
            ...Object.fromEntries(response.headers.entries()),
            "x-agreement-lens-source": "jd-privacy-api"
          }
        });
      }
    }
    return persistSnapshot(parsed, html, {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries())
    });
  } catch (error) {
    if (renderedHtml && source.relation === "primary") {
      return persistSnapshot(parseHtml(source.id, source.title, renderedHtml, source.url), renderedHtml);
    }
    const message = sourceErrorMessage(error);
    return {
      id: source.id, title: source.title, url: source.url, mediaType: source.kind === "pdf" ? "pdf" : source.kind === "text" ? "text" : "html",
      normalizedText: "", fingerprint: contentFingerprint(""), sections: [],
      fetchedAt: new Date().toISOString(), status: "failed", error: message
    };
  }
}

export async function loadSourceGraph(
  selected: DiscoveredSource[],
  renderedHtml?: string,
  maxDocuments = maxSourceDocuments,
  currentPageUrl?: string
): Promise<SourceDocument[]> {
  selected = deduplicateDiscoveredSources(selected);
  const currentFamilies = new Set(selected.flatMap((source) => {
    if (!source.url) return [];
    const url = new URL(source.url);
    if (isHistoricalVersionLink(source.title, url)) return [];
    const family = agreementVersionFamily(source.title, url);
    return family ? [family] : [];
  }));
  const roots = selected.filter((source) => {
    if (!source.url) return true;
    const url = new URL(source.url);
    if (!isHistoricalVersionLink(source.title, url)) return true;
    const family = agreementVersionFamily(source.title, url);
    return !family || !currentFamilies.has(family);
  }).slice(0, maxDocuments);
  const normalizedPageUrl = currentPageUrl ? new URL(currentPageUrl) : undefined;
  const rootDocuments = await Promise.all(roots.map((source) => {
    let useRenderedHtml: string | undefined;
    if (renderedHtml && source.url && normalizedPageUrl) {
      const sourceUrl = new URL(source.url);
      if (sourceUrl.href === normalizedPageUrl.href) useRenderedHtml = renderedHtml;
    }
    return loadSource(source, useRenderedHtml);
  }));
  // linkedSources is deliberately retained as an index of references. The
  // referenced pages are not fetched here: an Agent may decide that a link is
  // relevant and let an analysis Agent read it later through read_source.
  return rootDocuments.map((document, index) => ({
    ...document,
    sourceRole: roots[index]?.relation === "direct" ? "related" as const : "root" as const,
    ...(roots[index]?.parentSourceId ? { parentSourceId: roots[index].parentSourceId } : {}),
    ...(roots[index]?.parentSectionId ? { parentSectionId: roots[index].parentSectionId } : {})
  }));
}
const agreementLinkKeywords = [
  "协议", "条款", "隐私", "privacy", "cookie", "cookies", "terms", "conditions",
  "user agreement", "service agreement", "subscription", "auto-renew", "自动续费",
  "规范", "community guidelines", "法律声明", "个人信息保护", "个人信息处理",
  "数据保护", "数据须知", "收集使用信息", "账号注销"
];

function matchesAgreementLink(value: string): boolean {
  const normalized = value
    .replace(/\u00a0/g, " ")
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/\s+/g, " ")
    .toLocaleLowerCase();
  return agreementLinkKeywords.some((keyword) => normalized.includes(keyword));
}
