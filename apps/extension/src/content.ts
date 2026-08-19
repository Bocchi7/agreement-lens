import { discoverAgreementSources, sanitizedRenderedHtml } from "./discovery";
import { highlightEvidence } from "./evidence-highlight";

async function collectSources() {
  const sources = discoverAgreementSources(document, location.href);
  for (const delay of [0, 300, 900]) {
    if (delay) await new Promise((resolve) => window.setTimeout(resolve, delay));
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
      if (response.links?.length) break;
    } catch (error) {
      console.warn("[agreement-lens] dynamic discovery request failed", error);
    }
  }
  return sources.slice(0, 12);
}

function publishDiscovery(sources: ReturnType<typeof discoverAgreementSources>) {
  void chrome.runtime.sendMessage({
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

async function sendDiscovery() {
  const sources = await collectSources();
  publishDiscovery(sources);
  return sources.length;
}

const runtimeWindow = window as Window & {
  __agreementLensContentVersion?: string;
};
const contentVersion = "2026-08-19-evidence-frames-v4";

if (runtimeWindow.__agreementLensContentVersion !== contentVersion) chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "SCAN_PAGE") {
    void sendDiscovery().then((count) => sendResponse({ count }));
    return true;
  }
  if (message.type === "GET_RENDERED_HTML") {
    sendResponse({ html: sanitizedRenderedHtml(document) });
    return;
  }
  if (message.type === "HIGHLIGHT_EVIDENCE") {
    sendResponse({ found: highlightEvidence(document, String(message.quote || "")) });
  }
});

if (runtimeWindow.__agreementLensContentVersion !== contentVersion) {
  runtimeWindow.__agreementLensContentVersion = contentVersion;
  let lastSignature = "";
  let timer: number | undefined;
  const scanIfChanged = async () => {
    const sources = await collectSources();
    const signature = sources.map((source) => `${source.title}|${source.url}`).join("\n");
    if (signature === lastSignature) return;
    lastSignature = signature;
    publishDiscovery(sources);
  };
  const scheduleScan = () => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = undefined;
      void scanIfChanged();
    }, 800);
  };
  const start = () => {
    void scanIfChanged();
    new MutationObserver(scheduleScan).observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener("popstate", scheduleScan);
    window.addEventListener("hashchange", scheduleScan);
    document.addEventListener("click", (event) => {
      const elementTarget = event.target instanceof Element
        ? event.target.closest("a,area,[role='link'],[data-href],[data-url]")
        : null;
      const label = elementTarget?.textContent?.replace(/\s+/g, " ").trim() ?? "";
      if (elementTarget && /用户(服务)?协议|服务条款|使用条款|隐私(权)?政策|隐私协议|会员协议|terms|privacy|user agreement|subscription/i.test(label)) {
        scheduleScan();
      }
    }, true);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
}
