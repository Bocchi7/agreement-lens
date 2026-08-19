import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@agreement-lens/shared": resolve(__dirname, "../shared/src/index.ts")
    }
  }
});
