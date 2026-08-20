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

  it("preserves SPA hash routes because they select different agreement documents", () => {
    const dom = new JSDOM(`
      <a href="https://wx.mail.qq.com/list/readtemplate?name=app_intro.html#/agreement/mailExpand">扩容服务条款</a>
      <a href="https://wx.mail.qq.com/list/readtemplate?name=app_intro.html#/agreement/mailVip">会员服务条款</a>
    `, { url: "https://mail.qq.com/" });
    const sources = discoverAgreementSources(dom.window.document, "https://mail.qq.com/");
    expect(sources.map((source) => source.url)).toEqual([
      "https://wx.mail.qq.com/list/readtemplate?name=app_intro.html#/agreement/mailExpand",
      "https://wx.mail.qq.com/list/readtemplate?name=app_intro.html#/agreement/mailVip"
    ]);
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

  it("discovers protocol controls without href attributes", () => {
    const dom = new JSDOM(`
      <footer>
        <a aria-label="服务条款" onclick="openAgreement('https://service.qq.com/terms')">服务条款</a>
        <a aria-label="隐私政策" onclick="window.open('https://privacy.qq.com/policy')">隐私政策</a>
        <a href="javascript:void(0)" data-target="https://privacy.qq.com/personal-information">个人信息保护政策</a>
      </footer>
    `);
    const sources = discoverAgreementSources(dom.window.document, "https://mail.qq.com/");
    expect(sources.map((source) => source.url)).toEqual([
      "https://service.qq.com/terms",
      "https://privacy.qq.com/policy",
      "https://privacy.qq.com/personal-information"
    ]);
  });

  it("discovers agreement links rendered inside a registration iframe document", () => {
    const dom = new JSDOM(`
      <div class="agreement">
        <a href="https://ptlogin.4399.com/resource/protocol.html?type=1&aids=1,3,6,7">《用户协议》</a>
        <a href="https://ptlogin.4399.com/resource/protocol.html?type=2&aids=2,10">《隐私政策》</a>
      </div>
    `, { url: "https://ptlogin.4399.com/ptlogin/phoneLoginFrame.do" });
    const sources = discoverAgreementSources(dom.window.document, dom.window.location.href);
    expect(sources.map((source) => source.title)).toEqual(["《用户协议》", "《隐私政策》"]);
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

  it("does not accept an unrelated label only because its URL uses a generic terms host path", () => {
    const dom = new JSDOM(`
      <a href="https://terms.example.com/legal-agreement/terms/contact/current.html">客服邮箱</a>
      <a href="https://terms.example.com/legal-agreement/terms/legal/current.html">法律声明</a>
      <a href="https://terms.example.com/legal-agreement/terms/sdk/current.html">第三方SDK收集使用信息说明</a>
    `);
    const sources = discoverAgreementSources(dom.window.document, "https://example.com/");
    expect(sources.map((source) => source.title)).toEqual([
      "法律声明",
      "第三方SDK收集使用信息说明"
    ]);
  });

  it("finds the agreement links shown on the Taobao login page", () => {
    const dom = new JSDOM(`
      <div class="login-agreement">
        <span>已阅读并同意以下协议</span>
        <a href="https://terms.alicdn.com/legal-agreement/terms/TD/TD201609301342_19559.html?spm=tracking">淘宝平台服务协议</a>
        <a href="https://terms.alicdn.com/legal-agreement/terms/suit_bu1_taobao/suit_bu1_taobao201703241622_61002.html?spm=tracking">隐私权政策</a>
        <a href="https://terms.alicdn.com/legal-agreement/terms/suit_bu1_taobao/suit_bu1_taobao201811121436_80276.html">法律声明</a>
        <a href="https://render.alipay.com/p/f/fd-jm7jym6r/alipay/multi-agreement.html">支付宝及客户端服务协议</a>
      </div>
      <a href="https://i.taobao.com/">收藏的店铺</a>
    `);
    const sources = discoverAgreementSources(dom.window.document, "https://login.taobao.com/havanaone/login/login.htm");
    expect(sources.map((source) => source.title)).toEqual([
      "淘宝平台服务协议",
      "隐私权政策",
      "法律声明",
      "支付宝及客户端服务协议"
    ]);
    expect(sources.map((source) => source.url)).not.toContain("https://i.taobao.com/");
  });

  it("finds the privacy materials shown on the Ctrip login page", () => {
    const dom = new JSDOM(`
      <div class="login-notice">
        新版<a href="https://contents.ctrip.com/huodong/privacypolicypc/index?type=1">《隐私政策》</a>已上线
      </div>
      <footer>
        <a href="https://rulecenter.ctrip.com/statics/rule/72/latest.html">用户协议</a>
        <a href="https://rulecenter.ctrip.com/statics/rule/74/latest.html">隐私政策</a>
      </footer>
    `, { url: "https://passport.ctrip.com/user/login" });
    const sources = discoverAgreementSources(dom.window.document, dom.window.location.href);
    expect(sources.map((source) => source.url)).toEqual([
      "https://contents.ctrip.com/huodong/privacypolicypc/index?type=1",
      "https://rulecenter.ctrip.com/statics/rule/72/latest.html",
      "https://rulecenter.ctrip.com/statics/rule/74/latest.html"
    ]);
  });

  it("uses agreement terms from link attributes when visible text is generic", () => {
    const dom = new JSDOM(`
      <a href="/privacy" aria-label="个人信息保护政策">了解详情</a>
    `, { url: "https://example.com/login" });
    const sources = discoverAgreementSources(dom.window.document, dom.window.location.href);
    expect(sources[0]?.url).toBe("https://example.com/privacy");
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
