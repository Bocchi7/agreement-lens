import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import matter from "gray-matter";
import { createHash } from "node:crypto";
import { knowledgeDbPath, repoRoot } from "./config.js";

const inputDir = path.join(repoRoot, "knowledge");
fs.mkdirSync(path.dirname(knowledgeDbPath), { recursive: true });
if (fs.existsSync(knowledgeDbPath)) fs.unlinkSync(knowledgeDbPath);
const db = new Database(knowledgeDbPath);
db.exec(`
  CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE knowledge_docs (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    source TEXT NOT NULL,
    jurisdiction TEXT,
    document_type TEXT,
    effective_date TEXT,
    source_url TEXT,
    body_hash TEXT NOT NULL,
    metadata_json TEXT NOT NULL
  );
  CREATE VIRTUAL TABLE knowledge_fts USING fts5(id UNINDEXED, title, body, source, tokenize='trigram');
`);
const insert = db.prepare("INSERT INTO knowledge_fts (id, title, body, source) VALUES (?, ?, ?, ?)");
const insertDocument = db.prepare(`
  INSERT INTO knowledge_docs
  (id, title, source, jurisdiction, document_type, effective_date, source_url, body_hash, metadata_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
let count = 0;
for (const file of fs.existsSync(inputDir) ? fs.readdirSync(inputDir).filter((name) => name.endsWith(".md")) : []) {
  const raw = fs.readFileSync(path.join(inputDir, file), "utf8");
  const parsed = matter(raw);
  const id = parsed.data.id ?? file.replace(/\.md$/, "");
  const title = parsed.data.title ?? file;
  const source = parsed.data.source ?? "local";
  const body = parsed.content.trim();
  insertDocument.run(
    id,
    title,
    source,
    parsed.data.jurisdiction ?? null,
    parsed.data.document_type ?? null,
    parsed.data.effective_date ?? null,
    parsed.data.source_url ?? null,
    createHash("sha256").update(body).digest("hex"),
    JSON.stringify(parsed.data)
  );
  insert.run(id, title, body, source);
  count++;
}
db.prepare("INSERT INTO metadata VALUES (?, ?)").run("version", `local-knowledge-v1-${new Date().toISOString().slice(0, 10)}`);
db.prepare("INSERT INTO metadata VALUES (?, ?)").run("documents", String(count));
db.close();
fs.chmodSync(knowledgeDbPath, 0o444);
console.log(`Imported ${count} knowledge documents to ${knowledgeDbPath}`);
