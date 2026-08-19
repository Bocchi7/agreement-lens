import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@agreement-lens/shared": resolve(__dirname, "../../packages/shared/src/index.ts"),
      "@agreement-lens/agent-core": resolve(__dirname, "../../packages/agent-core/src/index.ts")
    }
  }
});
