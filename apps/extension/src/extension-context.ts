export const CONTENT_SCRIPT_VERSION = "2026-08-20-context-migration-v8";

export type ContentScriptRuntimeState = {
  hasController: boolean;
  hasLoadedMarker: boolean;
  contentVersion?: string;
};

export function requiresContentScriptMigration(state: ContentScriptRuntimeState): boolean {
  if (state.hasController) return false;
  return state.hasLoadedMarker
    || Boolean(state.contentVersion && state.contentVersion !== CONTENT_SCRIPT_VERSION);
}

export function isExtensionContextInvalidated(error: unknown): boolean {
  const messages: string[] = [];
  let current: unknown = error;
  const visited = new Set<object>();
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
    if (typeof current === "object") {
      if (visited.has(current)) break;
      visited.add(current);
      const record = current as { message?: unknown; name?: unknown; stack?: unknown; cause?: unknown };
      for (const value of [record.message, record.name, record.stack]) {
        if (typeof value === "string") messages.push(value);
      }
      current = record.cause;
      continue;
    }
    messages.push(String(current));
    break;
  }
  if (!messages.length) messages.push(String(error));
  return messages.some((message) => /extension context invalidated/i.test(message));
}

export function hasLiveExtensionContext(): boolean {
  try {
    return typeof chrome !== "undefined" && Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}
