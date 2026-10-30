import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { interruptedExitCode, runInvocation, sanitizeOutput } from "./run-quality-and-tests.mjs";
import { npmInvocation } from "./npm-command.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const EVIDENCE_DIR = path.join(REPO_ROOT, ".tmp/browser-main-flows-ci");
const PLAYWRIGHT_CLI = path.join(REPO_ROOT, "node_modules/playwright/cli.js");
const PLAYWRIGHT_PACKAGE = path.join(REPO_ROOT, "node_modules/playwright/package.json");
const PLAYWRIGHT_BROWSERS = path.join(REPO_ROOT, "node_modules/playwright-core/browsers.json");
const PACKAGE_LOCK = path.join(REPO_ROOT, "package-lock.json");
const CACHED_BROWSER_NAMES = ["chromium", "chromium-headless-shell", "ffmpeg"];
const COMPONENT_LABELS = {
	chromium: "Chrome for Testing",
	"chromium-headless-shell": "Chrome Headless Shell",
	ffmpeg: "FFmpeg",
};

export const BROWSER_CI_STAGES = {
	"npm-dependencies": {
		timeoutMs: 90_000,
		invocation: { ...npmInvocation(["ci"]), cwd: REPO_ROOT },
	},
	"system-dependencies": {
		timeoutMs: 8 * 60_000,
		invocation: {
			command: process.execPath,
			args: [PLAYWRIGHT_CLI, "install-deps", "chromium"],
			cwd: REPO_ROOT,
		},
	},
	"browser-install": {
		timeoutMs: 3 * 60_000,
		invocation: {
			command: process.execPath,
			args: [PLAYWRIGHT_CLI, "install", "chromium"],
			cwd: REPO_ROOT,
		},
	},
	"browser-verify": {
		timeoutMs: 45_000,
		invocation: {
			command: process.execPath,
			args: [
				"--input-type=module",
				"-e",
				'import { chromium } from "playwright"; const browser = await chromium.launch({ headless: true }); await browser.close(); process.stdout.write("Chromium launch verified\\n");',
			],
			cwd: REPO_ROOT,
		},
	},
	"browser-tests": {
		timeoutMs: 270_000,
		invocations: [
			{
				...npmInvocation(["run", "test:browser:main-flows", "-w", "@llm-wiki-agent/web"]),
				cwd: REPO_ROOT,
			},
			{
				command: "bash",
				args: ["tests/graph-offline-warnings.regression-1.sh"],
				cwd: REPO_ROOT,
			},
		],
	},
};

export async function createPlaywrightCacheIdentity({
	lockPath = PACKAGE_LOCK,
	packagePath = PLAYWRIGHT_PACKAGE,
	browsersPath = PLAYWRIGHT_BROWSERS,
} = {}) {
	const [lock, playwrightPackage, manifest] = await Promise.all([
		readJson(lockPath),
		readJson(packagePath),
		readJson(browsersPath),
	]);
	const lockedVersion = lock.packages?.["node_modules/playwright"]?.version;
	if (!lockedVersion || playwrightPackage.version !== lockedVersion) {
		throw new Error(
			`installed Playwright ${playwrightPackage.version ?? "unknown"} does not match package-lock ${lockedVersion ?? "missing"}`,
		);
	}
	const browsers = CACHED_BROWSER_NAMES.map((name) => {
		const entry = manifest.browsers?.find((candidate) => candidate.name === name);
		if (!entry?.revision) throw new Error(`Playwright browser manifest is missing ${name}`);
		return {
			name,
			revision: entry.revision,
			...(entry.browserVersion ? { browserVersion: entry.browserVersion } : {}),
			...(entry.revisionOverrides ? { revisionOverrides: entry.revisionOverrides } : {}),
		};
	});
	const digest = createHash("sha256")
		.update(JSON.stringify({ playwrightVersion: lockedVersion, browsers }))
		.digest("hex")
		.slice(0, 16);
	return {
		key: `playwright-${lockedVersion}-chromium-${digest}`,
		playwrightVersion: lockedVersion,
		browserRevisions: Object.fromEntries(browsers.map(({ name, revision }) => [name, revision])),
	};
}

