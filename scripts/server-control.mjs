import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, "data");
const pidFile = path.join(dataDir, "server.pid");
const logFile = path.join(dataDir, "server.log");
const serverEntry = path.join(root, "apps", "server", "dist", "index.js");
const command = process.argv[2];

fs.mkdirSync(dataDir, { recursive: true });

async function healthy() {
  try {
    const response = await fetch("http://127.0.0.1:4317/health", { signal: AbortSignal.timeout(800) });
    return response.ok;
  } catch {
    return false;
  }
}

function recordedPid() {
  try {
    return Number(fs.readFileSync(pidFile, "utf8").trim()) || undefined;
  } catch {
    return undefined;
  }
}

if (command === "start") {
  if (await healthy()) {
    console.log("本地分析服务已经在 http://127.0.0.1:4317 运行。");
    process.exit(0);
  }
  const output = fs.openSync(logFile, "a");
  const child = spawn(process.execPath, [serverEntry], {
    cwd: root,
    detached: true,
    env: process.env,
    stdio: ["ignore", output, output]
  });
  fs.writeFileSync(pidFile, String(child.pid));
  child.unref();
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (await healthy()) {
      console.log(`本地分析服务已在后台启动（PID ${child.pid}）。`);
      console.log(`日志：${logFile}`);
      process.exit(0);
    }
  }
  console.error(`服务未能启动，请查看日志：${logFile}`);
  process.exit(1);
}

if (command === "stop") {
  const pid = recordedPid();
  if (pid) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // A stale PID file is handled below.
    }
  }
  fs.rmSync(pidFile, { force: true });
  if (await healthy()) {
    console.error("4317 端口仍有其他进程在运行，请使用 lsof -nP -iTCP:4317 -sTCP:LISTEN 检查。");
    process.exit(1);
  }
  console.log("本地分析服务已停止。");
  process.exit(0);
}

if (command === "status") {
  if (await healthy()) {
    console.log(`运行中：http://127.0.0.1:4317${recordedPid() ? `（PID ${recordedPid()}）` : ""}`);
    process.exit(0);
  }
  console.log("未运行。");
  process.exit(1);
}

console.error("用法：node scripts/server-control.mjs <start|stop|status>");
process.exit(2);
