import type { PageSnapshot } from "./types";
import { resolveAgreementLinksFromLoadedScripts, resolveDynamicAgreementLinks } from "./dynamic-discovery";
import { setTabBadge as updateTabBadge } from "./tab-badge";
import { mergeDiscoveredSources } from "./frame-discovery";
import { needsRenderedFallback, visibleTextLength } from "./html-readiness";

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);

const MAX_HTML_BYTES = 2_000_000;
const MAX_PDF_BYTES = 8_000_000;
const MAX_BROWSER_SOURCES = 8;
const DIRECT_HTML_TIMEOUT_MS = 20_000;

interface BrowserSourceRequest {
  id: string;
  title: string;
  url: string;
  kind: "url" | "pdf";
  relation?: "primary" | "direct" | "manual";
}

interface CapturedAgreementLink {
  title: string;
  url: string;
}

interface CapturedRenderedPage {
  html: string;
  title: string;
  url: string;
  textLength: number;
  links: CapturedAgreementLink[];
}

interface BrowserFetchedSource extends BrowserSourceRequest {
  renderedHtml?: string;
  dataBase64?: string;
  textLength?: number;
  error?: string;
  linkedSources: CapturedAgreementLink[];
}

type FrameDiscoveryRecord = Omit<PageSnapshot, "tabId" | "pendingRecheck">;

const discoveryUpdates = new Map<number, Promise<PageSnapshot | null>>();
let existingPageMigration: Promise<void> | undefined;

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

async function waitForTab(tabId: number, timeoutMs = 8_000): Promise<boolean> {
  const current = await chrome.tabs.get(tabId);
  if (current.status === "complete") return true;
  return new Promise<boolean>((resolve) => {
    const finish = (completed: boolean) => {
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timeout);
      resolve(completed);
    };
    const timeout = setTimeout(() => finish(false), timeoutMs);
    const listener = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
      finish(true);
    };
    chrome.tabs.onUpdated.addListener(listener);
    void chrome.tabs.get(tabId).then((tab) => {
      if (tab.status !== "complete") return;
      finish(true);
    }).catch(() => undefined);
  });
}

async function waitForOpenedTabUrl(tabId: number, timeoutMs = 5_000): Promise<string | undefined> {
  const readUrl = async (): Promise<string | undefined> => {
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    return tab?.url?.startsWith("http") ? tab.url : undefined;
  };
  const initialUrl = await readUrl();
  if (initialUrl) return initialUrl;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (url?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(url);
    };
    const timeout = setTimeout(() => {
      void readUrl().then((url) => finish(url));
    }, timeoutMs);
    const listener = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId !== tabId || !changeInfo.url) return;
      void readUrl().then((url) => {
        if (url) finish(url);
      });
    };
    chrome.tabs.onUpdated.addListener(listener);
    void readUrl().then((url) => {
      if (url) finish(url);
    });
  });
}

