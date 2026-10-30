import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import { getAgentDir, getShellConfig, SettingsManager } from "@earendil-works/pi-coding-agent";

export const BASH_UNAVAILABLE_MESSAGE = "未找到可用的 Bash。Windows 请安装 Git for Windows，或在现有 pi 设置中指定 Bash 路径后重试。";

export class BashUnavailableError extends Error {
	readonly code = "SETUP_REQUIRED";
	readonly reason = "BASH_UNAVAILABLE";
	constructor() { super(BASH_UNAVAILABLE_MESSAGE); }
}

interface BashScriptOptions {
	cwd: string;
	env?: NodeJS.ProcessEnv;
	/** Dependency seams for platform checks; normal callers only supply cwd/env. */
	platform?: NodeJS.Platform;
	resolveShell?: typeof getShellConfig;
	readShellPath?: (cwd: string) => string | undefined;
}

/** Convert only known filesystem arguments; user text must stay untouched. */
export function toBashPath(value: string, platform: NodeJS.Platform = process.platform): string {
	return platform === "win32" ? value.replaceAll("\\", "/") : value;
}

/** Execute a script as an argv file, never as a shell command string. */
export function createBashScriptCommand(scriptPath: string, args: string[], options: BashScriptOptions): {
	command: string;
	args: string[];
	env: NodeJS.ProcessEnv;
} {
	const platform = options.platform ?? process.platform;
	const resolveShell = options.resolveShell ?? getShellConfig;
	const readShellPath = options.readShellPath ?? ((cwd) => SettingsManager.create(cwd, getAgentDir()).getShellPath());
	let command: string;
	try {
		const preferred = readShellPath(options.cwd);
		command = resolveShell(preferred).shell;
		// A user's interactive zsh/sh setting cannot execute our Bash-specific scripts.
		if (!isBash(command) && preferred) command = resolveShell().shell;
		if (!isBash(command)) throw new BashUnavailableError();
	} catch { throw new BashUnavailableError(); }
	const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env), PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" };
	if (platform === "win32") {
		// Init deliberately uses a small environment; retain Windows runtime essentials.
		for (const key of ["SystemRoot", "windir", "ComSpec", "PATHEXT", "ProgramFiles", "ProgramFiles(x86)", "TEMP", "TMP"]) {
			if (!environmentValue(env, key)) {
				const value = environmentValue(process.env, key);
				if (value) env[key] = value;
			}
		}
		const currentPath = environmentValue(env, "PATH") ?? "";
		for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
		const shellDirectory = path.win32.dirname(command);
		const search = [shellDirectory];
		if (path.win32.basename(shellDirectory).toLowerCase() === "bin") {
			const parent = path.win32.dirname(shellDirectory);
			const root = path.win32.basename(parent).toLowerCase() === "usr" ? path.win32.dirname(parent) : parent;
			search.push(path.win32.join(root, "usr", "bin"), path.win32.join(root, "bin"));
		}
		search.push(path.win32.dirname(process.execPath), currentPath);
		env.PATH = [...new Set(search.filter(Boolean))].join(";");
	}
	return { command, args: ["--noprofile", "--norc", "--", toBashPath(scriptPath, platform), ...args], env };
}

function isBash(command: string): boolean {
	return /(?:^|[/\\])bash(?:\.exe)?$/iu.test(command);
}

function environmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
	const key = Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase());
	return key ? env[key] : undefined;
}

/** Own time/output limits so termination covers descendants before the leader exits. */
export async function executeBashScript(
	scriptPath: string,
	args: string[],
	options: BashScriptOptions & { timeoutMs?: number; maxOutputBytes?: number },
): Promise<{ stdout: string; stderr: string }> {
	const invocation = createBashScriptCommand(scriptPath, args, options);
	const platform = options.platform ?? process.platform;
	const maxOutput = options.maxOutputBytes ?? 1024 * 1024;
	return new Promise((resolve, reject) => {
		const child = spawn(invocation.command, invocation.args, {
			cwd: options.cwd, env: invocation.env, windowsHide: true,
			detached: platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
		});
		const chunks: Record<"stdout" | "stderr", Buffer[]> = { stdout: [], stderr: [] };
		const sizes = { stdout: 0, stderr: 0 };
		let failure: Error | undefined;
		let hardStop: ReturnType<typeof setTimeout> | undefined;
		const stopTree = (signal: NodeJS.Signals) => {
			try { signalBashProcessTree(child, signal, platform); }
			catch { if (failure) Object.assign(failure, { cleanupFailed: true }); }
		};
		const terminate = (error: Error) => {
			if (failure) return;
			failure = error;
			stopTree("SIGTERM");
			hardStop = setTimeout(() => stopTree("SIGKILL"), 100);
		};
		for (const stream of ["stdout", "stderr"] as const) {
			child[stream].on("data", (value: Buffer) => {
				if (failure) return;
				const remaining = Math.max(0, maxOutput - sizes[stream]);
				chunks[stream].push(value.subarray(0, remaining));
				sizes[stream] += value.length;
				if (sizes[stream] > maxOutput) terminate(Object.assign(new Error("Bash 脚本输出超过限制"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }));
			});
		}
		const timer = setTimeout(() => terminate(Object.assign(new Error("Bash 脚本执行超时"), { code: "ETIMEDOUT" })), options.timeoutMs ?? 60_000);
		child.once("error", (error) => { failure ??= error; });
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			if (hardStop) {
				clearTimeout(hardStop);
				// Descendants with redirected stdio do not delay the leader's close event.
				stopTree("SIGKILL");
			}
			const output = { stdout: Buffer.concat(chunks.stdout).toString("utf8"), stderr: Buffer.concat(chunks.stderr).toString("utf8") };
			if (!failure && (code !== 0 || signal)) failure = Object.assign(new Error("Bash 脚本执行失败"), { code, signal });
			if (failure) reject(Object.assign(failure, output)); else resolve(output);
		});
	});
}

const signalledProcessGroups = new WeakSet<object>();

/** Windows has no POSIX process groups: taskkill /T also terminates descendants. */
export function signalBashProcessTree(
	child: Pick<ChildProcess, "pid" | "exitCode" | "signalCode" | "kill">,
	signal: NodeJS.Signals,
	platform: NodeJS.Platform = process.platform,
	terminate: typeof spawnSync = spawnSync,
): void {
	if (!child.pid) return;
	const finished = child.exitCode !== null || child.signalCode !== null;
	// A timed-out group may outlive its leader while still owning inherited pipes.
	if (finished && !(platform !== "win32" && signal === "SIGKILL" && signalledProcessGroups.has(child))) return;
	if (platform === "win32") {
		const systemRoot = environmentValue(process.env, "SystemRoot") ?? "C:\\Windows";
		const result = terminate(path.win32.join(systemRoot, "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], {
			windowsHide: true, stdio: "ignore", timeout: 2_000,
		});
		if (result.error || (result.status !== 0 && result.status !== 128)) child.kill(signal);
		return;
	}
	if (signal === "SIGTERM") signalledProcessGroups.add(child);
	try { process.kill(-child.pid, signal); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
	finally { if (signal === "SIGKILL") signalledProcessGroups.delete(child); }
}
