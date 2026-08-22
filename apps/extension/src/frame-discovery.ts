import type { DiscoveredSource } from "@agreement-lens/shared";

const trackingQueryParameter = /^(?:utm_[^=]*|spm|from|source|src|ref|referer|referrer|campaign|campaignid|clickid|click_id|adid|ad_id|fbclid|gclid|msclkid|yclid|igshid|share_token)$/i;

export function canonicalDiscoveredSourceUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hostname = url.hostname.toLocaleLowerCase();
    if ((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443")) url.port = "";
    if (url.hash && !/^#(?:!\/|\/)/.test(url.hash)) url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (trackingQueryParameter.test(key) || (/^_\d{10,}$/.test(key) && !url.searchParams.get(key))) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    url.pathname = url.pathname.replace(/\/{2,}/g, "/");
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    return url.href;
  } catch {
    return value;
  }
}

export function mergeDiscoveredSources(groups: DiscoveredSource[][], limit = 24): DiscoveredSource[] {
  const merged: DiscoveredSource[] = [];
  const seen = new Set<string>();
  for (const source of groups.flat()) {
    const key = source.url ? canonicalDiscoveredSourceUrl(source.url) : `text:${source.title}:${source.text ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(source.url && source.url !== key ? { ...source, url: key } : source);
    if (merged.length >= limit) break;
  }
  return merged;
}

export function permissionPatternsForSite(pageUrl: string): string[] {
  const url = new URL(pageUrl);
  const exact = `${url.protocol}//${url.host}/*`;
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":")) {
    return [exact];
  }
  const labels = hostname.split(".");
  if (labels.length < 2) return [exact];
  const compoundSuffixes = new Set([
    "com.cn", "net.cn", "org.cn", "gov.cn",
    "com.hk", "com.tw", "co.uk", "org.uk", "com.au", "co.jp"
  ]);
  const suffix = labels.slice(-2).join(".");
  const domain = compoundSuffixes.has(suffix) && labels.length >= 3
    ? labels.slice(-3).join(".")
    : suffix;
  return [...new Set([exact, `${url.protocol}//*.${domain}/*`])];
}
