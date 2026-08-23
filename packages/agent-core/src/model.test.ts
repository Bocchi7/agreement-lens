import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { modelConfigFromEnv, runModelFollowUp, runModelSpecialist, runModelVerifier } from "./model.js";

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("OpenAI-compatible model adapter", () => {
  it("resolves an API key referenced from another environment variable", () => {
    const previousKey = process.env.OPENAI_API_KEY;
    const previousReferencedKey = process.env.TEST_MODEL_API_KEY;
    try {
      process.env.OPENAI_API_KEY = "$TEST_MODEL_API_KEY";
      process.env.TEST_MODEL_API_KEY = "resolved-secret";
      expect(modelConfigFromEnv()?.apiKey).toBe("resolved-secret");
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
    }
  });

  it("executes native tool calls and validates the final specialist schema", async () => {
    let calls = 0;
    const progress: Array<{ rounds?: number; retries?: number; message?: string }> = [];
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
        onProgress: ({ progress: update }) => progress.push(update)
      }
    });

    expect(calls).toBe(2);
    expect(requestBodies[0]?.reasoning_effort).toBe("low");
    const firstMessages = requestBodies[0]?.messages as Array<{ role: string; content?: string }>;
    const systemPrompt = firstMessages.find((message) => message.role === "system")?.content ?? "";
    expect(systemPrompt).toContain("confidence is a JSON number from 0 to 1");
    expect(systemPrompt).toContain("Never use qualitative confidence labels");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.evidence[0]?.quote).toContain("自动续费");
    expect(progress.some((update) => update.rounds === 1)).toBe(true);
    expect(progress.some((update) => update.rounds === 2)).toBe(true);
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
    expect(requestBodies[1]?.tools).toBeUndefined();
    const finalMessages = requestBodies[1]?.messages as Array<{ role: string; content?: string }>;
    expect(finalMessages.at(-1)?.content).toContain("工具调用阶段已经结束");
  });

  it("forces a final answer when the model repeats the same tool request", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const server = http.createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requestBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      response.setHeader("content-type", "application/json");
      if (requestBodies.length <= 3) {
        response.end(JSON.stringify({
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: `repeated-tool-${requestBodies.length}`,
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
        reasoningEffort: "low", timeoutMs: 45_000, maxToolRounds: 100
      }
    });

    expect(findings).toEqual([]);
    expect(requestBodies).toHaveLength(4);
    expect(requestBodies[3]?.tools).toBeUndefined();
    const finalMessages = requestBodies[3]?.messages as Array<{ role: string; content?: string }>;
    expect(finalMessages.at(-1)?.content).toContain("工具调用阶段已经结束");
    expect(finalMessages.some((message) => message.role === "tool" && message.content?.includes("already been executed twice"))).toBe(true);
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
                  name: "read_source_section",
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
    expect(requestBodies[0]?.stream).toBe(true);
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
          index: 0, id: "call-1", type: "function", function: { name: "read_source_section", arguments: "" }
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
    expect(assistant?.tool_calls?.[0]?.function.name).toBe("read_source_section");
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
