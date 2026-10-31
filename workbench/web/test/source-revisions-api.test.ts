import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { checkSourceChanges, createSourceCandidates, listSourceRevisions, readSourceCandidate, readSourceHistory, readSourceVersion, sourceCandidateAction } from "../src/lib/api/source-revisions";
import { ApiError, ContractMismatchError } from "../src/lib/api/client";
import { candidate, data, fakeApi, jobId } from "./source-revisions-fixtures";

describe("source revisions JSON API", () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => { globalThis.fetch = originalFetch; });
	it("scopes each endpoint and retains guarded actions and legacy regeneration bodies", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const api = fakeApi();
		globalThis.fetch = (async (input, init) => {
			const url = String(input); calls.push({ url, init });
			const result = url.includes("/detail") ? await api.detail("/a", "candidate") : url.includes("/sources/") ? await api.history("/a", "source") : url.includes("/versions/") ? await api.version("/a", "v1") : url.includes("/check") ? await api.check({ kbPath: "/a", sourceScanId: "scan" }) : url.endsWith("/candidates") ? { candidates: [candidate()] } : init?.method === "POST" ? candidate() : data();
			return Response.json({ ok: true, data: result });
		}) as typeof fetch;
		await listSourceRevisions("/a");
		await checkSourceChanges({ kbPath: "/a", sourceScanId: "fresh-scan" });
		await createSourceCandidates({ type: "regenerate", kbPath: "/a", target: { type: "ingest-file", jobId, fileId: "legacy" }, requestId: jobId });
		await readSourceCandidate("/a", "candidate");
		for (const action of ["adopt", "cancel", "retry"] as const) await sourceCandidateAction(action, "candidate", { kbPath: "/a", expectedRevision: 4 });
		await readSourceHistory("/a", "source"); await readSourceVersion("/a", "v1");
		assert.equal(calls.length, 9);
		assert.ok(calls.filter((call) => call.init?.method === "GET").every((call) => call.url.endsWith("?kb=%2Fa")));
		assert.deepEqual(JSON.parse(String(calls[1].init?.body)), { kbPath: "/a", sourceScanId: "fresh-scan" });
		assert.deepEqual(JSON.parse(String(calls[4].init?.body)), { kbPath: "/a", expectedRevision: 4 });
		assert.match(calls[3].url, /candidates\/candidate\/detail/);
	});
	it("rejects path-like opaque IDs, missing version guards and empty changes before network access", async () => {
		let calls = 0;
		globalThis.fetch = async () => { calls++; return Response.json({ ok: true, data: {} }); };
		for (const id of ["../other", "a/b", "a%2fb", "a\\b", "a\u0000b"]) await assert.rejects(async () => readSourceVersion("/a", id));
		await assert.rejects(async () => sourceCandidateAction("adopt", "candidate", { kbPath: "/a", expectedRevision: -1 }));
		await assert.rejects(async () => createSourceCandidates({ type: "changes", kbPath: "/a", requestId: jobId, checkId: "check", changeIds: [] }));
		assert.equal(calls, 0);
	});
	it("preserves conflict errors and rejects response body drift", async () => {
		globalThis.fetch = async () => Response.json({ ok: false, code: "CONFLICT", message: "摘要被外部编辑" }, { status: 409 });
		await assert.rejects(sourceCandidateAction("adopt", "candidate", { kbPath: "/a", expectedRevision: 1 }), (cause: unknown) => cause instanceof ApiError && cause.code === "CONFLICT");
		globalThis.fetch = async () => Response.json({ ok: true, data: { ...data(), candidates: [{ ...candidate(), text: "unexpected full body" }] } });
		await assert.rejects(listSourceRevisions("/a"), ContractMismatchError);
	});
});
