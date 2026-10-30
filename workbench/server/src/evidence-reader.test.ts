import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { EvidenceCitation } from "@llm-wiki/workbench-contracts";

import { hashExcerpt, MAX_EVIDENCE_FILE_BYTES, readEvidence } from "./evidence-reader.js";
import { sha256Bytes } from "./graph-rename-safe-io.js";
import { buildKnowledgeContextMessage, searchKnowledgeBase } from "./retrieval.js";

test("unreadable or unsafe corpus roots report a partial scan, while absent optional roots are benign", async (t) => {
	const kb = await mkdtemp(path.join(os.tmpdir(), "evidence-unreadable-corpus-"));
	t.after(() => rm(kb, { recursive: true, force: true }));
	const absent = await searchKnowledgeBase(kb, "unfindable", { mode: "sources-only", assertRegistered: false });
	assert.deepEqual(absent.warnings, []);
	// ENOTDIR is deterministic on macOS and under root, unlike chmod-based EACCES fixtures.
	await writeFile(path.join(kb, "raw"), "cannot enumerate a regular file as a corpus directory");
	const unreadable = await searchKnowledgeBase(kb, "unfindable", { mode: "sources-only", assertRegistered: false });
	assert.equal(unreadable.results.length, 0);
	assert.equal(unreadable.warnings?.length, 1);
	assert.match(unreadable.warnings![0]!, /检索范围不完整/u);
	assert.match(buildKnowledgeContextMessage({ kb: { name: "fixture", path: kb }, search: unreadable }), /检索范围不完整/u);
	await rm(path.join(kb, "raw"));
	await mkdir(path.join(kb, "private"));
	await symlink(path.join(kb, "private"), path.join(kb, "raw"));
	const unsafe = await searchKnowledgeBase(kb, "unfindable", { mode: "sources-only", assertRegistered: false });
	assert.equal(unsafe.warnings?.length, 1);
	assert.match(unsafe.warnings![0]!, /检索范围不完整/u);
});

test("evidence reads revalidate location and enforce safe file boundaries", async (t) => {
	const kb = await mkdtemp(path.join(os.tmpdir(), "evidence-reader-test-"));
	const outside = await mkdtemp(path.join(os.tmpdir(), "evidence-reader-outside-"));
	t.after(async () => { await rm(kb, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });
	await mkdir(path.join(kb, "raw"));
	await mkdir(path.join(kb, "wiki/topics"), { recursive: true });
	const bytes = Buffer.from("# Guide\r\n\r\n## Exact\r\nA quoted  sentence.\r\nSecond line.\r\n");
	const original = bytes.toString("utf8").replace(/\r\n/gu, "\n");
	const file = path.join(kb, "raw/guide.md");
	await writeFile(file, bytes);
	const citation: EvidenceCitation = {
		id: "E1", path: "raw/guide.md", kind: "raw", title: "Guide", headingPath: ["Guide", "Exact"],
		startLine: 4, endLine: 5, excerpt: "A quoted  sentence.\nSecond line.",
		fileHash: sha256Bytes(bytes), excerptHash: hashExcerpt("A quoted  sentence.\nSecond line."),
	};
	await t.test("exact CRLF bytes hash and LF line location", async () => {
		const result = await readEvidence(kb, citation);
		assert.equal(result.locationStatus, "exact");
		assert.equal(result.content, original);
		assert.equal(result.fileHash, sha256Bytes(bytes));
		assert.equal(result.startLine, 4);
		assert.equal(result.endLine, 5);
	});
	await t.test("wrong line coordinates never highlight", async () => {
		const result = await readEvidence(kb, { ...citation, startLine: 1, endLine: 2 });
		assert.equal(result.locationStatus, "changed");
		assert.equal(result.startLine, null);
	});
	await t.test("tampered excerpt hash is rejected", async () => {
		await assert.rejects(readEvidence(kb, { ...citation, excerpt: "forged statement" }), /excerpt hash/u);
	});
	await t.test("mismatched kind and excessive range are rejected", async () => {
		await assert.rejects(readEvidence(kb, { ...citation, kind: "wiki" }));
		await assert.rejects(readEvidence(kb, { ...citation, endLine: 9999 }));
	});
	await t.test("unique unchanged quote relocates after insertion", async () => {
		await writeFile(file, "new intro\nnew context\n" + original);
		const result = await readEvidence(kb, citation);
		assert.equal(result.locationStatus, "relocated");
		assert.equal(result.startLine, 6);
		assert.equal(result.endLine, 7);
		assert.notEqual(result.fileHash, citation.fileHash);
	});
	await t.test("changed quote does not highlight", async () => {
		await writeFile(file, original.replace("quoted", "edited"));
		const result = await readEvidence(kb, citation);
		assert.equal(result.locationStatus, "changed");
		assert.equal(result.startLine, null);
		assert.equal(result.endLine, null);
	});
	await t.test("duplicate quotes are ambiguous after file change", async () => {
		await writeFile(file, `${original}\n${citation.excerpt}\n`);
		const result = await readEvidence(kb, citation);
		assert.equal(result.locationStatus, "changed");
		assert.equal(result.startLine, null);
	});
	await t.test("absolute, traversal, hidden and unsupported paths are rejected", async () => {
		for (const unsafe of ["/etc/passwd", "raw/../../outside.md", "raw/.hidden.md", "raw/.private/x.md", "raw/guide.pdf", "wiki/a.txt", "raw\\guide.md", "schema.md"]) {
			await assert.rejects(readEvidence(kb, { ...citation, path: unsafe }));
		}
	});
	await writeFile(path.join(outside, "private.md"), "secret outside the corpus");
	await symlink(path.join(outside, "private.md"), path.join(kb, "raw/file-link.md"));
	await symlink(outside, path.join(kb, "raw/dir-link"));
	await t.test("file and ancestor symlinks cannot escape", async () => {
		await assert.rejects(readEvidence(kb, { ...citation, path: "raw/file-link.md" }), /symbolic/u);
		await assert.rejects(readEvidence(kb, { ...citation, path: "raw/dir-link/private.md" }), /symbolic/u);
	});
	await t.test("invalid UTF8 and oversized files are rejected clearly", async () => {
		await writeFile(path.join(kb, "raw/invalid.md"), Buffer.from([0xc3, 0x28]));
		await assert.rejects(readEvidence(kb, { ...citation, path: "raw/invalid.md" }), /UTF-8/u);
		await writeFile(path.join(kb, "raw/large.md"), Buffer.alloc(MAX_EVIDENCE_FILE_BYTES + 1, 0x61));
		await assert.rejects(readEvidence(kb, { ...citation, path: "raw/large.md" }), /2 MB/u);
	});
	await t.test("retrieval reports unreadable corpus limits without exposing hidden/symlink text", async () => {
		const result = await searchKnowledgeBase(kb, "secret outside", { mode: "sources-only", assertRegistered: false });
		assert.equal(result.evidence?.length, 0);
		assert.ok(result.warnings?.some((warning) => warning.includes("2 MB")));
		assert.ok(result.warnings?.some((warning) => warning.includes("符号链接")));
	});
	await t.test("retrieved quote round-trips through the reader", async () => {
		await writeFile(file, bytes);
		const result = await searchKnowledgeBase(kb, "quoted sentence", { mode: "sources-only", assertRegistered: false, snippetMaxChars: 30 });
		assert.ok(result.evidence?.[0]);
		const read = await readEvidence(kb, result.evidence![0]!);
		assert.equal(read.locationStatus, "exact");
	});
});
