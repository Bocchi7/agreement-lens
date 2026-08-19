import { describe, expect, it } from "vitest";
import { sanitizeRenderedHtml, validateRemoteUrl } from "./security.js";

describe("rendered DOM sanitization", () => {
  it("removes scripts, values and inline handlers", () => {
    const html = `<main onclick="steal()"><h1>协议</h1><input value="secret"><script>bad()</script><p>正文</p></main>`;
    const clean = sanitizeRenderedHtml(html);
    expect(clean).toContain("正文");
    expect(clean).not.toContain("secret");
    expect(clean).not.toContain("bad()");
    expect(clean).not.toContain("onclick");
  });

  it("rejects loopback URLs before fetching", async () => {
    await expect(validateRemoteUrl("http://127.0.0.1:8080/private")).rejects.toThrow(/本地|私有/);
  });
});
