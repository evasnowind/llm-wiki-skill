import assert from "node:assert/strict";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { SourceCandidate } from "@llm-wiki/workbench-contracts";

import { createIngestQueue, type IngestQueueDeps, type IngestQueueService } from "./ingest/queue.js";
import { inspectPath } from "./knowledge-bases.js";
import { loadRetrievalCorpus } from "./markdown-retrieval-corpus.js";
import { createApp } from "./app.js";
import { createSecurityMiddleware } from "./security/middleware.js";
import { CAPABILITY_TOKEN_HEADER } from "./security/token.js";
import { managedHistoricalHashes } from "./ingest/source-revision-history.js";

async function fixture(t: TestContext) {
	const directory = await realpath(await mkdtemp(path.join(tmpdir(), "llm-wiki-revisions-")));
	const kb = path.join(directory, "kb"); const incoming = path.join(directory, "素材 目录"); const root = path.join(directory, "application", "ingest");
	await mkdir(kb, { recursive: true }); await mkdir(incoming);
	await writeFile(path.join(kb, ".wiki-schema.md"), "# schema");
	await writeFile(path.join(kb, "index.md"), "# Index\n"); await writeFile(path.join(kb, "log.md"), "# Log\n");
	const source = path.join(incoming, "中文 😀.MD"); await writeFile(source, "# v1\r\n原始内容\r\n");
	const services: IngestQueueService[] = []; let calls = 0;
	const make = (overrides: Partial<IngestQueueDeps> = {}) => {
		const queue = createIngestQueue({ root, assertRegisteredKnowledgeBase: async (value) => { if (value !== kb) throw new Error("unregistered"); return value; },
			validateSources: () => ({ ok: true, root: incoming }), generate: async () => "first summary", generateRevision: async ({ text }) => { calls++; return `new summary ${text}`; }, ...overrides }); services.push(queue); return queue;
	};
	const check = async (queue: IngestQueueService, dir = incoming) => queue.sourceRevisions.check(kb, (await inspectPath(dir)).ingestibleFiles!.scanId);
	t.after(async () => { await Promise.allSettled(services.map((queue) => queue.close())); await rm(directory, { recursive: true, force: true }); });
	return { directory, kb, incoming, root, source, make, check, calls: () => calls };
}
async function waitCandidate(queue: IngestQueueService, kb: string, id: string, status: string): Promise<SourceCandidate> {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) { const candidate = (await queue.sourceRevisions.list(kb)).candidates.find((item) => item.id === id)!; if (candidate.status === status) return candidate; await new Promise((resolve) => setTimeout(resolve, 5)); }
	throw new Error(`candidate timeout ${JSON.stringify(await queue.sourceRevisions.list(kb))}`);
}
async function initial(queue: IngestQueueService, kb: string, source: string) {
	const job = await queue.enqueue({ kbPath: kb, filePaths: [source] });
	for (let attempt = 0; attempt < 500; attempt++) { const current = (await queue.list(kb)).find((item) => item.id === job.id)!; if (current.status === "completed") return current; await new Promise((resolve) => setTimeout(resolve, 5)); }
	throw new Error("initial timeout");
}
async function added(queue: IngestQueueService, f: Awaited<ReturnType<typeof fixture>>) {
	const check = await f.check(queue);
	const created = await queue.sourceRevisions.create({ type: "changes", kbPath: f.kb, checkId: check.id, changeIds: check.changes.filter((item) => ["added", "modified"].includes(item.kind)).map((item) => item.id), requestId: randomUUID() });
	return waitCandidate(queue, f.kb, created.candidates[0]!.id, "ready");
}

test("check mixed changes; only chosen candidates generate and adoption preserves immutable original and stable summary", async (t) => {
	const f = await fixture(t); const queue = f.make();
	const first = await added(queue, f);
	assert.deepEqual(await readFile(path.join(f.kb, "index.md"), "utf8"), "# Index\n");
	assert.equal((await f.check(queue)).changes[0]!.kind, "added");
	const adopted = await queue.sourceRevisions.adopt(f.kb, first.id, first.revision);
	const source = (await queue.sourceRevisions.list(f.kb)).sources[0]!;
	const v1 = (await queue.sourceRevisions.history(f.kb, source.id)).versions[0]!;
	const original = await readFile(path.join(f.kb, v1.rawPath));
	await writeFile(f.source, "# v2\r\n新内容\r\n");
	await writeFile(path.join(f.incoming, "added.md"), "added");
	await writeFile(path.join(f.incoming, "unchanged.md"), "stable");
	const secondCheck = await f.check(queue);
	const secondCreated = await queue.sourceRevisions.create({ type: "changes", kbPath: f.kb, checkId: secondCheck.id, changeIds: [secondCheck.changes.find((item) => item.kind === "modified")!.id], requestId: randomUUID() });
	const second = await waitCandidate(queue, f.kb, secondCreated.candidates[0]!.id, "ready"); await queue.sourceRevisions.adopt(f.kb, second.id, second.revision);
	assert.equal((await queue.sourceRevisions.list(f.kb)).sources.find((item) => item.id === source.id)!.outputPath, source.outputPath);
	assert.deepEqual(await readFile(path.join(f.kb, v1.rawPath)), original);
	assert.equal((await queue.sourceRevisions.version(f.kb, source.id, v1.id)).original.text, original.toString());
	assert.equal((await managedHistoricalHashes(f.kb, f.root)).get(v1.rawPath), v1.rawHash);
	assert.equal(adopted.status, "adopted");
});

