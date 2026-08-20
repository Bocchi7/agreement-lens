export interface DynamicAgreementLink {
  title: string;
  url: string;
}

export async function resolveAgreementLinksFromLoadedScripts(labels: string[]): Promise<DynamicAgreementLink[]> {
  // This fallback is also serialized into the page's MAIN world, so keep all
  // helpers local. It is only used for href-less controls whose destination is
  // closed over inside a framework bundle.
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim().toLocaleLowerCase();
  const normalizedLabels = [...new Set(labels.map((label) => label.replace(/\s+/g, " ").trim()).filter(Boolean))].slice(0, 12);
  if (!normalizedLabels.length) return [];
  const runtimeWindow = typeof window === "undefined" ? undefined : window as Window & {
    __agreementLensScriptLinkCache?: Record<string, DynamicAgreementLink[]>;
  };
  const cacheKey = normalizedLabels.map(normalize).sort().join("|");
  const cached = runtimeWindow?.__agreementLensScriptLinkCache?.[cacheKey];
  if (cached) return cached;
  const scriptUrls = [...new Set([
    ...performance.getEntriesByType("resource").map((entry) => entry.name),
    ...[...document.scripts].map((script) => script.src)
  ].filter((url) => /^https?:\/\/.+\.js(?:[?#]|$)/i.test(url)))].slice(0, 24);
  const candidates: Array<{ url: string; position: number; source: string }> = [];
  const addCandidate = (rawUrl: string, position: number, source: string) => {
    try {
      const url = new URL(rawUrl.replace(/\\\//g, "/"), location.href);
      if (!["http:", "https:"].includes(url.protocol)) return;
      candidates.push({ url: url.href, position, source });
    } catch {
      // Ignore malformed strings found inside minified bundles.
    }
  };
  await Promise.all(scriptUrls.map(async (scriptUrl) => {
    try {
      const response = await fetch(scriptUrl, { signal: AbortSignal.timeout(6_000) });
      if (!response.ok) return;
      const source = await response.text();
      if (source.length > 3_000_000 || !normalizedLabels.some((label) => normalize(source).includes(normalize(label)))) return;
      const directPattern = /(?:https?:)?\\?\/\\?\/[a-z0-9.-]+(?::\d+)?(?:\\?\/[^"'`\s),;}]*)?/gi;
      for (const match of source.matchAll(directPattern)) {
        addCandidate(match[0], match.index ?? 0, source);
      }
      const concatPattern = /["'`]((?:https?:)?\/\/[^"'`\s]+)["'`]\s*\.\s*concat\(\s*["'`]([^"'`]+)["'`]\s*\)/gi;
      for (const match of source.matchAll(concatPattern)) {
        addCandidate(`${match[1]}${match[2]}`, match.index ?? 0, source);
      }
      const emptyConcatPattern = /["'`]\s*["'`]\s*\.\s*concat\(\s*["'`]((?:https?:)?\/\/[^"'`\s]+)["'`]\s*,\s*["'`]([^"'`]+)["'`]\s*\)/gi;
      for (const match of source.matchAll(emptyConcatPattern)) {
        addCandidate(`${match[1]}${match[2]}`, match.index ?? 0, source);
      }
    } catch {
      // A blocked or slow bundle should not prevent other discovery paths.
    }
  }));
  const results: DynamicAgreementLink[] = [];
  const seen = new Set<string>();
  for (const title of normalizedLabels) {
    const label = normalize(title);
    const privacy = /隐私|privacy|cookie/.test(label);
    let best: { url: string; score: number } | undefined;
    for (const candidate of candidates) {
      const candidateValue = normalize(candidate.url);
      if (!/协议|条款|隐私|privacy|cookie|terms?|agreement|conditions?|policy/.test(candidateValue)) continue;
      let nearest = Number.POSITIVE_INFINITY;
      let from = 0;
      while (from < candidate.source.length) {
        const index = normalize(candidate.source.slice(from)).indexOf(label);
        if (index < 0) break;
        const absolute = from + index;
        nearest = Math.min(nearest, Math.abs(candidate.position - absolute));
        from = absolute + Math.max(title.length, 1);
      }
      if (!Number.isFinite(nearest) || nearest > 1_000) continue;
      const familyMatch = privacy
        ? /隐私|privacy|cookie|policy/.test(candidateValue)
        : !/隐私|privacy|cookie/.test(candidateValue) && /协议|条款|terms?|agreement|conditions?/.test(candidateValue);
      const score = (familyMatch ? 10_000 : 0) - nearest;
      if (!best || score > best.score) best = { url: candidate.url, score };
    }
    if (!best || seen.has(best.url)) continue;
    seen.add(best.url);
    results.push({ title, url: best.url });
  }
  if (runtimeWindow) {
    runtimeWindow.__agreementLensScriptLinkCache ??= {};
    runtimeWindow.__agreementLensScriptLinkCache[cacheKey] = results;
  }
  return results;
}

export function resolveDynamicAgreementLinks(): DynamicAgreementLink[] {
  // `chrome.scripting.executeScript({ func })` serializes this function
  // without module-level closures, so every runtime helper must be local.
  const agreementLabel = (value: string): string | undefined => {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (!normalized) return undefined;
    return normalized.replace(/^[《「『【[(\s]+|[》」』】)\]\s]+$/g, "").trim();
  };
  const isHistoricalVersionLink = (label: string, url: URL): boolean => {
    const path = `${url.pathname}${url.search}`.toLocaleLowerCase();
    const text = `${label} ${path}`;
    return /历史版本|历史条款|旧版|上一版|previous|histor(?:y|ical)|archive|archived/.test(text)
      || /(?:^|[/_-])old(?:[/_-]|$)/.test(path)
      || /(?:^|[?&])(?:version|revision|history)=/i.test(url.search);
  };
  const keywords = [
    "协议", "条款", "隐私", "privacy", "cookie", "cookies", "terms", "conditions",
    "user agreement", "service agreement", "subscription", "auto-renew", "自动续费",
    "社区规范", "community guidelines", "法律声明", "个人信息保护", "个人信息处理",
    "数据保护", "数据须知", "收集使用信息", "账号注销"
  ];
  const normalize = (value: string) => value
    .replace(/\u00a0/g, " ")
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
  const matches = (value: string) => {
    const normalized = normalize(value);
    return keywords.some((keyword) => normalized.includes(keyword));
  };
  const elementsIn = (root: Document | ShadowRoot): Element[] => {
    const elements = [...root.querySelectorAll("*")];
    for (const element of [...elements]) {
      if (element.shadowRoot) elements.push(...elementsIn(element.shadowRoot));
    }
    return elements;
  };
  const urlsFromFramework = (element: Element): Array<{ title?: string; url: string }> => {
    const roots: unknown[] = [];
    for (let current: Element | null = element, depth = 0; current && depth < 6; current = current.parentElement, depth += 1) {
      const record = current as Element & Record<string, unknown>;
      for (const key of Object.getOwnPropertyNames(record)) {
        if (/^__vue__$|^__reactProps\$|^__reactFiber\$|^__reactInternalInstance\$|^__reactEventHandlers\$|^__svelte/i.test(key)) {
          let value = record[key];
          roots.push(value);
          // React stores href-less link data on a parent fiber's props. Walk
          // the return chain explicitly before the generic object traversal;
          // otherwise the large rendered subtree can exhaust the inspection
          // budget before reaching the footer component's data.
          const seenFibers = new Set<object>();
          for (let fiberDepth = 0; value && typeof value === "object" && fiberDepth < 40; fiberDepth += 1) {
            if (seenFibers.has(value)) break;
            seenFibers.add(value);
            const fiber = value as Record<string, unknown>;
            roots.unshift(fiber.memoizedProps, fiber.pendingProps);
            value = fiber.return;
          }
        }
      }
    }

    const queue = roots.map((value) => ({ value, depth: 0 }));
    const visited = new Set<object>();
    const candidates: Array<{ title?: string; url: string }> = [];
    let inspected = 0;
    while (queue.length && inspected < 300) {
      const item = queue.shift();
      if (!item || !item.value || typeof item.value !== "object" || visited.has(item.value)) continue;
      visited.add(item.value);
      inspected += 1;
      let entries: Array<[string, unknown]>;
      try {
        entries = Object.entries(item.value);
      } catch {
        continue;
      }
      const title = entries.find(([key, value]) =>
        /^(?:name|title|label|text)$/i.test(key) && typeof value === "string"
      )?.[1];
      for (const [key, value] of entries) {
        if (/(?:url|href|link|target|^to$)/i.test(key) && typeof value === "string") {
          candidates.push({ title: typeof title === "string" ? title : undefined, url: value });
        }
      }
      if (item.depth >= 10) continue;
      for (const [key, value] of entries) {
        if (!value || typeof value !== "object"
          || /^(?:\$parent|\$root|\$children|\$el|_vnode|_watcher|_scope|parent|child|sibling|stateNode)$/i.test(key)) continue;
        queue.push({ value, depth: item.depth + 1 });
      }
    }
    return candidates;
  };

  const urlFromReactEventHandler = (element: Element): string | undefined => {
    const keys = Object.getOwnPropertyNames(element)
      .filter((key) => /^__reactEventHandlers\$/i.test(key));
    for (const key of keys) {
      const handlers = (element as Element & Record<string, unknown>)[key];
      if (!handlers || typeof handlers !== "object") continue;
      for (const handler of Object.values(handlers as Record<string, unknown>)) {
        if (typeof handler !== "function") continue;
        const source = Function.prototype.toString.call(handler);
        const embeddedUrl = source.match(/https?:\/\/[^\s"'`\\)]+/i)?.[0];
        if (embeddedUrl) return embeddedUrl;
      }
    }
    return undefined;
  };

  const urlsFromClick = (element: Element): string[] => {
    if (typeof window === "undefined") return [];
    const directTarget = element.getAttribute("href")
      || element.getAttribute("data-href")
      || element.getAttribute("data-url");
    if (directTarget || !element.matches("a,area,[role='link']")) return [];
    const captured: string[] = [];
    const originalOpen = window.open;
    const capture = (value: unknown) => {
      if (typeof value !== "string" && !(value instanceof URL)) return;
      try {
        const url = new URL(String(value), location.href);
        if (["http:", "https:"].includes(url.protocol)) captured.push(url.href);
      } catch {
        // Ignore non-URL navigation values.
      }
    };
    try {
      window.open = ((url?: string | URL) => {
        capture(url);
        return null;
      }) as typeof window.open;
      const EventConstructor = element.ownerDocument.defaultView?.MouseEvent ?? MouseEvent;
      element.dispatchEvent(new EventConstructor("click", {
        bubbles: true,
        cancelable: true,
        view: element.ownerDocument.defaultView
      }));
      runtimeWindow?.__agreementLensDynamicClickRecords?.push({
        title: agreementLabel(element.textContent || "") ?? "",
        captured: [...captured]
      });
    } catch {
      // Some controls require trusted pointer events; framework metadata is
      // still inspected as a fallback.
    } finally {
      window.open = originalOpen;
    }
    return captured;
  };
  const canonicalUrl = (value: string): string => {
    const url = new URL(value, location.href);
    for (const key of [...url.searchParams.keys()]) {
      if (/^_\d{10,}$/.test(key) && !url.searchParams.get(key)) url.searchParams.delete(key);
    }
    return url.href;
  };

  const runtimeWindow = typeof window === "undefined" ? undefined : window as Window & {
    __agreementLensDynamicClickRecords?: Array<{ title: string; captured: string[] }>;
  };
  if (runtimeWindow) runtimeWindow.__agreementLensDynamicClickRecords = [];
  const results: DynamicAgreementLink[] = [];
  const seen = new Set<string>();
  for (const element of elementsIn(document)) {
    const text = normalize(
      (element as HTMLElement).innerText
      || element.getAttribute("aria-label")
      || element.getAttribute("title")
      || element.textContent
      || ""
    );
    if (!text || text.length > 100 || !matches(text)) continue;
    const candidates = urlsFromFramework(element)
      .map((candidate) => ({
        ...candidate,
        score: candidate.title && (text.includes(normalize(candidate.title)) || normalize(candidate.title).includes(text)) ? 2 : 1
      }))
      .sort((left, right) => right.score - left.score);
    const handlerUrl = urlFromReactEventHandler(element);
    if (handlerUrl) candidates.unshift({ title: agreementLabel(text), url: handlerUrl, score: 3 });
    for (const clickUrl of urlsFromClick(element)) {
      candidates.unshift({ title: agreementLabel(text), url: clickUrl, score: 4 });
    }
    for (const candidate of candidates) {
      // A URL without the matching component label is too ambiguous: Vue/React
      // instances often contain unrelated navigation URLs as well.
      const title = candidate.title;
      if (!title || !matches(title)) continue;
      let url: URL;
      try {
        url = new URL(candidate.url, location.href);
      } catch {
        continue;
      }
      if (!["http:", "https:"].includes(url.protocol)) continue;
      if (isHistoricalVersionLink(title, url)) continue;
      const canonical = canonicalUrl(url.href);
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      results.push({
        title: title.trim(),
        url: canonical
      });
      break;
    }
  }

  return results.slice(0, 12);
}
