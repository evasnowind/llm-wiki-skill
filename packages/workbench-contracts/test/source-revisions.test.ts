import assert from "node:assert/strict";
import test from "node:test";
import { CreateSourceCandidatesBodySchema, SourceCandidateActionBodySchema, SourceChangeCheckBodySchema, SourceCandidateSchema, SourceRevisionsDataSchema, SourceRevisionIdSchema } from "../src/index.js";
const requestId = "11111111-1111-4111-8111-111111111111";
test("revision creation distinguishes chosen changes and explicit legacy snapshot regeneration", () => {
	assert.ok(CreateSourceCandidatesBodySchema.safeParse({ type: "changes", kbPath: "/kb", requestId, checkId: "check", changeIds: ["modified"] }).success);
	assert.ok(CreateSourceCandidatesBodySchema.safeParse({ type: "regenerate", kbPath: "/kb", requestId, target: { type: "ingest-file", jobId: requestId, fileId: "legacy" }, feedback: "保留反例" }).success);
	assert.ok(CreateSourceCandidatesBodySchema.safeParse({ type: "regenerate", kbPath: "/kb", requestId, target: { type: "source", sourceId: "source", baseVersionId: "v1" } }).success);
	for (const extra of [{ sourcePath: "/arbitrary" }, { apiKey: "secret" }, { outputPath: "wiki/arbitrary.md" }]) {
		assert.equal(CreateSourceCandidatesBodySchema.safeParse({ type: "changes", kbPath: "/kb", requestId, checkId: "check", changeIds: ["id"], ...extra }).success, false);
	}
	assert.equal(CreateSourceCandidatesBodySchema.safeParse({ type: "changes", kbPath: "/kb", requestId, checkId: "check", changeIds: [] }).success, false);
	assert.equal(CreateSourceCandidatesBodySchema.safeParse({ type: "regenerate", kbPath: "/kb", requestId, target: { type: "source", sourceId: "source" } }).success, false);
});
test("checks require renewed scan authorization and candidate actions require a version guard", () => {
	assert.equal(SourceChangeCheckBodySchema.safeParse({ kbPath: "/kb", directoryId: "old" }).success, false);
	assert.equal(SourceCandidateActionBodySchema.safeParse({ kbPath: "/kb" }).success, false);
	assert.ok(SourceCandidateActionBodySchema.safeParse({ kbPath: "/kb", expectedRevision: 0 }).success);
});
test("polling exposes metadata without candidate or source bodies", () => {
	const candidate = { id: "candidate", kbPath: "/kb", sourceId: null, name: "中文.md", kind: "added", status: "ready", revision: 2, baseVersionId: null, adoptedVersionId: null, model: null, createdAt: "2026-10-31T00:00:00Z", updatedAt: "2026-10-31T00:00:00Z", error: null, progressChars: 20, attempts: 1 };
	assert.ok(SourceRevisionsDataSchema.safeParse({ directories: [], sources: [], candidates: [candidate] }).success);
	assert.equal(SourceCandidateSchema.safeParse({ ...candidate, summary: "private body" }).success, false);
});

test("revision IDs are opaque tokens, never filesystem paths", () => {
 for (const id of ["../other", "a/b", "a%2fb", "a\\b", "a\u0000b"]) assert.equal(SourceRevisionIdSchema.safeParse(id).success, false);
 assert.ok(SourceRevisionIdSchema.safeParse("version_01-abc").success);
});