async function captureRenderedTab(tabId: number): Promise<CapturedRenderedPage> {
  type CaptureTarget = { tabId: number; allFrames?: boolean; frameIds?: number[] };
  type RenderedFrameResult = {
    html: string;
    textLength: number;
    title: string;
    url: string;
    links: CapturedAgreementLink[];
  };
  const capture = async (target: CaptureTarget): Promise<Array<{ result?: unknown }>> => chrome.scripting.executeScript({
    target,
    func: async () => {
      const visibleTextLength = () => {
        const renderedText = document.body?.innerText?.replace(/\s+/g, " ").trim();
        if (renderedText) return renderedText.length;
        const clone = document.documentElement.cloneNode(true) as HTMLElement;
        clone.querySelectorAll("script,style,noscript,template").forEach((node) => node.remove());
        return (clone.textContent ?? "").replace(/\s+/g, " ").trim().length;
      };
      const startedAt = Date.now();
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const textLength = visibleTextLength();
        const elapsed = Date.now() - startedAt;
        // A readable agreement is more valuable than a perfectly idle page.
        // Sites with timers or analytics can keep mutating their DOM forever.
        if (textLength >= 300 && elapsed >= 500) break;
        if (textLength >= 80 && (document.readyState === "complete" || elapsed >= 4_000)) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      const clone = document.documentElement.cloneNode(true) as HTMLElement;
      clone.querySelectorAll("script,style,noscript,iframe,input,textarea,select,button,template").forEach((node) => node.remove());
      clone.querySelectorAll("*").forEach((node) => {
        for (const attribute of [...node.attributes]) {
          if (/^on/i.test(attribute.name) || ["value", "srcdoc"].includes(attribute.name)) node.removeAttribute(attribute.name);
        }
      });
      const keywords = [
        "协议", "条款", "隐私", "privacy", "cookie", "cookies", "terms", "conditions",
        "user agreement", "service agreement", "subscription", "auto-renew", "自动续费",
        "社区规范", "community guidelines", "法律声明", "个人信息保护", "个人信息处理",
        "数据保护", "数据须知", "收集使用信息", "账号注销"
      ];
      const normalize = (value: string) => value
        .replace(/\u00a0/g, " ")
        .replace(/[\u2010-\u2015]/g, "-")
        .replace(/\s+/g, " ")
        .trim()
        .toLocaleLowerCase();
      const links = [...document.querySelectorAll<HTMLAnchorElement>("a[href],area[href]")]
        .map((link) => {
          const title = normalize(link.innerText || link.textContent || link.title || link.getAttribute("aria-label") || "");
          try {
            const target = new URL(link.href, location.href);
            const matchValue = `${title} ${target.pathname} ${target.hash}`;
            const historical = /历史版本|历史条款|旧版|上一版|previous|histor(?:y|ical)|archive|archived/i.test(matchValue)
              || /(?:^|[/_-])old(?:[/_-]|$)/i.test(`${target.pathname}${target.search}`);
            const interactive = /\/(?:oauth2?|authorize|signin|sign-in|login)(?:\/|$)/i.test(`${target.hostname}${target.pathname}`)
              || ["client_id", "redirect_uri", "response_type"].some((name) => target.searchParams.has(name));
            return ["http:", "https:"].includes(target.protocol)
              && keywords.some((keyword) => matchValue.includes(keyword))
              && !historical
              && !interactive
              ? { title: link.innerText?.replace(/\s+/g, " ").trim() || link.textContent?.replace(/\s+/g, " ").trim() || "关联规则", url: target.href }
              : undefined;
          } catch {
            return undefined;
          }
        })
        .filter((item): item is { title: string; url: string } => Boolean(item));
      return {
        html: clone.outerHTML.slice(0, 2_000_000),
        textLength: visibleTextLength(),
        title: document.title || location.hostname,
        url: location.href,
        links
      };
    }
  });
  let rendered: Array<{ result?: unknown }> = [];
  try {
    // Read the top-level document first. An unrelated slow iframe must not
    // hold up a complete agreement document in the main frame.
    rendered = await capture({ tabId });
  } catch {
    try {
      const frames = await chrome.webNavigation.getAllFrames({ tabId });
      const frameResults = await Promise.allSettled(
        (frames ?? []).map((frame) => capture({ tabId, frameIds: [frame.frameId] }))
      );
      rendered = frameResults
        .flatMap((item) => item.status === "fulfilled" ? item.value : []);
    } catch {
      rendered = await capture({ tabId });
    }
  }
  let candidates = rendered
    .map((entry) => entry.result)
    .filter((entry): entry is RenderedFrameResult =>
      Boolean(entry && typeof entry === "object"
        && typeof (entry as { html?: unknown }).html === "string"
        && typeof (entry as { textLength?: unknown }).textLength === "number"));
  if ((candidates.sort((left, right) => right.textLength - left.textLength)[0]?.textLength ?? 0) < 80) {
    try {
      const frameResults = await capture({ tabId, allFrames: true });
      candidates = [
        ...candidates,
        ...frameResults.flatMap((entry) => entry.result ? [entry.result] : [])
      ]
        .filter((entry): entry is RenderedFrameResult =>
          Boolean(entry && typeof entry === "object"
            && typeof (entry as { html?: unknown }).html === "string"
            && typeof (entry as { textLength?: unknown }).textLength === "number"));
    } catch {
      // Keep the first capture result; the caller will report a useful empty-body error.
    }
  }
  const candidate = candidates.sort((left, right) => right.textLength - left.textLength)[0];
  const html = candidate?.html ?? "";
  if (!html) throw new Error("当前来源页面没有返回 HTML");
  const textLength = candidate?.textLength ?? 0;
  if (textLength < 80) {
    throw new Error(`页面完成渲染后仍未取得正文（仅 ${textLength} 字）`);
  }
  const links = candidates
    .flatMap((result) => result.links ?? [])
    .filter((item, index, all) => all.findIndex((other) => other.url === item.url) === index)
    .slice(0, MAX_BROWSER_SOURCES);
  console.info("[agreement-lens] captured rendered frame", {
    tabId,
    frameCount: rendered.length,
    textLength: candidate?.textLength ?? 0,
    htmlLength: html.length
  });
  return {
    html,
    title: candidate?.title ?? "",
    url: candidate?.url ?? "",
    textLength,
    links
  };
}

