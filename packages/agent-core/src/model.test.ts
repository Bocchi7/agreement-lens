import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { SourceDocument } from "@agreement-lens/shared";
import { modelConfigFromEnv, runModelFollowUp, runModelSpecialist, runModelVerifier } from "./model.js";

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("OpenAI-compatible model adapter", () => {
  it("resolves an API key referenced from another environment variable", () => {
    const previousKey = process.env.OPENAI_API_KEY;
    const previousReferencedKey = process.env.TEST_MODEL_API_KEY;
    const previousApiFormat = process.env.MODEL_API_FORMAT;
    try {
      process.env.OPENAI_API_KEY = "$TEST_MODEL_API_KEY";
      process.env.TEST_MODEL_API_KEY = "resolved-secret";
      process.env.MODEL_API_FORMAT = "responses";
      expect(modelConfigFromEnv()?.apiKey).toBe("resolved-secret");
      expect(modelConfigFromEnv()?.apiFormat).toBe("responses");
      expect(modelConfigFromEnv()?.toolMode).toBe("native");
      expect(modelConfigFromEnv()?.reasoningEffort).toBe("low");
      expect(modelConfigFromEnv()?.timeoutMs).toBe(86_400_000);
      expect(modelConfigFromEnv()?.maxToolRounds).toBe(100);
      expect(modelConfigFromEnv()?.maxRetries).toBe(100);
      expect(modelConfigFromEnv()?.maxCompletionTokens).toBeUndefined();
    } finally {
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousKey;
      if (previousReferencedKey === undefined) delete process.env.TEST_MODEL_API_KEY;
      else process.env.TEST_MODEL_API_KEY = previousReferencedKey;
      if (previousApiFormat === undefined) delete process.env.MODEL_API_FORMAT;
      else process.env.MODEL_API_FORMAT = previousApiFormat;
    }
  });

  it("allows a single analysis to override the configured model and reasoning effort", () => {
    const previousApiFormat = process.env.MODEL_API_FORMAT;
    const previousKey = process.env.OPENAI_API_KEY;
    const previousGeminiKey = process.env.GEMINI_API_KEY;
    try {
      process.env.OPENAI_API_KEY = "configured-secret";
      delete process.env.GEMINI_API_KEY;
      process.env.MODEL_API_FORMAT = "gemini";
      expect(modelConfigFromEnv({ model: "gpt-5.6-terra", reasoningEffort: "max" })).toMatchObject({
        model: "gpt-5.6-terra",
        apiFormat: "chat",
        reasoningEffort: "max"
      });
      expect(modelConfigFromEnv({ model: "gemini-3.7-flash", reasoningEffort: "none" })).toMatchObject({
        model: "gemini-3.7-flash",
        apiFormat: "gemini",
        reasoningEffort: "none"
      });
    } finally {
      if (previousApiFormat === undefined) delete process.env.MODEL_API_FORMAT;
      else process.env.MODEL_API_FORMAT = previousApiFormat;
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousKey;
      if (previousGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = previousGeminiKey;
    }
  });

  it("adds the OpenAI-compatible /v1 prefix when the configured base URL is a server root", async () => {
    const requestPaths: string[] = [];
    const server = http.createServer(async (request, response) => {
      requestPaths.push(request.url ?? "");
      for await (const _chunk of request) {
        // Drain the request before responding.
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        choices: [{ message: { role: "assistant", content: JSON.stringify({ findings: [] }) } }]
      }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not expose a port");

    await runModelSpecialist({
      role: "fees",
      sources: [],
      context: { action: "register", concerns: ["money"], redlines: [], notes: "" },
      knowledge: { search: () => [] },
      config: {
        apiKey: "test",
        baseUrl: `http://127.0.0.1:${address.port}`,
        model: "test-model",
        reasoningEffort: "low",
        timeoutMs: 45_000,
        maxToolRounds: 0,
        agentName: "fees"
      }
    });

    expect(requestPaths).toEqual(["/v1/chat/completions"]);
  });

  it("executes native tool calls and validates the final specialist schema", async () => {
    let calls = 0;
    const progress: Array<{ rounds?: number; retries?: number; message?: string }> = [];
    const trace: Array<{ phase: string; toolName?: string; data: Record<string, unknown> }> = [];
    const requestBodies: Array<Record<string, unknown>> = [];
    const server = http.createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requestBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      calls++;
      response.setHeader("content-type", "application/json");
      if (calls === 1) {
        response.end(JSON.stringify({
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "tool-1",
                type: "function",
                function: { name: "search_sources", arguments: "{\"query\":\"自动续费\",\"limit\":3}" }
              }]
            }
          }]
        }));
        return;
      }
      response.end(JSON.stringify({
        choices: [{
          message: {
            role: "assistant",
            content: JSON.stringify({
              findings: [{
                category: "费用与自动续费",
                title: "自动续费",
                trigger: "开通连续包月时",
                platformAction: "到期后自动扣款",
                userImpact: "可能产生非预期费用",
                severity: "high",
                confidence: 0.9,
                actions: ["提前关闭续费"],
                evidence: [{
                  sourceId: "source-1",
                  sectionId: "section-1",
                  quote: "服务将在到期后自动续费并扣款。"
                }],
                knowledgeRefs: [],
                uncertainty: ""
              }]
            })
          }
        }]
      }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not expose a port");

    const text = "服务将在到期后自动续费并扣款。";
    const findings = await runModelSpecialist({
      role: "fees",
      sources: [{
        id: "source-1",
        title: "会员协议",
        mediaType: "text",
        normalizedText: text,
        fingerprint: "fixture",
        sections: [{ id: "section-1", heading: "续费", content: text }],
        fetchedAt: new Date().toISOString(),
        status: "ready"
      }],
      context: { action: "pay", concerns: ["money"], redlines: [], notes: "" },
      knowledge: { search: () => [] },
      config: {
        apiKey: "test",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "test-model",
        reasoningEffort: "low",
        timeoutMs: 45_000,
        maxToolRounds: 2,
        agentName: "fees",
        onTrace: (event) => trace.push(event),
        onProgress: ({ progress: update }) => progress.push(update)
      }
    });

    expect(calls).toBe(2);
    expect(requestBodies[0]?.reasoning_effort).toBe("low");
    expect(requestBodies[0]?.messages).not.toEqual(requestBodies[1]?.messages);
    expect((requestBodies[0]?.messages as unknown[]).length).toBe(2);
    expect((requestBodies[1]?.messages as unknown[]).length).toBe(5);
    const firstMessages = requestBodies[0]?.messages as Array<{ role: string; content?: string }>;
    const systemPrompt = firstMessages.find((message) => message.role === "system")?.content ?? "";
    const continuationMessages = requestBodies[1]?.messages as Array<{ role: string; content?: string }>;
    expect(systemPrompt).toContain("confidence is a JSON number from 0 to 1");
    expect(systemPrompt).toContain("Never use qualitative confidence labels");
    expect(continuationMessages.at(-1)?.content).toContain("以下是本轮已实际执行的工具返回结果");
    expect(continuationMessages.at(-1)?.content).toContain("自动续费");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.evidence[0]?.quote).toContain("自动续费");
    expect(progress.some((update) => update.rounds === 1)).toBe(true);
    expect(progress.some((update) => update.rounds === 2)).toBe(true);
    expect(trace.map((event) => event.phase)).toEqual([
      "request", "response", "tool_call", "tool_result",
      "request", "final", "validation"
    ]);
    expect(trace.find((event) => event.phase === "tool_call")?.toolName).toBe("search_sources");
    expect(trace.find((event) => event.phase === "tool_result")?.data.result).toBeDefined();
    expect(trace.find((event) => event.phase === "request")?.data.messageCount).toBe(2);
  });

  it("injects root materials and lets an Agent read a cited source on demand", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    let fetchCalls = 0;
    const server = http.createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      requestBodies.push(body);
      response.setHeader("content-type", "application/json");
      if (requestBodies.length === 1) {
        response.end(JSON.stringify({
          choices: [{ message: {
            role: "assistant",
            tool_calls: [{
              id: "related-1",
              type: "function",
              function: {
                name: "read_source",
                arguments: JSON.stringify({
                  url: "https://example.com/privacy",
                  title: "隐私政策"
                })
              }
            }]
          } }]
        }));
        return;
      }
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify({ findings: [] }) } }] }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not expose a port");

    const rootText = "根协议正文，包含隐私政策链接。";
    const findings = await runModelSpecialist({
      role: "privacy",
      sources: [{
        id: "root-1",
        title: "服务协议",
        url: "https://example.com/terms",
        sourceRole: "root",
        mediaType: "html",
        normalizedText: rootText,
        fingerprint: "root-fingerprint",
        sections: [{ id: "root-section", heading: "隐私", content: rootText }],
        linkedSources: [{ title: "隐私政策", url: "https://example.com/privacy" }],
        fetchedAt: new Date().toISOString(),
        status: "ready"
      }],
      context: { action: "register", concerns: ["data"], redlines: [], notes: "" },
      knowledge: { search: () => [] },
      readSource: async (sourceRequest) => {
        fetchCalls += 1;
        expect(sourceRequest.url).toBe("https://example.com/privacy");
        expect(sourceRequest.parentSourceId).toBe("root-1");
          return {
          reused: false,
          loadedNewSource: true,
          source: {
            id: "related-1",
            title: "隐私政策",
            url: sourceRequest.url,
            sourceRole: "related",
            parentSourceId: "root-1",
            parentSectionId: "root-section",
            mediaType: "html",
            normalizedText: "隐私政策正文。",
            fingerprint: "related-fingerprint",
            sections: [{ id: "privacy-section", heading: "收集", content: "隐私政策正文。" }],
            fetchedAt: new Date().toISOString(),
            status: "ready"
          }
        };
      },
      config: {
        apiKey: "test",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "test-model",
        reasoningEffort: "low",
        timeoutMs: 45_000,
        maxToolRounds: 2,
        agentName: "privacy"
      }
    });

    expect(fetchCalls).toBe(1);
    expect(findings).toEqual([]);
    const firstMessages = requestBodies[0]?.messages as Array<{ role: string; content?: string }>;
    const firstUser = JSON.parse(firstMessages.find((message) => message.role === "user")?.content ?? "{}");
    expect(firstUser.sourceMaterials[0].sourceId).toBe("root-1");
    expect(firstUser.sourceMaterials[0].sections[0].content).toBe(rootText);
    expect(firstUser.sourceMaterials).toHaveLength(1);
    expect(JSON.stringify(requestBodies[1])).toContain("related-1");
    expect(JSON.stringify(requestBodies[1])).toContain("隐私政策正文");
  });

  it("routes registered related section reads through the source reader", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const server = http.createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requestBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      response.setHeader("content-type", "application/json");
      if (requestBodies.length === 1) {
        response.end(JSON.stringify({ choices: [{ message: {
          role: "assistant",
          tool_calls: [{
            id: "related-section-1",
            type: "function",
            function: {
              name: "read_source",
              arguments: JSON.stringify({ sourceId: "related-1", sectionId: "related-section" })
            }
          }]
        } }] }));
        return;
      }
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify({ findings: [] }) } }] }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not expose a port");

    let readerCalls = 0;
    const relatedSource: SourceDocument = {
      id: "related-1",
      title: "直播服务协议",
      url: "https://example.com/live-terms",
      sourceRole: "related",
      mediaType: "html",
      normalizedText: "直播服务协议正文。",
      fingerprint: "related-fingerprint",
      sections: [{ id: "related-section", heading: "直播规则", content: "直播服务协议正文。" }],
      fetchedAt: new Date().toISOString(),
      status: "ready"
    };
    await runModelSpecialist({
      role: "content",
      sources: [{
        id: "root-1",
        title: "用户协议",
        url: "https://example.com/terms",
        sourceRole: "root",
        mediaType: "html",
        normalizedText: "用户协议正文。",
        fingerprint: "root-fingerprint",
        sections: [{ id: "root-section", heading: "正文", content: "用户协议正文。" }],
        fetchedAt: new Date().toISOString(),
        status: "ready"
      }, relatedSource],
      context: { action: "register", concerns: ["content"], redlines: [], notes: "" },
      knowledge: { search: () => [] },
      readSource: async (sourceRequest) => {
        readerCalls += 1;
        expect(sourceRequest).toEqual({ sourceId: "related-1" });
        return { source: relatedSource, reused: true, loadedNewSource: false };
      },
      config: {
        apiKey: "test",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "test-model",
        reasoningEffort: "low",
        timeoutMs: 45_000,
        maxToolRounds: 2
      }
    });

    expect(readerCalls).toBe(1);
    expect(JSON.stringify(requestBodies[1])).toContain("直播服务协议正文");
  });

  it("rejects a URL that is not declared by linkedSources", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const server = http.createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requestBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      response.setHeader("content-type", "application/json");
      if (requestBodies.length === 1) {
        response.end(JSON.stringify({ choices: [{ message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "not-allowed",
            type: "function",
            function: {
              name: "read_source",
              arguments: JSON.stringify({ url: "https://example.com/not-cited" })
            }
          }]
        } }] }));
        return;
      }
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify({ findings: [] }) } }] }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not expose a port");

    let readerCalls = 0;
    await runModelSpecialist({
      role: "privacy",
      sources: [{
        id: "root-1",
        title: "服务协议",
        url: "https://example.com/terms",
        sourceRole: "root",
        mediaType: "html",
        normalizedText: "服务协议正文。",
        fingerprint: "root-fingerprint",
        sections: [{ id: "root-section", heading: "正文", content: "服务协议正文。" }],
        linkedSources: [{ title: "隐私政策", url: "https://example.com/privacy" }],
        fetchedAt: new Date().toISOString(),
        status: "ready"
      }],
      context: { action: "register", concerns: ["data"], redlines: [], notes: "" },
      knowledge: { search: () => [] },
      readSource: async () => {
        readerCalls += 1;
        throw new Error("reader should not be called for an unlisted URL");
      },
      config: {
        apiKey: "test",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "test-model",
        reasoningEffort: "low",
        timeoutMs: 45_000,
        maxToolRounds: 2
      }
    });

    expect(readerCalls).toBe(0);
    expect((requestBodies[1]?.messages as Array<{ role: string; content?: string }>).some((message) =>
      message.role === "tool" && message.content?.includes("not present in linkedSources")
    )).toBe(true);
  });

  it("uses the native Responses format when configured", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const server = http.createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requestBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      response.setHeader("content-type", "application/json");
      if (requestBodies.length === 1) {
        response.end(JSON.stringify({
          output: [{
            type: "function_call",
            id: "fc-1",
            call_id: "call-1",
            name: "search_sources",
            arguments: JSON.stringify({ query: "自动续费" })
          }],
          usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 }
        }));
        return;
      }
      response.end(JSON.stringify({
        output: [{
          type: "message",
          content: [{ type: "output_text", text: JSON.stringify({ findings: [] }) }]
        }],
        usage: { input_tokens: 140, output_tokens: 30, total_tokens: 170 }
      }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not expose a port");

    const findings = await runModelSpecialist({
      role: "fees",
      sources: [{
        id: "source-1", title: "会员协议", mediaType: "text", normalizedText: "服务将自动续费。",
        fingerprint: "fixture", sections: [{ id: "section-1", heading: "续费", content: "服务将自动续费。" }],
        fetchedAt: new Date().toISOString(), status: "ready"
      }],
      context: { action: "pay", concerns: ["money"], redlines: [], notes: "" },
      knowledge: { search: () => [] },
      config: {
        apiKey: "test", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "gpt-5.6-terra",
        apiFormat: "responses", reasoningEffort: "low", timeoutMs: 45_000, maxToolRounds: 2
      }
    });

    expect(findings).toEqual([]);
    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0]?.messages).toBeUndefined();
    expect(requestBodies[0]?.input).toBeDefined();
    expect(requestBodies[0]?.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "function", name: "search_sources" })
    ]));
    expect(requestBodies[1]?.input).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "function_call_output", call_id: "call-1" })
    ]));
  });

  it("returns explicit tool errors instead of executing missing arguments", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const server = http.createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requestBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      response.setHeader("content-type", "application/json");
      if (requestBodies.length === 1) {
        response.end(JSON.stringify({
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "tool-empty",
                type: "function",
                function: { name: "search_sources", arguments: "{}" }
              }]
            }
          }]
        }));
        return;
      }
      response.end(JSON.stringify({
        choices: [{ message: { role: "assistant", content: JSON.stringify({ findings: [] }) } }]
      }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not expose a port");

    await runModelSpecialist({
      role: "privacy",
      sources: [],
      context: { action: "authorize", concerns: ["data"], redlines: [], notes: "" },
      knowledge: { search: () => [] },
      config: {
        apiKey: "test",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "test-model",
        reasoningEffort: "low",
        timeoutMs: 45_000,
        maxToolRounds: 2
      }
    });

    const secondMessages = requestBodies[1]?.messages as Array<{ role: string; content?: string }>;
    expect(secondMessages.find((message) => message.role === "tool")?.content)
      .toContain("missing required field: query");
  });

  it("lets the verifier consolidate semantically duplicate findings", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const server = http.createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        choices: [{
          message: {
            role: "assistant",
            content: JSON.stringify({
              decisions: [
                { findingId: "finding-a", status: "verified", confidence: 0.9, uncertainty: "" },
                { findingId: "finding-b", status: "verified", confidence: 0.88, uncertainty: "" }
              ],
              findings: [{
                sourceFindingIds: ["finding-a", "finding-b"],
                category: "content",
                title: "平台获得长期且不可撤回的内容使用许可",
                trigger: "用户发布内容时",
                platformAction: "平台可以长期使用内容并向第三方授权",
                userImpact: "内容后续使用范围可能超出用户预期",
                severity: "high",
                confidence: 0.88,
                actions: ["上传前核对授权期限和使用范围"],
                evidence: [{
                  sourceId: "source-1",
                  sectionId: "section-1",
                  quote: "平台可以永久使用您发布的内容并向第三方授权。"
                }],
                knowledgeRefs: [],
                uncertainty: ""
              }]
            })
          }
        }]
      }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not expose a port");

    const result = await runModelVerifier({
      findings: [
        {
          id: "finding-a", category: "content", title: "内容授权期限很长", trigger: "发布内容时",
          platformAction: "平台可以长期使用内容", userImpact: "内容可能被持续使用", severity: "high", confidence: 0.9,
          actions: ["核对授权范围"], evidence: [{ sourceId: "source-1", sectionId: "section-1", quote: "平台可以永久使用您发布的内容并向第三方授权。", verified: false }],
          knowledgeRefs: [], uncertainty: "", status: "needs_verification"
        },
        {
          id: "finding-b", category: "content", title: "发布内容可被平台继续使用", trigger: "上传内容时",
          platformAction: "平台可以继续使用发布内容", userImpact: "用户可能无法限制后续使用", severity: "high", confidence: 0.88,
          actions: ["核对是否可以撤回"], evidence: [{ sourceId: "source-1", sectionId: "section-1", quote: "平台可以永久使用您发布的内容并向第三方授权。", verified: false }],
          knowledgeRefs: [], uncertainty: "", status: "needs_verification"
        }
      ],
      sources: [{
        id: "source-1", title: "用户协议", mediaType: "text", normalizedText: "平台可以永久使用您发布的内容并向第三方授权。",
        fingerprint: "fixture", fetchedAt: new Date().toISOString(), status: "ready",
        sections: [{ id: "section-1", heading: "内容授权", content: "平台可以永久使用您发布的内容并向第三方授权。" }]
      }],
      knowledge: { search: () => [] },
      config: {
        apiKey: "test", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model",
        reasoningEffort: "low", timeoutMs: 45_000, maxToolRounds: 1
      }
    });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.sourceFindingIds).toEqual(["finding-a", "finding-b"]);
    const systemPrompt = ((requestBody?.messages as Array<{ role: string; content?: string }>) ?? [])
      .find((message) => message.role === "system")?.content ?? "";
    expect(systemPrompt).toContain("不要使用关键词、标题相似度或任何固定规则");
  });

  it("forces a final answer after the configured tool rounds instead of failing", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const server = http.createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      requestBodies.push(body);
      response.setHeader("content-type", "application/json");
      if (requestBodies.length === 1) {
        response.end(JSON.stringify({
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "tool-1",
                type: "function",
                function: { name: "search_sources", arguments: "{\"query\":\"自动续费\"}" }
              }]
            }
          }]
        }));
        return;
      }
      response.end(JSON.stringify({
        choices: [{ message: { role: "assistant", content: JSON.stringify({ findings: [] }) } }]
      }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not expose a port");

    const findings = await runModelSpecialist({
      role: "fees",
      sources: [{
        id: "source-1", title: "会员协议", mediaType: "text", normalizedText: "服务将自动续费。",
        fingerprint: "fixture", sections: [{ id: "section-1", heading: "续费", content: "服务将自动续费。" }],
        fetchedAt: new Date().toISOString(), status: "ready"
      }],
      context: { action: "pay", concerns: ["money"], redlines: [], notes: "" },
      knowledge: { search: () => [] },
      config: {
        apiKey: "test", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model",
        reasoningEffort: "low", timeoutMs: 45_000, maxToolRounds: 1
      }
    });

    expect(findings).toEqual([]);
    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0]?.tools).toBeDefined();
    expect(requestBodies[0]?.stream).toBe(false);
    expect(requestBodies[1]?.tools).toBeUndefined();
    expect(requestBodies[1]?.stream).toBe(true);
    const finalMessages = requestBodies[1]?.messages as Array<{ role: string; content?: string }>;
    expect(finalMessages.at(-1)?.content).toContain("工具调用阶段已经结束");
  });

  it("returns complete large source sections to the model without a 30k truncation", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const server = http.createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requestBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      response.setHeader("content-type", "application/json");
      if (requestBodies.length === 1) {
        response.end(JSON.stringify({
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "tool-full-section",
                type: "function",
                function: {
                  name: "read_source",
                  arguments: JSON.stringify({ sourceId: "source-1", sectionId: "section-1" })
                }
              }]
            }
          }]
        }));
        return;
      }
      response.end(JSON.stringify({
        choices: [{ message: { role: "assistant", content: JSON.stringify({ findings: [] }) } }]
      }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not expose a port");

    const largeText = `${"个人信息处理规则。".repeat(5_000)}末尾核验标记。`;
    await runModelSpecialist({
      role: "privacy",
      sources: [{
        id: "source-1",
        title: "隐私政策",
        mediaType: "text",
        normalizedText: largeText,
        fingerprint: "fixture",
        sections: [{ id: "section-1", heading: "正文", content: largeText }],
        fetchedAt: new Date().toISOString(),
        status: "ready"
      }],
      context: { action: "authorize", concerns: ["data"], redlines: [], notes: "" },
      knowledge: { search: () => [] },
      config: {
        apiKey: "test",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "test-model",
        reasoningEffort: "low",
        timeoutMs: 45_000,
        maxToolRounds: 2
      }
    });

    const messages = requestBodies[1]?.messages as Array<{ role: string; content?: string }>;
    const toolMessage = messages.find((message) => message.role === "tool");
    expect(toolMessage?.content?.length).toBeGreaterThan(30_000);
    expect(toolMessage?.content).toContain("末尾核验标记");
  });

  it("normalizes common specialist type drift before schema validation", async () => {
    const server = http.createServer(async (_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        choices: [{
          message: {
            role: "assistant",
            content: JSON.stringify({
              findings: [{
                category: "money",
                title: "自动续费",
                trigger: "开通时",
                platformAction: "到期扣款",
                userImpact: "可能产生非预期费用",
                severity: "high",
                confidence: "high",
                actions: "提前关闭续费",
                evidence: {
                  sourceId: "source-1",
                  sectionId: "section-1",
                  quote: "服务将在到期后自动续费。"
                },
                knowledgeRefs: "kb-1",
                uncertainty: ""
              }]
            })
          }
        }]
      }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not expose a port");

    const findings = await runModelSpecialist({
      role: "fees",
      sources: [{
        id: "source-1",
        title: "会员协议",
        mediaType: "text",
        normalizedText: "服务将在到期后自动续费。",
        fingerprint: "fixture",
        sections: [{ id: "section-1", heading: "续费", content: "服务将在到期后自动续费。" }],
        fetchedAt: new Date().toISOString(),
        status: "ready"
      }],
      context: { action: "pay", concerns: ["money"], redlines: [], notes: "" },
      knowledge: { search: () => [] },
      config: {
        apiKey: "test",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "test-model",
        reasoningEffort: "low",
        timeoutMs: 45_000,
        maxToolRounds: 1
      }
    });

    expect(findings[0]?.confidence).toBe(0.85);
    expect(findings[0]?.actions).toEqual(["提前关闭续费"]);
    expect(findings[0]?.evidence).toHaveLength(1);
    expect(findings[0]?.knowledgeRefs).toEqual(["kb-1"]);
  });

  it("reads streamed output and repairs invalid JSON in the same conversation", async () => {
    let calls = 0;
    const requestBodies: Array<Record<string, unknown>> = [];
    const server = http.createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requestBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      calls++;
      response.statusCode = 200;
      response.setHeader("content-type", "text/event-stream");
      const content = calls === 1
        ? JSON.stringify({ findings: [{ category: "money" }] })
        : JSON.stringify({
          findings: [{
            category: "money", title: "自动续费", trigger: "开通时",
            platformAction: "到期扣款", userImpact: "可能产生费用", severity: "high",
            confidence: 0.8, actions: ["提前关闭"], evidence: [{
              sourceId: "source-1", sectionId: "section-1", quote: "服务将自动续费。"
            }], knowledgeRefs: [], uncertainty: ""
          }]
        });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: content.slice(0, 20) } }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: content.slice(20) } }] })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not expose a port");

    const findings = await runModelSpecialist({
      role: "fees",
      sources: [{
        id: "source-1", title: "会员协议", mediaType: "text", normalizedText: "服务将自动续费。",
        fingerprint: "fixture", sections: [{ id: "section-1", heading: "续费", content: "服务将自动续费。" }],
        fetchedAt: new Date().toISOString(), status: "ready"
      }],
      context: { action: "pay", concerns: ["money"], redlines: [], notes: "" },
      knowledge: { search: () => [] },
      config: {
        apiKey: "test", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model",
        reasoningEffort: "low", timeoutMs: 45_000, maxToolRounds: 2
      }
    });
    expect(findings[0]?.title).toBe("自动续费");
    expect(requestBodies[0]?.stream).toBe(false);
    expect((requestBodies[1]?.messages as Array<{ role: string }>).some((message) => message.role === "assistant")).toBe(true);
    expect((requestBodies[1]?.messages as Array<{ role: string; content?: string }>).at(-1)?.content).toContain("校验错误");
  });

  it("repairs gateways that split tool arguments into an unnamed streamed call", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const server = http.createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requestBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      response.statusCode = 200;
      response.setHeader("content-type", "text/event-stream");
      if (requestBodies.length === 1) {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{
          index: 0, id: "call-1", type: "function", function: { name: "read_source", arguments: "" }
        }] } }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{
          index: 0, function: { arguments: "{}" }
        }] } }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{
          index: 1, id: "call-2", type: "function", function: {
            arguments: JSON.stringify({ sourceId: "source-1", sectionId: "section-1" })
          }
        }] }, finish_reason: "tool_calls" }] })}\n\n`);
        response.end("data: [DONE]\n\n");
        return;
      }
      response.write(`data: ${JSON.stringify({ choices: [{ delta: {
        content: JSON.stringify({ findings: [] })
      } }] })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not expose a port");

    await runModelSpecialist({
      role: "privacy",
      sources: [{
        id: "source-1", title: "隐私政策", mediaType: "text",
        normalizedText: "平台会处理个人信息。",
        fingerprint: "fixture",
        sections: [{ id: "section-1", heading: "信息处理", content: "平台会处理个人信息。" }],
        fetchedAt: new Date().toISOString(), status: "ready"
      }],
      context: { action: "authorize", concerns: ["data"], redlines: [], notes: "" },
      knowledge: { search: () => [] },
      config: {
        apiKey: "test", baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "test-model",
        reasoningEffort: "low", timeoutMs: 45_000, maxToolRounds: 2
      }
    });

    expect(requestBodies).toHaveLength(2);
    const secondMessages = requestBodies[1]?.messages as Array<{
      role: string;
      content?: string;
      tool_calls?: Array<{ function: { name: string; arguments: string } }>;
    }>;
    const assistant = secondMessages.find((message) => message.role === "assistant");
    expect(assistant?.tool_calls).toHaveLength(1);
    expect(assistant?.tool_calls?.[0]?.function.name).toBe("read_source");
    expect(assistant?.tool_calls?.[0]?.function.arguments).toBe(JSON.stringify({
      sourceId: "source-1", sectionId: "section-1"
    }));
    expect(secondMessages.find((message) => message.role === "tool")?.content).toContain("平台会处理个人信息");
  });

  it("retries transient empty streamed responses with a fresh final-answer instruction", async () => {
    let calls = 0;
    const progress: Array<{ retries?: number }> = [];
    const requestBodies: Array<Record<string, unknown>> = [];
    const server = http.createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requestBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      calls++;
      response.setHeader("content-type", "text/event-stream");
      if (calls < 3) {
        response.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
        return;
      }
      const content = JSON.stringify({ findings: [] });
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not expose a port");

    const findings = await runModelSpecialist({
      role: "privacy",
      sources: [],
      context: { action: "authorize", concerns: ["data"], redlines: [], notes: "" },
      knowledge: { search: () => [] },
      config: {
        apiKey: "test",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "test-model",
        reasoningEffort: "low",
        timeoutMs: 45_000,
        maxToolRounds: 2,
        maxRetries: 2,
        agentName: "privacy",
        onProgress: ({ progress: update }) => progress.push(update)
      }
    });

    expect(findings).toEqual([]);
    expect(calls).toBe(3);
    const retryMessages = requestBodies[1]?.messages as Array<{ role: string; content?: string }>;
    expect(retryMessages.at(-1)?.content).toContain("没有返回任何可见内容");
    expect(retryMessages.some((message) => message.role === "assistant" && !message.content)).toBe(false);
    expect(progress.some((update) => update.retries === 1)).toBe(true);
    expect(progress.some((update) => update.retries === 2)).toBe(true);
  });

  it("keeps the complete native Gemini history when a relay omits the model role", async () => {
    let calls = 0;
    const requestBodies: Array<Record<string, unknown>> = [];
    const requestPaths: string[] = [];
    const sentinel = "SENTINEL-7f4c2a-只存在于完整协议正文";
    const sourceText = `${"协议目录和一般说明。".repeat(40)}${sentinel}`;
    const server = http.createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requestPaths.push(request.url ?? "");
      requestBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      calls++;
      response.setHeader("content-type", "application/json");
      if (calls === 1) {
        response.end(JSON.stringify({
          candidates: [{
            content: {
              parts: [{
                functionCall: {
                  name: "read_source",
                  args: { sourceId: "source-1", sectionId: "section-1" },
                  id: "gemini-call-1"
                },
                thoughtSignature: "opaque-gemini-signature"
              }]
            }
          }]
        }));
        return;
      }
      const currentRequest = requestBodies.at(-1);
      const hasShadowTranscript = ((currentRequest?.contents ?? []) as Array<{
        role?: string;
        parts?: Array<{ text?: string }>;
      }>).some((content) => content.role === "user"
        && content.parts?.some((part) =>
          part.text?.includes("以下是本轮已实际执行的工具返回结果")
          && part.text.includes(sentinel)
        ));
      if (!hasShadowTranscript) {
        response.statusCode = 400;
        response.end(JSON.stringify({ error: { message: "The native request did not contain the shadow tool transcript." } }));
        return;
      }
      response.end(JSON.stringify({
        candidates: [{
          content: {
            role: "model",
            parts: [{
              text: JSON.stringify({
                findings: [{
                  category: "money",
                  title: sentinel,
                  trigger: "用户使用服务",
                  platformAction: "平台保留相关处理权",
                  userImpact: "用户需要了解该项安排",
                  severity: "medium",
                  confidence: 0.8,
                  actions: ["阅读完整条款"],
                  evidence: [{
                    sourceId: "source-1",
                    sectionId: "section-1",
                    quote: sentinel
                  }],
                  knowledgeRefs: [],
                  uncertainty: ""
                }]
              })
            }]
          }
        }]
      }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not expose a port");

    const findings = await runModelSpecialist({
      role: "fees",
      sources: [{
        id: "source-1",
        title: "会员协议",
        mediaType: "text",
        normalizedText: sourceText,
        fingerprint: "fixture",
        sections: [{ id: "section-1", heading: "续费", content: sourceText }],
        fetchedAt: new Date().toISOString(),
        status: "ready"
      }],
      context: { action: "pay", concerns: ["money"], redlines: [], notes: "" },
      knowledge: { search: () => [] },
      config: {
        apiKey: "test",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "gemini-test",
        apiFormat: "gemini",
        reasoningEffort: "low",
        timeoutMs: 45_000,
        maxToolRounds: 2,
        agentName: "fees"
      }
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.title).toBe(sentinel);
    expect(calls).toBe(2);
    expect(requestPaths).toEqual([
      "/v1beta/models/gemini-test:generateContent",
      "/v1beta/models/gemini-test:generateContent"
    ]);
    expect(requestBodies[0]?.tools).toBeDefined();
    expect(requestBodies[0]?.systemInstruction).toBeDefined();
    expect(requestBodies[1]).toMatchObject({
      contents: expect.any(Array)
    });
    const secondContents = requestBodies[1]?.contents as Array<{
      role: string;
      parts: Array<{
        text?: string;
        functionCall?: { name?: string };
        functionResponse?: { name?: string; id?: string; response?: { output?: unknown } };
      }>;
    }>;
    expect(secondContents.some((content) => content.role === "user"
      && content.parts.some((part) => part.text?.includes("\"sourceCatalog\"")))).toBe(true);
    expect(secondContents.some((content) => content.role === "model"
      && content.parts.some((part) => part.functionCall?.name === "read_source"))).toBe(true);
    expect(secondContents.some((content) => content.role === "user"
      && content.parts.some((part) => part.text?.includes("以下是本轮已实际执行的工具返回结果")
        && part.text.includes(sentinel)))).toBe(true);
    expect(secondContents.some((content) => content.role === "user"
      && content.parts.some((part) => part.functionResponse?.name === "read_source"
        && part.functionResponse.id === "gemini-call-1"
        && JSON.stringify(part.functionResponse.response?.output).includes(sentinel)))).toBe(true);
  });

  it("returns an explicit native Gemini no-match result instead of an empty array", async () => {
    let calls = 0;
    const requestBodies: Array<Record<string, unknown>> = [];
    const server = http.createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requestBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      calls++;
      response.setHeader("content-type", "application/json");
      if (calls === 1) {
        response.end(JSON.stringify({
          candidates: [{
            content: {
              role: "model",
              parts: [{
                functionCall: {
                  name: "search_sources",
                  args: { query: "不存在的费用规则", limit: 3 },
                  id: "gemini-call-no-match"
                }
              }]
            }
          }]
        }));
        return;
      }
      const toolResponse = JSON.stringify(requestBodies.at(-1));
      if (!toolResponse.includes("\"matchCount\":0") || !toolResponse.includes("No supplied source section matched")) {
        response.statusCode = 400;
        response.end(JSON.stringify({ error: { message: "Missing explicit no-match function response." } }));
        return;
      }
      response.end(JSON.stringify({
        candidates: [{
          content: {
            role: "model",
            parts: [{ text: JSON.stringify({ findings: [] }) }]
          }
        }]
      }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not expose a port");

    const findings = await runModelSpecialist({
      role: "fees",
      sources: [{
        id: "source-1",
        title: "账户说明",
        mediaType: "text",
        normalizedText: "这份材料只说明头像和通知设置。",
        fingerprint: "fixture",
        sections: [{ id: "section-1", heading: "设置", content: "这份材料只说明头像和通知设置。" }],
        fetchedAt: new Date().toISOString(),
        status: "ready"
      }],
      context: { action: "register", concerns: ["money"], redlines: [], notes: "" },
      knowledge: { search: () => [] },
      config: {
        apiKey: "test",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "gemini-test",
        apiFormat: "gemini",
        reasoningEffort: "low",
        timeoutMs: 45_000,
        maxToolRounds: 2,
        agentName: "fees"
      }
    });

    expect(findings).toEqual([]);
    expect(calls).toBe(2);
  });

  it("does not present inline materials as an exhausted tool budget", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const progress: Array<{ message?: string }> = [];
    const server = http.createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        choices: [{ message: { role: "assistant", content: JSON.stringify({ findings: [] }) } }]
      }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not expose a port");

    const findings = await runModelSpecialist({
      role: "fees",
      sources: [],
      context: { action: "pay", concerns: ["money"], redlines: [], notes: "" },
      knowledge: { search: () => [] },
      config: {
        apiKey: "test",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "test-model",
        toolMode: "inline",
        reasoningEffort: "low",
        timeoutMs: 45_000,
        maxToolRounds: 100,
        agentName: "fees",
        onProgress: ({ progress: update }) => progress.push(update)
      }
    });

    expect(findings).toEqual([]);
    expect(requestBody?.tools).toBeUndefined();
    const messages = requestBody?.messages as Array<{ content?: string }>;
    expect(messages.some((message) => message.content?.includes("工具调用阶段已经结束"))).toBe(false);
    expect(progress.some((update) => update.message === "正在根据已提供的协议材料生成答案")).toBe(true);
  });

  it("turns an accidental integrator JSON response into a natural follow-up answer", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const server = http.createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        choices: [{
          message: {
            role: "assistant",
            content: JSON.stringify({
              recommendation: "adjust first",
              recommendationReason: "条款没有说明取消通知会导致既有材料下架，处理范围仍不明确。",
              topFindingIds: ["finding-1"],
              actionChecklist: ["核对取消通知的生效时间和既有材料处理规则。"],
              followUpSuggestions: ["平台是否必须删除已发布的改编内容？"]
            })
          }
        }]
      }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not expose a port");

    const response = await runModelFollowUp({
      result: { recommendation: "pause", recommendationReason: "需要核验", findings: [] },
      message: "请核对取消服务后既有材料是否需要下架？",
      session: {
        model: "test-model",
        messages: [
          { role: "system", content: "初次整合时只返回 JSON。" },
          { role: "user", content: "Return JSON." },
          { role: "assistant", content: "{\"recommendation\":\"pause\"}" }
        ]
      },
      sources: [],
      knowledge: { search: () => [] },
      config: {
        apiKey: "test",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "test-model",
        reasoningEffort: "low",
        timeoutMs: 45_000,
        maxToolRounds: 1
      }
    });

    expect(response.answer).toContain("结论：先调整后再决定");
    expect(response.answer).toContain("既有材料下架");
    expect(response.answer).not.toContain("\"recommendation\"");
    const messages = requestBody?.messages as Array<{ role: string; content?: string }>;
    expect(messages.some((message) => message.role === "system" && message.content?.includes("FOLLOW_UP_CONVERSATION_MODE"))).toBe(true);
  });
});
