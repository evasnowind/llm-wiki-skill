import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { interruptedExitCode, runInvocation, sanitizeOutput } from "./run-quality-and-tests.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const NETWORK_GUARD = pathToFileURL(path.join(REPO_ROOT, "workbench/server/test/support/network-guard.mjs")).href;

export const PLATFORM_BACKEND_TESTS = [
	"workbench/scripts/platform-commands.test.mjs",
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
		NODE_OPTIONS: `--import=${NETWORK_GUARD}`,
	};
	for (const name of ["CI", "SystemRoot", "ComSpec", "PATHEXT", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "PLAYWRIGHT_BROWSERS_PATH"]) {
		if (source[name]) environment[name] = source[name];
	}
	return environment;
}

export async function runPlatformWorkbenchTests(mode, { requireWindows = false } = {}) {
	if (!["backend", "browser"].includes(mode)) throw new Error("Expected backend or browser test mode");
	if (requireWindows && process.platform !== "win32") throw new Error("Native Windows CI must run with a Windows Node.js executable");
	const sandbox = await mkdtemp(path.join(tmpdir(), "llm-wiki-platform-suite-"));
	const home = path.join(sandbox, "用户 HOME");
	const evidence = path.join(REPO_ROOT, ".tmp", "windows-workbench");
	const environment = createPlatformTestEnvironment(home);
	const generation = randomUUID();
	const probeFile = path.join(sandbox, "network-probe.json");
	Object.assign(environment, {
		LLM_WIKI_BROWSER_NETWORK_PROBE_FILE: probeFile,
		LLM_WIKI_BROWSER_NETWORK_PROBE_TARGET: "http://192.0.2.1:9",
		LLM_WIKI_BROWSER_NETWORK_PROBE_GENERATION: generation,
	});
	await Promise.all([environment.APPDATA, environment.LOCALAPPDATA, environment.XDG_CONFIG_HOME, environment.PI_CODING_AGENT_DIR, environment.TMPDIR, evidence].map((directory) => mkdir(directory, { recursive: true })));
	await rm(path.join(evidence, `${mode}.json`), { force: true });
	const controller = new AbortController();
	let signal;
	const interrupt = () => { signal = "SIGINT"; controller.abort(); };
	const terminate = () => { signal = "SIGTERM"; controller.abort(); };
	process.once("SIGINT", interrupt);
	process.once("SIGTERM", terminate);
	try {
		const files = mode === "backend" ? PLATFORM_BACKEND_TESTS : PLATFORM_BROWSER_TESTS;
		const result = await runInvocation({
			command: process.execPath,
			args: ["--import", "tsx", "--test-concurrency=1", "--test", ...files],
			cwd: REPO_ROOT,
		}, environment, mode === "browser" ? 240_000 : 180_000, undefined, { signal: controller.signal });
		const output = sanitizeOutput(result.output, { repoRoot: REPO_ROOT, sandbox, home });
		await writeFile(path.join(evidence, `${mode}.log`), output, "utf8");
		process.stdout.write(output.endsWith("\n") ? output : output + "\n");
		const probe = JSON.parse(await readFile(probeFile, "utf8"));
		if (probe.generation !== generation || probe.result !== "BLOCKED") throw new Error("Platform suite network guard was not verified for this launch");
		if (signal) throw new Error(`Platform suite interrupted by ${signal}`);
		if (result.timedOut || result.code !== 0) throw new Error(`Platform ${mode} tests failed (${result.timedOut ? "timeout" : result.code ?? result.signal})`);
		await writeFile(path.join(evidence, `${mode}.json`), JSON.stringify({ platform: process.platform, mode, testFiles: files, result: "passed", networkGuard: "verified" }, null, 2) + "\n");
	} catch (error) {
		await writeFile(path.join(evidence, `${mode}.json`), JSON.stringify({ platform: process.platform, mode, result: "failed" }, null, 2) + "\n");
		process.exitCode = interruptedExitCode(signal);
		throw error;
	} finally {
		process.off("SIGINT", interrupt);
		process.off("SIGTERM", terminate);
		await rm(sandbox, { recursive: true, force: true });
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const flags = process.argv.slice(2);
	const mode = flags.find((flag) => !flag.startsWith("--")) ?? "backend";
	await runPlatformWorkbenchTests(mode, { requireWindows: flags.includes("--require-windows") });
}