async function currentTabId(preferredTabId?: number): Promise<number | undefined> {
  if (preferredTabId !== undefined) {
    try {
      const tab = await chrome.tabs.get(preferredTabId);
      if (tab.id && tab.url) return tab.id;
    } catch {
      // The page may have been closed while the side panel was open.
    }
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

async function fetchCurrentTabSource(
  source: BrowserSourceRequest,
  preferredTabId?: number
): Promise<BrowserFetchedSource | undefined> {
  if (source.kind === "pdf") return undefined;
  const tabId = await currentTabId(preferredTabId);
  if (!tabId) return undefined;
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (!tab?.url || !samePageUrl(tab.url, source.url)) return undefined;
  try {
    const captured = await captureRenderedTab(tabId);
    if (captured.html.length > MAX_HTML_BYTES) throw new Error("当前页面超过 2 MB");
    console.info("[agreement-lens] captured rendered current tab", {
      sourceUrl: source.url,
      tabId,
      textLength: captured.textLength,
      htmlLength: captured.html.length
    });
    return {
      ...source,
      renderedHtml: captured.html,
      textLength: captured.textLength,
      linkedSources: captured.links
    };
  } catch (error) {
    console.warn("[agreement-lens] failed to capture rendered current tab", {
      sourceUrl: source.url,
      tabId,
      error: error instanceof Error ? error.message : String(error)
    });
    return undefined;
  }
}

async function fetchStaticHtmlSource(
  source: BrowserSourceRequest,
  startedAt: number
): Promise<BrowserFetchedSource | undefined> {
  try {
    const response = await fetch(source.url, {
      credentials: "include",
      redirect: "follow",
      signal: AbortSignal.timeout(DIRECT_HTML_TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`来源返回 HTTP ${response.status}`);
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType && !contentType.includes("html") && !contentType.includes("xhtml")) {
      throw new Error(`来源不是 HTML 页面（${contentType}）`);
    }
    const html = await response.text();
    if (!html) throw new Error("来源返回空白页面");
    if (html.length > MAX_HTML_BYTES) throw new Error("页面超过 2 MB");
    const textLength = visibleTextLength(html);
    if (textLength < 80) throw new Error(`静态正文过短（仅 ${textLength} 字）`);
    if (needsRenderedFallback(html)) {
      console.info("[agreement-lens] static source needs rendered fallback", {
        sourceId: source.id,
        sourceUrl: source.url,
        responseUrl: response.url,
        textLength
      });
      return undefined;
    }
    console.info("[agreement-lens] browser source fetched directly", {
      sourceId: source.id,
      sourceUrl: source.url,
      responseUrl: response.url,
      textLength,
      htmlLength: html.length,
      elapsedMs: Date.now() - startedAt
    });
    return {
      ...source,
      renderedHtml: html,
      textLength,
      linkedSources: []
    };
  } catch (error) {
    console.info("[agreement-lens] direct source fetch unavailable; using rendered fallback", {
      sourceId: source.id,
      sourceUrl: source.url,
      elapsedMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error)
    });
    return undefined;
  }
}

async function fetchRenderedSource(
  source: BrowserSourceRequest,
  preferredTabId?: number
): Promise<BrowserFetchedSource> {
  const startedAt = Date.now();
  console.info("[agreement-lens] fetching browser source", {
    sourceId: source.id,
    sourceUrl: source.url
  });
  const currentTabSource = await fetchCurrentTabSource(source, preferredTabId);
  if (currentTabSource) {
    console.info("[agreement-lens] browser source read from current tab", {
      sourceId: source.id,
      sourceUrl: source.url,
      elapsedMs: Date.now() - startedAt
    });
    return currentTabSource;
  }

  if (source.kind === "pdf") {
    try {
      const response = await fetch(source.url, {
        credentials: "include",
        redirect: "follow",
        signal: AbortSignal.timeout(12_000)
      });
      if (!response.ok) throw new Error(`来源返回 HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > MAX_PDF_BYTES) throw new Error("PDF 超过 8 MB");
      console.info("[agreement-lens] browser source fetched as PDF", {
        sourceId: source.id,
        sourceUrl: source.url,
        elapsedMs: Date.now() - startedAt
      });
      return { ...source, dataBase64: base64FromBytes(bytes), linkedSources: [] as CapturedAgreementLink[] };
    } catch (error) {
      return {
        ...source,
        error: error instanceof Error ? error.message : "浏览器无法读取 PDF",
        linkedSources: [] as CapturedAgreementLink[]
      };
    }
  }

  const directlyFetchedSource = await fetchStaticHtmlSource(source, startedAt);
  if (directlyFetchedSource) return directlyFetchedSource;

  let tabId: number | undefined;
  try {
    console.info("[agreement-lens] opening browser source tab", {
      sourceId: source.id,
      sourceUrl: source.url
    });
    const tab = await chrome.tabs.create({ url: source.url, active: false });
    if (!tab.id) throw new Error("无法打开来源页面");
    tabId = tab.id;
    console.info("[agreement-lens] browser source tab opened", {
      sourceId: source.id,
      sourceUrl: source.url,
      tabId,
      status: tab.status
    });
    if (tab.status !== "complete") {
      const completed = await waitForTab(tab.id);
      if (!completed) {
        console.info("[agreement-lens] source tab stayed loading; capturing current DOM", {
          sourceId: source.id,
          sourceUrl: source.url,
          tabId
        });
      }
    }
    console.info("[agreement-lens] browser source tab ready for capture", {
      sourceId: source.id,
      sourceUrl: source.url,
      tabId
    });
    const captured = await captureRenderedTab(tabId);
    console.info("[agreement-lens] captured rendered source", {
      sourceUrl: source.url,
      capturedUrl: captured.url,
      tabId,
      textLength: captured.textLength,
      htmlLength: captured.html.length
    });
    return captured.html && captured.html.length <= MAX_HTML_BYTES
      ? { ...source, renderedHtml: captured.html, textLength: captured.textLength, linkedSources: captured.links }
      : { ...source, error: "页面正文为空或超过 2 MB", linkedSources: [] as CapturedAgreementLink[] };
  } catch (error) {
    const result = {
      ...source,
      error: error instanceof Error ? error.message : "浏览器无法读取来源",
      linkedSources: [] as CapturedAgreementLink[]
    };
    console.warn("[agreement-lens] browser source failed", {
      sourceId: source.id,
      sourceUrl: source.url,
      elapsedMs: Date.now() - startedAt,
      error: result.error
    });
    return result;
  } finally {
    if (tabId !== undefined) await chrome.tabs.remove(tabId).catch(() => undefined);
  }
}

async function fetchSourceGraphInBrowser(
  roots: BrowserSourceRequest[],
  preferredTabId?: number
) {
  const queued = roots.slice(0, MAX_BROWSER_SOURCES);
  const results: BrowserFetchedSource[] = [];
  while (queued.length && results.length < MAX_BROWSER_SOURCES) {
    // Some agreement pages use global singleton scripts and behave badly when
    // several hidden tabs render the same document at once. Read sources
    // serially so one page cannot stall the whole analysis batch.
    const source = queued.shift();
    if (!source) continue;
    const acquired = await fetchRenderedSource(source, preferredTabId);
    results.push(acquired);
  }
  return results;
}

async function maybeRecheck(payload: PageSnapshot) {
  const host = new URL(payload.pageUrl).hostname.replace(/^www\./, "");
  const local = await chrome.storage.local.get(["pairToken", "savedServices"]);
  const serviceId = (local.savedServices as Record<string, string> | undefined)?.[host];
  if (!serviceId || !local.pairToken) return payload;
  const marker = `rechecked:${payload.tabId}:${payload.pageUrl}`;
  if ((await chrome.storage.session.get(marker))[marker]) return payload;
  await chrome.storage.session.set({ [marker]: true });
  try {
    const response = await fetch(`http://127.0.0.1:4317/v1/services/${encodeURIComponent(serviceId)}/recheck`, {
      method: "POST",
      headers: { authorization: `Bearer ${local.pairToken}`, "content-type": "application/json" }
    });
    if (!response.ok) return payload;
    const pendingRecheck = await response.json() as { analysisId: string; jobId: string };
    await updateTabBadge(chrome, payload.tabId, "…", "#9b6c24");
    return { ...payload, pendingRecheck };
  } catch {
    return payload;
  }
}

async function scanTab(tabId: number) {
  const scanFrame = async (frameId: number) => {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ["content.js"] });
    await chrome.tabs.sendMessage(tabId, { type: "SCAN_PAGE" }, { frameId });
  };
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => [{ frameId: 0 }]);
    const frameIds = [...new Set((frames ?? []).map((frame) => frame.frameId))];
    await scanFrame(0);
    await Promise.all(frameIds.filter((frameId) => frameId !== 0).map((frameId) =>
      scanFrame(frameId).catch((error) => {
        console.info("[agreement-lens] skipped inaccessible frame", {
          tabId,
          frameId,
          error: error instanceof Error ? error.message : String(error)
        });
      })
    ));
  } catch (error) {
    console.warn("[agreement-lens] page scan failed", {
      tabId,
      error: error instanceof Error ? error.message : String(error)
    });
    await updateTabBadge(chrome, tabId, "?", "#69726d");
  }
}

