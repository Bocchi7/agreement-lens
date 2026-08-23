import { describe, expect, it } from "vitest";
import { contentFingerprint, dedupeFindings, routeChangedContent, runWorkflow } from "./index.js";

describe("workflow", () => {
  it("merges model findings that cite the same clause under different titles", () => {
    const quote = "您一旦接受本协议，即在全世界范围内永久、免费、独家且不可撤销地授权平台用于商业用途并向第三方转授权。";
    const makeFinding = (id: string, title: string, action: string, confidence: number) => ({
      id,
      category: "content" as const,
      title,
      trigger: "发布内容时",
      platformAction: action,
      userImpact: "内容可能被长期商业使用",
      severity: "high" as const,
      confidence,
      actions: [action],
      evidence: [{ sourceId: "terms", sectionId: "license", quote, verified: false }],
      knowledgeRefs: [],
      uncertainty: "",
      status: "needs_verification" as const
    });
    const findings = dedupeFindings([
      makeFinding("one", "用户发布内容被授予全球永久免费且不可撤销的广泛商业使用权", "平台可用于商业用途并转授权", 0.99),
      makeFinding("two", "上传内容被授予全球永久且不可撤销的商业使用及转授权许可", "平台可修改内容并转授权", 0.99),
      makeFinding("three", "发布内容被授予永久、免费且不可撤销的广泛商业使用权", "平台可制作衍生作品", 0.99),
      makeFinding("four", "发布内容将被授予全球永久且不可撤销的独家商业使用权", "平台可在全球范围内独家使用", 0.98)
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.title).toBe("用户发布内容被授予全球永久免费且不可撤销的广泛商业使用权");
    expect(findings[0]?.evidence).toHaveLength(1);
    expect(findings[0]?.actions).toEqual([
      "平台可用于商业用途并转授权",
      "平台可修改内容并转授权",
      "平台可制作衍生作品",
      "平台可在全球范围内独家使用"
    ]);
  });

  it("finds and verifies an automatic renewal risk", async () => {
    const text = "会员服务将在到期后自动续费并从原支付账户扣款。用户可提前取消。";
    const result = await runWorkflow({
      analysisId: "a1",
      serviceId: "s1",
      serviceName: "示例",
      context: { action: "pay", concerns: ["money"], redlines: [], notes: "" },
      sources: [{
        id: "src1", title: "会员协议", mediaType: "text", normalizedText: text,
        fingerprint: contentFingerprint(text), fetchedAt: new Date().toISOString(), status: "ready",
        sections: [{ id: "sec1", heading: "续费", content: text }]
      }]
    }, { search: () => [] });
    expect(result.findings[0]?.title).toContain("自动续费");
    expect(result.findings[0]?.status).toBe("verified");
    expect(result.recommendation).toBe("adjust");
  });

  it("keeps generated evidence focused on the relevant clause", async () => {
    const text = `${"账户功能说明。".repeat(40)}用户开通连续包月后，服务将在每个计费周期到期前自动续费并从原支付账户扣款。用户可在到期前二十四小时关闭。${"其他说明。".repeat(40)}`;
    const result = await runWorkflow({
      analysisId: "a2",
      serviceId: "s2",
      serviceName: "示例",
      context: { action: "pay", concerns: ["money"], redlines: [], notes: "" },
      sources: [{
        id: "src2", title: "会员协议", mediaType: "text", normalizedText: text,
        fingerprint: contentFingerprint(text), fetchedAt: new Date().toISOString(), status: "ready",
        sections: [{ id: "sec2", heading: "续费", content: text }]
      }]
    }, { search: () => [] });
    const quote = result.findings.find((finding) => finding.title.includes("自动续费"))?.evidence[0]?.quote ?? "";
    expect(quote).toContain("自动续费");
    expect(quote.length).toBeLessThanOrEqual(260);
    expect(quote).not.toContain("账户功能说明");
  });

  it("routes a privacy-only version change without rerunning unrelated domains", () => {
    const beforeText = "我们仅收集账号信息。";
    const afterText = "我们收集账号信息，并可能与第三方共享个人信息。";
    const makeSource = (text: string) => ({
      id: "src1", title: "隐私政策", url: "https://example.com/privacy", mediaType: "text" as const,
      normalizedText: text, fingerprint: contentFingerprint(text), fetchedAt: new Date().toISOString(),
      status: "ready" as const, sections: [{ id: "sec1", heading: "信息共享", content: text }]
    });
    const route = routeChangedContent([makeSource(beforeText)], [makeSource(afterText)]);
    expect(route.changed).toBe(true);
    expect(route.domains).toContain("privacy");
    expect(route.domains).not.toContain("fees");
    expect(route.domains).not.toContain("rights");
    expect(route.structural).toBe(false);
  });

  it("identifies an unchanged snapshot without any analysis domains", () => {
    const text = "同一份用户协议。";
    const source = {
      id: "src1", title: "用户协议", mediaType: "text" as const,
      normalizedText: text, fingerprint: contentFingerprint(text), fetchedAt: new Date().toISOString(),
      status: "ready" as const, sections: [{ id: "sec1", heading: "正文", content: text }]
    };
    expect(routeChangedContent([source], [{ ...source, id: "new-id" }])).toEqual({
      changed: false, domains: [], confidence: 1, structural: false, changedSections: []
    });
  });

  it("ignores transient session ids when comparing agreement URLs", () => {
    const text = "同一份用户协议。";
    const before = {
      id: "src1", title: "隐私政策", url: "https://kyfw.12306.cn/otn/gonggao/privacyPolicy_web.html;jsessionid=ABC123",
      mediaType: "text" as const, normalizedText: text, fingerprint: contentFingerprint(text),
      fetchedAt: new Date().toISOString(), status: "ready" as const,
      sections: [{ id: "sec1", heading: "正文", content: text }]
    };
    const after = { ...before, id: "src2", url: "https://kyfw.12306.cn/otn/gonggao/privacyPolicy_web.html" };
    expect(routeChangedContent([before], [after]).changed).toBe(false);
  });

  it("does not treat a previously linked but not yet fetched document as a version change", () => {
    const text = "隐私政策正文。";
    const child = "https://example.com/child-policy";
    const before = {
      id: "privacy", title: "隐私政策", url: "https://example.com/privacy", mediaType: "text" as const,
      normalizedText: text, fingerprint: contentFingerprint(text), fetchedAt: new Date().toISOString(),
      status: "ready" as const, sections: [{ id: "privacy-section", heading: "正文", content: text }],
      linkedSources: [{ title: "儿童隐私规则", url: child }]
    };
    const childSource = {
      id: "child", title: "儿童隐私规则", url: child, mediaType: "text" as const,
      normalizedText: "儿童信息规则正文。", fingerprint: contentFingerprint("儿童信息规则正文。"),
      fetchedAt: new Date().toISOString(), status: "ready" as const,
      sections: [{ id: "child-section", heading: "正文", content: "儿童信息规则正文。" }]
    };
    expect(routeChangedContent([before], [before, childSource]).changed).toBe(false);
  });
});
