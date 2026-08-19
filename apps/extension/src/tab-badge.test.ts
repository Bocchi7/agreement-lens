import { describe, expect, it, vi } from "vitest";
import { setTabBadge } from "./tab-badge";

describe("tab badge updates", () => {
  it("ignores a tab that was closed before the badge update", async () => {
    const setBadgeText = vi.fn(async () => undefined);
    const setBadgeBackgroundColor = vi.fn(async () => undefined);
    const controller = {
      tabs: { get: vi.fn(async () => { throw new Error("No tab with id: 1407355873."); }) },
      action: { setBadgeText, setBadgeBackgroundColor }
    };

    await expect(setTabBadge(controller, 1407355873, "…", "#9b6c24")).resolves.toBeUndefined();
    expect(setBadgeText).not.toHaveBeenCalled();
    expect(setBadgeBackgroundColor).not.toHaveBeenCalled();
  });

  it("updates the badge while the tab is still available", async () => {
    const controller = {
      tabs: { get: vi.fn(async () => ({ id: 12 })) },
      action: {
        setBadgeText: vi.fn(async () => undefined),
        setBadgeBackgroundColor: vi.fn(async () => undefined)
      }
    };

    await setTabBadge(controller, 12, "…", "#9b6c24");
    expect(controller.action.setBadgeText).toHaveBeenCalledWith({ tabId: 12, text: "…" });
    expect(controller.action.setBadgeBackgroundColor).toHaveBeenCalledWith({ tabId: 12, color: "#9b6c24" });
  });

  it("also ignores a tab that disappears between lookup and update", async () => {
    const controller = {
      tabs: { get: vi.fn(async () => ({ id: 12 })) },
      action: {
        setBadgeText: vi.fn(async () => {
          throw new Error("No tab with id: 12.");
        }),
        setBadgeBackgroundColor: vi.fn(async () => undefined)
      }
    };

    await expect(setTabBadge(controller, 12, "…", "#9b6c24")).resolves.toBeUndefined();
    expect(controller.action.setBadgeBackgroundColor).not.toHaveBeenCalled();
  });
});
