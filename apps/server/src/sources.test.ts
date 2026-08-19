import fs from "node:fs";
import { decodeHtmlBytes } from "@agreement-lens/shared";
import { describe, expect, it } from "vitest";
import { loadSourceGraph } from "./sources.js";
import { snapshotDir } from "./config.js";

describe("source loading", () => {
  it("decodes HTML according to its declared GBK charset", () => {
    const gb18030 = Uint8Array.from([
      0xbe, 0xa9, 0xb6, 0xab, 0xbb, 0xf9, 0xb1, 0xbe, 0xb9, 0xa6,
      0xc4, 0xdc, 0xd2, 0xfe, 0xcb, 0xbd, 0xd5, 0xfe, 0xb2, 0xdf
    ]);
    expect(decodeHtmlBytes(gb18030, "text/html; charset=GBK")).toBe("京东基本功能隐私政策");
  });

  it("uses an HTML meta charset when the response omits content-type charset", () => {
    const bytes = new TextEncoder().encode('<meta charset="UTF-8"><title>隐私政策</title>');
    expect(decodeHtmlBytes(bytes, "text/html")).toContain("隐私政策");
  });

  it("recognizes the legacy http-equiv meta charset declaration", () => {
    const bytes = new TextEncoder().encode(
      '<meta http-equiv="Content-Type" content="text/html; charset=UTF-8"><title>隐私政策</title>'
    );
    expect(decodeHtmlBytes(bytes, "text/html")).toContain("隐私政策");
  });

  it("normalizes pasted text and persists an immutable snapshot", async () => {
    const [source] = await loadSourceGraph([{
      id: `test-${Date.now()}`,
      kind: "text",
      title: "测试协议",
      text: "第一条   自动续费。\n\n\n第二条 不支持退款。",
      selected: true,
      relation: "manual"
    }]);
    expect(source?.normalizedText).toContain("自动续费");
    expect(source?.snapshotPath).toBeTruthy();
    expect(fs.existsSync(`${snapshotDir}/${source?.snapshotPath}/normalized.json`)).toBe(true);
    expect(fs.existsSync(`${snapshotDir}/${source?.snapshotPath}/raw.txt`)).toBe(true);
  });

  it("extracts agreement-specific direct links from rendered HTML", async () => {
    const sources = await loadSourceGraph([{
      id: `html-${Date.now()}`,
      kind: "url",
      title: "当前页面",
      url: "https://example.com/account",
      selected: true,
      relation: "primary"
    }], `<main><h1>账户中心</h1><p>请查看 <a href="/privacy">隐私政策</a> 和 <a href="/terms">用户协议</a>。</p></main>`, 1, "https://example.com/account");
    expect(sources[0]?.linkedSources?.map((item) => item.title)).toEqual(["隐私政策", "用户协议"]);
    expect(sources).toHaveLength(1);
  });

  it("extracts links when agreement labels are split or use partial English wording", async () => {
    const [source] = await loadSourceGraph([{
      id: `partial-labels-${Date.now()}`,
      kind: "url",
      title: "当前页面",
      url: "https://example.com/account",
      renderedHtml: `<main>
        <a href="/legal/terms-and-conditions"><span>Terms</span><span> and Conditions</span></a>
        <a href="/privacy-cookies">Privacy &amp; Cookies</a>
      </main>`,
      selected: true,
      relation: "primary"
    }], undefined, 1, "https://example.com/account");
    expect(source?.linkedSources?.map((item) => item.url)).toEqual([
      "https://example.com/legal/terms-and-conditions",
      "https://example.com/privacy-cookies"
    ]);
  });

  it("preserves SPA hash routes for linked agreement documents", async () => {
    const [source] = await loadSourceGraph([{
      id: `spa-linked-${Date.now()}`,
      kind: "url",
      title: "QQ邮箱服务协议",
      url: "https://wx.mail.qq.com/list/readtemplate?name=app_intro.html#/agreement/mailService",
      renderedHtml: `<main>
        <p>${"本协议说明邮箱服务规则。".repeat(20)}</p>
        <a href="https://wx.mail.qq.com/list/readtemplate?name=app_intro.html#/agreement/expand">QQ邮箱扩容服务条款</a>
        <a href="https://wx.mail.qq.com/list/readtemplate?name=app_intro.html#/agreement/mailvip">QQ邮箱会员服务条款</a>
      </main>`,
      selected: true,
      relation: "primary"
    }], undefined, 1);
    expect(source?.linkedSources).toEqual([
      {
        title: "QQ邮箱扩容服务条款",
        url: "https://wx.mail.qq.com/list/readtemplate?name=app_intro.html#/agreement/expand"
      },
      {
        title: "QQ邮箱会员服务条款",
        url: "https://wx.mail.qq.com/list/readtemplate?name=app_intro.html#/agreement/mailvip"
      }
    ]);
  });

  it("uses HTML acquired by the extension for an external agreement URL", async () => {
    const [source] = await loadSourceGraph([{
      id: `extension-html-${Date.now()}`,
      kind: "url",
      title: "服务协议",
      url: "https://blocked.example/terms",
      renderedHtml: `<main><h1>服务协议</h1><h2>自动续费</h2><p>${"用户可在续费日前关闭自动续费，关闭后不再扣款。".repeat(12)}</p></main>`,
      selected: true,
      relation: "primary"
    }]);
    expect(source?.status).toBe("ready");
    expect(source?.normalizedText).toContain("关闭自动续费");
    expect(source?.normalizedText.length).toBeGreaterThan(80);
  });

  it("does not statically refetch links already discovered from browser-rendered HTML", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    globalThis.fetch = (async () => {
      fetchCount += 1;
      return new Response("<html><body><div id=\"app\"></div></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    }) as typeof fetch;
    try {
      const sources = await loadSourceGraph([{
        id: `browser-graph-${Date.now()}`,
        kind: "url",
        title: "QQ邮箱服务协议",
        url: "https://wx.mail.qq.com/list/readtemplate?name=app_intro.html#/agreement/mailService",
        renderedHtml: `<main>
          <p>${"本协议说明邮箱服务规则。".repeat(20)}</p>
          <a href="https://wx.mail.qq.com/list/readtemplate?name=app_intro.html#/agreement/expand">QQ邮箱扩容服务条款</a>
        </main>`,
        selected: true,
        relation: "primary"
      }], undefined, 8);
      expect(sources).toHaveLength(1);
      expect(fetchCount).toBe(0);
      expect(sources[0]?.linkedSources?.[0]?.url).toContain("#/agreement/expand");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("recovers the JD privacy policy body from its data API when the HTML is only an app shell", async () => {
    const originalFetch = globalThis.fetch;
    const responses = [
      new Response(
        `<html><head><script src="/static/js/main.example.js"></script></head><body><div id="root"></div><footer>${"网站导航 ".repeat(80)}</footer></body></html>`,
        { status: 200, headers: { "content-type": "text/html" } }
      ),
      new Response(JSON.stringify({
        code: 0,
        data: {
          title: "京东基本功能隐私政策",
          date: "2026年4月7日",
          dateEff: "2026年4月14日",
          tips: "<p>特别提示。</p>",
          content: `<h3>一、收集和使用</h3><p>${"完整隐私政策正文。".repeat(250)}</p>`
        }
      }), { status: 200, headers: { "content-type": "application/json" } })
    ];
    globalThis.fetch = (async () => responses.shift() ?? new Response("{}", { status: 500 })) as typeof fetch;
    try {
      const [source] = await loadSourceGraph([{
        id: `jd-privacy-api-${Date.now()}`,
        kind: "url",
        title: "关于京东",
        url: "https://about.jd.com/privacy/",
        selected: true,
        relation: "primary"
      }], undefined, 1);
      expect(source?.status).toBe("ready");
      expect(source?.normalizedText).toContain("完整隐私政策正文");
      expect(source?.normalizedText.length).toBeGreaterThan(2000);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps section tools aligned with text extracted by Readability", async () => {
    const body = Array.from({ length: 80 }, (_, index) =>
      `<div data-leaf="true"><span>第 ${index + 1} 项个人信息处理规则：说明收集目的、共享对象、保存期限和删除方式。</span></div>`
    ).join("");
    const [source] = await loadSourceGraph([{
      id: `readability-sections-${Date.now()}`,
      kind: "url",
      title: "隐私政策",
      url: "https://example.com/privacy",
      renderedHtml: `<article><h1>隐私政策</h1>${body}</article>`,
      selected: true,
      relation: "primary"
    }], undefined, 1);
    const sectionLength = source?.sections.reduce((total, section) => total + section.content.length, 0) ?? 0;
    expect(source?.normalizedText).toContain("第 80 项个人信息处理规则");
    expect(sectionLength).toBeGreaterThanOrEqual((source?.normalizedText.length ?? 0) * 0.75);
  });

  it("does not follow unrelated links merely because the hosting path contains terms", async () => {
    const [source] = await loadSourceGraph([{
      id: `generic-terms-path-${Date.now()}`,
      kind: "url",
      title: "隐私政策",
      url: "https://terms.example.com/legal-agreement/terms/privacy/current.html",
      renderedHtml: `<main><p>${"本政策说明个人信息处理规则。".repeat(20)}</p>
        <a href="/legal-agreement/terms/contact/current.html">客服邮箱</a>
        <a href="/legal-agreement/terms/legal/current.html">法律声明</a>
        <a href="/legal-agreement/terms/sdk/current.html">第三方SDK收集使用信息说明</a>
      </main>`,
      selected: true,
      relation: "primary"
    }], undefined, 1);
    expect(source?.linkedSources?.map((item) => item.title)).toEqual([
      "法律声明",
      "第三方SDK收集使用信息说明"
    ]);
  });

  it("does not follow interactive account and OAuth links", async () => {
    const [source] = await loadSourceGraph([{
      id: `oauth-filter-${Date.now()}`,
      kind: "url",
      title: "服务协议",
      url: "https://example.com/terms",
      renderedHtml: `<main><h1>服务协议</h1><p>${"本协议说明服务规则和用户权利。".repeat(12)}</p>
        <a href="https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?client_id=test&redirect_uri=https%3A%2F%2Fexample.com">隐私仪表板</a>
        <a href="https://example.com/privacy">隐私政策</a>
      </main>`,
      selected: true,
      relation: "primary"
    }], undefined, 1);
    expect(source?.linkedSources).toEqual([{ title: "隐私政策", url: "https://example.com/privacy" }]);
  });

  it("does not follow account privacy dashboards as agreement documents", async () => {
    const [source] = await loadSourceGraph([{
      id: `dashboard-filter-${Date.now()}`,
      kind: "url",
      title: "服务协议",
      url: "https://example.com/terms",
      renderedHtml: `<main><p>${"本协议说明服务规则和用户权利。".repeat(12)}</p>
        <a href="https://account.microsoft.com/privacy">Microsoft privacy dashboard</a>
        <a href="https://example.com/privacy">隐私政策</a>
      </main>`,
      selected: true,
      relation: "primary"
    }], undefined, 1);
    expect(source?.linkedSources).toEqual([{ title: "隐私政策", url: "https://example.com/privacy" }]);
  });

  it("does not follow generic membership links as agreement documents", async () => {
    const [source] = await loadSourceGraph([{
      id: `membership-filter-${Date.now()}`,
      kind: "url",
      title: "服务协议",
      url: "https://example.com/terms",
      renderedHtml: `<main><p>${"本协议说明服务规则和用户权利。".repeat(12)}</p>
        <a href="https://show.example.com/">会员购</a>
        <a href="https://account.example.com/big">大会员</a>
        <a href="https://example.com/member-agreement">会员服务协议</a>
      </main>`,
      selected: true,
      relation: "primary"
    }], undefined, 1);
    expect(source?.linkedSources).toEqual([{
      title: "会员服务协议",
      url: "https://example.com/member-agreement"
    }]);
  });

  it("does not automatically follow historical agreement versions", async () => {
    const [source] = await loadSourceGraph([{
      id: `history-filter-${Date.now()}`,
      kind: "url",
      title: "个人信息保护指引",
      url: "https://www.zhihu.com/term/privacy",
      renderedHtml: `<main><h1>个人信息保护指引</h1>
        <p>${"当前版本正文。".repeat(40)}</p>
        <p>历史版本：<a href="/term/old-privacy-5-1">5.1</a>、<a href="/term/old-privacy-5">5.0</a></p>
        <a href="/term/realname-authentication">实名认证协议</a>
      </main>`,
      selected: true,
      relation: "primary"
    }], undefined, 1);
    expect(source?.linkedSources).toEqual([{
      title: "实名认证协议",
      url: "https://www.zhihu.com/term/realname-authentication"
    }]);
  });

  it("drops a historical root when the current version is already selected", async () => {
    const body = `<main><h1>个人信息保护指引</h1><p>${"当前版本正文。".repeat(40)}</p></main>`;
    const sources = await loadSourceGraph([
      {
        id: `current-privacy-${Date.now()}`,
        kind: "url",
        title: "个人信息保护指引",
        url: "https://www.zhihu.com/term/privacy",
        renderedHtml: body,
        selected: true,
        relation: "primary"
      },
      {
        id: `old-privacy-${Date.now()}`,
        kind: "url",
        title: "个人信息保护指引 5.1",
        url: "https://www.zhihu.com/term/old-privacy-5-1",
        renderedHtml: body,
        selected: true,
        relation: "manual"
      }
    ]);
    expect(sources.map((source) => source.url)).toEqual(["https://www.zhihu.com/term/privacy"]);
  });
});
