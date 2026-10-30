import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";

import {
	chooseSystemDirectory,
	DIRECTORY_PICKER_TIMEOUT_MS,
	type DirectoryPickerCommand,
	type DirectoryPickerRunner,
} from "./directory-picker.js";

function fixture(stdout: string) {
	const commands: DirectoryPickerCommand[] = [];
	const run: DirectoryPickerRunner = async (command) => {
		commands.push(command);
		return stdout;
	};
	return { run, commands };
}

test("Windows picker uses its system PowerShell with a constant UTF-16 script and explicit UTF-8 output", async () => {
	const selected = "C:\\知识 库\\Alice's & $notes [1]";
	const { run, commands } = fixture(`\uFEFF${selected}\r\n`);
	const env = { SystemRoot: "D:\\Windows System", PATH: "D:\\node" };
	assert.equal(await chooseSystemDirectory({ platform: "win32", env, run }), selected);
	assert.equal(commands.length, 1);
	const command = commands[0]!;
	assert.equal(command.file, "D:\\Windows System\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
	assert.deepEqual(command.args.slice(0, -1), ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand"]);
	const script = Buffer.from(command.args.at(-1)!, "base64").toString("utf16le");
	assert.match(script, /FolderBrowserDialog/u);
	assert.match(script, /UTF8Encoding\(\$false\)/u);
	assert.match(script, /选择知识库文件夹/u);
	assert.match(script, /finally\s*\{\s*\$dialog\.Dispose\(\)/u);
	assert.ok(!script.includes(selected));
	assert.equal(command.options.shell, false);
	assert.equal(command.options.windowsHide, true);
	assert.equal(command.options.encoding, "utf8");
	assert.equal(command.options.timeout, DIRECTORY_PICKER_TIMEOUT_MS);
	assert.equal(command.options.killSignal, "SIGTERM");
	assert.deepEqual(env, { SystemRoot: "D:\\Windows System", PATH: "D:\\node" });
});

test("Windows picker preserves UNC selection and supports uppercase Windows environment keys", async () => {
	const selected = "\\\\server\\shared notes\\中文";
	const { run, commands } = fixture(selected);
	assert.equal(await chooseSystemDirectory({ platform: "win32", env: { SYSTEMROOT: "C:\\WINDOWS" }, run }), selected);
	assert.equal(commands[0]?.file, "C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
});

test("Windows cancellation is a successful empty selection and never runs another command", async () => {
	const { run, commands } = fixture("\r\n");
	assert.equal(await chooseSystemDirectory({ platform: "win32", env: {}, run }), null);
	assert.equal(commands.length, 1);
	assert.equal(commands[0]?.file, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
});

test("Windows failures and invalid output cannot expose paths, script contents or native error details", async () => {
	for (const error of [new Error("C:\\private\\key-secret picker-128"), Object.assign(new Error("native timeout secret"), { code: "ENOENT" })]) {
		await assert.rejects(chooseSystemDirectory({ platform: "win32", run: async () => { throw error; } }), (result: unknown) => {
			assert.equal((result as { code?: unknown }).code, "DIRECTORY_PICKER_FAILED");
			assert.doesNotMatch(String(result), /key-secret|private|native timeout/u);
			return true;
		});
	}
	for (const output of ["relative\\folder", "C:\\notes\0private"]) {
		await assert.rejects(chooseSystemDirectory({ platform: "win32", run: fixture(output).run }), /无法打开文件夹选择器/u);
	}
});

test("macOS retains its existing AppleScript directory result and cancellation semantics", async () => {
	const { run, commands } = fixture("/Volumes/fixture/知识 库/\n");
	assert.equal(await chooseSystemDirectory({ platform: "darwin", run }), "/Volumes/fixture/知识 库/");
	assert.equal(commands[0]?.file, "/usr/bin/osascript");
	assert.deepEqual(commands[0]?.args, ["-e", 'POSIX path of (choose folder with prompt "选择知识库文件夹")']);
	for (const message of ["execution error: User canceled. (-128)", "user canceled"]) {
		assert.equal(await chooseSystemDirectory({ platform: "darwin", run: async () => { throw new Error(message); } }), null);
	}
	await assert.rejects(chooseSystemDirectory({ platform: "darwin", run: fixture("\n").run }), (error: unknown) => (error as { code?: unknown }).code === "EMPTY_SELECTION");
});

test("unsupported systems stay explicit and do not launch a desktop process", async () => {
	let calls = 0;
	await assert.rejects(chooseSystemDirectory({ platform: "linux", run: async () => { calls++; return ""; } }), (error: unknown) => (error as { code?: unknown }).code === "ENOTSUP");
	assert.equal(calls, 0);
});

test("request abort is forwarded to the owned dialog process and discards a late selection", async () => {
	const controller = new AbortController();
	let command: DirectoryPickerCommand | undefined;
	const result = await chooseSystemDirectory({ platform: "win32", signal: controller.signal, run: async (value) => {
		command = value;
		controller.abort();
		return "C:\\late selection";
	} });
	assert.equal(command?.options.signal, controller.signal);
	assert.equal(result, null);
	let calls = 0;
	assert.equal(await chooseSystemDirectory({ platform: "darwin", signal: controller.signal, run: async () => { calls++; return "/late"; } }), null);
	assert.equal(calls, 0);
});

test("timeout and output overflow have distinct safe failures", async () => {
	await assert.rejects(chooseSystemDirectory({ platform: "win32", run: async () => { throw Object.assign(new Error("private native failure"), { killed: true }); } }), (error: unknown) => {
		assert.equal((error as { code?: unknown }).code, "DIRECTORY_PICKER_TIMEOUT");
		assert.doesNotMatch(String(error), /private|native/u);
		return true;
	});
	await assert.rejects(chooseSystemDirectory({ platform: "win32", run: async () => { throw Object.assign(new Error("private buffer"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true }); } }), (error: unknown) => (error as { code?: unknown }).code === "DIRECTORY_PICKER_FAILED");
});

test("native Windows PowerShell parses the picker and loads WinForms without opening a dialog", { skip: process.platform !== "win32" }, async () => {
	const { run, commands } = fixture("");
	await chooseSystemDirectory({ run });
	const command = commands[0]!;
	const encoded = command.args.at(-1)!;
	assert.match(encoded, /^[A-Za-z0-9+/=]+$/u);
	const probe = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$source = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}'))
$tokens = $null
$errors = $null
[void][System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw 'Directory picker script does not parse' }
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
try { [Console]::Out.Write('选择器语法有效') } finally { $dialog.Dispose() }
`.trim();
	const args = [...command.args.slice(0, -1), Buffer.from(probe, "utf16le").toString("base64")];
	const output = await new Promise<string>((resolve, reject) => {
		execFile(command.file, args, command.options, (error, stdout) => error ? reject(error) : resolve(stdout));
	});
	assert.equal(output, "选择器语法有效");
});
