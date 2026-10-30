import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { isolateTestHome } from "../test/support/isolated-home.js";
import { executeBashScript, toBashPath } from "./platform/bash.js";

test("Skill cache keeps portable identities and safely accepts legacy Windows separators", async (t) => {
	const directory = await mkdtemp(path.join(tmpdir(), "cache 中文 空格-"));
	const restoreHome = isolateTestHome(directory);
	t.after(async () => { restoreHome(); await rm(directory, { recursive: true, force: true }); });
	const kb = path.join(directory, "kb");
	const hook = path.join(directory, "python-site");
	const rawRef = "raw/notes/素材.md";
	const sourceRef = "wiki/sources/素材.md";
	const raw = path.join(kb, rawRef);
	const source = path.join(kb, sourceRef);
	const cache = path.join(kb, ".wiki-cache.json");
	const bytes = Buffer.from("# original\n原始素材。\n");
	await Promise.all([path.dirname(raw), path.dirname(source), hook].map((target) => mkdir(target, { recursive: true })));
	await writeFile(path.join(kb, ".wiki-schema.md"), "# schema\n");
	await writeFile(raw, bytes);
	// On Windows exercise native Python; elsewhere emulate its relpath and stdout defaults.
	await writeFile(path.join(hook, "sitecustomize.py"), String.raw`import os
import sys
original_relpath = os.path.relpath
def windows_relpath(*args, **kwargs):
    return original_relpath(*args, **kwargs).replace("/", "\\")
os.path.relpath = windows_relpath
os.sep = "\\"
sys.stdout.reconfigure(newline="\r\n")
`);
	const environment = { ...process.env, PYTHONNOUSERSITE: "1", ...(process.platform === "win32" ? {} : { PYTHONPATH: hook }) };
	const run = async (command: string, ...args: string[]) => {
		const { stdout } = await executeBashScript(path.resolve("scripts/cache.sh"), [command, toBashPath(raw), ...args], { cwd: kb, env: environment });
		assert.doesNotMatch(stdout, /\r/u, "cache protocol must use LF independently of the native Python defaults");
		return stdout.trim();
	};
	const readCache = async () => JSON.parse(await readFile(cache, "utf8")) as { version: number; marker?: string; entries: Record<string, { hash: string; source_page: string; ingested_at: string }> };
	const reset = async (sourcePath: string, entries: Record<string, unknown> = {}) => {
		await writeFile(cache, JSON.stringify({ version: 1, marker: "preserve metadata", entries }) + "\n");
		await writeFile(source, `---\nsource_path: ${sourcePath}\n---\n# Summary\n`);
	};
	const hash = (relative: string, value: Buffer) => "sha256:" + createHash("sha256").update(relative).update("\0").update(value).digest("hex");

	await t.test("forward-slash source frontmatter self-heals with a canonical cache key", async () => {
		await reset(rawRef);
		assert.equal(await run("check"), "HIT(repaired)");
		assert.equal(await run("check"), "HIT");
		const data = await readCache();
		assert.deepEqual(Object.keys(data.entries), [rawRef]);
		assert.equal(data.entries[rawRef]?.source_page, sourceRef);
		assert.equal(data.entries[rawRef]?.hash, hash(rawRef, bytes));
		assert.equal(data.marker, "preserve metadata");
	});
	await t.test("legacy backslash frontmatter remains a verified match", async () => {
		await reset(rawRef.replaceAll("/", "\\"));
		assert.equal(await run("check"), "HIT(repaired)");
		assert.equal((await readCache()).entries[rawRef]?.source_page, sourceRef);
	});
	await t.test("verified legacy keys and source references migrate without losing metadata", async () => {
		const legacyRef = rawRef.replaceAll("/", "\\");
		await reset(rawRef, { [legacyRef]: { hash: hash(legacyRef, bytes), source_page: sourceRef.replaceAll("/", "\\"), ingested_at: "2020-01-01T00:00:00Z" } });
		assert.equal(await run("check"), "HIT(repaired)");
		assert.equal(await run("check"), "HIT");
		const data = await readCache();
		assert.deepEqual(Object.keys(data.entries), [rawRef]);
		assert.equal(data.entries[rawRef]?.ingested_at, "2020-01-01T00:00:00Z");
		assert.equal(data.entries[rawRef]?.hash, hash(rawRef, bytes));
	});
	await t.test("changed raw bytes cannot be accepted through legacy cache migration", async () => {
		const legacyRef = rawRef.replaceAll("/", "\\");
		await reset(rawRef, { [legacyRef]: { hash: hash(legacyRef, bytes), source_page: sourceRef, ingested_at: "2020-01-01T00:00:00Z" } });
		const before = await readFile(cache, "utf8");
		await writeFile(raw, "changed original must not HIT\n");
		assert.equal(await run("check"), "MISS:hash_changed");
		assert.equal(await readFile(cache, "utf8"), before);
		await writeFile(raw, bytes);
	});
	await t.test("invalidate removes canonical and legacy identities together", async () => {
		const legacyRef = rawRef.replaceAll("/", "\\");
		await reset(rawRef, {
			[rawRef]: { hash: hash(rawRef, bytes), source_page: sourceRef },
			[legacyRef]: { hash: hash(legacyRef, bytes), source_page: sourceRef.replaceAll("/", "\\") },
		});
		assert.equal(await run("invalidate"), "INVALIDATED");
		const data = await readCache();
		assert.deepEqual(data.entries, {});
		assert.equal(data.marker, "preserve metadata");
	});
	for (const reference of [sourceRef.replaceAll("/", "\\"), toBashPath(source)]) {
		await t.test(`update normalizes ${path.isAbsolute(reference) || /^[A-Za-z]:/u.test(reference) ? "absolute" : "relative"} source page references`, async () => {
			await reset(rawRef);
			await run("update", reference);
			assert.equal(await run("check"), "HIT");
			assert.equal((await readCache()).entries[rawRef]?.source_page, sourceRef);
		});
	}
});
