import type { PageSnapshot } from "./types";
import { resolveDynamicAgreementLinks } from "./dynamic-discovery";
import { needsRenderedFallback } from "./html-readiness";
import { setTabBadge as updateTabBadge } from "./tab-badge";

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);

const MAX_HTML_BYTES = 2_000_000;
const MAX_PDF_BYTES = 8_000_000;

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

async function waitForTab(tabId: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("来源页面加载超时"));
    }, 15_000);
    const listener = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function fetchRenderedSource(source: { id: string; url: string; kind: "url" | "pdf" }) {
  let lastError = "浏览器无法读取来源";
  try {
    const response = await fetch(source.url, {
      credentials: "include",
      redirect: "follow",
      signal: AbortSignal.timeout(12_000)
    });
    if (response.ok) {
      const contentType = response.headers.get("content-type") ?? "";
      if (source.kind === "pdf" || contentType.includes("pdf") || /\.pdf(?:$|\?)/i.test(source.url)) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length <= MAX_PDF_BYTES) {
          return { id: source.id, dataBase64: base64FromBytes(bytes) };
        }
        lastError = "PDF 超过 8 MB";
      } else {
        const html = await response.text();
        if (html.length <= MAX_HTML_BYTES && !needsRenderedFallback(html)) {
          return { id: source.id, renderedHtml: html };
        }
        lastError = html.length > MAX_HTML_BYTES ? "页面超过 2 MB" : "页面是动态渲染空壳";
      }
    } else {
      lastError = `来源返回 HTTP ${response.status}`;
    }
  } catch (error) {
    lastError = error instanceof Error ? error.message : lastError;
  }

  if (source.kind === "pdf") return { id: source.id, error: lastError };

  let tabId: number | undefined;
  try {
    const tab = await chrome.tabs.create({ url: source.url, active: false });
    if (!tab.id) throw new Error("无法打开来源页面");
    tabId = tab.id;
    if (tab.status !== "complete") await waitForTab(tab.id);
    const [rendered] = await chrome.scripting.executeScript({
      target: { tabId },
      func: async () => {
        const textLength = () => {
          const clone = document.documentElement.cloneNode(true) as HTMLElement;
          clone.querySelectorAll("script,style,noscript,template").forEach((node) => node.remove());
          return (clone.textContent ?? "").replace(/\s+/g, " ").trim().length;
        };
        for (let attempt = 0; attempt < 20 && textLength() < 300; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        const clone = document.documentElement.cloneNode(true) as HTMLElement;
        clone.querySelectorAll("script,style,noscript,iframe,input,textarea,select,button,template").forEach((node) => node.remove());
        clone.querySelectorAll("*").forEach((node) => {
          for (const attribute of [...node.attributes]) {
            if (/^on/i.test(attribute.name) || ["value", "srcdoc"].includes(attribute.name)) node.removeAttribute(attribute.name);
          }
        });
        return clone.outerHTML.slice(0, 2_000_000);
      }
    });
    const html = typeof rendered?.result === "string" ? rendered.result : "";
    return html && html.length <= MAX_HTML_BYTES
      ? { id: source.id, renderedHtml: html }
      : { id: source.id, error: "页面正文为空或超过 2 MB" };
  } catch (error) {
    return { id: source.id, error: error instanceof Error ? error.message : lastError };
  } finally {
    if (tabId !== undefined) await chrome.tabs.remove(tabId).catch(() => undefined);
  }
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
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    await chrome.tabs.sendMessage(tabId, { type: "SCAN_PAGE" });
  } catch {
    await updateTabBadge(chrome, tabId, "?", "#69726d");
  }
}

chrome.action.onClicked.addListener((tab) => {
  if (tab.id) void scanTab(tab.id);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab.url?.startsWith("http")) return;
  const origin = new URL(tab.url).origin + "/*";
  chrome.permissions.contains({ origins: [origin] }, (allowed) => {
    if (allowed) void scanTab(tabId);
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "RESOLVE_DYNAMIC_AGREEMENT_LINKS") {
    if (!sender.tab?.id) {
      sendResponse({ links: [] });
      return;
    }
    void chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      world: "MAIN",
      func: resolveDynamicAgreementLinks
    }).then(([result]) => sendResponse({ links: result?.result ?? [] }))
      .catch(() => sendResponse({ links: [] }));
    return true;
  }
  if (message.type === "PAGE_DISCOVERED") {
    const incoming = { ...message.payload, tabId: sender.tab?.id ?? message.payload.tabId } as PageSnapshot;
    void maybeRecheck(incoming).then((payload) => {
      void chrome.storage.session.set({ [`page:${payload.tabId}`]: payload, latestPage: payload });
      void chrome.runtime.sendMessage({ type: "PAGE_STATE_UPDATED", payload }).catch(() => undefined);
      const count = payload.sources.length;
      if (payload.tabId >= 0 && !payload.pendingRecheck) {
        void updateTabBadge(chrome, payload.tabId, count ? String(count) : "", count ? "#c7482d" : "#69726d");
      }
      sendResponse({ ok: true });
    });
    return true;
  }
  if (message.type === "GET_PAGE_STATE") {
    chrome.tabs.query({ active: true, currentWindow: true }, async ([tab]) => {
      if (!tab?.id) return sendResponse(null);
      const stored = await chrome.storage.session.get(`page:${tab.id}`);
      sendResponse(stored[`page:${tab.id}`] ?? null);
    });
    return true;
  }
  if (message.type === "FETCH_AGREEMENT_SOURCES") {
    void Promise.all(message.sources.slice(0, 8).map(fetchRenderedSource))
      .then((sources) => sendResponse({ ok: true, sources }))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : "来源读取失败" }));
    return true;
  }
});
