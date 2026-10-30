import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { interruptedExitCode, runInvocation } from "./run-quality-and-tests.mjs";
import { npmInvocation } from "./npm-command.mjs";
import { emitGithubError, sanitizePlatformOutput } from "./platform-diagnostics.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const NETWORK_GUARD = pathToFileURL(path.join(REPO_ROOT, "workbench/server/test/support/network-guard.mjs")).href;

export const PLATFORM_BACKEND_TESTS = [
	"workbench/scripts/platform-commands.test.mjs",
	"workbench/scripts/check-workbench-boundaries.test.mjs",
	"workbench/server/src/platform/bash.test.ts",
	"workbench/server/src/platform/directory-picker.test.ts",
	"workbench/server/src/wiki-init.test.ts",
	"workbench/server/src/wiki-init-platform.test.ts",
	"workbench/server/src/knowledge-base-routes.test.ts",
	"workbench/server/src/graph.test.ts",
	"workbench/server/src/graph-rename-portability.test.ts",
	"workbench/server/src/ingest-queue.test.ts",
	"workbench/server/src/retrieval.test.ts",
	"workbench/server/src/markdown-retrieval.test.ts",
	"workbench/server/src/evidence-reader.test.ts",
	"workbench/server/src/evidence-routes.test.ts",
	"workbench/server/src/evidence-metadata.test.ts",
	"workbench/server/src/sources-only.test.ts",
	"workbench/server/src/prompt-routes.test.ts",
	"workbench/server/src/test-home-isolation.test.ts",
];

/** Keep failures attributable to one build stage rather than one combined shell step. */
export function platformBuildSteps(commandOptions) {
	return [
		["build-server", ["run", "build", "-w", "@llm-wiki-agent/server"]],
		["build-web", ["run", "build", "-w", "@llm-wiki-agent/web"]],
		["typecheck", ["run", "typecheck"]],
	].map(([id, args]) => ({ id, invocation: { ...npmInvocation(args, commandOptions), cwd: REPO_ROOT }, timeoutMs: 180_000 }));
}

export const PLATFORM_BROWSER_TESTS = [
	"workbench/web/test/browser/reliable-ingest.test.ts",
	"workbench/web/test/browser/markdown-evidence.test.ts",
];

/** Deliberately does not inherit provider keys, registry credentials or user Node hooks. */
export function createPlatformTestEnvironment(home, source = process.env) {
	const environment = {
		HOME: home,
		USERPROFILE: home,
		APPDATA: path.join(home, "AppData", "Roaming"),
		LOCALAPPDATA: path.join(home, "AppData", "Local"),
		XDG_CONFIG_HOME: path.join(home, ".config"),
		PI_CODING_AGENT_DIR: path.join(home, ".pi", "agent"),
		TEMP: path.join(home, "tmp"),
		TMP: path.join(home, "tmp"),
		TMPDIR: path.join(home, "tmp"),
		PATH: source.PATH ?? source.Path ?? "",
		LANG: "C.UTF-8",
		PYTHONIOENCODING: "utf-8",
		NO_UPDATE_NOTIFIER: "1",
		npm_config_update_notifier: "false",
		npm_config_audit: "false",
		NODE_OPTIONS: `--import=${NETWORK_GUARD}`,
	};
	for (const name of ["CI", "SystemRoot", "ComSpec", "PATHEXT", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "PLAYWRIGHT_BROWSERS_PATH"]) {
		if (source[name]) environment[name] = source[name];
	}
	return environment;
}

