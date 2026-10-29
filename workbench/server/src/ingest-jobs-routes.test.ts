import assert from "node:assert/strict";
import test from "node:test";

import type { IngestJob } from "@llm-wiki/workbench-contracts";

import { createApp } from "./app.js";
import type { IngestJobRouteService } from "./routes/ingest-jobs.js";
import { createSecurityMiddleware } from "./security/middleware.js";
import { CAPABILITY_TOKEN_HEADER } from "./security/token.js";

const KB = "/fictional/canonical-kb";
const ALIAS = "/fictional/alias-kb";
const ID = "11111111-1111-4111-8111-111111111111";
const headers = { "Content-Type": "application/json" };

function job(): IngestJob {
	return { id: ID, kbPath: KB, revision: 1, createdAt: "2026-10-29T00:00:00.000Z", updatedAt: "2026-10-29T00:00:00.000Z", concurrency: 3, status: "pending", files: [{ id: "source-id", name: "source.md", status: "pending", attempts: 0, progressChars: 0, outputPath: null, error: null }] };
}
function service(overrides: Partial<IngestJobRouteService> = {}): IngestJobRouteService {
	return {
		assertRegisteredKnowledgeBase: async (kbPath) => {
			if (![KB, ALIAS].includes(kbPath)) throw Object.assign(new Error("unregistered private location"), { code: "KB_NOT_REGISTERED" });
			return KB;
		},
		enqueue: async () => job(), list: async () => [job()], cancel: async () => ({ ...job(), status: "cancelled", files: [{ ...job().files[0]!, status: "cancelled" }] }), retry: async () => job(),
		recover: async () => undefined, close: async () => undefined,
		...overrides,
	};
}

test("reliable ingest routes validate strict request context and return typed snapshots", async () => {
	const app = createApp({ ingestJobService: service() });
	const posted = await app.request("/api/knowledge-bases/ingest-jobs", { method: "POST", headers, body: JSON.stringify({ kbPath: KB, filePaths: ["/approved/source.md"] }) });
	assert.equal(posted.status, 200); assert.equal((await posted.json() as any).data.id, ID);
	const listed = await app.request(`/api/knowledge-bases/ingest-jobs?kb=${encodeURIComponent(KB)}`);
	assert.equal(listed.status, 200); assert.equal((await listed.json() as any).data.jobs.length, 1);
	for (const body of [{ filePaths: ["/a.md"] }, { kbPath: KB, filePaths: [] }, { kbPath: KB, filePaths: ["/a.md"], concurrency: 2 }, { kbPath: KB, filePaths: ["/a.md"], secret: "bad" }]) {
		const response = await app.request("/api/knowledge-bases/ingest-jobs", { method: "POST", headers, body: JSON.stringify(body) });
		assert.equal(response.status, 400);
	}
	assert.equal((await app.request("/api/knowledge-bases/ingest-jobs")).status, 400);
	assert.equal((await app.request(`/api/knowledge-bases/ingest-jobs/${ID}/cancel`, { method: "POST", headers, body: JSON.stringify({ kbPath: "/other" }) })).status, 404);
	assert.equal((await app.request("/api/knowledge-bases/ingest-jobs/not-an-id/retry", { method: "POST", headers, body: JSON.stringify({ kbPath: KB }) })).status, 400);
});

test("all task responses echo the authorized requested scope while internal identity remains canonical", async () => {
	const seen: string[] = [];
	const app = createApp({ ingestJobService: service({
		enqueue: async (input) => { seen.push(input.kbPath); return job(); },
		list: async (kb) => { seen.push(kb); return [job()]; },
		cancel: async (kb) => { seen.push(kb); return job(); },
		retry: async (kb) => { seen.push(kb); return job(); },
	}) });
	const listed = await app.request(`/api/knowledge-bases/ingest-jobs?kb=${encodeURIComponent(ALIAS)}`);
	assert.equal((await listed.json() as any).data.jobs[0].kbPath, ALIAS);
	for (const endpoint of ["", `/${ID}/cancel`, `/${ID}/retry`]) {
		const body = endpoint ? { kbPath: ALIAS } : { kbPath: ALIAS, filePaths: ["/source.md"] };
		const response = await app.request(`/api/knowledge-bases/ingest-jobs${endpoint}`, { method: "POST", headers, body: JSON.stringify(body) });
		assert.equal((await response.json() as any).data.kbPath, ALIAS);
	}
	assert.deepEqual(seen, [KB, KB, KB, KB]);
});

test("task list and actions use the registered capability and origin boundary", async () => {
	let calls = 0;
	const token = "test-ingest-capability";
	const app = createApp({ ingestJobService: service({ list: async () => { calls++; return []; } }), security: createSecurityMiddleware({ token, trustedOrigins: new Set(["http://localhost:5180"]) }) });
	const url = `/api/knowledge-bases/ingest-jobs?kb=${encodeURIComponent(KB)}`;
	assert.equal((await app.request(url)).status, 403);
	assert.equal((await app.request(url, { headers: { [CAPABILITY_TOKEN_HEADER]: token, Origin: "https://untrusted.example" } })).status, 403);
	assert.equal(calls, 0);
	assert.equal((await app.request(url, { headers: { [CAPABILITY_TOKEN_HEADER]: token, Origin: "http://localhost:5180" } })).status, 200);
	assert.equal(calls, 1);
});

test("task failures preserve safe actionable errors and redact arbitrary internal failures", async () => {
	const app = createApp({ ingestJobService: service({ list: async () => { throw new Error("secret-token /private/user/path"); } }) });
	const response = await app.request(`/api/knowledge-bases/ingest-jobs?kb=${encodeURIComponent(KB)}`);
	assert.equal(response.status, 500); assert.doesNotMatch(await response.text(), /secret-token|private/);
	const damaged = createApp({ ingestJobService: service({ list: async () => { throw Object.assign(new Error("private damaged file"), { code: "CORRUPT_INGEST_QUEUE" }); } }) });
	const conflict = await damaged.request(`/api/knowledge-bases/ingest-jobs?kb=${encodeURIComponent(KB)}`);
	assert.equal(conflict.status, 409); assert.match((await conflict.json() as any).message, /损坏.*保留/);
});
