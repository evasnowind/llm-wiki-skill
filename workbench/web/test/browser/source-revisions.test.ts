import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { IngestJob, SourceCandidate, SourceCandidateDetail, SourceHistoryData, SourceRevisionsData } from "@llm-wiki/workbench-contracts";
import {
	REPO_ROOT, SERVER_ENTRY, VITE_ENTRY, WEB_ROOT, START_TIMEOUT_MS,
	assertPortAvailable, availablePort, blockExternalBrowserTraffic, closeBrowserResources,
	createKnowledgeBase, hashKnowledgeFiles, isolatedEnvironment, platformSandboxEnvironment,
	prepareSandboxDirectories, startNetworkGuardedProcess, stopProcess, waitUntil, type RunningProcess,
} from "./support/browser-harness";

test("Markdown revisions require review, preserve history, survive restart and reject external edits", { timeout: 180_000 }, async (t) => {
	const sandbox = await mkdtemp(join(tmpdir(), "markdown revisions 中文 spaces-"));
	const home = join(sandbox, "home");
	const appDir = join(home, ".llm-wiki-agent");
	const kb = join(home, "llm-wiki", "revision-atlas");
	const otherKb = join(home, "llm-wiki", "revision-harbor");
	const input = join(home, "Markdown 目录 spaces");
	const backendPort = await availablePort();
	const webPort = 5180;
	await assertPortAvailable(webPort);
	let server: RunningProcess | undefined;
	const resources: { vite?: RunningProcess; browser?: Browser; context?: BrowserContext } = {};
	t.after(async () => {
		const errors: unknown[] = [];
		await writeFile(join(appDir, "browser-revision-release"), "release").catch(() => {});
		await closeBrowserResources(resources).catch((error) => errors.push(error));
		if (resources.vite) await stopProcess(resources.vite, [0, 143]).catch((error) => errors.push(error));
		if (server) await stopProcess(server).catch((error) => errors.push(error));
		await rm(sandbox, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
		if (errors.length) throw new AggregateError(errors, "revision browser cleanup failed");
	});
	await prepareSandboxDirectories(home);
	await createKnowledgeBase(kb, "Revision Atlas", "ATLAS_ONLY");
	await createKnowledgeBase(otherKb, "Revision Harbor", "HARBOR_ONLY");
	await Promise.all([appDir, input].map((directory) => mkdir(directory, { recursive: true })));
	const original = "# Fictional Markdown\r\n\r\nREVISION_V1: original verified material.\r\n";
	await writeFile(join(input, "updated.md"), original);
	await writeFile(join(input, "unchanged.md"), "# Stable Markdown\n\nUNCHANGED_V1: retained fixed material.\n");
	await writeFile(join(input, "deleted.md"), "# Removed source\n\nDELETED_V1: preserve this original.\n");
	await writeFile(join(appDir, "config.json"), JSON.stringify({
		version: 1, externalKnowledgeBases: [kb, otherKb], lastUsedKbPath: kb,
		modelRoles: { main: { provider: "browser-test-provider", modelId: "browser-test-model" } },
	}));
	const startBackend = () => startNetworkGuardedProcess(process.execPath, ["--import", "tsx", SERVER_ENTRY], REPO_ROOT,
		isolatedEnvironment(home, backendPort, input), (output) => output.includes("listening on http://"),
		"revision browser backend", join(home, "backend-network-probe"));
	server = await startBackend();
	resources.vite = await startNetworkGuardedProcess(process.execPath,
		[VITE_ENTRY, "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"], WEB_ROOT,
		{ HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: join(home, "tmp"), LANG: "C.UTF-8",
			LLM_WIKI_AGENT_API_ORIGIN: `http://127.0.0.1:${backendPort}`, LLM_WIKI_AGENT_DISABLE_HMR: "1", ...platformSandboxEnvironment(home) },
		(output) => output.includes("Local:"), "revision Vite frontend", join(home, "vite-network-probe"));
	const browser = await chromium.launch({ headless: true, env: isolatedEnvironment(home, 0, input) });
	resources.browser = browser;
	const context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1280, height: 900 } });
	resources.context = context;
	const blocked: string[] = [];
	await blockExternalBrowserTraffic(context, blocked);
	const page = await context.newPage();
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	page.on("response", (response) => {
		if (response.status() >= 400 && new URL(response.url()).pathname.includes("source-revisions")) {
			void response.text().then((body) => console.info(`revision response ${response.status()}: ${body}`)).catch(() => {});
		}
	});
	await page.goto(`http://127.0.0.1:${webPort}`, { waitUntil: "domcontentloaded", timeout: START_TIMEOUT_MS });
	await page.locator(".topbar-kb-name").filter({ hasText: "revision-atlas" }).waitFor();
	await page.locator(".chat-input-area").evaluate((element, directory) => {
		const transfer = new DataTransfer(); transfer.setData("text/plain", directory);
		element.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: transfer }));
	}, input);
	await page.getByRole("button", { name: /发现 3 个可入库文件，点击批量入库/ }).click();
	const panel = page.getByRole("region", { name: "入库任务", exact: true });
	const initial = await waitForJob(page, kb, (job) => job.status === "completed" && job.files.length === 3);
	const revisions = page.getByRole("region", { name: "素材更新与摘要候选", exact: true });
	await revisions.getByRole("button", { name: "检查 Markdown 变化", exact: true }).click();
	const changes = revisions.getByRole("region", { name: "Markdown 变化清单", exact: true });
	await changes.getByRole("checkbox", { name: "选择 updated.md", exact: true }).waitFor();
	assert.equal(await changes.getByRole("checkbox", { name: "选择 updated.md", exact: true }).isDisabled(), true);
	await waitUntil(async () => (await collection(page, kb)).sources.length === 3, 15_000, "legacy sources were not linked by an explicit check");
	await writeFile(join(input, "updated.md"), "# Fictional Markdown\r\n\r\nREVISION_V2: explicitly updated material.\r\n");
	await writeFile(join(input, "added.md"), "# New material\n\nADDED_ONLY: not selected in this check.\n");
	await rm(join(input, "deleted.md"));
	const registeredDirectory = (await collection(page, kb)).directories[0]!;
	await revisions.getByRole("button", { name: `确认并检查目录：${registeredDirectory.path}`, exact: true }).click();
	await waitUntil(async () => !(await changes.getByRole("checkbox", { name: "选择 updated.md", exact: true }).isDisabled()), 15_000, "modified material did not become selectable");
	assert.equal(await changes.getByRole("checkbox", { name: "选择 deleted.md", exact: true }).isDisabled(), true);
	assert.equal(await changes.getByRole("checkbox", { name: "选择 unchanged.md", exact: true }).isDisabled(), true);
	await changes.getByRole("checkbox", { name: "选择 added.md", exact: true }).uncheck();
	await changes.getByRole("checkbox", { name: "选择 updated.md", exact: true }).check();
	const before = await hashKnowledgeFiles(kb);
	const beforeCache = await optionalText(join(kb, ".wiki-cache.json"));
	await revisions.getByRole("button", { name: /为选中变化生成候选/ }).click();
	const update = await waitForCandidate(page, kb, (candidate) => candidate.kind === "modified" && candidate.status === "ready");
	assert.equal((await collection(page, kb)).candidates.length, 1);
	assert.deepEqual(await hashKnowledgeFiles(kb), before, "ready candidates cannot publish knowledge files");
	assert.equal(await optionalText(join(kb, ".wiki-cache.json")), beforeCache);
	let card = revisions.getByRole("article", { name: "摘要候选 updated.md", exact: true });
	await card.getByRole("button", { name: "查看对照", exact: true }).click();
	let detail = revisions.getByRole("region", { name: "素材版本详情", exact: true });
	await detail.getByText(/REVISION_V2/).first().waitFor();
	assert.match(await detail.getByRole("region", { name: "原文对照", exact: true }).innerText(), /REVISION_V1/);
	assert.equal(await detail.getByRole("button", { name: "确认采用此候选", exact: true }).isDisabled(), true);
	await waitUntil(async () => (await panel.boundingBox())!.width >= 760, 5_000, "source comparison did not expand for desktop reading");
	assert.ok((await panel.boundingBox())!.height >= 600, "source comparison needs the available reading height");
	await page.setViewportSize({ width: 390, height: 844 });
	const narrowPanel = await panel.boundingBox();
	assert.ok(narrowPanel && narrowPanel.x >= 0 && narrowPanel.x + narrowPanel.width <= 390 && narrowPanel.y >= 0 && narrowPanel.y + narrowPanel.height <= 844, "source comparison must fit a narrow viewport");
	await page.setViewportSize({ width: 1280, height: 900 });
	await mkdir(join(REPO_ROOT, ".tmp/source-revisions"), { recursive: true });
	await detail.getByRole("region", { name: "原文对照", exact: true }).scrollIntoViewIfNeeded();
	await page.screenshot({ path: join(REPO_ROOT, ".tmp/source-revisions/comparison.png") });
	await page.reload({ waitUntil: "domcontentloaded" });
	await page.getByRole("button", { name: /^入库任务/ }).click();
	await card.waitFor();
	await page.locator(".kb-row").filter({ hasText: "revision-harbor" }).click();
	await waitUntil(async () => (await card.count()) === 0, 10_000, "previous knowledge base candidate leaked");
	await page.locator(".kb-row").filter({ hasText: "revision-atlas" }).click();
	await card.waitFor();
	await stopProcess(server); server = await startBackend();
	await page.reload({ waitUntil: "domcontentloaded" });
	await page.getByRole("button", { name: /^入库任务/ }).click();
	await waitForCandidate(page, kb, (candidate) => candidate.id === update.id && candidate.status === "ready");
	assert.deepEqual(await hashKnowledgeFiles(kb), before, "restart must not adopt a ready candidate");
	card = revisions.getByRole("article", { name: "摘要候选 updated.md", exact: true });
	await card.getByRole("button", { name: "查看对照", exact: true }).click();
	detail = revisions.getByRole("region", { name: "素材版本详情", exact: true });
	await detail.getByRole("checkbox", { name: "已核对原文与摘要对照", exact: true }).check();
	await detail.getByRole("button", { name: "确认采用此候选", exact: true }).click();
	const adopted = await waitForCandidate(page, kb, (candidate) => candidate.id === update.id && candidate.status === "adopted");
	assert.ok(adopted.sourceId);
	const updatedSource = (await collection(page, kb)).sources.find((source) => source.id === adopted.sourceId)!;
	const oldFile = initial.files.find((file) => file.name === "updated.md")!;
	assert.equal(updatedSource.outputPath, oldFile.outputPath, "adoption must preserve the original summary link");
	assert.match(await readFile(join(kb, updatedSource.outputPath), "utf8"), /REVISION_V2/);
	const history = await api<SourceHistoryData>(page, `/api/knowledge-bases/source-revisions/sources/${updatedSource.id}?kb=${encodeURIComponent(kb)}`);
	assert.equal(history.versions.length, 2);
	const oldest = history.versions.find((version) => version.id !== updatedSource.currentVersionId)!;
	assert.equal(await readFile(join(kb, oldest.rawPath), "utf8"), original, "old raw bytes and CRLF must remain unchanged");
	assert.equal((await hashKnowledgeFiles(kb))[initial.files.find((file) => file.name === "deleted.md")!.outputPath!], before[initial.files.find((file) => file.name === "deleted.md")!.outputPath!]);
	const reinspection = await api<{ ingestibleFiles: { scanId: string; paths: string[] } }>(page, "/api/knowledge-bases/inspect", { path: input });
	const currentInput = reinspection.ingestibleFiles.paths.find((path) => /[\\/]updated\.md$/.test(path));
	assert.ok(currentInput);
	const beforeReentry = await hashKnowledgeFiles(kb);
	const reentry = await api<IngestJob>(page, "/api/knowledge-bases/ingest-jobs", { kbPath: kb, filePaths: [currentInput], sourceScanId: reinspection.ingestibleFiles.scanId });
	assert.equal(reentry.status, "completed");
	assert.equal(reentry.files[0]!.attempts, 0, "ordinary intake must reuse an adopted current source without calling the model");
	assert.equal(reentry.files[0]!.outputPath, updatedSource.outputPath);
	assert.deepEqual(await hashKnowledgeFiles(kb), beforeReentry, "re-entering an adopted source must not create another summary");
	const reusedCandidate = (await api<{ candidates: SourceCandidate[] }>(page, "/api/knowledge-bases/source-revisions/candidates", {
		type: "regenerate", kbPath: kb, requestId: randomUUID(), target: { type: "ingest-file", jobId: reentry.id, fileId: reentry.files[0]!.id },
	})).candidates[0]!;
	const reusedReady = await waitForCandidate(page, kb, (candidate) => candidate.id === reusedCandidate.id && candidate.status === "ready");
	const reusedDetail = await api<SourceCandidateDetail>(page, `/api/knowledge-bases/source-revisions/candidates/${reusedReady.id}/detail?kb=${encodeURIComponent(kb)}`);
	assert.match(reusedDetail.original.after!.text, /REVISION_V2/);
	assert.deepEqual(await hashKnowledgeFiles(kb), beforeReentry, "regeneration from a reused completed task must remain a candidate");
	await api(page, `/api/knowledge-bases/source-revisions/candidates/${reusedReady.id}/cancel`, { kbPath: kb, expectedRevision: reusedReady.revision });

	await writeFile(join(input, "unchanged.md"), "EXTERNAL_CHANGE_MUST_NOT_ENTER_REGEN");
	await panel.getByRole("button", { name: "重新生成 unchanged.md 的摘要", exact: true }).click();
	const regenerate = revisions.getByRole("region", { name: "重新生成素材摘要", exact: true });
	await regenerate.getByRole("textbox", { name: "摘要改进要求", exact: true }).fill("突出可核对的关键细节");
	const beforeRegenerate = await hashKnowledgeFiles(kb);
	await regenerate.getByRole("button", { name: "生成摘要候选", exact: true }).click();
	const regen = await waitForCandidate(page, kb, (candidate) => candidate.kind === "regenerated" && candidate.name === "unchanged.md" && candidate.status === "ready");
	assert.deepEqual(await hashKnowledgeFiles(kb), beforeRegenerate);
	const regenDetail = await api<SourceCandidateDetail>(page, `/api/knowledge-bases/source-revisions/candidates/${regen.id}/detail?kb=${encodeURIComponent(kb)}`);
	assert.match(regenDetail.original.after!.text, /UNCHANGED_V1/);
	assert.doesNotMatch(regenDetail.summary.after!.text, /EXTERNAL_CHANGE_MUST_NOT_ENTER_REGEN/);
	assert.match(regenDetail.summary.after!.text, /突出可核对的关键细节/);
	assert.ok(regen.model, "actual generation model must be persisted");
	const stableSource = (await collection(page, kb)).sources.find((source) => source.id === regen.sourceId)!;
	const manual = "# External edit\n\nMANUAL_CONTENT_MUST_REMAIN\n";
	await writeFile(join(kb, stableSource.outputPath), manual);
	const regenCard = revisions.getByRole("article", { name: "摘要候选 unchanged.md", exact: true });
	await regenCard.getByRole("button", { name: "查看对照", exact: true }).click();
	await detail.getByRole("checkbox", { name: "已核对原文与摘要对照", exact: true }).check();
	await detail.getByRole("button", { name: "确认采用此候选", exact: true }).click();
	await waitForCandidate(page, kb, (candidate) => candidate.id === regen.id && candidate.status === "stale");
	assert.equal(await readFile(join(kb, stableSource.outputPath), "utf8"), manual);

	const held = (await api<{ candidates: SourceCandidate[] }>(page, "/api/knowledge-bases/source-revisions/candidates", {
		type: "regenerate", kbPath: kb, requestId: randomUUID(),
		target: { type: "source", sourceId: updatedSource.id, baseVersionId: updatedSource.currentVersionId },
		feedback: "[revision-hold] [ignore-cancel]",
	})).candidates[0]!;
	await waitForCandidate(page, kb, (candidate) => candidate.id === held.id && candidate.status === "generating");
	const beforeCancel = await hashKnowledgeFiles(kb);
	await revisions.getByRole("article", { name: "摘要候选 updated.md", exact: true }).filter({ has: page.getByRole("button", { name: "取消候选", exact: true }) })
		.getByRole("button", { name: "取消候选", exact: true }).click();
	await waitForCandidate(page, kb, (candidate) => candidate.id === held.id && candidate.status === "cancelled");
	await writeFile(join(appDir, "browser-revision-release"), "release");
	await waitUntil(async () => (await collection(page, kb)).candidates.find((candidate) => candidate.id === held.id)?.status === "cancelled", 5_000, "cancelled candidate was revived");
	await stopProcess(server); server = undefined;
	assert.deepEqual(await hashKnowledgeFiles(kb), beforeCancel);
	assert.equal(await readFile(join(otherKb, "wiki/entities/shared.md"), "utf8"), "# Revision Harbor\n\nHARBOR_ONLY\n");
	assert.equal(blocked.every((origin) => ["https://fonts.googleapis.com", "https://fonts.gstatic.com"].includes(origin)), true);
	assert.deepEqual(pageErrors, []);
});

