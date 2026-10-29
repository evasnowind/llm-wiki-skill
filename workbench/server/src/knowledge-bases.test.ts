import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { findRegisteredKnowledgeBase, inspectPath, validateInspectedSourceFiles, type KnowledgeBaseInfo } from "./knowledge-bases.js";

test("findRegisteredKnowledgeBase only accepts registered valid knowledge bases", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "llm-wiki-kb-registry-"));
	const registered = path.join(root, "registered");
	const other = path.join(root, "other");
	const alias = path.join(root, "registered-link");
	try {
		await mkdir(registered);
		await mkdir(other);
		await writeFile(path.join(registered, ".wiki-schema.md"), "# schema\n", "utf8");
		await symlink(registered, alias);
		const knownBases: KnowledgeBaseInfo[] = [
			{ path: registered, name: "registered", origin: "external", valid: true },
			{ path: other, name: "other", origin: "external", valid: false, reason: "Missing .wiki-schema.md" },
		];

		assert.equal((await findRegisteredKnowledgeBase(alias, knownBases))?.path, registered);
		assert.equal(await findRegisteredKnowledgeBase(other, knownBases), null);
		assert.equal(await findRegisteredKnowledgeBase(path.join(root, "missing"), knownBases), null);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("source inspection authorizes HTML with existing formats while excluding hidden and linked files", async () => {
	const root = await realpath(await mkdtemp(path.join(tmpdir(), "llm-wiki-source-inspect-")));
	try {
		await mkdir(path.join(root, "nested"));
		await mkdir(path.join(root, ".hidden"));
		for (const name of ["note.md", "note.txt", "paper.pdf", "nested/page.HTML", "ignored.bin", ".hidden/private.html"]) {
			await writeFile(path.join(root, name), "fixture text");
		}
		await symlink(path.join(root, "ignored.bin"), path.join(root, "linked.html"));
		const result = await inspectPath(root);
		const scan = result.ingestibleFiles;
		assert.ok(scan);
		assert.equal(scan.count, 4);
		assert.deepEqual(scan.paths.map((file) => path.relative(root, file)).sort(), ["nested/page.HTML", "note.md", "note.txt", "paper.pdf"]);
		assert.equal(validateInspectedSourceFiles(scan.scanId, [path.join(root, "nested/page.HTML")]).ok, true);
		assert.equal(validateInspectedSourceFiles(scan.scanId, [path.join(root, "linked.html")]).ok, false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
