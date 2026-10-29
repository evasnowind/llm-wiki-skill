import assert from "node:assert/strict";
import test from "node:test";

import { IngestJobActionBodySchema, IngestJobRequestBodySchema, IngestJobSchema } from "../src/index.js";

test("ingest request contracts reject unknown fields, empty batches and unsupported concurrency", () => {
	assert.ok(IngestJobRequestBodySchema.safeParse({ kbPath: "/kb", filePaths: ["/source.md"], concurrency: 3 }).success);
	for (const value of [{ kbPath: "/kb", filePaths: [] }, { kbPath: "/kb", filePaths: ["/a"], concurrency: 2 }, { kbPath: "/kb", filePaths: ["/a"], apiKey: "secret" }]) assert.equal(IngestJobRequestBodySchema.safeParse(value).success, false);
	assert.equal(IngestJobActionBodySchema.safeParse({}).success, false);
	assert.equal(IngestJobActionBodySchema.safeParse({ kbPath: "/kb", id: "unexpected" }).success, false);
});

test("ingest snapshots preserve per-file status and expose no private source path fields", () => {
	const job = { id: "11111111-1111-4111-8111-111111111111", kbPath: "/kb", revision: 1, createdAt: "2026-10-29T00:00:00.000Z", updatedAt: "2026-10-29T00:00:00.000Z", concurrency: 3, status: "running", files: [{ id: "file", name: "source.md", status: "running", attempts: 1, progressChars: 20, outputPath: null, error: null }] };
	assert.ok(IngestJobSchema.safeParse(job).success);
	assert.equal(IngestJobSchema.safeParse({ ...job, files: [{ ...job.files[0], originalPath: "/private/source" }] }).success, false);
});