test("legacy completion association uses path plus hash, same-content regeneration is independent and request replay is idempotent", async (t) => {
	const f = await fixture(t); const queue = f.make(); const job = await initial(queue, f.kb, f.source);
	const checked = await f.check(queue); assert.equal(checked.changes[0]!.kind, "unchanged");
	const request = { type: "regenerate" as const, kbPath: f.kb, target: { type: "ingest-file" as const, jobId: job.id, fileId: job.files[0]!.id }, requestId: randomUUID() };
	const created = await queue.sourceRevisions.create(request); const replay = await queue.sourceRevisions.create(request);
	assert.equal(created.candidates[0]!.id, replay.candidates[0]!.id);
	const ready = await waitCandidate(queue, f.kb, created.candidates[0]!.id, "ready");
	assert.equal(f.calls(), 1);
	const before = await readFile(path.join(f.kb, job.files[0]!.outputPath!), "utf8");
	assert.equal((await queue.list(f.kb))[0]!.status, "completed");
	await queue.sourceRevisions.adopt(f.kb, ready.id, ready.revision);
	assert.notEqual(await readFile(path.join(f.kb, job.files[0]!.outputPath!), "utf8"), before);
	assert.equal((await queue.enqueue({ kbPath: f.kb, filePaths: [f.source] })).status, "completed");
	assert.equal((await queue.sourceRevisions.history(f.kb, ready.sourceId!)).versions.length, 2);
	assert.equal((await readFile(path.join(f.kb, "index.md"), "utf8")).split(`[[${job.files[0]!.outputPath!.replace(/\.md$/, "")}]]`).length - 1, 1);
});

test("ready survives restart; two candidates compare-and-swap and external summary edits are preserved", async (t) => {
	const f = await fixture(t); let queue = f.make();
	const one = await added(queue, f); const two = await added(queue, f);
	await queue.close(); queue = f.make(); await queue.recover();
	assert.equal((await queue.sourceRevisions.detail(f.kb, one.id)).candidate.status, "ready");
	await queue.sourceRevisions.adopt(f.kb, one.id, one.revision);
	await assert.rejects(queue.sourceRevisions.adopt(f.kb, two.id, two.revision), { code: "CONFLICT" });
	const source = (await queue.sourceRevisions.list(f.kb)).sources[0]!;
	const created = await queue.sourceRevisions.create({ type: "regenerate", kbPath: f.kb, target: { type: "source", sourceId: source.id, baseVersionId: source.currentVersionId }, requestId: randomUUID() });
	const ready = await waitCandidate(queue, f.kb, created.candidates[0]!.id, "ready");
	await writeFile(path.join(f.kb, source.outputPath), "external content");
	await assert.rejects(queue.sourceRevisions.adopt(f.kb, ready.id, ready.revision), { code: "CONFLICT" });
	assert.equal(await readFile(path.join(f.kb, source.outputPath), "utf8"), "external content");
});

test("adopting journal resumes after partial publish and logs once without another model call", async (t) => {
	const f = await fixture(t); let fail = true;
	let queue = f.make({ afterPublicationWrite: (relative) => { if (fail && relative.startsWith("wiki/")) throw new Error("simulated crash"); } });
	const ready = await added(queue, f);
	await assert.rejects(queue.sourceRevisions.adopt(f.kb, ready.id, ready.revision));
	assert.equal((await queue.sourceRevisions.detail(f.kb, ready.id)).candidate.status, "adopting");
	await queue.close(); fail = false; queue = f.make(); await queue.recover();
	assert.equal((await queue.sourceRevisions.detail(f.kb, ready.id)).candidate.status, "adopted"); assert.equal(f.calls(), 1);
	assert.equal((await readFile(path.join(f.kb, "log.md"), "utf8")).split("采用素材版本").length - 1, 1);
});

test("cancelled late generation never becomes ready or writes knowledge files; recheck newer source stales a candidate", async (t) => {
	const f = await fixture(t); let release: (value: string) => void = () => undefined;
	const queue = f.make({ generateRevision: () => new Promise<string>((resolve) => { release = resolve; }) });
	const checked = await f.check(queue);
	const created = await queue.sourceRevisions.create({ type: "changes", kbPath: f.kb, checkId: checked.id, changeIds: [checked.changes[0]!.id], requestId: randomUUID() });
	const generating = await waitCandidate(queue, f.kb, created.candidates[0]!.id, "generating");
	await queue.sourceRevisions.cancel(f.kb, generating.id, generating.revision); release("late output");
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal((await queue.sourceRevisions.detail(f.kb, generating.id)).candidate.status, "cancelled");
	assert.equal(await readFile(path.join(f.kb, "index.md"), "utf8"), "# Index\n");
	await writeFile(f.source, "newer"); await f.check(queue);
	assert.equal((await queue.sourceRevisions.detail(f.kb, generating.id)).candidate.status, "stale");
});

