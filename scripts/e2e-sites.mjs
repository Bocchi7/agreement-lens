import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname, "..");
const debugPort = Number(process.env.E2E_DEBUG_PORT ?? 9333);
const serverUrl = "http://127.0.0.1:4317";
const urls = [
  "https://login.live.com/",
  "https://www.baidu.com/",
  "https://www.weibo.com/",
  "https://www.zhihu.com/",
  "https://www.bilibili.com/",
  "https://chat.deepseek.com/sign_in",
  "https://www.qianwen.com/",
  "https://login.taobao.com/",
  "https://reg.jd.com/p/regPage",
  "https://kyfw.12306.cn/otn/regist/init",
  "https://passport.ctrip.com/user/login"
];

class Connection {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  async send(method, params = {}) {
    await this.ready;
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

async function browserConnection() {
  const version = await fetch(`http://127.0.0.1:${debugPort}/json/version`).then((response) => response.json());
  return new Connection(version.webSocketDebuggerUrl);
}

async function pageConnection(browser, targetId) {
  const version = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json());
  const descriptor = version.find((item) => item.id === targetId);
  if (!descriptor) throw new Error(`目标 ${targetId} 不存在`);
  const connection = new Connection(descriptor.webSocketDebuggerUrl);
  await connection.send("Page.enable");
  await connection.send("Runtime.enable");
  return { connection, sessionId: target.sessionId };
}

async function evaluate(connection, expression, returnByValue = true) {
  const result = await connection.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? "浏览器脚本执行失败");
  }
  return result.result?.value;
}

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function navigate(connection, url) {
  await connection.send("Page.navigate", { url });
  await wait(4500);
}

async function screenshot(connection, filename) {
  const result = await connection.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await fs.writeFile(filename, Buffer.from(result.data, "base64"));
}

async function findAndClickAuth(connection) {
  return evaluate(connection, `(() => {
    const pattern = /登录|注册|登入|立即登录|sign[ -]?in|log[ -]?in|sign[ -]?up|register/i;
    const nodes = [...document.querySelectorAll('a,button,[role="button"],input[type="button"],input[type="submit"]')];
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== 'hidden';
    };
    const candidates = nodes
      .filter(visible)
      .map((node) => ({
        node,
        text: (node.innerText || node.getAttribute('aria-label') || node.getAttribute('title') || node.value || '').replace(/\\s+/g, ' ').trim(),
        href: node.href || ''
      }))
      .filter((item) => pattern.test(item.text) || pattern.test(item.href))
      .sort((a, b) => (a.text.length - b.text.length));
    const chosen = candidates.find((item) => /登录|sign[ -]?in|log[ -]?in/i.test(item.text)) ?? candidates[0];
    if (!chosen) return { clicked: false, candidates: candidates.slice(0, 8).map(({ text, href }) => ({ text, href })) };
    chosen.node.click();
    return { clicked: true, text: chosen.text, href: chosen.href, candidates: candidates.slice(0, 8).map(({ text, href }) => ({ text, href })) };
  })()`);
}

async function pageState(worker) {
  return evaluate(worker, `new Promise((resolve) => chrome.storage.session.get(null, (all) => {
    const pages = Object.entries(all)
      .filter(([key]) => key.startsWith('page:'))
      .map(([, value]) => value)
      .filter((value) => value && typeof value === 'object');
    resolve(pages.sort((a, b) => new Date(b.scannedAt).getTime() - new Date(a.scannedAt).getTime())[0] ?? null);
  }))`);
}

async function rescanActiveTab(worker) {
  return evaluate(worker, `new Promise((resolve) => chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
    const tabId = tabs[0]?.id;
    if (!tabId) return resolve({ ok: false, error: '没有活动标签页' });
    chrome.tabs.sendMessage(tabId, { type: 'SCAN_PAGE' }, (response) => resolve({
      ok: !chrome.runtime.lastError,
      response,
      error: chrome.runtime.lastError?.message
    }));
  }))`);
}

async function browserAcquire(worker, sources) {
  const selected = sources
    .filter((source) => source.selected && source.url && ["url", "pdf"].includes(source.kind))
    .slice(0, 8)
    .map((source) => ({ id: source.id, url: source.url, kind: source.kind }));
  if (!selected.length) return [];
  return evaluate(worker, `new Promise((resolve) => chrome.runtime.sendMessage({
    type: 'FETCH_AGREEMENT_SOURCES',
    sources: ${JSON.stringify(selected)}
  }, (response) => resolve(response?.sources ?? [])))`);
}

