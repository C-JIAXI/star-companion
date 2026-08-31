import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "../../apps/web/node_modules/playwright/index.mjs";
import { perfMarkerName, seedPerformanceDataset } from "./dataset.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const profileName = args.get("--profile") ?? "large";
const pagesToLoad = Number(args.get("--pages") ?? 100);
const outputArg = args.get("--output");
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run this benchmark through npm so the package runner can be located safely.");
if (!Number.isSafeInteger(pagesToLoad) || pagesToLoad < 1 || pagesToLoad > 200) throw new Error("--pages must be an integer from 1 to 200.");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.unref().on("error", reject).listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") return reject(new Error("Unable to reserve a local port."));
    server.close((error) => error ? reject(error) : resolve(address.port));
  });
});
const run = async (command, commandArgs, options = {}) => {
  const child = spawn(command, commandArgs, { cwd: root, stdio: "inherit", ...options });
  const [code] = await once(child, "exit");
  if (code !== 0) throw new Error(`Build command failed with exit code ${code}.`);
};
const waitForUrl = async (url, child) => {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Local performance process exited before ${url} became ready.`);
    try { const response = await fetch(url); if (response.ok) return; } catch {}
    await delay(100);
  }
  throw new Error(`Timed out waiting for local performance URL ${new URL(url).pathname}.`);
};
const stop = async (child) => {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    await once(killer, "exit").catch(() => undefined);
  } else {
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), delay(5_000)]).catch(() => undefined);
  }
};

const directory = await mkdtemp(path.join(os.tmpdir(), `star-companion-web-perf-${profileName}-`));
let serverProcess;
let webProcess;
let browser;
try {
  const databasePath = path.join(directory, "performance.db");
  const seed = await seedPerformanceDataset({
    profileName,
    seed: 20260831,
    databasePath,
    mediaDirectory: path.join(directory, "media"),
    migrationsDirectory: path.join(root, "apps/server/prisma/migrations")
  });
  const [serverPort, webPort] = await Promise.all([freePort(), freePort()]);
  const serverUrl = `http://127.0.0.1:${serverPort}`;
  const webUrl = `http://127.0.0.1:${webPort}`;
  await run(process.execPath, [npmCli, "run", "build", "--prefix", "apps/web"], {
    env: { ...process.env, VITE_API_BASE_URL: serverUrl }
  });
  serverProcess = spawn(process.execPath, [path.join(root, "apps/server/node_modules/tsx/dist/cli.mjs"), "src/index.ts"], {
    cwd: path.join(root, "apps/server"),
    env: { ...process.env, DATABASE_URL: `file:${databasePath.replaceAll("\\", "/")}`, SERVER_PORT: String(serverPort), CORS_ORIGIN: webUrl, API_KEY_ENCRYPTION_SECRET: "performance-fixture-secret-0123456789abcdef", STAR_COMPANION_DATA_DIR: directory },
    stdio: "ignore"
  });
  webProcess = spawn(process.execPath, [npmCli, "run", "preview", "--prefix", "apps/web", "--", "--host", "127.0.0.1", "--port", String(webPort)], { cwd: root, stdio: "ignore" });
  await Promise.all([waitForUrl(`${serverUrl}/api/health`, serverProcess), waitForUrl(webUrl, webProcess)]);

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => {
    localStorage.setItem("star-companion:selected-chat", "chat-000000000");
    window.__starPerf = { longTasks: [], peakDomNodes: 0 };
    new PerformanceObserver((list) => window.__starPerf.longTasks.push(...list.getEntries().map((entry) => entry.duration))).observe({ type: "longtask", buffered: true });
    const sampleDom = () => { window.__starPerf.peakDomNodes = Math.max(window.__starPerf.peakDomNodes, document.getElementsByTagName("*").length); };
    new MutationObserver(sampleDom).observe(document, { childList: true, subtree: true });
    sampleDom();
  });
  const page = await context.newPage();
  let apiRequests = 0;
  page.on("request", (request) => { if (request.url().includes("/api/")) apiRequests += 1; });
  const started = performance.now();
  await page.goto(webUrl, { waitUntil: "domcontentloaded" });
  await page.locator('[data-testid="chat-message-viewport"]').waitFor();
  await page.waitForFunction(() => document.querySelectorAll("[data-message-id]").length === 50);
  const interactiveMs = performance.now() - started;
  const initialMessageContainers = await page.locator("[data-message-id]").count();
  let anchorViolations = 0;
  const anchorFailures = [];
  let pagesLoaded = 0;
  for (let index = 0; index < pagesToLoad; index += 1) {
    const button = page.locator('[data-testid="chat-page-prev"]');
    if (await button.isDisabled()) break;
    await button.scrollIntoViewIfNeeded();
    const beforeRange = await page.locator('[data-testid="chat-message-pagination"]').textContent();
    const before = await page.evaluate(() => {
      const viewport = document.querySelector('[data-testid="chat-message-viewport"]');
      const rows = [...document.querySelectorAll("[data-message-id]")];
      const top = viewport?.getBoundingClientRect().top ?? 0;
      const row = rows.find((entry) => entry.getBoundingClientRect().bottom > top + 1);
      return row?.getAttribute("data-message-id") ?? null;
    });
    await button.click();
    await page.waitForFunction((previous) => {
      const range = document.querySelector('[data-testid="chat-message-pagination"]')?.textContent ?? "";
      return range !== previous;
    }, beforeRange);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    if (before) {
      const visible = await page.evaluate((messageId) => {
        const viewport = document.querySelector('[data-testid="chat-message-viewport"]');
        const row = document.querySelector(`[data-message-id="${messageId}"]`);
        if (!viewport || !row) return { visible: false, reason: "missing" };
        const viewportRect = viewport.getBoundingClientRect();
        const rowRect = row.getBoundingClientRect();
        return { visible: rowRect.bottom >= viewportRect.top && rowRect.top <= viewportRect.bottom, rowTop: rowRect.top, rowBottom: rowRect.bottom, viewportTop: viewportRect.top, viewportBottom: viewportRect.bottom, scrollTop: viewport.scrollTop };
      }, before);
      if (!visible.visible) {
        anchorViolations += 1;
        anchorFailures.push({ page: index + 1, messageId: before, ...visible });
      }
    }
    pagesLoaded += 1;
  }
  const steadyMessageContainers = await page.locator("[data-message-id]").count();
  const browserMetrics = await page.evaluate(() => ({
    longTasks: window.__starPerf.longTasks,
    peakDomNodes: window.__starPerf.peakDomNodes,
    domNodes: document.getElementsByTagName("*").length,
    heapUsedBytes: performance.memory?.usedJSHeapSize ?? null
  }));
  const client = await context.newCDPSession(page);
  await client.send("Performance.enable");
  const cdp = await client.send("Performance.getMetrics");
  const cdpMetrics = Object.fromEntries(cdp.metrics.map((metric) => [metric.name, metric.value]));
  const report = {
    kind: "web",
    profileName,
    seed: 20260831,
    appVersion: JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version,
    schemaVersion: seed.schemaVersion,
    environment: { platform: process.platform, node: process.version, browser: await browser.version(), viewport: "1440x900" },
    run: { temperature: "cold-navigation-then-warm-pages", generatedAt: new Date().toISOString(), pagesRequested: pagesToLoad, pagesLoaded },
    dataset: seed.counts,
    metrics: {
      interactiveMs: Math.round(interactiveMs * 100) / 100,
      initialMessageContainers,
      steadyMessageContainers,
      peakDomNodes: browserMetrics.peakDomNodes,
      finalDomNodes: browserMetrics.domNodes,
      apiRequests,
      longTaskCount: browserMetrics.longTasks.length,
      maxLongTaskMs: Math.max(0, ...browserMetrics.longTasks),
      anchorViolations,
      anchorFailures,
      heapUsedBytes: browserMetrics.heapUsedBytes ?? Math.round((cdpMetrics.JSHeapUsedSize ?? 0))
    },
    success: initialMessageContainers <= 50 && steadyMessageContainers <= 250 && anchorViolations === 0
  };
  if (!report.success) throw new Error(`Web performance correctness budget failed: ${JSON.stringify(report.metrics)}`);
  const output = outputArg ? path.resolve(outputArg) : path.join(root, "perf-results", `web-${profileName}.json`);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (browser) await browser.close();
  await Promise.all([stop(webProcess), stop(serverProcess)]);
  await readFile(path.join(directory, perfMarkerName), "utf8");
  await rm(directory, { recursive: true, force: true });
}