function samePageUrl(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    if (leftUrl.hash && !/^#(?:!\/|\/)/.test(leftUrl.hash)) leftUrl.hash = "";
    if (rightUrl.hash && !/^#(?:!\/|\/)/.test(rightUrl.hash)) rightUrl.hash = "";
    return leftUrl.href === rightUrl.href;
  } catch {
    return left === right;
  }
}

async function migrateExistingPageContentScripts(): Promise<void> {
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  let injected = 0;
  for (const tab of tabs) {
    if (!tab.id || !tab.url) continue;
    let origin: string;
    try {
      origin = new URL(tab.url).origin + "/*";
    } catch {
      continue;
    }
    const allowed = await chrome.permissions.contains({ origins: [origin] }).catch(() => false);
    if (!allowed) continue;
    try {
      // Reinject into tabs that survived an extension reload. The current
      // script disposes newer controllers and reloads pages with legacy
      // scripts that have no way to unregister their listeners.
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content.js"]
      });
      injected += 1;
    } catch (error) {
      console.info("[agreement-lens] existing page migration skipped", {
        tabId: tab.id,
        url: tab.url,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  console.info("[agreement-lens] existing page content scripts migrated", {
    tabCount: tabs.length,
    injected
  });
}

function queueExistingPageContentScriptMigration(): void {
  if (existingPageMigration) return;
  existingPageMigration = migrateExistingPageContentScripts().catch((error) => {
    console.info("[agreement-lens] existing page migration unavailable", {
      error: error instanceof Error ? error.message : String(error)
    });
  });
}

chrome.action.onClicked.addListener((tab) => {
  if (tab.id) void scanTab(tab.id);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "loading" || changeInfo.url) {
    void chrome.storage.session.remove([`page:${tabId}`, `pageFrames:${tabId}`]);
  }
  if (changeInfo.status !== "complete" || !tab.url?.startsWith("http")) return;
  const origin = new URL(tab.url).origin + "/*";
  chrome.permissions.contains({ origins: [origin] }, (allowed) => {
    if (allowed) void scanTab(tabId);
  });
});

chrome.webNavigation.onDOMContentLoaded.addListener((details) => {
  if (details.frameId === 0 || !details.url.startsWith("http")) return;
  const origin = new URL(details.url).origin + "/*";
  chrome.permissions.contains({ origins: [origin] }, (allowed) => {
    if (!allowed) return;
    void chrome.scripting.executeScript({
      target: { tabId: details.tabId, frameIds: [details.frameId] },
      files: ["content.js"]
    }).then(() => chrome.tabs.sendMessage(
      details.tabId,
      { type: "SCAN_PAGE" },
      { frameId: details.frameId }
    )).catch((error) => {
      console.info("[agreement-lens] dynamic frame scan skipped", {
        tabId: details.tabId,
        frameId: details.frameId,
        url: details.url,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  });
});

async function updatePageDiscovery(
  incoming: PageSnapshot,
  frameId: number
): Promise<PageSnapshot | null> {
  const tab = await chrome.tabs.get(incoming.tabId);
  if (!tab.url?.startsWith("http")) return null;
  if (frameId === 0) {
    if (!samePageUrl(tab.url, incoming.pageUrl)) return null;
  } else {
    const frame = await chrome.webNavigation.getFrame({ tabId: incoming.tabId, frameId }).catch(() => null);
    if (!frame || !samePageUrl(frame.url, incoming.pageUrl)) return null;
  }

  const framesKey = `pageFrames:${incoming.tabId}`;
  const pageKey = `page:${incoming.tabId}`;
  const stored = await chrome.storage.session.get([framesKey, pageKey]);
  const previousPage = stored[pageKey] as PageSnapshot | undefined;
  let records = {
    ...((stored[framesKey] as Record<string, FrameDiscoveryRecord> | undefined) ?? {})
  };
  const previousTop = records["0"];
  if ((previousTop && !samePageUrl(previousTop.pageUrl, tab.url))
    || (previousPage && !samePageUrl(previousPage.pageUrl, tab.url))) records = {};
  records[String(frameId)] = {
    pageUrl: incoming.pageUrl,
    pageTitle: incoming.pageTitle,
    origin: incoming.origin,
    sources: incoming.sources,
    scannedAt: incoming.scannedAt
  };

  const liveFrames = await chrome.webNavigation.getAllFrames({ tabId: incoming.tabId }).catch(() => []);
  const liveById = new Map((liveFrames ?? []).map((frame) => [String(frame.frameId), frame.url]));
  for (const [id, record] of Object.entries(records)) {
    if (id === "0") continue;
    const liveUrl = liveById.get(id);
    if (!liveUrl || !samePageUrl(liveUrl, record.pageUrl)) delete records[id];
  }

  const top = records["0"];
  const orderedRecords = Object.entries(records)
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([, record]) => record);
  const payload: PageSnapshot = {
    tabId: incoming.tabId,
    pageUrl: tab.url,
    pageTitle: top?.pageTitle || tab.title || incoming.pageTitle,
    origin: new URL(tab.url).origin,
    sources: mergeDiscoveredSources(orderedRecords.map((record) => record.sources)),
    scannedAt: incoming.scannedAt,
    pendingRecheck: previousPage?.pendingRecheck
  };
  await chrome.storage.session.set({ [framesKey]: records });
  return frameId === 0 && !payload.pendingRecheck ? maybeRecheck(payload) : payload;
}

function queuePageDiscovery(incoming: PageSnapshot, frameId: number): Promise<PageSnapshot | null> {
  const previous = discoveryUpdates.get(incoming.tabId) ?? Promise.resolve(null);
  const current = previous
    .catch(() => null)
    .then(() => updatePageDiscovery(incoming, frameId));
  discoveryUpdates.set(incoming.tabId, current);
  void current.finally(() => {
    if (discoveryUpdates.get(incoming.tabId) === current) discoveryUpdates.delete(incoming.tabId);
  });
  return current;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "RESOLVE_DYNAMIC_AGREEMENT_LINKS") {
    if (!sender.tab?.id) {
      sendResponse({ links: [] });
      return;
    }
    const tabId = sender.tab.id;
    const frameId = sender.frameId ?? 0;
    const openedTabs = new Map<number, string | undefined>();
    const onCreated = (tab: chrome.tabs.Tab) => {
      if (tab.id !== undefined && tab.openerTabId === tabId) openedTabs.set(tab.id, tab.url);
    };
    chrome.tabs.onCreated.addListener(onCreated);
    void chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: "MAIN",
      func: resolveDynamicAgreementLinks
    }).then(async ([result]) => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      chrome.tabs.onCreated.removeListener(onCreated);
      const recordsResult = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        world: "MAIN",
        func: () => {
          const runtimeWindow = window as Window & {
            __agreementLensDynamicClickRecords?: Array<{ title: string; captured: string[] }>;
          };
          const records = runtimeWindow.__agreementLensDynamicClickRecords ?? [];
          delete runtimeWindow.__agreementLensDynamicClickRecords;
          return records;
        }
      }).catch(() => [{ result: [] as Array<{ title: string; captured: string[] }> }]);
      const records = recordsResult[0]?.result ?? [];
      const openedTabIds = [...openedTabs.keys()];
      const openedUrls = await Promise.all(openedTabIds.map(async (openedTabId) =>
        (await waitForOpenedTabUrl(openedTabId)) ?? openedTabs.get(openedTabId)
      ));
      await Promise.all(openedTabIds.map((openedTabId) => chrome.tabs.remove(openedTabId).catch(() => undefined)));
      const fallbackLinks = records
        .filter((record) => record.title && record.captured.length === 0)
        .map((record, index) => {
          const url = openedUrls[index];
          if (!url) return undefined;
          return { title: record.title, url };
        })
        .filter((item): item is { title: string; url: string } => Boolean(item));
      const resolvedLinks = [...((result?.result ?? []) as Array<{ title: string; url: string }>), ...fallbackLinks];
      const unresolvedLabels = records
        .map((record) => record.title)
        .filter((title) => title && !resolvedLinks.some((link) => link.title === title));
      const scriptLinks = unresolvedLabels.length
        ? await chrome.scripting.executeScript({
            target: { tabId, frameIds: [frameId] },
            world: "MAIN",
            func: resolveAgreementLinksFromLoadedScripts,
            args: [unresolvedLabels]
          }).then(([scriptResult]) => scriptResult?.result ?? []).catch(() => [])
        : [];
      const links = [...resolvedLinks, ...scriptLinks]
        .filter((item, index, all) => all.findIndex((candidate) => candidate.url === item.url) === index);
      console.info("[agreement-lens] dynamic discovery completed", {
        tabId,
        frameId,
        links,
        openedTabCount: openedTabIds.length,
        clickRecords: records
      });
      sendResponse({ links });
    }).catch((error) => {
      chrome.tabs.onCreated.removeListener(onCreated);
      for (const openedTabId of openedTabs.keys()) void chrome.tabs.remove(openedTabId).catch(() => undefined);
      console.warn("[agreement-lens] dynamic discovery failed", {
        tabId,
        frameId,
        error: error instanceof Error ? error.message : String(error)
      });
      sendResponse({ links: [] });
    });
    return true;
  }
  if (message.type === "PAGE_DISCOVERED") {
    const incoming = { ...message.payload, tabId: sender.tab?.id ?? message.payload.tabId } as PageSnapshot;
    void queuePageDiscovery(incoming, sender.frameId ?? 0).then(async (payload) => {
      if (!payload) {
        sendResponse({ ok: false, stale: true });
        return;
      }
      await chrome.storage.session.set({ [`page:${payload.tabId}`]: payload, latestPage: payload });
      void chrome.runtime.sendMessage({ type: "PAGE_STATE_UPDATED", payload }).catch(() => undefined);
      const count = payload.sources.length;
      if (payload.tabId >= 0 && !payload.pendingRecheck) {
        void updateTabBadge(chrome, payload.tabId, count ? String(count) : "", count ? "#c7482d" : "#69726d");
      }
      sendResponse({ ok: true, payload });
    }).catch(() => sendResponse({ ok: false, stale: true }));
    return true;
  }
  if (message.type === "GET_PAGE_STATE") {
    chrome.tabs.query({ active: true, currentWindow: true }, async ([tab]) => {
      if (!tab?.id) return sendResponse(null);
      const stored = await chrome.storage.session.get(`page:${tab.id}`);
      const snapshot = stored[`page:${tab.id}`] as PageSnapshot | undefined;
      sendResponse(snapshot && samePageUrl(snapshot.pageUrl, tab.url) ? snapshot : null);
    });
    return true;
  }
  if (message.type === "FETCH_AGREEMENT_SOURCES") {
    const tabId = message.tabId;
    void fetchSourceGraphInBrowser(message.sources.slice(0, MAX_BROWSER_SOURCES) as BrowserSourceRequest[], tabId)
      .then((sources) => sendResponse({ ok: true, sources }))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : "来源读取失败" }));
    return true;
  }
});

// A service-worker restart does not refresh pages that already contain an old
// content script. Run this once per worker lifetime so extension reloads clean
// up those pages without injecting on every message.
queueExistingPageContentScriptMigration();