test("complete scans report deletion without deleting knowledge; stale grant and symlink roots are rejected", async (t) => {
	const f = await fixture(t); const queue = f.make(); const ready = await added(queue, f); await queue.sourceRevisions.adopt(f.kb, ready.id, ready.revision);
	await unlink(f.source); const checked = await f.check(queue); assert.equal(checked.changes[0]!.kind, "deleted");
	const source = (await queue.sourceRevisions.list(f.kb)).sources[0]!; assert.match(await readFile(path.join(f.kb, source.outputPath), "utf8"), /new summary/);
	await assert.rejects(queue.sourceRevisions.create({ type: "changes", kbPath: f.kb, checkId: checked.id, changeIds: [checked.changes[0]!.id], requestId: randomUUID() }), { code: "INVALID_REQUEST" });
	await writeFile(f.source, "another"); const scan = (await inspectPath(f.incoming)).ingestibleFiles!; await writeFile(f.source, "changed after scan");
	await assert.rejects(queue.sourceRevisions.check(f.kb, scan.scanId), { code: "CONFLICT" });
	if (process.platform !== "win32") { const link = path.join(f.directory, "symbolic"); await symlink(f.incoming, link); const inspected = await inspectPath(link); assert.equal(inspected.resolvedPath, f.incoming); }
});

test("v1 missing provenance associates only through canonical path proof; identical names in separate directories stay separate", async (t) => {
	const f = await fixture(t); let queue = f.make({ validateSources: () => ({ ok: true, root: f.directory }) });
	const otherRoot = path.join(f.directory, "另一目录"); await mkdir(otherRoot); const other = path.join(otherRoot, path.basename(f.source)); await writeFile(other, await readFile(f.source));
	const first = await initial(queue, f.kb, f.source); const second = await initial(queue, f.kb, other); await queue.close();
	const files = await import("node:fs/promises"); const crypto = await import("node:crypto");
	const record = path.join(f.root, crypto.createHash("sha256").update(f.kb).digest("hex"), "queue.json");
	const disk = JSON.parse(await readFile(record, "utf8")); for (const job of disk.jobs) for (const file of job.files) delete file.canonicalPath; await files.writeFile(record, JSON.stringify(disk));
	queue = f.make(); await queue.recover();
	const regenerated = await queue.sourceRevisions.create({ type: "regenerate", kbPath: f.kb, target: { type: "ingest-file", jobId: first.id, fileId: first.files[0]!.id }, requestId: randomUUID() });
	const originalId = regenerated.candidates[0]!.sourceId;
	const checkedFirst = await f.check(queue); const checkedOther = await f.check(queue, otherRoot);
	assert.equal(checkedFirst.changes[0]!.sourceId, originalId);
	assert.notEqual(checkedFirst.changes[0]!.sourceId, checkedOther.changes[0]!.sourceId);
	assert.notEqual(first.files[0]!.id, second.files[0]!.id);
	assert.equal((await queue.sourceRevisions.list(f.kb)).sources.length, 2);
});

test("v1 to v2 to v1 retains content identity and three adopted summary versions", async (t) => {
	const f = await fixture(t); const queue = f.make(); const v1bytes = await readFile(f.source);
	const c1 = await added(queue, f); await queue.sourceRevisions.adopt(f.kb, c1.id, c1.revision);
	await writeFile(f.source, "version two"); const c2 = await added(queue, f); await queue.sourceRevisions.adopt(f.kb, c2.id, c2.revision);
	await writeFile(f.source, v1bytes); const c3 = await added(queue, f); await queue.sourceRevisions.adopt(f.kb, c3.id, c3.revision);
	const source = (await queue.sourceRevisions.list(f.kb)).sources[0]!; const versions = (await queue.sourceRevisions.history(f.kb, source.id)).versions;
	assert.equal(versions.length, 3); assert.equal(versions[0]!.rawPath, versions[2]!.rawPath); assert.notEqual(versions[1]!.rawPath, versions[2]!.rawPath);
	assert.deepEqual(await readFile(path.join(f.kb, versions[0]!.rawPath)), v1bytes);
	const historical = await managedHistoricalHashes(f.kb, f.root); assert.equal(historical.has(versions[0]!.rawPath), false); assert.equal(historical.has(versions[1]!.rawPath), true);
});

test("incomplete depth-limited scan never declares omitted sources deleted", async (t) => {
	const f = await fixture(t); const queue = f.make(); const ready = await added(queue, f); await queue.sourceRevisions.adopt(f.kb, ready.id, ready.revision);
	await unlink(f.source); const deep = path.join(f.incoming, ...Array.from({ length: 7 }, () => "deep")); await mkdir(deep, { recursive: true }); await writeFile(path.join(deep, "hidden.md"), "too deep");
	const checked = await f.check(queue); assert.equal(checked.complete, false); assert.equal(checked.changes.some((change) => change.kind === "deleted"), false); assert.match(checked.warnings.join(" "), /上限/);
});

test("every publication interruption replays once and completes before ordinary ingest metadata writes", async (t) => {
	for (const step of ["raw/", "wiki/", "index.md", "log.md"]) await t.test(step, async (subtest) => {
		const f = await fixture(subtest); let fail = true; let queue = f.make({ afterPublicationWrite: (relative) => { if (fail && relative.startsWith(step)) throw new Error("interrupt"); } });
		const ready = await added(queue, f); await assert.rejects(queue.sourceRevisions.adopt(f.kb, ready.id, ready.revision));
		await queue.close(); fail = false; queue = f.make(); await queue.recover();
		assert.equal((await queue.sourceRevisions.detail(f.kb, ready.id)).candidate.status, "adopted");
		const source2 = path.join(f.incoming, "普通.md"); await writeFile(source2, "ordinary input"); await initial(queue, f.kb, source2);
		const log = await readFile(path.join(f.kb, "log.md"), "utf8"); assert.equal(log.split("采用素材版本").length - 1, 1); assert.equal(log.split("入库：").length - 1, 1); assert.equal(f.calls(), 1);
	});
});

