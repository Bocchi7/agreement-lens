import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceDocument } from "@agreement-lens/shared";
import { createSourceReader } from "./related-source.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function rootSource(): SourceDocument {
  return {
    id: "root",
    title: "服务协议",
    url: "https://example.com/terms",
    sourceRole: "root",
    mediaType: "html",
    normalizedText: "服务协议正文。".repeat(80),
    fingerprint: "root-fingerprint",
    sections: [{ id: "root-section", heading: "正文", content: "服务协议正文。".repeat(80) }],
    linkedSources: [{ title: "隐私政策", url: "https://example.com/privacy" }],
    fetchedAt: new Date().toISOString(),
    status: "ready"
  };
}

describe("source reader", () => {
  it("reads a registered source without fetching it again", async () => {
    const sources = [rootSource()];
    const readSource = createSourceReader(sources);

    const result = await readSource({ sourceId: "root" });

    expect(result.reused).toBe(true);
    expect(result.loadedNewSource).toBe(false);
    expect(result.source.sections[0]?.content).toContain("服务协议正文");
  });

  it("reuses a normalized URL and does not fetch the same document twice", async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      return new Response(`<main><h1>隐私政策</h1><p>${"隐私政策正文。".repeat(80)}</p></main>`, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    }) as typeof fetch;
    const sources = [rootSource()];
    const readSource = createSourceReader(sources);

    const first = await readSource({ url: "https://EXAMPLE.com/privacy/?utm_source=test", title: "隐私政策", parentSourceId: "root" });
    const second = await readSource({ url: "https://example.com/privacy", title: "另一个标题" });

    expect(requests).toBe(1);
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(sources).toHaveLength(2);
    expect(sources[1]?.sourceRole).toBe("related");
    expect(sources[1]?.parentSourceId).toBe("root");
  });

  it("shares one in-flight fetch between concurrent Agent calls", async () => {
    let requests = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    globalThis.fetch = (async () => {
      requests += 1;
      await gate;
      return new Response(`<main><h1>隐私政策</h1><p>${"隐私政策正文。".repeat(80)}</p></main>`, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    }) as typeof fetch;
    const sources = [rootSource()];
    const readSource = createSourceReader(sources);
    const first = readSource({ url: "https://example.com/privacy", title: "隐私政策" });
    const second = readSource({ url: "https://example.com/privacy", title: "隐私政策" });
    release?.();
    const results = await Promise.all([first, second]);

    expect(requests).toBe(1);
    expect(results[0]?.source.id).toBe(results[1]?.source.id);
    expect(sources).toHaveLength(2);
  });

  it("returns a failed fetch as an error instead of registering empty material", async () => {
    globalThis.fetch = (async () => new Response("", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" }
    })) as typeof fetch;
    const sources = [rootSource()];
    const readSource = createSourceReader(sources);

    await expect(readSource({ url: "https://example.com/privacy" })).rejects.toThrow();
    expect(sources).toHaveLength(1);
  });
});
