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

  it("captures URLs opened by legacy React click handlers on non-anchor controls", () => {
    const dom = new JSDOM(`
      <div role="link" aria-label="服务条款">服务条款</div>
      <div role="link" aria-label="隐私政策">隐私政策</div>
    `, { url: "https://mail.qq.com/" });
    const links = [...dom.window.document.querySelectorAll("[role='link']")] as Array<Element & Record<string, unknown>>;
    links[0]!.__reactEventHandlers$test = {
      onClick: () => dom.window.open("https://wx.mail.qq.com/list/readtemplate?name=app_intro.html#/agreement/mailService")
    };
    links[1]!.__reactEventHandlers$test = {
      onClick: () => dom.window.open("https://wx.mail.qq.com/list/readtemplate?name=app_intro.html#/agreement/appPolicy")
    };
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal("location", dom.window.location);
    vi.stubGlobal("window", dom.window);

    const injectedResolver = new Function(`return (${resolveDynamicAgreementLinks.toString()})`)() as typeof resolveDynamicAgreementLinks;
    expect(injectedResolver()).toEqual([
      { title: "服务条款", url: "https://wx.mail.qq.com/list/readtemplate?name=app_intro.html#/agreement/mailService" },
      { title: "隐私政策", url: "https://wx.mail.qq.com/list/readtemplate?name=app_intro.html#/agreement/appPolicy" }
    ]);
  });

  it("captures URLs opened by native listeners on href-less agreement links", () => {
    const dom = new JSDOM(`
      <p>
        <a id="user">《百度用户协议》</a>
        <a id="child">《儿童个人信息保护声明》</a>
        <a id="privacy">《百度隐私权保护声明》</a>
      </p>
    `, { url: "https://passport.baidu.com/v2/?reg" });
    dom.window.document.querySelector("#user")?.addEventListener("click", () => {
      dom.window.open("http://passport.baidu.com/static/passpc-account/html/protocal.html", "_blank");
    });
    dom.window.document.querySelector("#child")?.addEventListener("click", () => {
      dom.window.open("https://privacy.baidu.com/policy/children-privacy-policy/index.html?_1787157891640", "_blank");
    });
    dom.window.document.querySelector("#privacy")?.addEventListener("click", () => {
      dom.window.open("http://privacy.baidu.com/detail?id=288", "_blank");
    });
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal("location", dom.window.location);
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("MouseEvent", dom.window.MouseEvent);
    vi.stubGlobal("URL", dom.window.URL);

    const injectedResolver = new Function(`return (${resolveDynamicAgreementLinks.toString()})`)() as typeof resolveDynamicAgreementLinks;
    expect(injectedResolver()).toEqual([
      { title: "百度用户协议", url: "http://passport.baidu.com/static/passpc-account/html/protocal.html" },
      { title: "儿童个人信息保护声明", url: "https://privacy.baidu.com/policy/children-privacy-policy/index.html" },
      { title: "百度隐私权保护声明", url: "http://privacy.baidu.com/detail?id=288" }
    ]);
  });
});
