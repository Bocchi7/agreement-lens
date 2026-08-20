import { discoverAgreementSources, sanitizedRenderedHtml } from "./discovery";
import { highlightEvidence } from "./evidence-highlight";
import { hasLiveExtensionContext, isExtensionContextInvalidated } from "./extension-context";

type CollectedSources = {
  sources: ReturnType<typeof discoverAgreementSources>;
  contextInvalidated: boolean;
};

async function collectSources(isActive: () => boolean): Promise<CollectedSources> {
  const sources = discoverAgreementSources(document, location.href);
  for (const delay of [0, 300, 900]) {
    if (delay) await new Promise((resolve) => window.setTimeout(resolve, delay));
    if (!isActive() || !hasLiveExtensionContext()) return { sources, contextInvalidated: true };
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
      if (isExtensionContextInvalidated(error) || !hasLiveExtensionContext()) {
        return { sources, contextInvalidated: true };
      }
      // Dynamic resolution is optional. Static links remain usable when the
      // message port disappears during a page or extension lifecycle change.
      break;
    }
  }
  return { sources: sources.slice(0, 12), contextInvalidated: false };
}

async function publishDiscovery(
  sources: ReturnType<typeof discoverAgreementSources>,
  isActive: () => boolean
): Promise<boolean> {
  if (!isActive() || !hasLiveExtensionContext()) return false;
  try {
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
    return true;
  } catch {
    return false;
  }
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
  const sendDiscovery = async () => {
    const collected = await collectSources(isActive);
    if (collected.contextInvalidated || !isActive()) {
      stop();
      return 0;
    }
    if (!await publishDiscovery(collected.sources, isActive)) {
      if (!hasLiveExtensionContext()) stop();
      return 0;
    }
    return collected.sources.length;
  };
  const scanIfChanged = async () => {
    const collected = await collectSources(isActive);
    if (collected.contextInvalidated || !isActive()) {
      stop();
      return;
    }
    const signature = collected.sources.map((source) => `${source.title}|${source.url}`).join("\n");
    if (signature === lastSignature) return;
    lastSignature = signature;
    if (!await publishDiscovery(collected.sources, isActive) && !hasLiveExtensionContext()) stop();
  };
  function scheduleScan() {
    if (!isActive()) return;
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = undefined;
      void scanIfChanged().catch(stop);
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
        .catch(() => {
          stop();
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
    void scanIfChanged().catch(stop);
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
