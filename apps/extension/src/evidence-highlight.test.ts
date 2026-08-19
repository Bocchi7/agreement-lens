import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { findEvidenceElement, highlightEvidence } from "./evidence-highlight";

describe("evidence location", () => {
  it("locates a quote split across nested text nodes", () => {
    const dom = new JSDOM(`
      <main>
        <p>无关说明</p>
        <section><p id="target">服务将在到期后<strong>自动续费</strong>，并从原支付账户扣款。</p></section>
      </main>
    `);
    expect(findEvidenceElement(dom.window.document, "服务将在到期后自动续费，并从原支付账户扣款。")?.id).toBe("target");
  });

  it("falls back to a distinctive fragment when surrounding text differs", () => {
    const dom = new JSDOM(`
      <main>
        <p>普通账户设置说明。</p>
        <p id="target">用户可以在续费日前关闭自动续费，关闭后不再扣款。</p>
      </main>
    `);
    expect(findEvidenceElement(dom.window.document, "其他上下文。用户可以在续费日前关闭自动续费，关闭后不再扣款。更多说明。")?.id).toBe("target");
  });

  it("highlights only the matching text instead of the whole page container", () => {
    const dom = new JSDOM(`
      <main id="document">
        <section><p>前面的协议说明。</p><p id="target">平台会保存您的真实姓名、联系方式和通讯录。</p><p>后续其他条款。</p></section>
      </main>
    `);
    Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", { value: () => undefined });
    expect(highlightEvidence(dom.window.document, "平台会保存您的真实姓名、联系方式和通讯录。")).toBe(true);
    expect(dom.window.document.querySelectorAll("mark[data-agreement-lens-highlight]")).toHaveLength(1);
    expect(dom.window.document.querySelector("main")?.hasAttribute("data-agreement-lens-highlight")).toBe(false);
    expect(dom.window.document.querySelector("section")?.hasAttribute("data-agreement-lens-highlight")).toBe(false);
    expect(dom.window.document.querySelector("#target")?.textContent).toContain("平台会保存您的真实姓名");
  });

  it("locates evidence when the live page changes punctuation and spacing", () => {
    const dom = new JSDOM(`
      <main><p id="target">授权 Agent 读取邮件，意味着这些内容将被传输至 Agent 服务提供者的系统。</p></main>
    `);
    Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", { value: () => undefined });
    expect(highlightEvidence(dom.window.document, "授权Agent读取邮件意味着这些内容将被传输至Agent服务提供者的系统。")).toBe(true);
    expect(dom.window.document.querySelectorAll("mark[data-agreement-lens-highlight]").length).toBeGreaterThan(0);
    expect(dom.window.document.querySelector("#target")?.textContent).toContain("Agent 服务提供者");
  });
});
