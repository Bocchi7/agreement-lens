import { describe, expect, it } from "vitest";
import { canonicalDiscoveredSourceUrl, mergeDiscoveredSources, permissionPatternsForFrames, permissionPatternsForSite } from "./frame-discovery";

describe("frame discovery helpers", () => {
  it("merges top-page and iframe sources while deduplicating canonical URLs", () => {
    const source = (title: string, url: string) => ({
      id: crypto.randomUUID(),
      kind: "url" as const,
      title,
      url,
      selected: true,
      relation: "primary" as const
    });
    const merged = mergeDiscoveredSources([
      [source("隐私政策", "https://ptlogin.4399.com/resource/protocol.html?type=2&aids=2,10#top")],
      [
        source("用户协议", "https://ptlogin.4399.com/resource/protocol.html?type=1&aids=1,3,6,7"),
        source("《隐私政策》", "https://ptlogin.4399.com/resource/protocol.html?type=2&aids=2,10")
      ]
    ]);
    expect(merged.map((item) => item.title)).toEqual(["隐私政策", "用户协议"]);
  });

  it("removes timestamp-only cache-buster parameters", () => {
    expect(canonicalDiscoveredSourceUrl(
      "https://privacy.baidu.com/policy/children-privacy-policy/index.html?_1787157891640"
    )).toBe("https://privacy.baidu.com/policy/children-privacy-policy/index.html");
  });

  it("removes common tracking parameters while preserving meaningful query parameters", () => {
    expect(canonicalDiscoveredSourceUrl(
      "https://www.sohu.com/xchannel/TURBd01EQXdNekky?spm=smpc.home.loginpop.5.1787366611540Fr5I1vK_1467"
    )).toBe("https://www.sohu.com/xchannel/TURBd01EQXdNekky");
    expect(canonicalDiscoveredSourceUrl(
      "https://example.com/terms?type=privacy&utm_source=homepage"
    )).toBe("https://example.com/terms?type=privacy");
  });

  it("requests the current host and its same-site subdomains", () => {
    expect(permissionPatternsForSite("https://www.4399.com/")).toEqual([
      "https://www.4399.com/*",
      "https://*.4399.com/*"
    ]);
    expect(permissionPatternsForSite("https://passport.baidu.com/v2/")).toContain("https://*.baidu.com/*");
    expect(permissionPatternsForSite("https://account.example.com.cn/")).toContain("https://*.example.com.cn/*");
  });

  it("includes cross-site iframe hosts so login dialogs can be scanned", () => {
    expect(permissionPatternsForFrames([
      "https://passport.yuewen.com/?popup=1",
      "https://turing.captcha.gtimg.com/1/template/drag_ele.html"
    ], "https://www.qidian.com/")).toEqual([
      "https://www.qidian.com/*",
      "https://*.qidian.com/*",
      "https://passport.yuewen.com/*"
    ]);
  });
});
