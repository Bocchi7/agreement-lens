export interface DynamicAgreementLink {
  title: string;
  url: string;
}

export function resolveDynamicAgreementLinks(): DynamicAgreementLink[] {
  // `chrome.scripting.executeScript({ func })` serializes this function
  // without module-level closures, so every runtime helper must be local.
  const agreementLabel = (value: string): string | undefined => {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (/隐私/.test(normalized)) return "隐私政策";
    if (/服务条款|用户协议|服务协议|条款|协议/.test(normalized)) return "服务条款";
    return undefined;
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
          roots.push(record[key]);
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
          || /^(?:\$parent|\$root|\$children|\$el|_vnode|_watcher|_scope|parent|return|child|sibling|stateNode)$/i.test(key)) continue;
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

  const urlsFromReactClick = (element: Element): string[] => {
    if (typeof window === "undefined") return [];
    const captured: string[] = [];
    const originalOpen = window.open;
    const capture = (value: unknown) => {
      if (typeof value !== "string") return;
      try {
        const url = new URL(value, location.href);
        if (["http:", "https:"].includes(url.protocol)) captured.push(url.href);
      } catch {
        // Ignore non-URL navigation values.
      }
    };
    const keys = Object.getOwnPropertyNames(element)
      .filter((key) => /^__reactEventHandlers\$/i.test(key));
    for (const key of keys) {
      const handlers = (element as Element & Record<string, unknown>)[key];
      if (!handlers || typeof handlers !== "object") continue;
      const handler = (handlers as Record<string, unknown>).onClick;
      if (typeof handler !== "function") continue;
      try {
        window.open = ((url?: string | URL) => {
          capture(url);
          return null;
        }) as typeof window.open;
        const returned = handler({
          preventDefault() {},
          stopPropagation() {},
          stopImmediatePropagation() {}
        });
        capture(returned);
      } catch {
        // A page may require a real browser event object.
      } finally {
        window.open = originalOpen;
      }
    }
    return captured;
  };

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
    for (const reactClickUrl of urlsFromReactClick(element)) {
      candidates.unshift({ title: agreementLabel(text), url: reactClickUrl, score: 4 });
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
      if (seen.has(url.href)) continue;
      seen.add(url.href);
      results.push({
        title: title.trim(),
        url: url.href
      });
      break;
    }
  }

  return results.slice(0, 12);
}
