import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, "../../..");

try {
  process.loadEnvFile(path.join(repoRoot, ".env"));
} catch {
  // The local model configuration is optional.
}

export const dataDir = process.env.DATA_DIR ?? path.join(repoRoot, "data");
export const appDbPath = process.env.APP_DB_PATH ?? path.join(dataDir, "app.db");
export const knowledgeDbPath = process.env.KNOWLEDGE_DB_PATH ?? path.join(dataDir, "knowledge.db");
export const snapshotDir = path.join(dataDir, "snapshots");
export const serverPort = Number(process.env.PORT ?? 4317);
export const allowedExtensionId = process.env.EXTENSION_ID ?? "";