test("fixed-input retry ignores external edits and bounded comparisons retain complete hashes", async (t) => {
	const f = await fixture(t); let fail = true; let seen = "";
	await writeFile(f.source, "x".repeat(150 * 1024));
	const queue = f.make({ generateRevision: async ({ text }) => { seen = text; if (fail) throw new Error("fail"); return "generated"; } });
	const checked = await f.check(queue); const created = await queue.sourceRevisions.create({ type: "changes", kbPath: f.kb, checkId: checked.id, changeIds: [checked.changes[0]!.id], requestId: randomUUID() });
	const failed = await waitCandidate(queue, f.kb, created.candidates[0]!.id, "failed"); await writeFile(f.source, "external edited input"); fail = false;
	await queue.sourceRevisions.retry(f.kb, failed.id, failed.revision); const ready = await waitCandidate(queue, f.kb, failed.id, "ready");
	assert.equal(seen.length, 150 * 1024);
	const comparison = await queue.sourceRevisions.detail(f.kb, ready.id); assert.equal(comparison.truncated, true); assert.equal(comparison.original.after!.text.length, 128 * 1024); assert.equal(comparison.original.after!.hash, checked.changes[0]!.contentHash);
});

test("retrieval omits only exact managed historical bytes while explicit original evidence and unknown external edits remain readable", async (t) => {
	const f = await fixture(t); const queue = f.make(); const c1 = await added(queue, f); await queue.sourceRevisions.adopt(f.kb, c1.id, c1.revision);
	const source = (await queue.sourceRevisions.list(f.kb)).sources[0]!; const v1 = (await queue.sourceRevisions.history(f.kb, source.id)).versions[0]!;
	await writeFile(f.source, "new version source"); const c2 = await added(queue, f); await queue.sourceRevisions.adopt(f.kb, c2.id, c2.revision);
	const reader = (kb: string) => managedHistoricalHashes(kb, f.root);
	const alias = path.join(f.directory, "历史检索 alias 中文");
	await symlink(f.kb, alias, process.platform === "win32" ? "junction" : "dir");
	const scopes = [f.kb, alias];
	if (f.kb.startsWith("/private/var/")) scopes.push(f.kb.slice("/private".length));
	if (process.platform === "win32") scopes.push(f.kb.replace(/^([a-z]):/i, (_prefix, drive: string) => `${drive === drive.toLowerCase() ? drive.toUpperCase() : drive.toLowerCase()}:`));
	const canonicalHistory = await reader(f.kb);
	for (const scope of scopes) {
		assert.deepEqual(await reader(scope), canonicalHistory, "legal aliases share the same managed history");
		const corpus = await loadRetrievalCorpus(scope, "sources-only", false, reader);
		assert.equal(corpus.documents.some((document) => document.path === v1.rawPath), false);
	}
	assert.match(await readFile(path.join(f.kb, v1.rawPath), "utf8"), /v1/);
	await writeFile(path.join(f.kb, v1.rawPath), "unknown externally edited historical file");
	for (const scope of scopes) {
		const changed = await loadRetrievalCorpus(scope, "sources-only", false, reader);
		assert.equal(changed.documents.some((document) => document.path === v1.rawPath), true, "unknown external content remains visible through aliases");
	}
});

