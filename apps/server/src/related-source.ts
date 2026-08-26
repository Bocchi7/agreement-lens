import { randomUUID } from "node:crypto";
import {
  canonicalSourceUrl,
  maxSourceDocuments,
  type SourceDocument
} from "@agreement-lens/shared";
import type {
  ReadSourceResult,
  ReadSourceRequest,
  SourceReader
} from "@agreement-lens/agent-core";
import { validateRemoteUrl } from "./security.js";
import { loadSource } from "./sources.js";

function sourceKey(value: string): string {
  try {
    const url = new URL(canonicalSourceUrl(value));
    return `${url.hostname.toLocaleLowerCase()}${url.port ? `:${url.port}` : ""}${url.pathname}${url.search}${url.hash}`
      .replace(/\/+$/, "");
  } catch {
    return value;
  }
}

function defaultTitle(value: string): string {
  const url = new URL(value);
  return url.pathname.split("/").filter(Boolean).pop() || url.hostname;
}

export function createSourceReader(
  sources: SourceDocument[],
  limit = maxSourceDocuments
): SourceReader {
  const pending = new Map<string, Promise<ReadSourceResult>>();

  return async (request: ReadSourceRequest): Promise<ReadSourceResult> => {
    if (request.sourceId) {
      const source = sources.find((item) => item.id === request.sourceId);
      if (!source) throw new Error("已注册来源不存在");
      return { source, reused: true, loadedNewSource: false };
    }
    if (!request.url) throw new Error("读取新来源时必须提供 URL");
    const validated = await validateRemoteUrl(canonicalSourceUrl(request.url));
    const normalizedUrl = validated.href;
    const key = sourceKey(normalizedUrl);
    const existing = sources.find((source) => source.url && sourceKey(source.url) === key);
    if (existing) return { source: existing, reused: true, loadedNewSource: false };

    const inFlight = pending.get(key);
    if (inFlight) return inFlight;
    if (sources.length >= limit) {
      throw new Error(`来源注册表已达到 ${limit} 份材料上限，无法读取新的引用来源`);
    }

    const sourceId = randomUUID();
    const task = (async () => {
      const loaded = await loadSource({
        id: sourceId,
        kind: /\.pdf(?:$|[?#])/i.test(normalizedUrl) ? "pdf" : "url",
        title: request.title?.trim() || defaultTitle(normalizedUrl),
        url: normalizedUrl,
        selected: true,
        relation: "direct"
      });
      if (loaded.status === "failed" || loaded.normalizedText.trim().length === 0) {
        throw new Error(loaded.error ?? "引用来源未取得有效正文");
      }
      const source: SourceDocument = {
        ...loaded,
        sourceRole: "related",
        ...(request.parentSourceId ? { parentSourceId: request.parentSourceId } : {})
      };
      const duplicate = sources.find((item) => item.url && sourceKey(item.url) === key);
      if (duplicate) return { source: duplicate, reused: true, loadedNewSource: false };
      sources.push(source);
      return { source, reused: false, loadedNewSource: true };
    })();
    pending.set(key, task);
    try {
      return await task;
    } finally {
      pending.delete(key);
    }
  };
}
