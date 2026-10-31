import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { npmInvocation } from "./npm-command.mjs";
import { runInvocation } from "./run-quality-and-tests.mjs";
import { createPlatformTestEnvironment, platformBuildSteps, PLATFORM_BACKEND_TESTS, PLATFORM_BROWSER_TESTS } from "./run-platform-workbench-tests.mjs";
import { emitGithubError, githubErrorAnnotation, MAX_GITHUB_ANNOTATION_BYTES, sanitizePlatformOutput } from "./platform-diagnostics.mjs";

test("Windows npm uses the exact npm CLI and arguments through Node, without cmd or shell expansion", async (t) => {
	const directory = await mkdtemp(path.join(tmpdir(), "npm 空格-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const cli = path.join(directory, "npm-cli.js");
	await writeFile(cli, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
	const args = ["run", "中文 & $(do-not-run) %USERPROFILE%", "--", "a b", 'a"b'];
	const invocation = npmInvocation(args, { platform: "win32", execPath: process.execPath, environment: { npm_execpath: cli } });
	assert.equal(invocation.command, process.execPath);
	assert.deepEqual(invocation.args, [cli, ...args]);
	const child = spawn(invocation.command, invocation.args, { stdio: ["ignore", "pipe", "pipe"], shell: false });
	let output = "";
	child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
	await new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`fixture exited ${code}`)));
	});
	assert.deepEqual(JSON.parse(output), args);
});

test("Windows npm discovery supports standard Node installs and case-insensitive PATH without npm_execpath", () => {
	const cli = "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";
	const standard = npmInvocation(["ci"], { platform: "win32", execPath: "C:\\Program Files\\nodejs\\node.exe", environment: {}, exists: (candidate) => candidate === cli });
	assert.deepEqual(standard.args, [cli, "ci"]);
	const roaming = "C:\\Users\\fixture\\AppData\\Roaming\\npm\\node_modules\\npm\\bin\\npm-cli.js";
	const found = npmInvocation(["run", "build"], { platform: "win32", execPath: "D:\\custom\\node.exe", environment: { Path: '"C:\\Users\\fixture\\AppData\\Roaming\\npm";C:\\Windows' }, exists: (candidate) => candidate === roaming });
	assert.deepEqual(found.args, [roaming, "run", "build"]);
	assert.throws(() => npmInvocation(["ci"], { platform: "win32", environment: {}, exists: () => false }), /Cannot locate npm CLI/);
	assert.deepEqual(npmInvocation(["ci"], { platform: "linux" }), { command: "npm", args: ["ci"] });
});

test("platform suite isolates every home location, drops credentials and only preserves system prerequisites", () => {
	const home = path.join(tmpdir(), "isolated-home");
	const environment = createPlatformTestEnvironment(home, {
		HOME: "/private-real-home", USERPROFILE: "C:\\real-profile", APPDATA: "C:\\real-appdata",
		PI_CODING_AGENT_DIR: "/real-agent", OPENAI_API_KEY: "private-key", NPM_TOKEN: "private-token",
		NODE_OPTIONS: "--require=untrusted.js", PATH: "/tools", SystemRoot: "C:\\Windows", ProgramFiles: "C:\\Program Files",
	});
	assert.equal(environment.HOME, home);
	assert.equal(environment.USERPROFILE, home);
	for (const name of ["APPDATA", "LOCALAPPDATA", "PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME", "TEMP", "TMP", "TMPDIR"]) assert.equal(path.relative(home, environment[name]).startsWith(".."), false, name);
	assert.equal(environment.OPENAI_API_KEY, undefined);
	assert.equal(environment.NPM_TOKEN, undefined);
	assert.equal(environment.SystemRoot, "C:\\Windows");
	assert.equal(environment.ProgramFiles, "C:\\Program Files");
	assert.match(environment.NODE_OPTIONS, /^--import=file:/);
	assert.doesNotMatch(environment.NODE_OPTIONS, /untrusted/);
	assert.ok(PLATFORM_BACKEND_TESTS.includes("workbench/server/src/ingest-queue.test.ts"));
	assert.ok(PLATFORM_BACKEND_TESTS.includes("workbench/server/src/sources-only.test.ts"));
	assert.ok(PLATFORM_BACKEND_TESTS.includes("workbench/server/src/source-revisions.test.ts"));
	assert.ok(PLATFORM_BACKEND_TESTS.includes("workbench/server/src/ingest/revision-generator.test.ts"));
	assert.deepEqual(PLATFORM_BROWSER_TESTS.map((file) => path.basename(file)), ["reliable-ingest.test.ts", "markdown-evidence.test.ts", "source-revisions.test.ts"]);
});

