import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import {
	REPO_ROOT, SERVER_ENTRY, VITE_ENTRY, WEB_ROOT, START_TIMEOUT_MS,
	assertPortAvailable, availablePort, blockExternalBrowserTraffic, closeBrowserResources,
	createKnowledgeBase, isolatedEnvironment, platformSandboxEnvironment,
	prepareSandboxDirectories, startNetworkGuardedProcess, stopProcess, waitUntil,
	type RunningProcess,
} from "./support/browser-harness";

test("Markdown evidence survives history, safely locates changed originals, and isolates raw-only answers and KB switches", { timeout: 100_000 }, async (t) => {
	const webPort = 5180;
	await assertPortAvailable(webPort);
	const sandbox = await mkdtemp(join(tmpdir(), "llm-wiki-browser-evidence-"));
	const home = join(sandbox, "home");
	const appDir = join(home, ".llm-wiki-agent");
	const kbA = join(home, "llm-wiki", "atlas-evidence");
	const kbB = join(home, "llm-wiki", "harbor-evidence");
	const backendPort = await availablePort();
	let server: RunningProcess | undefined, vite: RunningProcess | undefined;
	let browser: Browser | undefined, context: BrowserContext | undefined;
	t.after(async () => {
		const errors: unknown[] = [];
		await closeBrowserResources({ context, browser }).catch((err) => errors.push(err));
		context = undefined;
		browser = undefined;
		if (vite) await stopProcess(vite, [0, 143]).catch((err) => errors.push(err));
		vite = undefined;
		if (server) await stopProcess(server).catch((err) => errors.push(err));
		server = undefined;
		await rm(sandbox, { recursive: true, force: true });
		if (errors.length) throw new AggregateError(errors, "evidence browser cleanup failed");
	});
	await prepareSandboxDirectories(home);
	for (const [kb, owner] of [[kbA, "ATLAS"], [kbB, "HARBOR"]]) {
		await createKnowledgeBase(kb!, `${owner} library`, "WIKI_PRIVATE_SENTINEL: fictional generated summary.");
		await mkdir(join(kb!, "raw"), { recursive: true });
		await writeFile(join(kb!, "raw/handbook.md"), source(owner!));
		await writeFile(join(kb!, "wiki/entities/portal.md"), "---\naliases: [月舟入口]\ntags: [退款规则]\n---\n# 退款入口\n\n关联原始手册 [[raw/handbook.md|退款资料]]。\n");
	}
	await mkdir(appDir, { recursive: true });
	await writeFile(join(appDir, "config.json"), JSON.stringify({ version: 1, externalKnowledgeBases: [kbA, kbB], lastUsedKbPath: kbA, modelRoles: { main: { provider: "browser-test-provider", modelId: "browser-test-model" } } }));
	server = await startNetworkGuardedProcess(process.execPath, ["--import", "tsx", SERVER_ENTRY], REPO_ROOT, isolatedEnvironment(home, backendPort, kbB), (out) => out.includes("listening on http://"), "evidence browser backend", join(home, "backend-network-probe"));
	vite = await startNetworkGuardedProcess(process.execPath, [VITE_ENTRY, "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"], WEB_ROOT, {
		HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: join(home, "tmp"), LANG: "C.UTF-8", LLM_WIKI_AGENT_API_ORIGIN: `http://127.0.0.1:${backendPort}`, LLM_WIKI_AGENT_DISABLE_HMR: "1", ...platformSandboxEnvironment(home),
	}, (out) => out.includes("Local:"), "evidence Vite frontend", join(home, "vite-network-probe"));
	browser = await chromium.launch({ headless: true, env: isolatedEnvironment(home, 0, kbA) });
	context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1440, height: 1000 } });
	const blocked: string[] = [];
	await blockExternalBrowserTraffic(context, blocked);
	const page = await context.newPage();
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(`http://127.0.0.1:${webPort}`, { waitUntil: "domcontentloaded", timeout: START_TIMEOUT_MS });
	await page.locator(".topbar-kb-name").filter({ hasText: "atlas-evidence" }).waitFor();
	await ask(page, "月舟入口 退款规则 退款时效 HISTORY_PRIVATE_SENTINEL [evidence]");
	const reference = () => page.getByRole("button", { name: /查看出处 1/ }).last();
	await reference().focus();
	await page.keyboard.press("Enter");
	await page.locator(".evidence-reader [data-evidence-highlight]").filter({ hasText: "ATLAS_RAW_REFUND_48" }).waitFor();
	assert.match(await page.locator(".evidence-location").innerText(), /raw\/handbook\.md[\s\S]*退款时效/);
	assert.equal(await page.locator(".evidence-reader [data-evidence-highlight]").evaluateAll((els) => els.some((el) => el === document.activeElement)), true);
	const screenshots = join(REPO_ROOT, ".tmp/markdown-evidence");
	await mkdir(screenshots, { recursive: true });
	await page.screenshot({ path: join(screenshots, "desktop.png"), fullPage: true });
	await page.setViewportSize({ width: 820, height: 1180 });
	await page.screenshot({ path: join(screenshots, "tablet.png"), fullPage: true });
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.keyboard.press("Escape");
	assert.equal(await page.locator(".evidence-reader").count(), 0);
	await page.reload({ waitUntil: "domcontentloaded" });
	await reference().click();
	await page.getByText(/已定位引用段落/).waitFor();
	await page.keyboard.press("Escape");
	await writeFile(join(kbA, "raw/handbook.md"), `\n${source("ATLAS")}`);
	await reference().click();
	await page.getByText(/已在当前原文中重新定位/).waitFor();
	assert.match(await page.locator(".evidence-reader [data-evidence-highlight]").filter({ hasText: "ATLAS_RAW_REFUND_48" }).innerText(), /48/);
	await page.keyboard.press("Escape");
	await writeFile(join(kbA, "raw/handbook.md"), "# 已改写资料\n\n原来的条款已被整段替换。\n");
	await reference().click();
	await page.getByText("原文已变化", { exact: true }).waitFor();
	assert.equal(await page.locator(".evidence-reader [data-evidence-highlight]").count(), 0);
	assert.match(await page.locator(".evidence-notice blockquote").innerText(), /ATLAS_RAW_REFUND_48/);
	await page.keyboard.press("Escape");
	await writeFile(join(kbA, "raw/handbook.md"), source("ATLAS"));
	await page.getByRole("radio", { name: "仅原文" }).check();
	await page.getByPlaceholder(/写下想法/).fill("@hand");
	await page.getByRole("option").filter({ hasText: "raw/handbook.md" }).waitFor();
	assert.equal(await page.getByRole("option").filter({ hasText: "wiki/" }).count(), 0);
	await page.keyboard.press("Escape");
	await ask(page, "月舟 退款时效 [evidence]");
	const contexts = (await readFile(join(appDir, "browser-evidence-contexts.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
	const rawContext = contexts.at(-1);
	assert.match(JSON.stringify(rawContext), /ATLAS_RAW_REFUND_48/);
	assert.doesNotMatch(JSON.stringify(rawContext), /WIKI_PRIVATE_SENTINEL|HISTORY_PRIVATE_SENTINEL|wiki\/entities|Fictional fixture reply/);
	assert.equal(rawContext.messages.length, 1);
	assert.deepEqual(rawContext.tools ?? [], []);
	await reference().click();
	await page.locator(".evidence-reader [data-evidence-highlight]").first().waitFor();
	await page.keyboard.press("Escape");

	// Delay a genuine read response, switch KB while it is in flight, and then release it.
	let release: (() => void) | undefined;
	let captured = false;
	await page.route("**/api/evidence/read", async (route) => {
		const response = await route.fetch();
		captured = true;
		await new Promise<void>((resolve) => { release = resolve; });
		await route.fulfill({ response }).catch(() => {});
	});
	await reference().click();
	await waitUntil(() => captured, 10_000, "the evidence read was not captured");
	await page.locator(".kb-row").filter({ hasText: "harbor-evidence" }).click();
	await page.locator(".topbar-kb-name").filter({ hasText: "harbor-evidence" }).waitFor();
	release?.();
	await page.unroute("**/api/evidence/read");
	assert.equal(await page.locator(".evidence-reader").count(), 0);
	await ask(page, "月舟 退款时效 [evidence]");
	await reference().click();
	await page.locator(".evidence-reader [data-evidence-highlight]").filter({ hasText: "HARBOR_RAW_REFUND_48" }).waitFor();
	assert.doesNotMatch(await page.locator(".evidence-reader").innerText(), /ATLAS_RAW_REFUND_48/);
	assert.equal(blocked.every((url) => url === "https://fonts.googleapis.com" || url === "https://fonts.gstatic.com"), true, "all external requests are blocked; only the existing optional font origins may be attempted");
	assert.deepEqual(errors, []);
});

function source(owner: string): string {
	return `---\ntitle: 退款原始手册\naliases: [月舟]\ntags: [退款规则]\n---\n# 退款手册\n\n## 退款时效\n\n${owner}_RAW_REFUND_48：退款在 48 小时内完成。\n\n## 通知渠道\n\n通知通过邮件发送。\n`;
}

async function ask(page: Page, question: string) {
	await page.getByPlaceholder(/写下想法/).fill(question);
	await page.getByRole("button", { name: "发送", exact: true }).click();
	await page.getByRole("button", { name: "停止", exact: true }).waitFor({ state: "hidden" });
	await page.getByRole("button", { name: /查看出处 1/ }).last().waitFor();
}
