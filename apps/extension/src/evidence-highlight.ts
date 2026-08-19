const evidenceSelector = "p,li,td,th,dd,dt,blockquote,pre,article,section,main,div";
const ignoredTextSelector = "script,style,noscript,template";

function normalize(value: string): string {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

function compact(value: string): string {
  return normalize(value).replace(/[\s，。；：、,.!?:;()[\]{}"'“”‘’《》]+/g, "");
}

function elementDepth(element: Element): number {
  let depth = 0;
  let parent = element.parentElement;
  while (parent) {
    depth++;
    parent = parent.parentElement;
  }
  return depth;
}

function searchFragments(quote: string): string[] {
  const normalized = normalize(quote);
  const fragments = [normalized];
  for (const length of [80, 56, 36, 24]) {
    if (normalized.length <= length) continue;
    fragments.push(normalized.slice(0, length));
    fragments.push(normalized.slice(Math.max(0, Math.floor((normalized.length - length) / 2)), Math.floor((normalized.length - length) / 2) + length));
    fragments.push(normalized.slice(-length));
  }
  return [...new Set(fragments.filter((fragment) => fragment.length >= 12))];
}

function matchingFragments(text: string, quote: string): Array<{ start: number; end: number; fragment: string }> {
  return searchFragments(quote)
    .sort((left, right) => right.length - left.length)
    .flatMap((fragment) => {
      const matches: Array<{ start: number; end: number; fragment: string }> = [];
      let start = text.indexOf(fragment);
      while (start >= 0) {
        matches.push({ start, end: start + fragment.length, fragment });
        start = text.indexOf(fragment, start + 1);
      }
      return matches;
    })
    .sort((left, right) => right.fragment.length - left.fragment.length || left.start - right.start);
}

function matchingRange(text: string, quote: string): { start: number; end: number; fragment: string } | null {
  const normalizedQuote = normalize(quote);
  const ellipsisParts = normalizedQuote.split(/(?:\.{3,}|…+)/).map((part) => part.trim()).filter(Boolean);
  if (ellipsisParts.length >= 2) {
    const prefixMatches = matchingFragments(text, ellipsisParts[0]!);
    const suffixMatches = matchingFragments(text, ellipsisParts.at(-1)!);
    const ranges = prefixMatches.flatMap((prefix) =>
      suffixMatches
        .filter((suffix) => suffix.start >= prefix.end)
        .map((suffix) => ({
          start: prefix.start,
          end: suffix.end,
          fragment: `${prefix.fragment}…${suffix.fragment}`
        }))
    );
    if (ranges.length) {
      return ranges.sort((left, right) =>
        right.fragment.length - left.fragment.length || (left.end - left.start) - (right.end - right.start)
      )[0]!;
    }
  }
  return matchingFragments(text, normalizedQuote)[0] ?? null;
}

interface TextPosition {
  node: Text;
  offset: number;
}

interface NormalizedDocumentText {
  text: string;
  positions: TextPosition[];
}

function documentText(document: Document, compactMode = false): NormalizedDocumentText {
  const textNodeFilter = document.defaultView?.NodeFilter.SHOW_TEXT ?? 4;
  const walker = document.createTreeWalker(document.body ?? document.documentElement, textNodeFilter);
  const parts: string[] = [];
  const positions: TextPosition[] = [];
  let lastWasSpace = true;
  let current: Node | null;
  while ((current = walker.nextNode())) {
    const node = current as Text;
    if (node.parentElement?.closest(ignoredTextSelector)) continue;
    const value = node.nodeValue ?? "";
    for (let offset = 0; offset < value.length; offset++) {
      const character = value[offset]!;
      if (/\s/.test(character)) {
        if (compactMode) continue;
        if (lastWasSpace) continue;
        parts.push(" ");
        positions.push({ node, offset });
        lastWasSpace = true;
        continue;
      }
      if (/[\u200b-\u200d\ufeff]/.test(character)) continue;
      if (compactMode && /[，。；：、,.!?:;()[\]{}"'“”‘’《》]/.test(character)) continue;
      parts.push(character.toLocaleLowerCase());
      positions.push({ node, offset });
      lastWasSpace = false;
    }
  }
  while (parts.at(-1) === " ") {
    parts.pop();
    positions.pop();
  }
  return { text: parts.join(""), positions };
}

function clearExistingHighlight(document: Document) {
  document.querySelectorAll<HTMLElement>("mark[data-agreement-lens-highlight]").forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) return;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    mark.remove();
  });
  document.querySelectorAll<HTMLElement>("[data-agreement-lens-highlight]").forEach((element) => {
    element.style.removeProperty("background-color");
    element.style.removeProperty("outline");
    element.style.removeProperty("outline-offset");
    element.removeAttribute("data-agreement-lens-highlight");
  });
}

function wrapTextRange(document: Document, start: TextPosition, end: TextPosition): HTMLElement | null {
  const textNodeFilter = document.defaultView?.NodeFilter.SHOW_TEXT ?? 4;
  const walker = document.createTreeWalker(document.body ?? document.documentElement, textNodeFilter);
  const nodes: Text[] = [];
  let current: Node | null;
  while ((current = walker.nextNode())) {
    const node = current as Text;
    if (node.parentElement?.closest(ignoredTextSelector)) continue;
    nodes.push(node);
  }
  const startIndex = nodes.indexOf(start.node);
  const endIndex = nodes.indexOf(end.node);
  if (startIndex < 0 || endIndex < 0 || startIndex > endIndex) return null;

  const selected: Array<{ node: Text; from: number; to: number }> = [];
  for (let index = startIndex; index <= endIndex; index++) {
    const node = nodes[index]!;
    const from = index === startIndex ? start.offset : 0;
    const to = index === endIndex ? end.offset : (node.nodeValue ?? "").length;
    if (to > from) selected.push({ node, from, to });
  }
  if (!selected.length) return null;

  const marks: HTMLElement[] = [];
  for (const item of selected.reverse()) {
    item.node.splitText(item.to);
    const target = item.node.splitText(item.from);
    const mark = document.createElement("mark");
    mark.dataset.agreementLensHighlight = "true";
    mark.style.setProperty("background-color", "rgba(255, 228, 92, 0.55)", "important");
    mark.style.setProperty("outline", "2px solid rgba(214, 162, 0, 0.75)", "important");
    mark.style.setProperty("outline-offset", "1px", "important");
    target.parentNode?.replaceChild(mark, target);
    mark.appendChild(target);
    marks.push(mark);
  }
  return marks.at(-1) ?? null;
}

export function findEvidenceElement(document: Document, quote: string): HTMLElement | null {
  const fragments = searchFragments(quote);
  if (!fragments.length) return null;
  const candidates = [...document.querySelectorAll<HTMLElement>(evidenceSelector)]
    .filter((element) => !element.closest("[data-agreement-lens-highlight]"))
    .map((element) => ({
      element,
      text: normalize(element.innerText || element.textContent || ""),
      depth: elementDepth(element)
    }))
    .filter((candidate) => candidate.text.length >= 12);

  for (const fragment of fragments) {
    const exact = candidates
      .filter((candidate) => candidate.text.includes(fragment))
      .sort((left, right) => left.text.length - right.text.length || right.depth - left.depth)[0];
    if (exact) return exact.element;
  }

  const tokens = normalize(quote)
    .split(/[，。；：、,.!?:;()[\]{}"'\s]+/)
    .filter((token) => token.length >= 4)
    .sort((left, right) => right.length - left.length)
    .slice(0, 8);
  if (!tokens.length) return null;
  const fuzzy = candidates
    .map((candidate) => ({
      ...candidate,
      score: tokens.reduce((score, token) => score + (candidate.text.includes(token) ? token.length : 0), 0)
    }))
    .filter((candidate) => candidate.score >= Math.min(12, tokens[0]!.length))
    .sort((left, right) => right.score - left.score || left.text.length - right.text.length)[0];
  return fuzzy?.element ?? null;
}

export function highlightEvidence(document: Document, quote: string): boolean {
  clearExistingHighlight(document);
  const normalizedQuote = normalize(quote);
  if (normalizedQuote.length < 12) return false;
  const normalizedText = documentText(document);
  let matchText = normalizedText;
  let range = matchingRange(matchText.text, normalizedQuote);
  if (!range) {
    const compactText = documentText(document, true);
    range = matchingRange(compactText.text, compact(normalizedQuote));
    matchText = compactText;
  }
  if (!range) return false;
  const start = matchText.positions[range.start];
  const end = matchText.positions[range.end - 1];
  if (!start || !end) return false;
  const endPosition = { node: end.node, offset: end.offset + 1 };
  const highlighted = wrapTextRange(document, start, endPosition);
  if (!highlighted) {
    const element = findEvidenceElement(document, range.fragment);
    if (!element) return false;
    element.dataset.agreementLensHighlight = "true";
    element.style.setProperty("background-color", "rgba(255, 228, 92, 0.35)", "important");
    element.style.setProperty("outline", "3px solid rgba(214, 162, 0, 0.75)", "important");
    element.style.setProperty("outline-offset", "3px", "important");
    element.scrollIntoView({ behavior: "smooth", block: "center" });
    return true;
  }
  highlighted.scrollIntoView({ behavior: "smooth", block: "center" });
  return true;
}
