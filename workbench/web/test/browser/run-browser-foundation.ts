import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { npmInvocation } from "../../../scripts/npm-command.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
const TOTAL_TIMEOUT_MS = 120_000;
const CLEANUP_BUDGET_MS = 1_000;
const EXECUTION_TIMEOUT_MS = TOTAL_TIMEOUT_MS - CLEANUP_BUDGET_MS;
const STOP_TIMEOUT_MS = CLEANUP_BUDGET_MS / 2;

const commands = [
	{
		...npmInvocation(["run", "build", "-w", "@llm-wiki-agent/server"]),
	},
	{
		command: process.execPath,
		args: ["--import", "tsx", "--test", "workbench/web/test/browser/browser-foundation.test.ts"],
	},
];

let activeChild: ChildProcess | undefined;
let timedOut = false;
let terminationSignal: NodeJS.Signals | undefined;
const deadline = Date.now() + EXECUTION_TIMEOUT_MS;
const timer = setTimeout(() => {
	timedOut = true;
	if (activeChild) signalProcessTree(activeChild, "SIGTERM");
}, EXECUTION_TIMEOUT_MS);
const terminate = (signal: NodeJS.Signals) => {
	terminationSignal = signal;
	if (activeChild) signalProcessTree(activeChild, signal);
};
const interruptHandler = () => terminate("SIGINT");
const terminateHandler = () => terminate("SIGTERM");
process.once("SIGINT", interruptHandler);
process.once("SIGTERM", terminateHandler);

try {
	for (const command of commands) {
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0 || timedOut) throw new Error("browser foundation exceeded 120 seconds");
		activeChild = spawn(command.command, command.args, {
			cwd: REPO_ROOT,
			detached: process.platform !== "win32",
			env: minimalEnvironment(),
			stdio: "inherit",
		});
		const result = await waitForExit(activeChild, remainingMs);
		if (terminationSignal) {
			await forceStop(activeChild);
			throw new Error(`browser foundation interrupted by ${terminationSignal}`);
		}
		if (timedOut) {
			await forceStop(activeChild);
			throw new Error("browser foundation exceeded 120 seconds");
		}
		if (result.code !== 0) {
			throw new Error(`browser foundation command failed with ${result.signal ?? result.code}`);
		}
		activeChild = undefined;
	}
} catch (error) {
	if (activeChild && activeChild.exitCode === null && activeChild.signalCode === null) await forceStop(activeChild);
	console.error(error);
	process.exitCode = terminationSignal === "SIGINT" ? 130 : terminationSignal === "SIGTERM" ? 143 : 1;
} finally {
	clearTimeout(timer);
	process.off("SIGINT", interruptHandler);
	process.off("SIGTERM", terminateHandler);
}

function minimalEnvironment(): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {
		HOME: process.env.HOME,
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		TMPDIR: process.env.TMPDIR,
		LANG: "C.UTF-8",
		CI: process.env.CI,
		PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
	};
	if (process.platform === "win32") {
		for (const name of ["SystemRoot", "ComSpec", "PATHEXT", "TEMP", "TMP"] as const) {
			if (process.env[name]) environment[name] = process.env[name];
		}
	}
	return environment;
}

async function waitForExit(
	child: ChildProcess,
	timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return { code: child.exitCode, signal: child.signalCode };
	}
	return new Promise((resolvePromise, reject) => {
		const timeout = setTimeout(
			() => reject(new Error("browser foundation command did not exit before its deadline")),
			timeoutMs,
		);
		child.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.once("exit", (code, signal) => {
			clearTimeout(timeout);
			resolvePromise({ code, signal });
		});
	});
}

async function forceStop(child: ChildProcess): Promise<void> {
	signalProcessTree(child, "SIGTERM");
	try {
		await waitForExit(child, STOP_TIMEOUT_MS);
	} catch {
		signalProcessTree(child, "SIGKILL");
		await waitForExit(child, STOP_TIMEOUT_MS);
	}
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
	if (!child.pid) return;
	try {
		if (process.platform === "win32") {
			spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
		} else {
			process.kill(-child.pid, signal);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}
