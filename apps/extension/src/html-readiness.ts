export function visibleTextLength(html: string): number {
  if (typeof DOMParser === "undefined") {
    return html
      .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .length;
  }
  const document = new DOMParser().parseFromString(html, "text/html");
  document.querySelectorAll("script,style,noscript,template").forEach((node) => node.remove());
  return (document.body?.textContent ?? "").replace(/\s+/g, " ").trim().length;
}

function hasClientRenderedShellMarkup(html: string): boolean {
  const hasEmptyMountPoint = /<(?:div|main|section)\b[^>]*\bid=["'](?:root|app|__next|__nuxt)["'][^>]*>\s*<\/(?:div|main|section)>/i.test(html);
  if (!hasEmptyMountPoint) return false;
  return /<script\b[^>]+src=["'][^"']*(?:\/static\/js\/|\/assets\/|chunk|webpack|main\.)/i.test(html)
    || /<noscript\b[^>]*>[\s\S]*?(?:enable javascript|需要启用 javascript)[\s\S]*?<\/noscript>/i.test(html);
}

function isClientRenderedShell(document: Document): boolean {
  const mountPoint = [...document.querySelectorAll("#root, #app, #__next, #__nuxt")]
    .some((element) => !element.textContent?.trim() && element.children.length === 0);
  if (!mountPoint) return false;

  const hasJavaScriptApp = [...document.querySelectorAll<HTMLScriptElement>("script[src]")]
    .some((script) => /(?:\/static\/js\/|\/assets\/|chunk|webpack|main\.)/i.test(script.src));
  const noscriptText = [...document.querySelectorAll("noscript")]
    .map((node) => node.textContent ?? "")
    .join(" ");
  return hasJavaScriptApp || /enable javascript|需要启用 javascript/i.test(noscriptText);
}

function hasEmptyAgreementContainer(document: Document): boolean {
  return [...document.querySelectorAll(
    ".detail.ProseMirror, .detail-container .detail, [class*='agreement-detail'], [class*='policy-detail']"
  )].some((element) => (element.textContent ?? "").replace(/\s+/g, " ").trim().length < 80);
}

export function needsRenderedFallback(html: string): boolean {
  if (typeof DOMParser === "undefined") {
    return visibleTextLength(html) < 300 || hasClientRenderedShellMarkup(html);
  }
  const document = new DOMParser().parseFromString(html, "text/html");
  return visibleTextLength(html) < 300 || isClientRenderedShell(document) || hasEmptyAgreementContainer(document);
}
