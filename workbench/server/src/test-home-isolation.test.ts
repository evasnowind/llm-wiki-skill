import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { isolateTestHome } from "../test/support/isolated-home.js";

test("temporary HOME also isolates Windows profile and SDK paths and restores every original value", async () => {
	const home = await mkdtemp(path.join(tmpdir(), "wiki-isolated-home-"));
	const keys = ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "PI_CODING_AGENT_DIR"];
	const before = keys.map((key) => [key, process.env[key]]);
	const restore = isolateTestHome(home);
	try {
		assert.equal(homedir(), home);
		assert.equal(process.env.USERPROFILE, home);
		for (const key of keys) {
			assert.equal(path.relative(home, process.env[key]!).startsWith(".."), false, key);
		}
	} finally {
		restore();
		await rm(home, { recursive: true, force: true });
	}
	assert.deepEqual(keys.map((key) => [key, process.env[key]]), before);
});
