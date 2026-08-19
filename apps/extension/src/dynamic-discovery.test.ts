import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveDynamicAgreementLinks } from "./dynamic-discovery";

describe("dynamic agreement discovery", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads agreement URLs stored in a Vue component behind clickable text", () => {
    const dom = new JSDOM(`
      <div class="login-agreement">
        <p>登录即代表你同意 <span>用户协议</span> 和 <span>隐私政策</span></p>
      </div>
    `, { url: "https://www.bilibili.com/" });
    const root = dom.window.document.querySelector(".login-agreement") as Element & { __vue__?: unknown };
    root.__vue__ = {
      list: [{
        match: [
          { name: "用户协议", url: "https://www.bilibili.com/protocal/licence.html" },
          { name: "隐私政策", url: "https://www.bilibili.com/blackboard/privacy-pc.html" }
        ]
      }]
    };
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal("location", dom.window.location);

    expect(resolveDynamicAgreementLinks()).toEqual([
      { title: "用户协议", url: "https://www.bilibili.com/protocal/licence.html" },
      { title: "隐私政策", url: "https://www.bilibili.com/blackboard/privacy-pc.html" }
    ]);
  });

  it("does not classify unrelated membership destinations as agreements", () => {
    const dom = new JSDOM(`
      <div>
        <span>会员购</span>
        <span>大会员</span>
      </div>
    `, { url: "https://www.bilibili.com/" });
    const root = dom.window.document.querySelector("div") as Element & { __vue__?: unknown };
    root.__vue__ = {
      links: [
        { name: "会员购", url: "https://show.bilibili.com/" },
        { name: "大会员", url: "https://account.bilibili.com/big" }
      ]
    };
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal("location", dom.window.location);

    expect(resolveDynamicAgreementLinks()).toEqual([]);
  });
});