test("process runner preserves an explicit guard preload and handles a preload path containing spaces", async (t) => {
	const directory = await mkdtemp(path.join(tmpdir(), "preload 空格-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const preload = path.join(directory, "guard marker.cjs");
	await writeFile(preload, "process.env.TEST_PRELOAD_MARKER = 'guard-loaded';\n");
	const environment = { ...createPlatformTestEnvironment(directory), NODE_OPTIONS: `--require=${JSON.stringify(preload.replaceAll("\\", "/"))}` };
	const result = await runInvocation({ command: process.execPath, args: ["-e", "process.stdout.write(process.env.TEST_PRELOAD_MARKER || 'missing')"], cwd: directory }, environment, 5_000);
	assert.equal(result.code, 0, result.output);
	assert.equal(result.output, "guard-loaded");
});

test("native Windows process completion does not attempt to inspect a POSIX process table", { skip: process.platform !== "win32" }, async (t) => {
	const directory = await mkdtemp(path.join(tmpdir(), "windows-native-child-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	let inspected = false;
	const result = await runInvocation({ command: process.execPath, args: ["-e", "process.stdout.write('native-child-finished')"], cwd: directory }, createPlatformTestEnvironment(directory), 5_000, undefined, {
		readProcesses: () => { inspected = true; throw new Error("POSIX ps must not run on Windows"); },
	});
	assert.equal(result.code, 0, result.output);
	assert.equal(result.output, "native-child-finished");
	assert.equal(inspected, false);
});

test("GitHub diagnostics escape data and properties without emitting nested commands or ANSI", () => {
	const command = githubErrorAnnotation("build%,:\r\n", "\u001b[31merror TS9999: 50%\r\n::warning::not-a-command\u001b[0m");
	assert.match(command, /^::error title=build%25%2C%3A%0D%0A::/);
	assert.match(command, /50%25%0D%0A::warning::not-a-command/);
	assert.equal(command.split("\n").length, 2);
	assert.doesNotMatch(command, /\u001b|\r/);
	const emitted = [];
	assert.equal(emitGithubError("title", "message", { environment: {}, write: (value) => emitted.push(value) }), false);
	assert.equal(emitted.length, 0);
	assert.equal(emitGithubError("title", "message", { environment: { GITHUB_ACTIONS: "true" }, write: (value) => emitted.push(value) }), true);
	assert.equal(emitted.length, 1);
});

test("diagnostics mask Windows slash, case and URI path variants and token-shaped values", () => {
	const context = { repoRoot: "D:\\Build Space\\project", sandbox: "C:\\Users\\Private Person\\temp\\run", home: "C:\\Users\\Private Person\\temp\\run\\用户 HOME", userHome: "C:\\Users\\Private Person" };
	const output = [
		"D:/build space/project/src/file.ts(1,2): error TS1: invalid",
		"file:///D:/Build%20Space/project/src/file.ts",
		"C:\\Users\\Private Person\\temp\\run\\source.txt",
		"C:/Users/Private Person/secret.txt sk-abcdefghijklmnop",
	].join("\n");
	const safe = sanitizePlatformOutput(output, context);
	assert.match(safe, /<repo>\/src\/file.ts/);
	assert.match(safe, /<sandbox>/);
	assert.match(safe, /<user-home>/);
	assert.doesNotMatch(safe, /Private Person|build space|Build%20Space|sk-abcdefghijklmnop/);
});

test("annotations retain the first concrete error and remain byte bounded without broken escapes", () => {
	const text = Array.from({ length: 80 }, (_, index) => `build progress ${index}`).join("\n")
		+ "\nerror TS9999: root-cause " + "中%\r\n".repeat(8_000) + "\nfinal failure";
	const command = githubErrorAnnotation("Windows workbench: build-server", text);
	assert.ok(Buffer.byteLength(command) <= MAX_GITHUB_ANNOTATION_BYTES);
	assert.match(command, /error TS9999: root-cause/);
	assert.equal(command.split("\n").length, 2);
	assert.doesNotThrow(() => decodeURIComponent(command.slice(command.indexOf("::", 2) + 2)));
});

test("passed test names containing failed cannot displace the actual assertion diagnostic", () => {
	const successful = Array.from({ length: 159 }, (_, index) => `✔ handles failed task ${index} and expected Error: diagnostics`).join("\n");
	const output = successful + "\n✖ target operation failed\nℹ tests 160\n✖ failing tests:\ntest at synthetic.test.ts:1:1\n✖ target operation failed\n  AssertionError [ERR_ASSERTION]: actual assertion reason must remain visible\n"
		+ Array.from({ length: 95 }, (_, index) => `    at synthetic-frame-${index}`).join("\n");
	const command = githubErrorAnnotation("backend", output);
	assert.match(command, /actual assertion reason must remain visible/);
	assert.doesNotMatch(command, /handles failed task/);
	assert.ok(Buffer.byteLength(command) <= MAX_GITHUB_ANNOTATION_BYTES);
});

test("TAP annotations include separate assertion details before a long successful output tail", () => {
	const failure = (number, message) => `not ok ${number} - native Windows operation\n  ---\n  duration_ms: 100\n  location: '<repo>/case.test.ts:1:1'\n  failureType: 'testCodeFailure'\n  error: |-\n    ${message}\n    Expected values to be strictly equal:\n    'actual' !== 'expected'\n  code: 'ERR_ASSERTION'\n  stack: |-\n    AssertionError: ${message}\n  ...`;
	const successful = Array.from({ length: 160 }, (_, index) => `ok ${index + 10} - handles failed tasks with expected Error: diagnostics`).join("\n");
	const aggregate = "not ok 171 - parent test\n  ---\n  failureType: 'subtestsFailed'\n  error: '1 subtest failed'\n  ...";
	const output = ["TAP version 13", failure(1, "actual cache assertion reason"), successful, failure(170, "actual graph assertion reason"), aggregate, successful, "1..172", "# tests 172", "# pass 170", "# fail 2"].join("\n");
	const command = githubErrorAnnotation("backend", output);
	assert.match(command, /TAP failure details/);
	assert.match(command, /actual cache assertion reason/);
	assert.match(command, /actual graph assertion reason/);
	assert.match(command, /Expected values to be strictly equal/);
	assert.doesNotMatch(command, /parent test|subtestsFailed/);
	assert.ok(Buffer.byteLength(command) <= MAX_GITHUB_ANNOTATION_BYTES);
});

test("build diagnostics have separate safe npm commands for server, web and typecheck", () => {
	const cli = "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";
	const executable = "C:\\Program Files\\nodejs\\node.exe";
	const steps = platformBuildSteps({ platform: "win32", execPath: executable, environment: { npm_execpath: cli }, exists: () => true });
	assert.deepEqual(steps.map(({ id }) => id), ["build-server", "build-web", "typecheck"]);
	assert.deepEqual(steps.map(({ invocation }) => invocation.args), [
		[cli, "run", "build", "-w", "@llm-wiki-agent/server"],
		[cli, "run", "build", "-w", "@llm-wiki-agent/web"],
		[cli, "run", "typecheck"],
	]);
	assert.ok(steps.every(({ invocation, timeoutMs }) => invocation.command === executable && timeoutMs === 180_000));
	assert.ok(PLATFORM_BACKEND_TESTS.includes("workbench/scripts/check-workbench-boundaries.test.mjs"));
});
