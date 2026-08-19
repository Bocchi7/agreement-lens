import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { needsRenderedFallback, visibleTextLength } from "./html-readiness";

describe("HTML readiness detection", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("recognizes script-only agreement pages as dynamic shells", () => {
    const dom = new JSDOM("<html><body><div id='app'></div><script>window.__DATA__={}</script></body></html>");
    vi.stubGlobal("DOMParser", dom.window.DOMParser);
    expect(visibleTextLength(dom.serialize())).toBe(0);
    expect(needsRenderedFallback(dom.serialize())).toBe(true);
  });

  it("keeps pages that already contain enough visible agreement text", () => {
    const text = "用户协议正文。".repeat(80);
    const dom = new JSDOM(`<html><body><main>${text}</main><script>ignored()</script></body></html>`);
    vi.stubGlobal("DOMParser", dom.window.DOMParser);
    expect(visibleTextLength(dom.serialize())).toBeGreaterThan(300);
    expect(needsRenderedFallback(dom.serialize())).toBe(false);
  });
});
