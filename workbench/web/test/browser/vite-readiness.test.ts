import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	OPERATION_TIMEOUT_MS, VITE_ENTRY, WEB_ROOT,
	assertPortAvailable, availablePort, isolatedEnvironment,
	prepareSandboxDirectories, startNetworkGuardedProcess, stopProcess,
	type RunningProcess,
} from "./support/browser-harness";

test("guarded Vite readiness accepts its native Windows colored Local label", { timeout: 45_000 }, async (t) => {
	const home = await mkdtemp(join(tmpdir(), "vite 中文 空格-"));
	const port = await availablePort();
	let running: RunningProcess | undefined;
	t.after(async () => {
		try {
			if (running) await stopProcess(running, [0, 143]);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
	await prepareSandboxDirectories(home);
	running = await startNetworkGuardedProcess(
		process.execPath,
		[VITE_ENTRY, "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
		WEB_ROOT,
		{
			...isolatedEnvironment(home, 0, home),
			PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
			XDG_CONFIG_HOME: join(home, ".config"),
			// picocolors enables this by default on Windows, including piped output.
			FORCE_COLOR: "1",
			LLM_WIKI_AGENT_DISABLE_HMR: "1",
		},
		(output) => output.includes("Local:"),
		"colored Vite frontend",
		join(home, "vite-network-probe"),
	);
	assert.ok(running.output().includes("\u001b[1mLocal\u001b[22m:"), "exercise the actual ANSI sequence that splits the readiness label");
	assert.doesNotMatch(running.output(), /Local:/u, "raw logs retain their original diagnostic content");
	const response = await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(OPERATION_TIMEOUT_MS) });
	assert.equal(response.status, 200);
	assert.match(await response.text(), /<div id="root">/u);
	await stopProcess(running, [0, 143]);
	running = undefined;
	await assertPortAvailable(port);
});