export async function runPlatformWorkbenchTests(mode, { requireWindows = false } = {}) {
	if (!["build", "backend", "browser"].includes(mode)) throw new Error("Expected build, backend or browser mode");
	if (requireWindows && process.platform !== "win32") throw new Error("Native Windows CI must run with a Windows Node.js executable");
	const userHome = homedir();
	const sandbox = await mkdtemp(path.join(tmpdir(), "llm-wiki-platform-suite-"));
	const home = path.join(sandbox, "用户 HOME");
	const evidence = path.join(REPO_ROOT, ".tmp", "windows-workbench");
	const environment = createPlatformTestEnvironment(home);
	await Promise.all([environment.APPDATA, environment.LOCALAPPDATA, environment.XDG_CONFIG_HOME, environment.PI_CODING_AGENT_DIR, environment.TMPDIR, evidence].map((directory) => mkdir(directory, { recursive: true })));
	await rm(path.join(evidence, `${mode}.json`), { force: true });
	await writeFile(path.join(evidence, `${mode}.log`), "", "utf8");
	const controller = new AbortController();
	let signal;
	const interrupt = () => { signal = "SIGINT"; controller.abort(); };
	const terminate = () => { signal = "SIGTERM"; controller.abort(); };
	process.once("SIGINT", interrupt);
	process.once("SIGTERM", terminate);
	let currentStage = mode;
	let failureOutput = "";
	const completed = [];
	try {
		const files = mode === "build" ? [] : mode === "backend" ? PLATFORM_BACKEND_TESTS : PLATFORM_BROWSER_TESTS;
		const stages = mode === "build" ? platformBuildSteps() : [{ id: mode, invocation: {
			command: process.execPath, args: ["--import", "tsx", "--test-concurrency=1", "--test", ...files], cwd: REPO_ROOT,
		}, timeoutMs: mode === "browser" ? 240_000 : 180_000 }];
		if (mode === "build") await Promise.all(stages.map((stage) => rm(path.join(evidence, `${stage.id}.log`), { force: true })));
		for (const stage of stages) {
			currentStage = stage.id;
			failureOutput = "";
			process.stdout.write(`[platform-workbench] ${currentStage} started\n`);
			const generation = randomUUID();
			const probeFile = path.join(sandbox, `${currentStage}.network-probe.json`);
			const stageEnvironment = { ...environment,
				LLM_WIKI_BROWSER_NETWORK_PROBE_FILE: probeFile,
				LLM_WIKI_BROWSER_NETWORK_PROBE_TARGET: "http://192.0.2.1:9",
				LLM_WIKI_BROWSER_NETWORK_PROBE_GENERATION: generation,
			};
			const result = await runInvocation(stage.invocation, stageEnvironment, stage.timeoutMs, undefined, { signal: controller.signal });
			failureOutput = sanitizePlatformOutput(result.output, { repoRoot: REPO_ROOT, sandbox, home, userHome });
			const labelledOutput = `[${currentStage}]\n${failureOutput}\n`;
			await writeFile(path.join(evidence, `${mode}.log`), completed.map((item) => `[${item}] passed\n`).join("") + labelledOutput, "utf8");
			if (mode === "build") await writeFile(path.join(evidence, `${currentStage}.log`), failureOutput, "utf8");
			process.stdout.write(labelledOutput);
			const probe = JSON.parse(await readFile(probeFile, "utf8"));
			if (probe.generation !== generation || probe.result !== "BLOCKED") throw new Error("Platform suite network guard was not verified for this launch");
			if (signal) throw new Error(`Platform suite interrupted by ${signal}`);
			if (result.timedOut || result.code !== 0) throw new Error(`Platform stage ${currentStage} failed (${result.timedOut ? "timeout" : result.code ?? result.signal})`);
			completed.push(currentStage);
		}
		await writeFile(path.join(evidence, `${mode}.json`), JSON.stringify({ platform: process.platform, mode, completedStages: completed, testFiles: files, result: "passed", networkGuard: "verified" }, null, 2) + "\n");
	} catch (error) {
		const message = sanitizePlatformOutput(error instanceof Error ? error.message : String(error), { repoRoot: REPO_ROOT, sandbox, home, userHome });
		emitGithubError(`Windows workbench: ${currentStage}`, `${failureOutput}\n${message}`, { repoRoot: REPO_ROOT, sandbox, home, userHome });
		const reportedError = error instanceof Error ? error : new Error(message);
		Object.assign(reportedError, { platformDiagnosticReported: true });
		await writeFile(path.join(evidence, `${mode}.json`), JSON.stringify({ platform: process.platform, mode, failedStage: currentStage, completedStages: completed, result: "failed" }, null, 2) + "\n");
		process.exitCode = interruptedExitCode(signal);
		throw reportedError;
	} finally {
		process.off("SIGINT", interrupt);
		process.off("SIGTERM", terminate);
		await rm(sandbox, { recursive: true, force: true });
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const flags = process.argv.slice(2);
	const mode = flags.find((flag) => !flag.startsWith("--")) ?? "backend";
	try {
		await runPlatformWorkbenchTests(mode, { requireWindows: flags.includes("--require-windows") });
	} catch (error) {
		const message = sanitizePlatformOutput(error instanceof Error ? error.message : String(error), { repoRoot: REPO_ROOT });
		if (!error?.platformDiagnosticReported) emitGithubError(`Windows workbench: ${mode}`, message, { repoRoot: REPO_ROOT });
		console.error(message);
		process.exitCode ||= 1;
	}
}
