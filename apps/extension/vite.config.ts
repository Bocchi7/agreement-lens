import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

const wrapContentScript: Plugin = {
  name: "wrap-content-script",
  renderChunk(code, chunk) {
    if (chunk.name !== "content") return null;
    return {
      code: `(() => {\n${code}\n})();`,
      map: null
    };
  }
};

export default defineConfig({
  plugins: [react(), wrapContentScript],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        sidepanel: resolve(__dirname, "sidepanel.html"),
        background: resolve(__dirname, "src/background.ts"),
        content: resolve(__dirname, "src/content.ts")
      },
      output: {
        entryFileNames: (chunk) => chunk.name === "sidepanel" ? "assets/[name]-[hash].js" : "[name].js"
      }
    }
  }
});