test("nine HTTP routes enforce capability, strict contexts, opaque identifiers and safe error envelopes", async (t) => {
	const f = await fixture(t); const queue = f.make(); const token = "revision-route-token";
	const app = createApp({ ingestJobService: { ...queue, assertRegisteredKnowledgeBase: async (kb) => { if (kb !== f.kb) throw Object.assign(new Error("secret private path"), { code: "KB_NOT_REGISTERED" }); return kb; } }, security: createSecurityMiddleware({ token, trustedOrigins: new Set(["http://localhost:5180"]) }) });
	const headers = { "Content-Type": "application/json", [CAPABILITY_TOKEN_HEADER]: token, Origin: "http://localhost:5180" };
	const post = (url: string, body: object) => app.request(`/api/knowledge-bases/source-revisions${url}`, { method: "POST", headers, body: JSON.stringify(body) });
	const url = `/api/knowledge-bases/source-revisions?kb=${encodeURIComponent(f.kb)}`;
	assert.equal((await app.request(url)).status, 403); const authenticated = await app.request(url, { headers }); assert.equal(authenticated.status, 200, await authenticated.text());
	assert.equal((await post("/check", { kbPath: f.kb, sourceScanId: "expired" })).status, 400);
	assert.equal((await post("/check", { kbPath: "/secret/other", sourceScanId: "expired" })).status, 404);
	const scan = (await inspectPath(f.incoming)).ingestibleFiles!.scanId;
	const check = await (await post("/check", { kbPath: f.kb, sourceScanId: scan })).json() as any;
	const creation = await post("/candidates", { type: "changes", kbPath: f.kb, checkId: check.data.id, changeIds: [check.data.changes[0].id], requestId: randomUUID() }); assert.equal(creation.status, 200);
	const id = ((await creation.json()) as any).data.candidates[0].id;
	const ready = await waitCandidate(queue, f.kb, id, "ready");
	assert.equal((await app.request(`/api/knowledge-bases/source-revisions/candidates/${id}/detail?kb=${encodeURIComponent(f.kb)}`, { headers })).status, 200);
	assert.equal((await app.request(`/api/knowledge-bases/source-revisions/candidates/..%2Fsecret/detail?kb=${encodeURIComponent(f.kb)}`, { headers })).status, 400);
	assert.equal((await post(`/candidates/${id}/adopt`, { kbPath: f.kb, expectedRevision: ready.revision })).status, 200);
	const source = (await queue.sourceRevisions.list(f.kb)).sources[0]!;
	assert.equal((await app.request(`/api/knowledge-bases/source-revisions/sources/${source.id}?kb=${encodeURIComponent(f.kb)}`, { headers })).status, 200);
	assert.equal((await app.request(`/api/knowledge-bases/source-revisions/versions/${source.currentVersionId}?kb=${encodeURIComponent(f.kb)}`, { headers })).status, 200);
	const regen = await queue.sourceRevisions.create({ type: "regenerate", kbPath: f.kb, target: { type: "source", sourceId: source.id, baseVersionId: source.currentVersionId }, requestId: randomUUID() });
	const another = await waitCandidate(queue, f.kb, regen.candidates[0]!.id, "ready");
	assert.equal((await post(`/candidates/${another.id}/cancel`, { kbPath: f.kb, expectedRevision: another.revision })).status, 200);
	const cancelled = (await queue.sourceRevisions.detail(f.kb, another.id)).candidate;
	assert.equal((await post(`/candidates/${another.id}/retry`, { kbPath: f.kb, expectedRevision: cancelled.revision })).status, 200);
	const unsafe = await app.request(`/api/knowledge-bases/source-revisions/versions/unknown?kb=${encodeURIComponent(f.kb)}`, { headers }); assert.equal(unsafe.status, 404); assert.doesNotMatch(await unsafe.text(), /secret|auth\.json/);
});

test("reenqueue after an interrupted adopting summary recovers before inspecting the legacy completion", async (t) => {
	const f = await fixture(t); let fail = false;
	const queue = f.make({ afterPublicationWrite: (relative) => { if (fail && relative.startsWith("wiki/")) throw new Error("interrupt"); } });
	const job = await initial(queue, f.kb, f.source);
	const created = await queue.sourceRevisions.create({ type: "regenerate", kbPath: f.kb, target: { type: "ingest-file", jobId: job.id, fileId: job.files[0]!.id }, requestId: randomUUID() });
	const ready = await waitCandidate(queue, f.kb, created.candidates[0]!.id, "ready"); fail = true;
	await assert.rejects(queue.sourceRevisions.adopt(f.kb, ready.id, ready.revision)); fail = false;
	const replay = await queue.enqueue({ kbPath: f.kb, filePaths: [f.source] });
	assert.equal(replay.id, job.id); assert.equal(replay.status, "completed");
	assert.equal((await queue.sourceRevisions.detail(f.kb, ready.id)).candidate.status, "adopted");
});

test("a newer scan observation cannot discard an already started adoption journal", async (t) => {
	const f = await fixture(t); let fail = false;
	const queue = f.make({ afterPublicationWrite: (relative) => { if (fail && relative.startsWith("wiki/")) throw new Error("interrupt"); } });
	const job = await initial(queue, f.kb, f.source);
	const created = await queue.sourceRevisions.create({ type: "regenerate", kbPath: f.kb, target: { type: "ingest-file", jobId: job.id, fileId: job.files[0]!.id }, requestId: randomUUID() });
	const ready = await waitCandidate(queue, f.kb, created.candidates[0]!.id, "ready"); fail = true;
	await assert.rejects(queue.sourceRevisions.adopt(f.kb, ready.id, ready.revision));
	await writeFile(f.source, "newer observed input"); const observed = await f.check(queue); assert.equal(observed.changes[0]!.kind, "modified");
	fail = false; await queue.sourceRevisions.recover(f.kb);
	assert.equal((await queue.sourceRevisions.detail(f.kb, ready.id)).candidate.status, "adopted");
	assert.equal((await f.check(queue)).changes[0]!.kind, "modified");
	assert.equal((await readFile(path.join(f.kb, "log.md"), "utf8")).split("采用素材版本").length - 1, 1);
});

