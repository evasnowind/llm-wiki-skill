import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { cancelIngestJob, createIngestJob, listIngestJobs, retryIngestJob } from "../src/lib/api/ingest-jobs";
import { ApiError, ContractMismatchError } from "../src/lib/api/client";

const id = "11111111-1111-4111-8111-111111111111";
const job = {
	id, kbPath: "/registered/知识库", revision: 2,
	createdAt: "2026-10-29T01:00:00.000Z", updatedAt: "2026-10-29T01:00:01.000Z",
	concurrency: 1, status: "running",
	files: [{ id: "file-1", name: "材料.md", status: "running", attempts: 1, progressChars: 12, outputPath: null, error: null }],
};

describe("reliable ingest API", () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => { globalThis.fetch = originalFetch; });

	it("uses registered JSON endpoints, explicit KB scope, and strict response schemas", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		globalThis.fetch = (async (input, init) => {
			calls.push({ url: String(input), init });
			const data = init?.method === "GET" ? { jobs: [job] } : job;
			return Response.json({ ok: true, data });
		}) as typeof fetch;
		assert.deepEqual(await listIngestJobs(job.kbPath), [job]);
		assert.deepEqual(await createIngestJob({ kbPath: job.kbPath, filePaths: ["/inputs/材料.md"], sourceScanId: "scan", concurrency: 1 }), job);
		assert.deepEqual(await cancelIngestJob(job.kbPath, id), job);
		assert.deepEqual(await retryIngestJob(job.kbPath, id), job);
		assert.equal(calls[0]?.url, "/api/knowledge-bases/ingest-jobs?kb=%2Fregistered%2F%E7%9F%A5%E8%AF%86%E5%BA%93");
		assert.deepEqual(calls.slice(1).map((call) => call.url), [
			"/api/knowledge-bases/ingest-jobs",
			`/api/knowledge-bases/ingest-jobs/${id}/cancel`,
			`/api/knowledge-bases/ingest-jobs/${id}/retry`,
		]);
		assert.deepEqual(JSON.parse(String(calls[2]?.init?.body)), { kbPath: job.kbPath });
	});

	it("rejects empty input and invalid task IDs before transport", async () => {
		let calls = 0;
		globalThis.fetch = (async () => { calls++; return Response.json({ ok: true, data: job }); }) as typeof fetch;
		await assert.rejects(createIngestJob({ kbPath: job.kbPath, filePaths: [] }));
		await assert.rejects(cancelIngestJob(job.kbPath, "../other"));
		await assert.rejects(retryIngestJob("", id));
		assert.equal(calls, 0);
	});

	it("preserves API failures and refuses incomplete or unknown task states", async () => {
		globalThis.fetch = (async () => Response.json({ ok: false, code: "CONFLICT", message: "任务正在保存，请刷新后查看" }, { status: 409 })) as typeof fetch;
		await assert.rejects(cancelIngestJob(job.kbPath, id), (error: unknown) => error instanceof ApiError && error.code === "CONFLICT");
		globalThis.fetch = (async () => Response.json({ ok: true, data: { jobs: [{ ...job, status: "unknown" }] } })) as typeof fetch;
		await assert.rejects(listIngestJobs(job.kbPath), ContractMismatchError);
	});
});
