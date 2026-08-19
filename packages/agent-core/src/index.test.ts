import { describe, expect, it } from "vitest";
import { contentFingerprint, routeChangedContent, runWorkflow } from "./index.js";

describe("workflow", () => {
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
});