export async function runBrowserCiStage(stageId, {
	evidenceDir,
	environment,
	invocation,
	invocations,
	signal,
	timeoutMs,
}) {
	await mkdir(evidenceDir, { recursive: true });
	const startedAt = new Date();
	process.stdout.write(`[browser-main-flows] ${stageId} started\n`);
	const milestones = [];
	let outputBuffer = "";
	const observeOutput = (chunk) => {
		if (stageId !== "browser-install") return;
		outputBuffer += chunk;
		const lines = outputBuffer.split(/\r?\n/);
		outputBuffer = lines.pop() ?? "";
		for (const line of lines) recordInstallMilestone(line, milestones, startedAt);
	};
	let result;
	let executionError;
	const outputs = [];
	const commands = invocations ?? (invocation ? [invocation] : []);
	const deadline = Date.now() + timeoutMs;
	if (commands.length === 0) executionError = new Error(`browser CI stage ${stageId} has no command`);
	for (const current of commands) {
		if (executionError) break;
		try {
			result = await runInvocation(current, environment, Math.max(1, deadline - Date.now()), undefined, {
				onOutput: observeOutput,
				signal,
			});
			outputs.push(result.output ?? "");
			if (result.code !== 0 || result.timedOut || result.aborted) break;
		} catch (error) {
			executionError = error;
		}
	}
	const finishedAt = new Date();
	const output = sanitizeOutput([
		outputs.filter(Boolean).join("\n"),
		executionError instanceof Error ? executionError.stack ?? executionError.message : executionError ? String(executionError) : "",
	].filter(Boolean).join("\n"), { home: environment.HOME });
	const aborted = result?.aborted ?? signal?.aborted ?? false;
	const status = aborted
		? "interrupted"
		: result?.timedOut
			? "timed-out"
			: executionError || result?.code !== 0
				? "failed"
				: "passed";
	const record = {
		stage: stageId,
		status,
		startedAt: startedAt.toISOString(),
		finishedAt: finishedAt.toISOString(),
		durationMs: finishedAt.getTime() - startedAt.getTime(),
		timeoutMs,
		exitCode: result?.code ?? null,
		signal: result?.signal ?? null,
		timedOut: result?.timedOut ?? false,
		aborted,
		milestones,
	};
	await Promise.all([
		writeFile(path.join(evidenceDir, `${stageId}.log`), output ? `${output}\n` : "", "utf8"),
		writeFile(path.join(evidenceDir, `${stageId}.json`), `${JSON.stringify(record, null, 2)}\n`, "utf8"),
	]);
	if (output) process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
	process.stdout.write(`[browser-main-flows] ${stageId} ${status} in ${record.durationMs}ms\n`);
	return record;
}

async function readJson(file) {
	return JSON.parse(await readFile(file, "utf8"));
}

function recordInstallMilestone(line, milestones, startedAt) {
	const match = line.match(/\(playwright (chromium|chromium-headless-shell|ffmpeg) v\d+\)/);
	if (!match) return;
	const event = line.startsWith("Downloading ")
		? "download-started"
		: line.includes(" downloaded to ")
			? "content-installed"
			: null;
	if (!event) return;
	const component = COMPONENT_LABELS[match[1]];
	if (milestones.some((item) => item.event === event && item.component === component)) return;
	milestones.push({
		event,
		component,
		observedAt: new Date().toISOString(),
		elapsedMs: Date.now() - startedAt.getTime(),
	});
}

function browserCiEnvironment(source = process.env) {
	return {
		HOME: source.HOME ?? tmpdir(),
		PATH: source.PATH ?? "/usr/bin:/bin",
		TMPDIR: source.TMPDIR ?? tmpdir(),
		LANG: "C.UTF-8",
		...(source.CI ? { CI: source.CI } : {}),
		...(source.PLAYWRIGHT_BROWSERS_PATH
			? { PLAYWRIGHT_BROWSERS_PATH: source.PLAYWRIGHT_BROWSERS_PATH }
			: {}),
		...Object.fromEntries(["SystemRoot", "ComSpec", "PATHEXT", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"].flatMap((name) => process.platform === "win32" && source[name] ? [[name, source[name]]] : [])),
	};
}

async function writeCacheIdentity() {
	const identity = await createPlaywrightCacheIdentity();
	await mkdir(EVIDENCE_DIR, { recursive: true });
	await writeFile(
		path.join(EVIDENCE_DIR, "playwright-cache-identity.json"),
		`${JSON.stringify(identity, null, 2)}\n`,
		"utf8",
	);
	if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `key=${identity.key}\n`, "utf8");
	process.stdout.write(`[browser-main-flows] cache identity ${identity.key}\n`);
}

async function main() {
	const stageId = process.argv[2];
	if (stageId === "cache-key") {
		await writeCacheIdentity();
		return;
	}
	const stage = BROWSER_CI_STAGES[stageId];
	if (!stage) throw new Error(`unknown browser CI stage: ${stageId ?? "missing"}`);
	if (stageId === "npm-dependencies") await rm(EVIDENCE_DIR, { recursive: true, force: true });
	const controller = new AbortController();
	let interrupted;
	const stopForSignal = (signal) => {
		interrupted ??= signal;
		controller.abort();
	};
	const interruptHandler = () => stopForSignal("SIGINT");
	const terminateHandler = () => stopForSignal("SIGTERM");
	process.once("SIGINT", interruptHandler);
	process.once("SIGTERM", terminateHandler);
	try {
		const record = await runBrowserCiStage(stageId, {
			evidenceDir: EVIDENCE_DIR,
			environment: browserCiEnvironment(),
			signal: controller.signal,
			...stage,
		});
		if (process.env.GITHUB_STEP_SUMMARY) {
			await appendFile(
				process.env.GITHUB_STEP_SUMMARY,
				`- ${stageId}: ${record.status} (${record.durationMs} ms)\n`,
				"utf8",
			);
		}
		if (interrupted) process.exitCode = interruptedExitCode(interrupted);
		else if (record.status !== "passed") process.exitCode = 1;
	} finally {
		process.off("SIGINT", interruptHandler);
		process.off("SIGTERM", terminateHandler);
	}
}


if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		await main();
	} catch (error) {
		const message = sanitizeOutput(
			error instanceof Error ? error.stack ?? error.message : String(error),
			{ repoRoot: REPO_ROOT, home: process.env.HOME ?? tmpdir() },
		);
		await mkdir(EVIDENCE_DIR, { recursive: true }).catch(() => undefined);
		await writeFile(path.join(EVIDENCE_DIR, "runner.log"), `${message}\n`, "utf8").catch(() => undefined);
		console.error(message);
		process.exitCode = 1;
	}
}
