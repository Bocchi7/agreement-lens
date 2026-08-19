const evidenceSelector = "p,li,td,th,dd,dt,blockquote,pre,article,section,main,div";

function normalize(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim().toLocaleLowerCase();
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
  const existing = document.querySelector<HTMLElement>("[data-agreement-lens-highlight]");
  if (existing) {
    existing.style.removeProperty("background-color");
    existing.style.removeProperty("outline");
    existing.style.removeProperty("outline-offset");
    existing.removeAttribute("data-agreement-lens-highlight");
  }
  const element = findEvidenceElement(document, quote);
  if (!element) return false;
  element.dataset.agreementLensHighlight = "true";
  element.style.setProperty("background-color", "rgba(255, 228, 92, 0.35)", "important");
  element.style.setProperty("outline", "3px solid rgba(214, 162, 0, 0.75)", "important");
  element.style.setProperty("outline-offset", "3px", "important");
  element.scrollIntoView({ behavior: "smooth", block: "center" });
  return true;
}
