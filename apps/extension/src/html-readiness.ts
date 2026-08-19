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

export function needsRenderedFallback(html: string): boolean {
  return visibleTextLength(html) < 300;
}
