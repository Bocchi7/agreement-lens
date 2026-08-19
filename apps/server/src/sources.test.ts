import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { loadSourceGraph } from "./sources.js";
import { snapshotDir } from "./config.js";

describe("source loading", () => {
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
