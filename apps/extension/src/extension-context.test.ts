import { describe, expect, it, vi } from "vitest";
import {
  CONTENT_SCRIPT_VERSION,
  hasLiveExtensionContext,
  isExtensionContextInvalidated,
  requiresContentScriptMigration
} from "./extension-context";

describe("extension context helpers", () => {
  it("recognizes the error emitted after an extension reload", () => {
    expect(isExtensionContextInvalidated(new Error("Extension context invalidated."))).toBe(true);
    expect(isExtensionContextInvalidated({ message: "Extension context invalidated." })).toBe(true);
    expect(isExtensionContextInvalidated({ cause: { message: "Extension context invalidated." } })).toBe(true);
    expect(isExtensionContextInvalidated(new Error("Could not establish connection."))).toBe(false);
  });

  it("reports a missing runtime as unavailable without throwing", () => {
    vi.stubGlobal("chrome", { runtime: {} });
    expect(hasLiveExtensionContext()).toBe(false);
    vi.unstubAllGlobals();
  });

  it("requires a page reload for legacy scripts without a disposer", () => {
    expect(requiresContentScriptMigration({
      hasController: false,
      hasLoadedMarker: true
    })).toBe(true);
    expect(requiresContentScriptMigration({
      hasController: false,
      hasLoadedMarker: false,
      contentVersion: "2026-08-19-cross-frame-discovery-v5"
    })).toBe(true);
    expect(requiresContentScriptMigration({
      hasController: true,
      hasLoadedMarker: true,
      contentVersion: "2026-08-19-cross-frame-discovery-v5"
    })).toBe(false);
    expect(requiresContentScriptMigration({
      hasController: false,
      hasLoadedMarker: false,
      contentVersion: CONTENT_SCRIPT_VERSION
    })).toBe(false);
  });
});
