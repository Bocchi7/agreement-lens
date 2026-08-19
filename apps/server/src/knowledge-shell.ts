import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { knowledgeDbPath, repoRoot } from "./config.js";

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
}

export function runKnowledgeShell(command: string): Promise<ShellResult> {
  if (command.length > 4000) return Promise.reject(new Error("知识库命令过长"));
  const args = [
    "--unshare-all",
    "--new-session",
    "--die-with-parent",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    "--dir", "/home",
    "--dir", "/run",
    "--ro-bind", "/usr", "/usr"
  ];
  if (fs.existsSync("/lib")) args.push("--ro-bind", "/lib", "/lib");
  if (fs.existsSync("/lib64")) args.push("--ro-bind", "/lib64", "/lib64");
  if (fs.existsSync("/bin")) args.push("--ro-bind", "/bin", "/bin");
  const knowledgeDir = path.join(repoRoot, "knowledge");
  args.push("--ro-bind", knowledgeDir, "/kb");
  if (fs.existsSync(knowledgeDbPath)) args.push("--ro-bind", knowledgeDbPath, "/knowledge.db");
  args.push(
    "--clearenv",
    "--setenv", "PATH", "/usr/bin:/bin",
    "--setenv", "HOME", "/tmp",
    "--setenv", "LANG", "C.UTF-8",
    "--chdir", "/kb",
    "--",
    "/bin/sh", "-c",
    "ulimit -t 3; ulimit -v 262144; ulimit -n 64; ulimit -u 24 2>/dev/null || true; exec /bin/sh -c \"$1\"",
    "knowledge-shell",
    command
  );

  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/bwrap", args, {
      env: {},
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    const collect = (target: "stdout" | "stderr", chunk: Buffer) => {
      const value = chunk.toString("utf8");
      if (target === "stdout") stdout += value;
      else stderr += value;
      if (stdout.length + stderr.length > 64_000) {
        truncated = true;
        stdout = stdout.slice(0, 48_000);
        stderr = stderr.slice(0, 16_000);
        child.kill("SIGKILL");
      }
    };
    child.stdout.on("data", (chunk) => collect("stdout", chunk));
    child.stderr.on("data", (chunk) => collect("stderr", chunk));
    child.on("error", reject);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 5000);
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode, timedOut, truncated });
    });
  });
}