async function api<T>(page: Page, path: string, body?: unknown): Promise<T> {
	return page.evaluate(async ({ path, body }) => {
		const response = await fetch(path, body === undefined ? undefined : {
			method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
		});
		const result = await response.json();
		if (!response.ok || !result.ok) throw new Error(`revision request failed (${response.status}): ${JSON.stringify(result)}`);
		return result.data;
	}, { path, body }) as Promise<T>;
}
const collection = (page: Page, kb: string) => api<SourceRevisionsData>(page, `/api/knowledge-bases/source-revisions?kb=${encodeURIComponent(kb)}`);
async function waitForCandidate(page: Page, kb: string, predicate: (candidate: SourceCandidate) => boolean): Promise<SourceCandidate> {
	let result: SourceCandidate | undefined;
	let latest: SourceCandidate[] = [];
	try {
		await waitUntil(async () => { latest = (await collection(page, kb)).candidates; result = latest.find(predicate); return Boolean(result); }, 20_000, "candidate did not reach expected state");
	} catch (error) { throw new Error(`candidate did not reach expected state: ${JSON.stringify(latest)}`, { cause: error }); }
	return result!;
}
async function waitForJob(page: Page, kb: string, predicate: (job: IngestJob) => boolean): Promise<IngestJob> {
	let result: IngestJob | undefined;
	await waitUntil(async () => { result = (await api<{ jobs: IngestJob[] }>(page, `/api/knowledge-bases/ingest-jobs?kb=${encodeURIComponent(kb)}`)).jobs.find(predicate); return Boolean(result); }, 20_000, "initial ingest did not complete");
	return result!;
}
async function optionalText(path: string): Promise<string | null> {
	try { return await readFile(path, "utf8"); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
