import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { discoverAgreementSources, sanitizedRenderedHtml } from "./discovery";

describe("agreement discovery", () => {
  it("finds Chinese and English agreement links, resolves URLs and deduplicates", () => {
    const dom = new JSDOM(`
      <a href="/terms#top">用户协议</a>
      <a href="/terms">重复协议</a>
      <a href="/privacy.pdf">Privacy Policy</a>
      <a href="/privacy-cookies">Privacy and cookies</a>
      <a href="/about">关于我们</a>
    `);
    const sources = discoverAgreementSources(dom.window.document, "https://example.com/account");
    expect(sources).toHaveLength(3);
    expect(sources[0]?.url).toBe("https://example.com/terms");
    expect(sources[1]?.kind).toBe("pdf");
    expect(sources[2]?.url).toBe("https://example.com/privacy-cookies");
  });

  it("matches agreement links by meaningful keyword fragments", () => {
    const dom = new JSDOM(`
      <a href="/legal/terms-and-conditions"><span>Terms</span><span>and Conditions</span></a>
      <a href="/privacy-cookies">Privacy &amp; Cookies</a>
      <a href="/privacy-notice">Your privacy notice</a>
    `);
    const sources = discoverAgreementSources(dom.window.document, "https://example.com/");
    expect(sources.map((source) => source.url)).toEqual([
      "https://example.com/legal/terms-and-conditions",
      "https://example.com/privacy-cookies",
      "https://example.com/privacy-notice"
    ]);
  });

  it("removes form values, scripts and event handlers from rendered DOM fallback", () => {
    const dom = new JSDOM(`<html><body onload="steal()"><input value="secret"><script>bad()</script><main><h1>协议</h1><p>正文</p></main></body></html>`);
    const html = sanitizedRenderedHtml(dom.window.document);
    expect(html).toContain("正文");
    expect(html).not.toContain("secret");
    expect(html).not.toContain("bad()");
    expect(html).not.toContain("onload");
  });

  it("does not treat OAuth and login actions as agreement sources", () => {
    const dom = new JSDOM(`
      <a href="https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?client_id=test&redirect_uri=https%3A%2F%2Fexample.com">隐私仪表板</a>
      <a href="https://example.com/privacy">隐私政策</a>
    `);
    const sources = discoverAgreementSources(dom.window.document, "https://example.com/account");
    expect(sources.map((source) => source.url)).toEqual(["https://example.com/privacy"]);
  });

  it("finds agreement links inside open shadow roots and data-href components", () => {
    const dom = new JSDOM("<main></main>");
    const host = dom.window.document.createElement("agreement-footer");
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<a data-href="/terms">用户协议</a>`;
    dom.window.document.body.append(host);
    const sources = discoverAgreementSources(dom.window.document, "https://example.com/account");
    expect(sources[0]?.url).toBe("https://example.com/terms");
  });

  it("does not treat generic membership links as agreement materials", () => {
    const dom = new JSDOM(`
      <a href="https://show.example.com/">会员购</a>
      <a href="https://account.example.com/big">大会员</a>
      <a href="/member-agreement">会员服务协议</a>
    `);
    const sources = discoverAgreementSources(dom.window.document, "https://example.com/");
    expect(sources.map((source) => source.title)).toEqual(["会员服务协议"]);
  });

  it("does not discover historical agreement versions as current materials", () => {
    const dom = new JSDOM(`
      <a href="/term/privacy">个人信息保护指引</a>
      <a href="/term/old-privacy-5-1">5.1</a>
      <a href="/term/old-privacy-5">5.0</a>
    `);
    const sources = discoverAgreementSources(dom.window.document, "https://www.zhihu.com/term/privacy");
    expect(sources.map((source) => source.url)).toEqual(["https://www.zhihu.com/term/privacy"]);
  });
});
