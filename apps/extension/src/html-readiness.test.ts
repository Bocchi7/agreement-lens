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

  it("recognizes an app shell that has navigation text but no rendered agreement body", () => {
    const dom = new JSDOM(`
      <html>
        <body>
          <header>${"京东首页 我的订单 客户服务 网站导航 ".repeat(20)}</header>
          <div id="root"></div>
          <footer>${"关于我们 联系我们 隐私政策 ".repeat(20)}</footer>
          <noscript>You need to enable JavaScript to run this app.</noscript>
          <script src="/static/js/main.example.js"></script>
        </body>
      </html>
    `);
    vi.stubGlobal("DOMParser", dom.window.DOMParser);
    expect(visibleTextLength(dom.serialize())).toBeGreaterThan(300);
    expect(needsRenderedFallback(dom.serialize())).toBe(true);
  });

  it("recognizes the same app shell in the extension service-worker environment", () => {
    const html = `
      <html><body>
        <header>${"京东首页 我的订单 客户服务 网站导航 ".repeat(20)}</header>
        <div id="root"></div>
        <footer>${"关于我们 联系我们 隐私政策 ".repeat(20)}</footer>
        <noscript>You need to enable JavaScript to run this app.</noscript>
        <script src="/static/js/main.example.js"></script>
      </body></html>
    `;
    vi.stubGlobal("DOMParser", undefined);
    expect(needsRenderedFallback(html)).toBe(true);
  });

  it("does not classify a normal document with an empty unrelated container as a shell", () => {
    const dom = new JSDOM(`
      <html>
        <body>
          <div id="root"></div>
          <article>${"这是一份已经包含完整正文的隐私政策。".repeat(80)}</article>
        </body>
      </html>
    `);
    vi.stubGlobal("DOMParser", dom.window.DOMParser);
    expect(needsRenderedFallback(dom.serialize())).toBe(false);
  });
});
