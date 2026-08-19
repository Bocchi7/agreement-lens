import type { DiscoveredSource } from "@agreement-lens/shared";

export function canonicalDiscoveredSourceUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.hash && !/^#(?:!\/|\/)/.test(url.hash)) url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^_\d{10,}$/.test(key) && !url.searchParams.get(key)) url.searchParams.delete(key);
    }
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