async function pair() {
  const response = await fetch(`${serverUrl}/v1/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "246810" })
  });
  return (await response.json()).token;
}

async function analyze(token, page, acquired) {
  const fetched = new Map(acquired.map((item) => [item.id, item]));
  const sources = page.sources.map((source) => {
    const item = fetched.get(source.id);
    return item ? { ...source, renderedHtml: item.renderedHtml, dataBase64: item.dataBase64 } : source;
  });
  const response = await fetch(`${serverUrl}/v1/analyses`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      serviceName: page.pageTitle,
      pageUrl: page.pageUrl,
      sources,
      context: { action: "register", concerns: ["money", "data"], redlines: [], notes: "" }
    })
  });
  if (!response.ok) throw new Error(`创建分析失败：HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
  const created = await response.json();
  for (let attempt = 0; attempt < 180; attempt++) {
    await wait(1000);
    const job = await fetch(`${serverUrl}/v1/jobs/${created.jobId}`, { headers: { authorization: `Bearer ${token}` } }).then((item) => item.json());
    if (job.state === "complete" || job.state === "failed") {
      const result = job.state === "complete"
        ? await fetch(`${serverUrl}/v1/analyses/${created.analysisId}`, { headers: { authorization: `Bearer ${token}` } }).then((item) => item.json())
        : undefined;
      return { job, result };
    }
  }
  return { job: { state: "timeout" } };
}

async function main() {
  await fs.mkdir(path.join(root, "data/e2e-results"), { recursive: true });
  const browser = await browserConnection();
  let targets = await browser.send("Target.getTargets");
  const workerTarget = targets.targetInfos.find((target) => target.type === "service_worker" && target.url.includes("service_worker.js"));
  let pageTarget = targets.targetInfos.find((target) => target.type === "page");
  if (!pageTarget) {
    const created = await browser.send("Target.createTarget", { url: "about:blank" });
    targets = await browser.send("Target.getTargets");
    pageTarget = targets.targetInfos.find((target) => target.targetId === created.targetId);
  }
  if (!workerTarget || !pageTarget) throw new Error("没有找到扩展 Service Worker 或测试页面");
  const worker = (await pageConnection(browser, workerTarget.targetId)).connection;
  const page = (await pageConnection(browser, pageTarget.targetId)).connection;
  const token = await pair();
  const report = [];

  for (const url of urls) {
    const item = { inputUrl: url, finalUrl: "", title: "", clickedAuth: null, discovered: [], acquired: [], analysis: null, screenshot: "", error: null };
    try {
      await navigate(page, url);
      item.finalUrl = await evaluate(page, "location.href");
      item.title = await evaluate(page, "document.title");
      let snapshot = await pageState(worker);
      if (!snapshot?.sources?.length) {
        item.clickedAuth = await findAndClickAuth(page);
        if (item.clickedAuth?.clicked) {
          await wait(5000);
          await rescanActiveTab(worker);
          await wait(1500);
          snapshot = await pageState(worker);
        }
      }
      item.discovered = snapshot?.sources ?? [];
      item.finalUrl = snapshot?.pageUrl ?? item.finalUrl;
      if (snapshot?.sources?.some((source) => source.selected)) {
        item.acquired = await browserAcquire(worker, snapshot.sources);
        item.analysis = await analyze(token, snapshot, item.acquired);
      }
      const safeName = item.finalUrl.replace(/^https?:\/\//, "").replace(/[^a-z0-9]+/gi, "_").slice(0, 80);
      item.screenshot = `data/e2e-results/${safeName || "page"}.png`;
      await screenshot(page, path.join(root, item.screenshot));
    } catch (error) {
      item.error = error instanceof Error ? error.message : String(error);
    }
    report.push(item);
    await fs.writeFile(path.join(root, "data/e2e-results/report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({
      url: item.inputUrl,
      finalUrl: item.finalUrl,
      discovered: item.discovered.length,
      acquired: item.acquired.filter((source) => source.renderedHtml || source.dataBase64).length,
      analysis: item.analysis?.job?.state ?? "skipped",
      error: item.error
    }));
  }
  worker.close();
  page.close();
  browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
