export interface BadgeController {
  tabs: {
    get(tabId: number): Promise<unknown>;
  };
  action: {
    setBadgeText(details: { tabId: number; text: string }): Promise<void>;
    setBadgeBackgroundColor(details: { tabId: number; color: string }): Promise<void>;
  };
}

export async function setTabBadge(
  controller: BadgeController,
  tabId: number,
  text: string,
  color: string
): Promise<void> {
  try {
    await controller.tabs.get(tabId);
    await controller.action.setBadgeText({ tabId, text });
    await controller.action.setBadgeBackgroundColor({ tabId, color });
  } catch (error) {
    // A tab may close while a background analysis is still running.
    if (!/No tab with id/i.test(error instanceof Error ? error.message : String(error))) {
      console.debug("[agreement-lens] badge update skipped", error);
    }
  }
}
