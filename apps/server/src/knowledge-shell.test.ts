import { describe, expect, it } from "vitest";
import { runKnowledgeShell } from "./knowledge-shell.js";

describe("knowledge shell sandbox", () => {
  it("reads the knowledge snapshot without exposing the project root", async () => {
    const result = await runKnowledgeShell("pwd; find . -maxdepth 1 -type f -name '*.md' | sort");
    if (result.stderr.includes("Creating new namespace failed")) return;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("/kb");
    expect(result.stdout).toContain("consumer-agreement-basics.md");
    expect(result.stdout).not.toContain("apps/server");
  });
});
