import type { DiscoveredSource } from "@agreement-lens/shared";

export interface PageSnapshot {
  tabId: number;
  pageUrl: string;
  pageTitle: string;
  origin: string;
  sources: DiscoveredSource[];
  scannedAt: string;
  pendingRecheck?: { analysisId: string; jobId: string };
}

export type ExtensionMessage =
  | { type: "SCAN_PAGE" }
  | { type: "PAGE_DISCOVERED"; payload: PageSnapshot }
  | { type: "PAGE_STATE_UPDATED"; payload: PageSnapshot }
  | { type: "GET_PAGE_STATE" }
  | { type: "HIGHLIGHT_EVIDENCE"; quote: string }
  | {
      type: "FETCH_AGREEMENT_SOURCES";
      sources: Array<{ id: string; url: string; kind: "url" | "pdf" }>;
    };
