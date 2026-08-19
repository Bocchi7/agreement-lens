import dns from "node:dns/promises";
import net from "node:net";

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a = 0, b = 0] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  const normalized = ip.toLowerCase();
  if (normalized.startsWith("::ffff:") && isPrivateIp(normalized.slice(7))) return true;
  return normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:");
}

export async function validateRemoteUrl(input: string): Promise<URL> {
  const url = new URL(input);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("仅支持 HTTP/HTTPS 来源");
  if (url.username || url.password) throw new Error("来源地址不能包含凭据");
  const records = await dns.lookup(url.hostname, { all: true });
  if (!records.length || records.some((record) => isPrivateIp(record.address))) throw new Error("拒绝访问本地或私有网络地址");
  return url;
}

export function sanitizeRenderedHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<(input|textarea|select)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/\s(on\w+|value|srcdoc)=("[^"]*"|'[^']*')/gi, "")
    .slice(0, 2_000_000);
}