test("final mutable summary read cannot archive external bytes as an approved generated version", async (t) => {
	const f = await fixture(t); let phase = false; let reads = 0; let summaryPath = "";
	const queue = f.make({ afterPublicationWrite: (relative) => { if (relative === "log.md") phase = true; } });
	const job = await initial(queue, f.kb, f.source); phase = false;
	const created = await queue.sourceRevisions.create({ type: "regenerate", kbPath: f.kb, target: { type: "ingest-file", jobId: job.id, fileId: job.files[0]!.id }, requestId: randomUUID() });
	const ready = await waitCandidate(queue, f.kb, created.candidates[0]!.id, "ready"); summaryPath = path.join(f.kb, job.files[0]!.outputPath!);
	const originalOpen = fsPromises.open;
	fsPromises.open = (async (...args: Parameters<typeof originalOpen>) => {
		if (phase && args[0] === summaryPath && ++reads === 2) await writeFile(summaryPath, "EXTERNAL EDIT AFTER VERIFICATION");
		return originalOpen(...args);
	}) as typeof originalOpen;
	syncBuiltinESMExports();
	try {
		await assert.rejects(queue.sourceRevisions.adopt(f.kb, ready.id, ready.revision), { code: "CONFLICT" });
		assert.equal((await queue.sourceRevisions.detail(f.kb, ready.id)).candidate.status, "adopting");
		assert.equal((await queue.sourceRevisions.history(f.kb, ready.sourceId!)).versions.length, 1);
		assert.equal(await readFile(summaryPath, "utf8"), "EXTERNAL EDIT AFTER VERIFICATION");
	} finally { fsPromises.open = originalOpen; syncBuiltinESMExports(); }
});

test("a mixed complete scan reports added modified deleted unchanged but invokes only selected modifications", async (t) => {
	const f = await fixture(t); const queue = f.make();
	const stable = path.join(f.incoming, "stable.md"); const removed = path.join(f.incoming, "removed.md");
	await writeFile(stable, "stable"); await writeFile(removed, "deleted later"); const baseline = await f.check(queue);
	const batch = await queue.sourceRevisions.create({ type: "changes", kbPath: f.kb, checkId: baseline.id, changeIds: baseline.changes.map((change) => change.id), requestId: randomUUID() });
	for (const item of batch.candidates) { const ready = await waitCandidate(queue, f.kb, item.id, "ready"); await queue.sourceRevisions.adopt(f.kb, ready.id, ready.revision); }
	await writeFile(f.source, "modified"); await unlink(removed); await writeFile(path.join(f.incoming, "new.md"), "new");
	const checked = await f.check(queue); assert.deepEqual(checked.changes.map((change) => change.kind).sort(), ["added", "deleted", "modified", "unchanged"]);
	const before = await Promise.all(["index.md", "log.md"].map((name) => readFile(path.join(f.kb, name))));
	const generated = await queue.sourceRevisions.create({ type: "changes", kbPath: f.kb, checkId: checked.id, changeIds: [checked.changes.find((change) => change.kind === "modified")!.id], requestId: randomUUID() });
	await waitCandidate(queue, f.kb, generated.candidates[0]!.id, "ready"); assert.equal(f.calls(), 4);
	assert.deepEqual(await Promise.all(["index.md", "log.md"].map((name) => readFile(path.join(f.kb, name)))), before);
	assert.equal((await f.check(queue)).changes.find((change) => change.relativePath === "new.md")!.kind, "added");
});

test("another live queue cannot mutate generation checkpoints through revision recovery", async (t) => {
	const f = await fixture(t); let release: (value: string) => void = () => undefined;
	const first = f.make({ generateRevision: () => new Promise<string>((resolve) => { release = resolve; }) });
	const checked = await f.check(first); const created = await first.sourceRevisions.create({ type: "changes", kbPath: f.kb, checkId: checked.id, changeIds: [checked.changes[0]!.id], requestId: randomUUID() });
	const generating = await waitCandidate(first, f.kb, created.candidates[0]!.id, "generating");
	const second = f.make(); await assert.rejects(second.sourceRevisions.recover(f.kb), { code: "BUSY" });
	assert.equal((await first.sourceRevisions.detail(f.kb, generating.id)).candidate.status, "generating");
	release("finished"); await waitCandidate(first, f.kb, generating.id, "ready");
});

test("replaced source roots and symlink publication targets cannot expand authority or overwrite external content", async (t) => {
	const f = await fixture(t); const queue = f.make(); const scan = (await inspectPath(f.incoming)).ingestibleFiles!.scanId;
	const moved = `${f.incoming}-moved`; await rename(f.incoming, moved); await mkdir(f.incoming); await writeFile(f.source, "replacement root");
	await assert.rejects(queue.sourceRevisions.check(f.kb, scan), { code: "FORBIDDEN_PATH" });
	const ready = await added(queue, f);
	if (process.platform !== "win32") {
		const digest = createHash("sha256").update(`${f.source}\0${createHash("sha256").update("replacement root").digest("hex")}`).digest("hex");
		const target = path.join(f.kb, "wiki", "sources", `${digest}.md`); await mkdir(path.dirname(target), { recursive: true });
		const external = path.join(f.directory, "external.md"); await writeFile(external, "DO NOT OVERWRITE"); await symlink(external, target);
		await assert.rejects(queue.sourceRevisions.adopt(f.kb, ready.id, ready.revision), { code: "FORBIDDEN_PATH" });
		assert.equal(await readFile(external, "utf8"), "DO NOT OVERWRITE"); assert.equal((await queue.sourceRevisions.detail(f.kb, ready.id)).candidate.status, "stale");
	}
});

