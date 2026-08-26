import { discoverAgreementSources, sanitizedRenderedHtml } from "./discovery";

type CapturedRenderedPage = {
  html: string;
  title: string;
  url: string;
  textLength: number;
  links: Array<{ title: string; url: string }>;
};

type CaptureMessage = { type?: string };

function visibleTextLength(): number {
  const renderedText = document.body?.innerText?.replace(/\s+/g, " ").trim();
  if (renderedText) return renderedText.length;
  const clone = document.documentElement.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("script,style,noscript,template").forEach((node) => node.remove());
  return (clone.textContent ?? "").replace(/\s+/g, " ").trim().length;
}

function agreementBodyIsStillLoading(): boolean {
  const emptyDetail = [...document.querySelectorAll(
    ".detail.ProseMirror, .detail-container .detail, [class*='agreement-detail'], [class*='policy-detail']"
  )].some((element) => (element.textContent ?? "").replace(/\s+/g, " ").trim().length < 80);
  const emptyDetailTitle = [...document.querySelectorAll(
    ".detail-container .title h1, [class*='agreement-detail'] h1, [class*='policy-detail'] h1"
  )].some((element) => !(element.textContent ?? "").trim());
  return emptyDetail || emptyDetailTitle;
}

async function captureRenderedPage(): Promise<CapturedRenderedPage> {
  const startedAt = Date.now();
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const textLength = visibleTextLength();
    const elapsed = Date.now() - startedAt;
    // A readable agreement is more valuable than a perfectly idle page.
    // Sites with timers or analytics can keep mutating their DOM forever.
    if (textLength >= 300 && elapsed >= 500 && !agreementBodyIsStillLoading()) break;
    if (textLength >= 80 && elapsed >= 1_500 && !agreementBodyIsStillLoading()) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (agreementBodyIsStillLoading() && visibleTextLength() < 300) {
    throw new Error("协议正文动态加载未完成");
  }

  const textLength = visibleTextLength();
  const sources = discoverAgreementSources(document, location.href);
  return {
    html: sanitizedRenderedHtml(document),
    textLength,
    title: document.title || location.hostname,
    url: location.href,
    links: sources
      .filter((source) => Boolean(source.url))
      .map((source) => ({ title: source.title, url: source.url! }))
  };
}

const runtimeWindow = window as Window & {
  __agreementLensRenderedCaptureInstalled?: boolean;
};

if (!runtimeWindow.__agreementLensRenderedCaptureInstalled) {
  runtimeWindow.__agreementLensRenderedCaptureInstalled = true;
  const handleMessage = (
    message: CaptureMessage,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: { ok: true; page: CapturedRenderedPage } | { ok: false; error: string }) => void
  ) => {
    if (message.type !== "CAPTURE_RENDERED_SOURCE") return;
    void captureRenderedPage()
      .then((page) => sendResponse({ ok: true, page }))
      .catch((error) => sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : "浏览器无法读取来源页面"
      }));
    return true;
  };
  chrome.runtime.onMessage.addListener(handleMessage);
}
