import type { DiscoveredSource } from "@agreement-lens/shared";

const agreementLinkKeywords = [
  "协议", "条款", "隐私", "privacy", "cookie", "cookies", "terms", "conditions",
  "user agreement", "service agreement", "subscription", "auto-renew", "自动续费",
  "社区规范", "community guidelines"
];

function matchesAgreementLink(value: string): boolean {
  const normalized = value
    .replace(/\u00a0/g, " ")
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/\s+/g, " ")
    .toLocaleLowerCase();
  return agreementLinkKeywords.some((keyword) => normalized.includes(keyword));
}

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

export function isHistoricalVersionLink(label: string, url: URL): boolean {
  const path = `${url.pathname}${url.search}`.toLocaleLowerCase();
  const text = `${label} ${path}`;
  return /历史版本|历史条款|旧版|上一版|previous|histor(?:y|ical)|archive|archived/.test(text)
    || /(?:^|[/_-])old(?:[/_-]|$)/.test(path)
    || /(?:^|[?&])(?:version|revision|history)=/i.test(url.search);
}

function classify(text: string, url: string): string {
  const value = `${text} ${url}`;
  if (/隐私|privacy/i.test(value)) return "隐私政策";
  if (/续费|付费|会员|subscription/i.test(value)) return "付费与续费规则";
  if (/社区|community/i.test(value)) return "社区规范";
  return "用户协议";
}

function agreementLinkElements(root: Document | ShadowRoot): Element[] {
  const elements = [...root.querySelectorAll("a[href],area[href],[role='link'][href],[data-href],[data-url]")];
  for (const element of [...root.querySelectorAll("*")]) {
    if (element.shadowRoot) elements.push(...agreementLinkElements(element.shadowRoot));
  }
  return elements;
}

export function discoverAgreementSources(document: Document, pageUrl: string): DiscoveredSource[] {
  const seen = new Set<string>();
  const sources: DiscoveredSource[] = [];
  for (const link of agreementLinkElements(document)) {
    const text = ((link as HTMLElement).innerText || link.getAttribute("aria-label") || link.getAttribute("title") || link.textContent || "").replace(/\s+/g, " ").trim();
    const rawHref = link.getAttribute("href") || link.getAttribute("data-href") || link.getAttribute("data-url") || "";
    let url: URL;
    try {
      url = new URL(rawHref, pageUrl);
    } catch {
      continue;
    }
    if (!["http:", "https:"].includes(url.protocol)
      || isInteractiveAccountUrl(url)
      || isAccountDashboardLink(text, url)
      || isHistoricalVersionLink(text, url)
      || !matchesAgreementLink(`${text} ${url.pathname}`)) continue;
    url.hash = "";
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    sources.push({
      id: crypto.randomUUID(),
      kind: /\.pdf(?:$|\?)/i.test(url.href) ? "pdf" : "url",
      title: text || classify("", url.href),
      url: url.href,
      selected: true,
      relation: "primary"
    });
  }
  return sources.slice(0, 12);
}

export function sanitizedRenderedHtml(document: Document): string {
  const clone = document.documentElement.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("script,style,noscript,iframe,input,textarea,select,button").forEach((node) => node.remove());
  clone.querySelectorAll("*").forEach((node) => {
    for (const attribute of [...node.attributes]) {
      if (/^on/i.test(attribute.name) || ["value", "srcdoc"].includes(attribute.name)) node.removeAttribute(attribute.name);
    }
  });
  return clone.outerHTML.slice(0, 2_000_000);
}
