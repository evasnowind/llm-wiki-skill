import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { IngestJob } from "@llm-wiki/workbench-contracts";

import {
	REPO_ROOT, SERVER_ENTRY, VITE_ENTRY, WEB_ROOT, START_TIMEOUT_MS,
	assertPortAvailable, availablePort, blockExternalBrowserTraffic, closeBrowserResources,
	createKnowledgeBase, isolatedEnvironment, platformSandboxEnvironment,
	prepareSandboxDirectories, startNetworkGuardedProcess, stopProcess, waitUntil,
	type RunningProcess,
} from "./support/browser-harness";

test("reliable ingest survives UI refresh, switches KBs, cancels, retries, and restores after restart", { timeout: 100_000 }, async (t) => {
	const webPort = 5180;
	await assertPortAvailable(webPort);
	const sandbox = await mkdtemp(join(tmpdir(), "llm-wiki-browser-ingest-"));
	const home = join(sandbox, "home");
	const appDir = join(home, ".llm-wiki-agent");
	const kbA = join(home, "llm-wiki", "atlas-ingest");
	const kbB = join(home, "llm-wiki", "harbor-ingest");
	const inputDirectory = join(home, "source-materials");
	const backendPort = await availablePort();
	let server: RunningProcess | undefined;
	let vite: RunningProcess | undefined;
	let browser: Browser | undefined;
	let context: BrowserContext | undefined;
	t.after(async () => {
		const errors: unknown[] = [];
		await closeBrowserResources({ context, browser }).catch((error) => errors.push(error));
		context = undefined;
		browser = undefined;
		if (vite) await stopProcess(vite, [0, 143]).catch((error) => errors.push(error));
		vite = undefined;
		if (server) await stopProcess(server).catch((error) => errors.push(error));
		await rm(sandbox, { recursive: true, force: true });
		if (errors.length) throw new AggregateError(errors, "reliable ingest browser cleanup failed");
	});
	await prepareSandboxDirectories(home);
	await createKnowledgeBase(kbA, "Atlas Ingest", "Atlas-only fictional material");
	await createKnowledgeBase(kbB, "Harbor Ingest", "Harbor-only fictional material");
	await mkdir(appDir, { recursive: true });
	await mkdir(inputDirectory, { recursive: true });
	await writeFile(join(inputDirectory, "hold.md"), "# Fictional source\n\n[ingest-hold] Raw fictional hold material.\n");
	await writeFile(join(appDir, "config.json"), JSON.stringify({
		version: 1, externalKnowledgeBases: [kbA, kbB], lastUsedKbPath: kbA,
		modelRoles: { main: { provider: "browser-test-provider", modelId: "browser-test-model" } },
	}));
	const startBackend = () => startNetworkGuardedProcess(
		process.execPath, ["--import", "tsx", SERVER_ENTRY], REPO_ROOT,
		isolatedEnvironment(home, backendPort, kbB),
		(output) => output.includes("listening on http://"), "ingest browser backend", join(home, "backend-network-probe"),
	);
	server = await startBackend();
	vite = await startNetworkGuardedProcess(
		process.execPath, [VITE_ENTRY, "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"], WEB_ROOT,
		{
			HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: join(home, "tmp"), LANG: "C.UTF-8",
			LLM_WIKI_AGENT_API_ORIGIN: `http://127.0.0.1:${backendPort}`, LLM_WIKI_AGENT_DISABLE_HMR: "1",
			...platformSandboxEnvironment(home),
		},
		(output) => output.includes("Local:"), "ingest Vite frontend", join(home, "vite-network-probe"),
	);
	browser = await chromium.launch({ headless: true, env: isolatedEnvironment(home, 0, kbA) });
	context = await browser.newContext({ serviceWorkers: "block" });
	const blocked: string[] = [];
	await blockExternalBrowserTraffic(context, blocked);
	const page = await context.newPage();
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	let cancelRequests = 0;
	page.on("request", (request) => {
		if (/\/ingest-jobs\/[^/]+\/cancel$/.test(new URL(request.url()).pathname)) cancelRequests++;
	});
	await page.goto(`http://127.0.0.1:${webPort}`, { waitUntil: "domcontentloaded", timeout: START_TIMEOUT_MS });
	await page.locator(".topbar-kb-name").filter({ hasText: "atlas-ingest" }).waitFor();
	await page.locator(".chat-input-area").evaluate((element, directory) => {
		const transfer = new DataTransfer();
		transfer.setData("text/plain", directory);
		element.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: transfer }));
	}, inputDirectory);
	await page.getByRole("button", { name: /发现 1 个可入库文件，点击批量入库/ }).click();
	const panel = page.getByRole("region", { name: "入库任务" });
	await panel.getByText("hold.md", { exact: true }).waitFor({ timeout: 10_000 }).catch(async (error: unknown) => {
		console.error("ingest queue diagnostic", await panel.innerText(), await page.evaluate(async (kb) => {
			const response = await fetch(`/api/knowledge-bases/ingest-jobs?kb=${encodeURIComponent(kb)}`);
			return response.json();
		}, kbA), server?.output());
		throw error;
	});
	const first = await waitForJob(page, kbA, (job) => job.files.some((file) => file.status === "running"));
	await panel.getByRole("button", { name: "关闭入库面板" }).click();
	assert.equal(cancelRequests, 0);
	await page.reload({ waitUntil: "domcontentloaded" });
	await page.getByRole("button", { name: /^入库任务/ }).click();
	await panel.getByText("hold.md", { exact: true }).waitFor();
	assert.equal(cancelRequests, 0, "hiding or reloading the panel must not cancel backend work");
	await page.locator(".kb-row").filter({ hasText: "harbor-ingest" }).click();
	await panel.getByText("当前知识库还没有入库任务。").waitFor();
	assert.equal(await panel.getByText("hold.md", { exact: true }).count(), 0);
	await page.locator(".kb-row").filter({ hasText: "atlas-ingest" }).click();
	await panel.getByText("hold.md", { exact: true }).waitFor();
	await panel.getByRole("button", { name: "取消未完成项" }).click();
	await waitForJob(page, kbA, (job) => job.id === first.id && job.status === "cancelled");
	await writeFile(join(appDir, "browser-ingest-release"), "release\n");
	await panel.getByRole("button", { name: "重试失败或取消项" }).click();
	const completed = await waitForJob(page, kbA, (job) => job.id === first.id && job.status === "completed");
	await panel.getByRole("button", { name: "打开 hold.md 的素材摘要" }).click();
	await page.getByText(/Raw fictional hold material/).first().waitFor();
	assert.ok(completed.files[0]?.outputPath?.startsWith("wiki/sources/"));
	assert.match(await readFile(join(kbA, "index.md"), "utf8"), /reliable-ingest/);
	assert.match(await readFile(join(kbA, "log.md"), "utf8"), /reliable-ingest/);
	assert.equal((await readdir(join(kbA, "wiki/sources"))).filter((name) => name.endsWith(".md")).length, 1);
	assert.equal(await readFile(join(inputDirectory, "hold.md"), "utf8"), "# Fictional source\n\n[ingest-hold] Raw fictional hold material.\n");

	await mkdir(join(kbA, "inputs"), { recursive: true });
	const failureSource = join(kbA, "inputs", "failure.md");
	await writeFile(failureSource, "# Failure fixture\n\n[ingest-fail] Fictional retry material.\n");
	await writeFile(join(appDir, "browser-ingest-fail"), "fail\n");
	const failureJob = await enqueue(page, kbA, failureSource);
	await waitForJob(page, kbA, (job) => job.id === failureJob.id && job.status === "failed");
	await rm(join(appDir, "browser-ingest-fail"));
	const failureCard = panel.getByRole("article", { name: `入库批次 ${failureJob.id}` });
	await failureCard.getByRole("button", { name: "重试失败或取消项" }).click();
	await waitForJob(page, kbA, (job) => job.id === failureJob.id && job.status === "completed");

	await rm(join(appDir, "browser-ingest-release"));
	const restartSource = join(kbA, "inputs", "restart.md");
	await writeFile(restartSource, "# Restart fixture\n\n[ingest-hold] Fictional restart material.\n");
	const restarting = await enqueue(page, kbA, restartSource);
	await waitForJob(page, kbA, (job) => job.id === restarting.id && job.files[0]?.status === "running");
	await panel.getByText("restart.md", { exact: true }).waitFor();
	await mkdir(join(REPO_ROOT, ".tmp/reliable-ingest"), { recursive: true });
	await panel.screenshot({ path: join(REPO_ROOT, ".tmp/reliable-ingest/panel.png") });
	await stopProcess(server);
	server = await startBackend();
	await writeFile(join(appDir, "browser-ingest-release"), "release\n");
	await waitForJob(page, kbA, (job) => job.id === restarting.id && job.status === "completed");
	const duplicate = await enqueue(page, kbA, restartSource);
	assert.equal(duplicate.id, restarting.id);
	assert.equal((await readdir(join(kbA, "wiki/sources"))).filter((name) => name.endsWith(".md")).length, 3);
	assert.equal(await readFile(join(kbB, "wiki/entities/shared.md"), "utf8"), "# Harbor Ingest\n\nHarbor-only fictional material\n");
	assert.equal(blocked.every((origin) => origin === "https://fonts.googleapis.com" || origin === "https://fonts.gstatic.com"), true,
		"only existing font requests may be blocked; the workflow must not contact external services");
	assert.deepEqual(pageErrors, []);
});

async function enqueue(page: Page, kbPath: string, sourcePath: string): Promise<IngestJob> {
	return page.evaluate(async ({ kbPath, sourcePath }) => {
		const response = await fetch("/api/knowledge-bases/ingest-jobs", {
			method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kbPath, filePaths: [sourcePath], concurrency: 1 }),
		});
		const payload = await response.json();
		if (!response.ok || !payload.ok) throw new Error(`enqueue failed: ${JSON.stringify(payload)}`);
		return payload.data;
	}, { kbPath, sourcePath });
}

async function waitForJob(page: Page, kbPath: string, predicate: (job: IngestJob) => boolean): Promise<IngestJob> {
	let result: IngestJob | undefined;
	await waitUntil(async () => {
		const jobs = await page.evaluate(async (kb) => {
			const response = await fetch(`/api/knowledge-bases/ingest-jobs?kb=${encodeURIComponent(kb)}`);
			const payload = await response.json();
			if (!response.ok || !payload.ok) return [];
			return payload.data.jobs as IngestJob[];
		}, kbPath);
		result = jobs.find(predicate);
		return Boolean(result);
	}, 15_000, "ingest job did not reach the expected durable state");
	return result!;
}
