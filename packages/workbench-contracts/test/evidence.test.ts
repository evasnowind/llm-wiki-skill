import assert from "node:assert/strict";
import test from "node:test";
import { EvidenceCitationSchema, EvidenceReadRequestBodySchema, EvidenceReadResultSchema, PromptRequestBodySchema, UIMessageSchema, PageRefsQuerySchema, findEndpoint } from "../src/index.js";

const citation = { id: "E1", kind: "raw", path: "raw/notes/a.md", title: "A", headingPath: ["章节"], startLine: 2, endLine: 3, fileHash: "a".repeat(64), excerptHash: "b".repeat(64), excerpt: "第一行\n第二行" };

test("evidence contract is bounded, strict and relative to visible Markdown or text sources", () => {
	assert.deepEqual(EvidenceCitationSchema.parse(citation), citation);
	for (const patch of [
		{ path: "/raw/a.md" }, { path: "raw/../a.md" }, { path: "raw/.hidden/a.md" },
		{ path: "raw/a.pdf" }, { path: "raw\\a.md" }, { path: "wiki/a.md" },
		{ path: "raw/a.md", kind: "wiki" }, { fileHash: "z".repeat(64) },
		{ id: "E0" }, { endLine: 1 }, { endLine: 5000 }, { startLine: 0 },
		{ excerpt: "" }, { excerpt: "a".repeat(64_001) }, { unknown: "private" },
	]) assert.equal(EvidenceCitationSchema.safeParse({ ...citation, ...patch }).success, false, JSON.stringify(patch));
	for (const path of ["purpose.md", "index.md", "wiki/topics/a.md"]) assert.equal(EvidenceCitationSchema.safeParse({ ...citation, path, kind: "wiki" }).success, true);
	assert.equal(EvidenceCitationSchema.safeParse({ ...citation, path: "raw/a.txt" }).success, true);
});

test("prompt and historical messages preserve old shapes while accepting explicit retrieval scope", () => {
	assert.deepEqual(PromptRequestBodySchema.parse({ message: "hello" }), { message: "hello" });
	assert.equal(PromptRequestBodySchema.safeParse({ message: "hello", retrievalMode: "sources-only", kbPath: "/fixture/kb", conversationId: "c1" }).success, true);
	assert.equal(PromptRequestBodySchema.safeParse({ message: "hello", retrievalMode: "invalid" }).success, false);
	const old = { id: "a-1", role: "assistant", content: "answer", tools: [] };
	assert.deepEqual(UIMessageSchema.parse(old), old);
	assert.equal(UIMessageSchema.safeParse({ ...old, evidence: [citation], retrievalMode: "sources-only" }).success, true);
	assert.equal(PageRefsQuerySchema.parse({ retrievalMode: "sources-only" }).retrievalMode, "sources-only");
});

test("evidence reading uses a read-only POST body and bounded result", () => {
	assert.equal(EvidenceReadRequestBodySchema.safeParse({ kbPath: "/fixture/kb", citation }).success, true);
	assert.equal(EvidenceReadRequestBodySchema.safeParse({ kbPath: "/fixture/kb", citation, extra: true }).success, false);
	assert.equal(EvidenceReadResultSchema.safeParse({ path: citation.path, kind: "raw", content: "source", locationStatus: "changed", startLine: null, endLine: null, fileHash: citation.fileHash }).success, true);
	assert.equal(findEndpoint("POST", "/api/evidence/read")?.safety, "read-only");
});
