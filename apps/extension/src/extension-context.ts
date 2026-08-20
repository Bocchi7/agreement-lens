export function isExtensionContextInvalidated(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /extension context invalidated/i.test(message);
}

export function hasLiveExtensionContext(): boolean {
  try {
    return typeof chrome !== "undefined" && Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}