test("candidate result hashes are revalidated before adoption instead of trusting truncated views or mutable app files", async (t) => {
	const f = await fixture(t); const queue = f.make(); const ready = await added(queue, f);
	const recordRoot = path.join(f.root, createHash("sha256").update(f.kb).digest("hex"));
	await writeFile(path.join(recordRoot, "revision-results", `${ready.id}.md`), "unknown replacement");
	await assert.rejects(queue.sourceRevisions.detail(f.kb, ready.id), { code: "CONFLICT" });
	await assert.rejects(queue.sourceRevisions.adopt(f.kb, ready.id, ready.revision), { code: "CONFLICT" });
	assert.equal(await readFile(path.join(f.kb, "index.md"), "utf8"), "# Index\n");
});

test("authorized KB aliases use canonical paths for adoption and canonical keys for cancellation and recovery", { skip: process.platform === "win32" }, async (t) => {
	const f = await fixture(t); const alias = path.join(f.directory, "knowledge alias 中文"); await symlink(f.kb, alias, "dir");
	const registered = async (kb: string) => { if (![alias, f.kb].includes(kb)) throw Object.assign(new Error("unregistered"), { code: "KB_NOT_REGISTERED" }); return kb; };
	let queue = f.make({ assertRegisteredKnowledgeBase: registered }); const job = await initial(queue, alias, f.source);
	let scan = await queue.sourceRevisions.check(alias, (await inspectPath(f.incoming)).ingestibleFiles!.scanId); assert.equal(scan.changes[0]!.kind, "unchanged");
	await writeFile(f.source, "alias modified\r\n"); scan = await queue.sourceRevisions.check(alias, (await inspectPath(f.incoming)).ingestibleFiles!.scanId);
	const created = await queue.sourceRevisions.create({ type: "changes", kbPath: alias, checkId: scan.id, changeIds: [scan.changes[0]!.id], requestId: randomUUID() });
	const ready = await waitCandidate(queue, alias, created.candidates[0]!.id, "ready"); await queue.close();
	queue = f.make({ assertRegisteredKnowledgeBase: registered }); await queue.recover();
	const app = createApp({ ingestJobService: { ...queue, assertRegisteredKnowledgeBase: registered } });
	const listResponse = await app.request(`/api/knowledge-bases/source-revisions?kb=${encodeURIComponent(alias)}`); const publicList = await listResponse.json() as any;
	assert.equal(publicList.data.candidates[0].kbPath, alias); assert.equal(publicList.data.sources[0].kbPath, alias); assert.equal(publicList.data.directories[0].kbPath, alias);
	const detailResponse = await app.request(`/api/knowledge-bases/source-revisions/candidates/${ready.id}/detail?kb=${encodeURIComponent(alias)}`); const publicDetail = await detailResponse.json() as any;
	assert.equal(publicDetail.data.candidate.kbPath, alias);
	const adoptedResponse = await app.request(`/api/knowledge-bases/source-revisions/candidates/${ready.id}/adopt`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kbPath: alias, expectedRevision: ready.revision }) });
	assert.equal(adoptedResponse.status, 200); const adopted = (await adoptedResponse.json() as any).data; assert.equal(adopted.status, "adopted"); assert.equal(adopted.kbPath, alias);
	assert.match(await readFile(path.join(f.kb, job.files[0]!.outputPath!), "utf8"), /alias modified/);
	await queue.close();
	let release: (value: string) => void = () => undefined; let aborted = false; let calls = 0;
	queue = f.make({ assertRegisteredKnowledgeBase: registered, generateRevision: ({ signal }) => { calls++; signal.addEventListener("abort", () => { aborted = true; }); return new Promise<string>((resolve) => { release = resolve; }); } });
	await queue.recover(); const source = (await queue.sourceRevisions.list(alias)).sources[0]!;
	const regenerated = await queue.sourceRevisions.create({ type: "regenerate", kbPath: alias, target: { type: "source", sourceId: source.id, baseVersionId: source.currentVersionId }, requestId: randomUUID() });
	const running = await waitCandidate(queue, alias, regenerated.candidates[0]!.id, "generating"); await queue.sourceRevisions.recover(alias);
	assert.equal(calls, 1); assert.equal((await queue.sourceRevisions.detail(alias, running.id)).candidate.attempts, 1);
	await queue.sourceRevisions.cancel(alias, running.id, running.revision); assert.equal(aborted, true); release("late");
});

