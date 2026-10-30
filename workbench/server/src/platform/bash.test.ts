import assert from "node:assert/strict";
import { execFile, type SpawnSyncOptions, type SpawnSyncReturns, type spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { BashUnavailableError, BASH_UNAVAILABLE_MESSAGE, createBashScriptCommand, executeBashScript, signalBashProcessTree, toBashPath } from "./bash.js";

test("Windows Bash scripts use separate argv and preserve user text, Unicode and shell metacharacters", () => {
	const shell = "C:\\Program Files\\Git\\bin\\bash.exe";
	const script = "C:\\project with spaces\\中文\\init.sh";
	const purpose = "研究 $HOME 'quotes' $(touch never) & C:\\not-a-path-argument";
	const originalEnv = { HOME: "C:\\用户\\测试", Path: "C:\\Node;C:\\Windows\\System32", SystemRoot: "C:\\Windows", ComSpec: "C:\\Windows\\System32\\cmd.exe" };
	const invocation = createBashScriptCommand(script, [toBashPath("C:\\知识库\\我的笔记", "win32"), purpose, "中文"], {
		cwd: "C:\\知识库", env: originalEnv, platform: "win32", readShellPath: () => undefined, resolveShell: () => ({ shell, args: ["-c"] }),
	});
	assert.equal(invocation.command, shell);
	assert.deepEqual(invocation.args, ["--noprofile", "--norc", "--", "C:/project with spaces/中文/init.sh", "C:/知识库/我的笔记", purpose, "中文"]);
	assert.equal(invocation.args.includes("-c"), false);
	assert.ok(invocation.env.PATH?.includes("C:\\Program Files\\Git\\usr\\bin"));
	assert.ok(invocation.env.PATH?.includes("C:\\Node;C:\\Windows\\System32"));
	assert.equal(Object.keys(invocation.env).filter((key) => key.toLowerCase() === "path").length, 1);
	assert.equal(invocation.env.SystemRoot, originalEnv.SystemRoot);
	assert.equal(invocation.env.ComSpec, originalEnv.ComSpec);
	assert.equal(invocation.env.PYTHONIOENCODING, "utf-8");
	assert.equal(invocation.env.PYTHONUTF8, "1");
	assert.deepEqual(originalEnv, { HOME: "C:\\用户\\测试", Path: "C:\\Node;C:\\Windows\\System32", SystemRoot: "C:\\Windows", ComSpec: "C:\\Windows\\System32\\cmd.exe" });
	assert.equal(toBashPath("\\\\host\\share name\\中文", "win32"), "//host/share name/中文");
	assert.equal(toBashPath("/ordinary/path\\literal", "linux"), "/ordinary/path\\literal");
});

test("existing shell settings are reused, while non-Bash interactive shells do not run Bash scripts", () => {
	const requested: Array<string | undefined> = [];
	const invocation = createBashScriptCommand("/script.sh", [], {
		cwd: "/kb", env: {}, readShellPath: () => "/configured/zsh",
		resolveShell: (preferred) => {
			requested.push(preferred);
			return { shell: preferred ?? "/bin/bash", args: ["-c"] };
		},
	});
	assert.deepEqual(requested, ["/configured/zsh", undefined]);
	assert.equal(invocation.command, "/bin/bash");
	const custom = createBashScriptCommand("/script.sh", [], { cwd: "/kb", env: {}, readShellPath: () => "/portable/bash", resolveShell: (preferred) => ({ shell: preferred!, args: ["-c"] }) });
	assert.equal(custom.command, "/portable/bash");
});

test("unavailable Bash and SDK sh fallback report only a safe actionable message", () => {
	for (const resolveShell of [() => ({ shell: "sh", args: ["-c"] }), () => { throw new Error("private shell path /Users/private/key-secret"); }]) {
		assert.throws(() => createBashScriptCommand("/script.sh", [], { cwd: "/kb", env: {}, readShellPath: () => undefined, resolveShell }), (error) => {
			assert.ok(error instanceof BashUnavailableError);
			assert.equal(error.message, BASH_UNAVAILABLE_MESSAGE);
			assert.equal(error.code, "SETUP_REQUIRED");
			assert.doesNotMatch(error.message, /private|key-secret/);
			return true;
		});
	}
});

test("minimal script environments do not inherit provider credentials", () => {
	const name = "WINDOWS_BASH_TEST_PROVIDER_SECRET";
	const before = process.env[name];
	process.env[name] = "must-not-inherit";
	try {
		const invocation = createBashScriptCommand("/script.sh", [], { cwd: "/kb", env: { HOME: "/isolated" }, readShellPath: () => undefined, resolveShell: () => ({ shell: "/bin/bash", args: ["-c"] }) });
		assert.equal(invocation.env[name], undefined);
	} finally {
		if (before === undefined) delete process.env[name]; else process.env[name] = before;
	}
});

test("a non-executable real script receives literal parameters in a space/Unicode directory", async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "wiki bash 中文 'space $-"));
	try {
		const script = path.join(directory, "脚本 ' $测试.sh");
		await writeFile(script, '#!/usr/bin/env bash\nset -eu\n"$1" -e \'process.stdout.write(JSON.stringify(process.argv.slice(1)))\' "${@:2}"\n', { mode: 0o600 });
		const values = ["中文 空格", "purpose $HOME 'quoted' $(touch must-not-exist); &", "原样 C:\\non-path"];
		const invocation = createBashScriptCommand(script, [toBashPath(process.execPath), ...values], { cwd: directory, env: { HOME: directory, PATH: process.env.PATH }, readShellPath: () => undefined });
		const stdout = await new Promise<string>((resolve, reject) => execFile(invocation.command, invocation.args, { cwd: directory, env: invocation.env, encoding: "utf8", windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(stdout)));
		assert.deepEqual(JSON.parse(stdout), values);
		await assert.rejects(readFile(path.join(directory, "must-not-exist")), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test("Windows graph cancellation targets the complete process tree and does not start a shell", () => {
	const calls: Array<{ command: string; args: string[]; options: SpawnSyncOptions }> = [];
	let fallback = false;
	const terminate = ((command: string, args: string[], options: SpawnSyncOptions): SpawnSyncReturns<Buffer> => {
		calls.push({ command, args, options });
		return { pid: 1, output: [], stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), status: 0, signal: null };
	}) as typeof spawnSync;
	const child = { pid: 12345, exitCode: null, signalCode: null, kill: () => { fallback = true; return true; } };
	signalBashProcessTree(child, "SIGTERM", "win32", terminate);
	assert.equal(path.win32.basename(calls[0]!.command), "taskkill.exe");
	assert.deepEqual(calls[0]!.args, ["/PID", "12345", "/T", "/F"]);
	assert.equal(calls[0]!.options.windowsHide, true);
	assert.equal(calls[0]!.options.shell, undefined);
	assert.equal(fallback, false);
	signalBashProcessTree({ ...child, exitCode: 0 }, "SIGTERM", "win32", terminate);
	assert.equal(calls.length, 1);
});

for (const limit of ["timeout", "output", "redirected-timeout"] as const) {
	test(`script ${limit} termination kills a real Bash grandchild before returning`, { timeout: 12_000 }, async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "wiki child 中文-"));
		const pidFile = path.join(directory, "child.pid");
		const heartbeat = path.join(directory, "heartbeat");
		const script = path.join(directory, "tree.sh");
		const grandchild = path.join(directory, "grandchild.cjs");
		let pid: number | undefined;
		try {
			await writeFile(grandchild, `const fs=require('node:fs');fs.writeFileSync(process.argv[2],String(process.pid));setInterval(()=>fs.writeFileSync(process.argv[3],String(Date.now())),20);process.on('SIGTERM',()=>{});if(process.argv[4]==='output')setTimeout(()=>process.stdout.write('x'.repeat(8192)),150);`);
			const redirected = limit === "redirected-timeout" ? " >/dev/null 2>&1" : "";
			await writeFile(script, `#!/usr/bin/env bash\nset -eu\n"$1" "$2" "$3" "$4" "$5"${redirected} &\nwait\n`);
			await assert.rejects(() => executeBashScript(script, [toBashPath(process.execPath), toBashPath(grandchild), toBashPath(pidFile), toBashPath(heartbeat), limit], {
				cwd: directory, env: { HOME: directory, PATH: process.env.PATH }, readShellPath: () => undefined,
				timeoutMs: limit === "output" ? 5_000 : 2_000, maxOutputBytes: 512,
			}), (error: Error & { code?: unknown; stdout?: string }) => {
				assert.equal(error.code, limit === "output" ? "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" : "ETIMEDOUT");
				assert.ok((error.stdout?.length ?? 0) <= 512);
				return true;
			});
			pid = Number(await readFile(pidFile, "utf8"));
			assert.ok(Number.isSafeInteger(pid) && pid > 0);
			const before = await stat(heartbeat);
			await new Promise((resolve) => setTimeout(resolve, 120));
			assert.equal((await stat(heartbeat)).mtimeMs, before.mtimeMs, "the descendant must stop writing before rejection returns");
			// POSIX can briefly retain a reparented zombie; it cannot write or keep pipes open.
			if (process.platform === "win32") assert.throws(() => process.kill(pid!, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH");
		} finally {
			if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* Already terminated. */ } }
			await rm(directory, { recursive: true, force: true });
		}
	});
}
