import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { findEvidenceElement } from "./evidence-highlight";

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
});