test("ordinary intake reuses adopted v1 and v2 completions with their stable summary and no extra model calls", async (t) => {
	const f = await fixture(t); let ordinaryCalls = 0;
	let queue = f.make({ generate: async () => { ordinaryCalls++; return "unexpected ordinary generation"; } });
	const v1 = await added(queue, f); await queue.sourceRevisions.adopt(f.kb, v1.id, v1.revision);
	const source = (await queue.sourceRevisions.list(f.kb)).sources[0]!;
	const beforeV1 = await readFile(path.join(f.kb, source.outputPath)); const logV1 = await readFile(path.join(f.kb, "log.md"));
	const first = await queue.enqueue({ kbPath: f.kb, filePaths: [f.source] });
	assert.equal(first.status, "completed"); assert.equal(first.files[0]!.attempts, 0); assert.equal(first.files[0]!.outputPath, source.outputPath);
	assert.equal((await queue.enqueue({ kbPath: f.kb, filePaths: [f.source] })).id, first.id);
	assert.deepEqual(await readFile(path.join(f.kb, source.outputPath)), beforeV1); assert.deepEqual(await readFile(path.join(f.kb, "log.md")), logV1);
	await writeFile(f.source, "adopted v2 bytes\r\n"); const v2 = await added(queue, f); await queue.sourceRevisions.adopt(f.kb, v2.id, v2.revision);
	const beforeV2 = await readFile(path.join(f.kb, source.outputPath)); const logV2 = await readFile(path.join(f.kb, "log.md"));
	await queue.close(); queue = f.make({ generate: async () => { ordinaryCalls++; return "unexpected ordinary generation"; } }); await queue.recover();
	const second = await queue.enqueue({ kbPath: f.kb, filePaths: [f.source] });
	assert.equal(second.status, "completed"); assert.equal(second.files[0]!.attempts, 0); assert.equal(second.files[0]!.outputPath, source.outputPath); assert.notEqual(second.files[0]!.id, first.files[0]!.id);
	assert.equal((await queue.enqueue({ kbPath: f.kb, filePaths: [f.source] })).id, second.id);
	assert.deepEqual(await readFile(path.join(f.kb, source.outputPath)), beforeV2); assert.deepEqual(await readFile(path.join(f.kb, "log.md")), logV2);
	const corpus = await loadRetrievalCorpus(f.kb, "knowledge", false, (kb) => managedHistoricalHashes(kb, f.root));
	assert.deepEqual(corpus.documents.filter((document) => document.path.startsWith("wiki/sources/")).map((document) => document.path), [source.outputPath]);
	assert.equal(ordinaryCalls, 0);
	const regenerated = await queue.sourceRevisions.create({ type: "regenerate", kbPath: f.kb, target: { type: "ingest-file", jobId: second.id, fileId: second.files[0]!.id }, requestId: randomUUID() });
	const refreshed = await waitCandidate(queue, f.kb, regenerated.candidates[0]!.id, "ready");
	assert.equal(refreshed.sourceId, source.id); assert.equal(refreshed.baseVersionId, (await queue.sourceRevisions.list(f.kb)).sources[0]!.currentVersionId);
	assert.equal((await queue.sourceRevisions.detail(f.kb, refreshed.id)).original.after!.text, "adopted v2 bytes\r\n");
	assert.deepEqual(await readFile(path.join(f.kb, source.outputPath)), beforeV2);
	await assert.rejects(queue.sourceRevisions.create({ type: "regenerate", kbPath: f.kb, target: { type: "ingest-file", jobId: first.id, fileId: first.files[0]!.id }, requestId: randomUUID() }), { code: "CONFLICT" });
});

test("ordinary intake refuses altered adopted summary, raw, checkpoint or journal instead of blindly reusing an input id", async (t) => {
	for (const changed of ["summary", "raw", "snapshot", "archive", "journal", "missing-raw"] as const) await t.test(changed, async (subtest) => {
		const f = await fixture(subtest); let ordinaryCalls = 0;
		const queue = f.make({ generate: async () => { ordinaryCalls++; return "unexpected ordinary generation"; } });
		const ready = await added(queue, f); const adopted = await queue.sourceRevisions.adopt(f.kb, ready.id, ready.revision);
		const source = (await queue.sourceRevisions.list(f.kb)).sources[0]!; const version = (await queue.sourceRevisions.history(f.kb, source.id)).versions[0]!;
		const application = path.join(f.root, createHash("sha256").update(f.kb).digest("hex"));
		const fileId = createHash("sha256").update(`${f.source}\0${version.rawHash}`).digest("hex");
		const target = changed === "summary" ? path.join(f.kb, source.outputPath) : changed === "raw" || changed === "missing-raw" ? path.join(f.kb, version.rawPath)
			: changed === "snapshot" ? path.join(application, "inputs", `${fileId}.md`) : changed === "archive" ? path.join(application, "revision-summaries", `${adopted.adoptedVersionId}.md`)
			: path.join(application, "revision-publications", `${ready.id}.json`);
		if (changed === "missing-raw") await unlink(target); else await writeFile(target, "UNKNOWN EXTERNAL CONTENT");
		await assert.rejects(queue.enqueue({ kbPath: f.kb, filePaths: [f.source] }), { code: "CONFLICT" });
		assert.equal(ordinaryCalls, 0); assert.equal((await queue.list(f.kb)).length, 0);
		if (changed !== "missing-raw") assert.equal(await readFile(target, "utf8"), "UNKNOWN EXTERNAL CONTENT");
	});
});

test("ordinary intake cannot bypass an adopted source lineage with new content but accepts a different same-name source", async (t) => {
	const f = await fixture(t); let ordinaryCalls = 0; const queue = f.make({ generate: async () => { ordinaryCalls++; return "independent ordinary source"; } });
	const ready = await added(queue, f); await queue.sourceRevisions.adopt(f.kb, ready.id, ready.revision);
	await writeFile(f.source, "unreviewed content must use a candidate"); await assert.rejects(queue.enqueue({ kbPath: f.kb, filePaths: [f.source] }), { code: "CONFLICT" });
	assert.equal(ordinaryCalls, 0);
	const otherDirectory = path.join(f.incoming, "independent"); await mkdir(otherDirectory); const other = path.join(otherDirectory, path.basename(f.source)); await writeFile(other, "unreviewed content must use a candidate");
	const done = await initial(queue, f.kb, other); assert.equal(done.status, "completed"); assert.equal(ordinaryCalls, 1);
});
