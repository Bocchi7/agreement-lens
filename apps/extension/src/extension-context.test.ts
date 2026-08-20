import { describe, expect, it, vi } from "vitest";
import { hasLiveExtensionContext, isExtensionContextInvalidated } from "./extension-context";

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
});
