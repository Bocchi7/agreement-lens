import type { DiscoveredSource } from "@agreement-lens/shared";

const agreementLinkKeywords = [
  "协议", "条款", "隐私", "privacy", "cookie", "cookies", "terms", "conditions",
  "user agreement", "service agreement", "subscription", "auto-renew", "自动续费",
  "社区规范", "community guidelines", "法律声明", "个人信息保护", "个人信息处理",
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
  const elements = [...root.querySelectorAll("a,area,[role='link'],[data-href],[data-url]")];
  for (const element of [...root.querySelectorAll("*")]) {
    if (element.shadowRoot) elements.push(...agreementLinkElements(element.shadowRoot));
  }
  return elements;
}

function linkLabel(link: Element): string {
  return (
    (link as HTMLElement).innerText
    || link.getAttribute("aria-label")
    || link.getAttribute("title")
    || link.textContent
    || ""
  ).replace(/\s+/g, " ").trim();
}

function linkRawTarget(link: Element): string {
  return [
    link.getAttribute("href"),
    link.getAttribute("data-href"),
    link.getAttribute("data-url"),
    link.getAttribute("data-link"),
    link.getAttribute("data-target"),
    link.getAttribute("onclick"),
    link.getAttribute("aria-label"),
    link.getAttribute("title")
  ].filter(Boolean).join(" ");
}

function linkUrl(link: Element, pageUrl: string): URL | null {
  const rawHref = link.getAttribute("href") || link.getAttribute("data-href") || link.getAttribute("data-url") || "";
  if (!rawHref) {
    const embeddedUrl = linkRawTarget(link).match(/https?:\/\/[^\s"'<>]+/i)?.[0];
    try {
      return embeddedUrl ? new URL(embeddedUrl, pageUrl) : null;
    } catch {
      return null;
    }
  }
  try {
    return new URL(rawHref, pageUrl);
  } catch {
    const embeddedUrl = linkRawTarget(link).match(/https?:\/\/[^\s"'<>]+/i)?.[0];
    try {
      return embeddedUrl ? new URL(embeddedUrl, pageUrl) : null;
    } catch {
      return null;
    }
  }
}

function canonicalAgreementUrl(url: URL): string {
  const normalized = new URL(url.href);
  if (normalized.hash && !/^#(?:!\/|\/)/.test(normalized.hash)) normalized.hash = "";
  return normalized.href;
}

export function discoverAgreementSources(document: Document, pageUrl: string): DiscoveredSource[] {
  const seen = new Set<string>();
  const sources: DiscoveredSource[] = [];
  for (const link of agreementLinkElements(document)) {
    const text = linkLabel(link);
    const rawTarget = linkRawTarget(link);
    const url = linkUrl(link, pageUrl);
    const matchValue = text || rawTarget || url?.pathname || "";
    if (url && (!["http:", "https:"].includes(url.protocol)
      || isInteractiveAccountUrl(url)
      || isAccountDashboardLink(text, url)
      || isHistoricalVersionLink(text, url)
      || !matchesAgreementLink(matchValue))) continue;
    if (!url || !matchesAgreementLink(matchValue)) continue;
    const canonicalUrl = canonicalAgreementUrl(url);
    if (seen.has(canonicalUrl)) continue;
    seen.add(canonicalUrl);
    sources.push({
      id: crypto.randomUUID(),
      kind: /\.pdf(?:$|\?)/i.test(canonicalUrl) ? "pdf" : "url",
      title: text || classify("", canonicalUrl),
      url: canonicalUrl,
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
