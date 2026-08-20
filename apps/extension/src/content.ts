import { discoverAgreementSources, sanitizedRenderedHtml } from "./discovery";
import { highlightEvidence } from "./evidence-highlight";
import { hasLiveExtensionContext, isExtensionContextInvalidated } from "./extension-context";

async function collectSources(isActive: () => boolean) {
  const sources = discoverAgreementSources(document, location.href);
  for (const delay of [0, 300, 900]) {
    if (delay) await new Promise((resolve) => window.setTimeout(resolve, delay));
    if (!isActive() || !hasLiveExtensionContext()) throw new Error("Extension context invalidated.");
    try {
      const response = await chrome.runtime.sendMessage({ type: "RESOLVE_DYNAMIC_AGREEMENT_LINKS" }) as {
        links?: Array<{ title: string; url: string }>;
      };
      const seen = new Set(sources.map((source) => source.url));
      for (const link of response.links ?? []) {
        if (seen.has(link.url)) continue;
        seen.add(link.url);
        sources.push({
          id: crypto.randomUUID(),
          kind: /\.pdf(?:$|\?)/i.test(link.url) ? "pdf" : "url",
          title: link.title,
          url: link.url,
          selected: true,
          relation: "primary"
        });
      }
      if (response.links?.length || sources.length) break;
    } catch (error) {
      if (isExtensionContextInvalidated(error) || !hasLiveExtensionContext()) throw error;
      console.warn("[agreement-lens] dynamic discovery request failed", error);
    }
  }
  return sources.slice(0, 12);
}

async function publishDiscovery(
  sources: ReturnType<typeof discoverAgreementSources>,
  isActive: () => boolean
) {
  if (!isActive() || !hasLiveExtensionContext()) throw new Error("Extension context invalidated.");
  await chrome.runtime.sendMessage({
    type: "PAGE_DISCOVERED",
    payload: {
      tabId: -1,
      pageUrl: location.href,
      pageTitle: document.title || location.hostname,
      origin: location.origin,
      sources,
      scannedAt: new Date().toISOString()
    }
  });
}

const runtimeWindow = window as Window & {
  __agreementLensContentController?: {
    dispose: () => void;
  };
};

runtimeWindow.__agreementLensContentController?.dispose();

{
  let disposed = false;
  let lastSignature = "";
  let timer: number | undefined;
  let observer: MutationObserver | undefined;
  const isActive = () => !disposed;
  const stop = () => {
    if (disposed) return;
    disposed = true;
    if (timer !== undefined) window.clearTimeout(timer);
    observer?.disconnect();
    window.removeEventListener("popstate", scheduleScan);
    window.removeEventListener("hashchange", scheduleScan);
    document.removeEventListener("click", handleDocumentClick, true);
    try {
      chrome.runtime.onMessage.removeListener(handleMessage);
    } catch {
      // The old content-script world cannot access chrome.runtime after reload.
    }
  };
  const handleFailure = (error: unknown) => {
    if (isExtensionContextInvalidated(error) || !hasLiveExtensionContext()) {
      stop();
      return;
    }
    console.warn("[agreement-lens] page discovery failed", error);
  };
  const sendDiscovery = async () => {
    const sources = await collectSources(isActive);
    if (!isActive()) return 0;
    await publishDiscovery(sources, isActive);
    return sources.length;
  };
  const scanIfChanged = async () => {
    const sources = await collectSources(isActive);
    if (!isActive()) return;
    const signature = sources.map((source) => `${source.title}|${source.url}`).join("\n");
    if (signature === lastSignature) return;
    lastSignature = signature;
    await publishDiscovery(sources, isActive);
  };
  function scheduleScan() {
    if (!isActive()) return;
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = undefined;
      void scanIfChanged().catch(handleFailure);
    }, 800);
  }
  function handleDocumentClick(event: Event) {
    const elementTarget = event.target instanceof Element
      ? event.target.closest("a,area,[role='link'],[data-href],[data-url]")
      : null;
    const label = elementTarget?.textContent?.replace(/\s+/g, " ").trim() ?? "";
    if (elementTarget && /用户(服务)?协议|服务条款|使用条款|隐私(权)?政策|隐私协议|会员协议|terms|privacy|user agreement|subscription/i.test(label)) {
      scheduleScan();
    }
  }
  function handleMessage(message: { type?: string; quote?: string }, _sender: unknown, sendResponse: (response: unknown) => void) {
    if (message.type === "SCAN_PAGE") {
      void sendDiscovery()
        .then((count) => sendResponse({ count }))
        .catch((error) => {
          handleFailure(error);
          try {
            sendResponse({ count: 0 });
          } catch {
            // The message port is already gone when the extension was reloaded.
          }
        });
      return true;
    }
    if (message.type === "GET_RENDERED_HTML") {
      sendResponse({ html: sanitizedRenderedHtml(document) });
      return;
    }
    if (message.type === "HIGHLIGHT_EVIDENCE") {
      sendResponse({ found: highlightEvidence(document, String(message.quote || "")) });
    }
  }
  const start = () => {
    if (!isActive()) return;
    void scanIfChanged().catch(handleFailure);
    observer = new MutationObserver(scheduleScan);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener("popstate", scheduleScan);
    window.addEventListener("hashchange", scheduleScan);
    document.addEventListener("click", handleDocumentClick, true);
  };
  chrome.runtime.onMessage.addListener(handleMessage);
  runtimeWindow.__agreementLensContentController = { dispose: stop };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
}
