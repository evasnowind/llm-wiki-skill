import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import type { IngestJob } from "@llm-wiki/workbench-contracts";

import { createIngestQueue, type IngestQueueDeps, type IngestQueueService } from "./ingest/queue.js";
import { createBashScriptCommand, toBashPath } from "./platform/bash.js";

async function fixture(t: TestContext, overrides: Partial<IngestQueueDeps> = {}) {
	const directory = await realpath(await mkdtemp(path.join(tmpdir(), "llm-wiki-ingest-")));
	const kb = path.join(directory, "kb");
	const root = path.join(directory, "application", "ingest");
	await mkdir(path.join(kb, "incoming"), { recursive: true });
	await writeFile(path.join(kb, ".wiki-schema.md"), "# Schema\n");
	await writeFile(path.join(kb, ".wiki-cache.json"), "{}\n");
	await writeFile(path.join(kb, "index.md"), "# Index\n");
	await writeFile(path.join(kb, "log.md"), "# Log\n");
	const source = path.join(kb, "incoming", "材料.md");
	await writeFile(source, "# Original\nOriginal source evidence.\n");
	const registered = new Set([kb]);
	const services: IngestQueueService[] = [];
	const deps: IngestQueueDeps = {
		root,
		assertRegisteredKnowledgeBase: async (value) => {
			if (!registered.has(value)) throw Object.assign(new Error("not registered"), { code: "KB_NOT_REGISTERED" });
			return value;
		},
		validateSources: () => ({ ok: false, error: "not scanned" }),
		generate: async () => "## 核心摘要\n\nOriginal source evidence.\n",
		retryDelayMs: 1,
		...overrides,
	};
	const make = (extra: Partial<IngestQueueDeps> = {}) => { const service = createIngestQueue({ ...deps, ...extra }); services.push(service); return service; };
	t.after(async () => { await Promise.allSettled(services.map((service) => service.close())); await rm(directory, { recursive: true, force: true }); });
	return { kb, root, directory, source, make, registered };
}

async function waitJob(service: IngestQueueService, kb: string, id: string, predicate: (job: IngestJob) => boolean): Promise<IngestJob> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const job = (await service.list(kb)).find((value) => value.id === id)!;
		if (predicate(job)) return job;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`queue did not reach expected state: ${JSON.stringify(await service.list(kb))}`);
}

function queuePath(root: string, kb: string): string { return path.join(root, createHash("sha256").update(kb).digest("hex"), "queue.json"); }

test("durable intake publishes a stable source, raw bytes and metadata; repeated input reuses completion and Skill cache", async (t) => {
	let calls = 0;
	const f = await fixture(t, { generate: async () => { calls++; return "## 核心摘要\nEvidence\n"; } });
	const service = f.make();
	const queued = await service.enqueue({ kbPath: f.kb, filePaths: [f.source, f.source] });
	const done = await waitJob(service, f.kb, queued.id, (job) => job.status === "completed");
	assert.equal(done.files.length, 1);
	const file = done.files[0]!;
	assert.equal(file.attempts, 1);
	const summary = await readFile(path.join(f.kb, file.outputPath!), "utf8");
	const rawPath = `raw/notes/${file.id}.md`;
	assert.match(summary, new RegExp(`source_path: ${rawPath}`));
	assert.equal(await readFile(path.join(f.kb, rawPath), "utf8"), await readFile(f.source, "utf8"));
	assert.equal((await service.enqueue({ kbPath: f.kb, filePaths: [f.source] })).id, done.id);
	assert.equal(calls, 1);
	for (const name of ["index.md", "log.md"]) assert.equal((await readFile(path.join(f.kb, name), "utf8")).split(`reliable-ingest:${file.id}`).length - 1, 1);
	const state = await stat(queuePath(f.root, f.kb));
	assert.equal(state.isFile(), true);
	// POSIX mode bits cannot express or prove the inherited Windows ACL.
	if (process.platform !== "win32") assert.equal(state.mode & 0o777, 0o600);
	const cacheSource = path.join(f.kb, rawPath);
	const invocation = createBashScriptCommand(path.resolve("scripts/cache.sh"), ["check", toBashPath(cacheSource)], { cwd: f.kb });
	const cacheOutput = await new Promise<string>((resolve, reject) => {
		execFile(invocation.command, invocation.args, { cwd: f.kb, env: invocation.env }, (error, stdout) => error ? reject(error) : resolve(stdout));
	});
	assert.match(cacheOutput, /HIT/);
});

test("reenqueue restores deleted completed summaries and raw files without another model call", async (t) => {
	for (const deletion of ["summary", "raw", "both"] as const) {
		await t.test(deletion, async (subtest) => {
			let calls = 0;
			const f = await fixture(subtest, { generate: async () => { calls++; return "Prepared summary retained for recovery"; } });
			const service = f.make();
			const queued = await service.enqueue({ kbPath: f.kb, filePaths: [f.source] });
			const done = await waitJob(service, f.kb, queued.id, (job) => job.status === "completed");
			const file = done.files[0]!;
			const summary = path.join(f.kb, file.outputPath!);
			const raw = path.join(f.kb, "raw", "notes", `${file.id}.md`);
			const expectedSummary = await readFile(summary, "utf8");
			const expectedRaw = await readFile(raw, "utf8");
			if (deletion !== "raw") await unlink(summary);
			if (deletion !== "summary") await unlink(raw);
			const restoring = await service.enqueue({ kbPath: f.kb, filePaths: [f.source] });
			assert.equal(restoring.id, done.id);
			assert.notEqual(restoring.status, "completed");
			const restored = await waitJob(service, f.kb, done.id, (job) => job.status === "completed");
			assert.equal(restored.files[0]!.outputPath, file.outputPath);
			assert.equal(calls, 1);
			assert.equal(await readFile(summary, "utf8"), expectedSummary);
			assert.equal(await readFile(raw, "utf8"), expectedRaw);
			for (const name of ["index.md", "log.md"]) assert.equal((await readFile(path.join(f.kb, name), "utf8")).split(`reliable-ingest:${file.id}`).length - 1, 1);
		});
	}
});

test("new batches also restore missing completed files while preserving unknown external rewrites", async (t) => {
	let calls = 0;
	const f = await fixture(t, { generate: async () => { calls++; return "Prepared source summary"; } });
	const service = f.make();
	const first = await service.enqueue({ kbPath: f.kb, filePaths: [f.source] });
	const completed = await waitJob(service, f.kb, first.id, (job) => job.status === "completed");
	const file = completed.files[0]!;
	await unlink(path.join(f.kb, "raw", "notes", `${file.id}.md`));
	const sourceB = path.join(f.kb, "incoming", "B.md"); await writeFile(sourceB, "New source B");
	const mixed = await service.enqueue({ kbPath: f.kb, filePaths: [f.source, sourceB] });
	const restored = await waitJob(service, f.kb, mixed.id, (job) => job.status === "completed");
	assert.equal(calls, 2);
	assert.equal(await readFile(path.join(f.kb, "raw", "notes", `${file.id}.md`), "utf8"), await readFile(f.source, "utf8"));
	const summary = path.join(f.kb, file.outputPath!);
	await writeFile(summary, "Human edited summary must survive\n");
	const conflict = await service.enqueue({ kbPath: f.kb, filePaths: [f.source, sourceB] });
	assert.equal(conflict.id, restored.id);
	assert.equal(conflict.status, "failed");
	await service.retry(f.kb, conflict.id);
	await waitJob(service, f.kb, conflict.id, (job) => job.status === "failed");
	assert.equal(await readFile(summary, "utf8"), "Human edited summary must survive\n");
	assert.equal(calls, 2);
});

test("accepted snapshots survive external edits and restart without an in-memory source scan grant", async (t) => {
	let started!: () => void;
	const began = new Promise<void>((resolve) => { started = resolve; });
	let finish!: (value: string) => void;
	const pending = new Promise<string>((resolve) => { finish = resolve; });
	const f = await fixture(t);
	const external = path.join(f.directory, "external"); await mkdir(external);
	const original = path.join(external, "source.txt"); await writeFile(original, "accepted snapshot");
	const first = f.make({ validateSources: () => ({ ok: true, root: external }), generate: async () => { started(); return pending; } });
	const job = await first.enqueue({ kbPath: f.kb, sourceScanId: "temporary-grant", filePaths: [original] });
	await began;
	await writeFile(original, "external edit after acceptance");
	await first.close();
	let seen = "";
	const second = f.make({ generate: async (input) => { seen = await readFile(input.filePath, "utf8"); return "Snapshot summary"; } });
	await second.recover();
	const completed = await waitJob(second, f.kb, job.id, (value) => value.status === "completed");
	assert.equal(seen, "accepted snapshot");
	assert.equal(await readFile(path.join(f.kb, "raw", "notes", `${completed.files[0]!.id}.txt`), "utf8"), "accepted snapshot");
	finish("late first process output");
});

test("cancel ignores a late generator result; retry is explicit and reuses the immutable input", async (t) => {
	let release!: (value: string) => void;
	let started!: () => void;
	const began = new Promise<void>((resolve) => { started = resolve; });
	let calls = 0;
	const f = await fixture(t, { generate: async () => { if (++calls === 1) { started(); return new Promise((resolve) => { release = resolve; }); } return "Retried summary"; } });
	const service = f.make();
	const job = await service.enqueue({ kbPath: f.kb, filePaths: [f.source] });
	await began;
	const cancelled = await service.cancel(f.kb, job.id);
	assert.equal(cancelled.status, "cancelled");
	release("late discarded summary");
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal((await service.list(f.kb))[0]!.files[0]!.outputPath, null);
	assert.equal(await stat(path.join(f.kb, "wiki")).catch(() => null), null);
	await service.retry(f.kb, job.id);
	const done = await waitJob(service, f.kb, job.id, (value) => value.status === "completed");
	assert.equal(calls, 2); assert.equal(done.files[0]!.attempts, 2);
});

test("transient model failures retry three times, authentication failures wait for manual retry", async (t) => {
	let calls = 0;
	const f = await fixture(t, { generate: async () => { if (++calls < 3) throw Object.assign(new Error("unavailable"), { status: 503 }); return "Summary"; } });
	const service = f.make();
	const a = await service.enqueue({ kbPath: f.kb, filePaths: [f.source] });
	assert.equal((await waitJob(service, f.kb, a.id, (job) => job.status === "completed")).files[0]!.attempts, 3);
	await service.close();
	await writeFile(f.source, "new source version");
	let authCalls = 0;
	const second = f.make({ generate: async () => { if (++authCalls === 1) throw new Error("401 secret token /private/user/path"); return "Authenticated summary"; } });
	const b = await second.enqueue({ kbPath: f.kb, filePaths: [f.source] });
	const failed = await waitJob(second, f.kb, b.id, (job) => job.status === "failed");
	assert.equal(authCalls, 1); assert.doesNotMatch(failed.files[0]!.error!, /secret|private/);
	await second.retry(f.kb, b.id);
	await waitJob(second, f.kb, b.id, (job) => job.status === "completed");
	assert.equal(authCalls, 2);
});

test("a partial metadata commit resumes after restart without generating again or duplicating entries", async (t) => {
	let fail = true;
	const f = await fixture(t, { afterPublicationWrite: (relative) => { if (relative === "index.md" && fail) { fail = false; throw new Error("crash after index"); } } });
	const first = f.make();
	const job = await first.enqueue({ kbPath: f.kb, filePaths: [f.source] });
	await waitJob(first, f.kb, job.id, (value) => value.status === "failed");
	await first.close();
	// The last durable state before an actual process death is committing.
	const disk = JSON.parse(await readFile(queuePath(f.root, f.kb), "utf8"));
	disk.jobs[0].status = "committing"; disk.jobs[0].files[0].status = "committing";
	await writeFile(queuePath(f.root, f.kb), JSON.stringify(disk));
	let calls = 0;
	const second = f.make({ generate: async () => { calls++; throw new Error("must reuse checkpoint"); } });
	await second.recover();
	const done = await waitJob(second, f.kb, job.id, (value) => value.status === "completed");
	assert.equal(calls, 0);
	for (const name of ["index.md", "log.md"]) assert.equal((await readFile(path.join(f.kb, name), "utf8")).split(`reliable-ingest:${done.files[0]!.id}`).length - 1, 1);
	assert.equal((await readdir(path.join(f.kb, "wiki", "sources"))).filter((name) => name.endsWith(".md")).length, 1);
});

test("explicit retry safely rebases append-only metadata after another source commits", async (t) => {
	let fail = true;
	const f = await fixture(t, { afterPublicationWrite: (relative) => { if (relative === "index.md" && fail) { fail = false; throw new Error("partial A"); } } });
	const service = f.make();
	const a = await service.enqueue({ kbPath: f.kb, filePaths: [f.source] });
	await waitJob(service, f.kb, a.id, (job) => job.status === "failed");
	const sourceB = path.join(f.kb, "incoming", "B.txt"); await writeFile(sourceB, "Source B");
	const b = await service.enqueue({ kbPath: f.kb, filePaths: [sourceB] });
	const completedB = await waitJob(service, f.kb, b.id, (job) => job.status === "completed");
	await service.retry(f.kb, a.id);
	const completedA = await waitJob(service, f.kb, a.id, (job) => job.status === "completed");
	for (const name of ["index.md", "log.md"]) {
		const text = await readFile(path.join(f.kb, name), "utf8");
		for (const done of [completedA, completedB]) assert.equal(text.split(`reliable-ingest:${done.files[0]!.id}`).length - 1, 1);
	}
});

test("external edits between metadata read and journal creation cannot be overwritten", async (t) => {
	let edit = true;
	const f = await fixture(t);
	const service = f.make({ afterPublicationRead: async (relative) => {
		if (relative === "index.md" && edit) { edit = false; await writeFile(path.join(f.kb, "index.md"), "External text must survive\n"); }
	} });
	const job = await service.enqueue({ kbPath: f.kb, filePaths: [f.source] });
	await waitJob(service, f.kb, job.id, (value) => value.status === "failed");
	assert.equal(await readFile(path.join(f.kb, "index.md"), "utf8"), "External text must survive\n");
	await service.retry(f.kb, job.id);
	await waitJob(service, f.kb, job.id, (value) => value.status === "completed");
	assert.match(await readFile(path.join(f.kb, "index.md"), "utf8"), /^External text must survive/);
});

test("storage and source symlinks are rejected; corrupt queues are preserved and isolated", async (t) => {
	const f = await fixture(t);
	const outside = path.join(f.directory, "outside"); await mkdir(outside); await writeFile(path.join(outside, "secret.md"), "secret");
	const link = path.join(f.kb, "incoming", "escape.md"); await symlink(path.join(outside, "secret.md"), link);
	const service = f.make();
	await assert.rejects(service.enqueue({ kbPath: f.kb, filePaths: [link] }), /授权/);
	const appLink = path.join(f.directory, "bad-root"); await symlink(outside, appLink);
	const unsafe = f.make({ root: appLink });
	await assert.rejects(unsafe.enqueue({ kbPath: f.kb, filePaths: [f.source] }), /授权/);
	const job = await service.enqueue({ kbPath: f.kb, filePaths: [f.source] });
	await waitJob(service, f.kb, job.id, (value) => value.status === "completed"); await service.close();
	const stateFile = queuePath(f.root, f.kb); await writeFile(stateFile, "{broken-json");
	const second = f.make();
	await second.recover();
	await assert.rejects(second.list(f.kb), /损坏/);
	assert.equal(await readFile(stateFile, "utf8"), "{broken-json");
	const secondKb = path.join(f.directory, "second-kb"); await mkdir(secondKb); f.registered.add(secondKb);
	const secondSource = path.join(secondKb, "source.md"); await writeFile(secondSource, "Second KB evidence");
	const secondJob = await second.enqueue({ kbPath: secondKb, filePaths: [secondSource] });
	await waitJob(second, secondKb, secondJob.id, (value) => value.status === "completed");
});

test("progress cannot advance durable revisions; closing prevents queued work from starting", async (t) => {
	let started!: () => void;
	const began = new Promise<void>((resolve) => { started = resolve; });
	let progress!: (chars: number) => void;
	let calls = 0;
	const f = await fixture(t, { generate: async (_input, onProgress) => { calls++; progress = onProgress; started(); return new Promise(() => undefined); } });
	const service = f.make();
	const sourceB = path.join(f.kb, "incoming", "second.md"); await writeFile(sourceB, "Second");
	const job = await service.enqueue({ kbPath: f.kb, filePaths: [f.source, sourceB], concurrency: 1 });
	await began;
	const before = (await service.list(f.kb))[0]!;
	for (let n = 0; n < 100; n++) progress(n * 100);
	const after = (await service.list(f.kb))[0]!;
	assert.equal(after.revision, before.revision);
	assert.equal(after.files[0]!.progressChars, 9900);
	await service.close();
	assert.equal(calls, 1);
	const second = f.make({ generate: async () => "Recovered" }); await second.recover();
	const done = await waitJob(second, f.kb, job.id, (value) => value.status === "completed");
	assert.ok(done.revision > after.revision);
});

test("a second service cannot modify or close a live owner's queue", async (t) => {
	let began!: () => void; const started = new Promise<void>((resolve) => { began = resolve; });
	const f = await fixture(t, { generate: async () => { began(); return new Promise(() => undefined); } });
	const first = f.make(); const a = await first.enqueue({ kbPath: f.kb, filePaths: [f.source] }); await started;
	const secondSource = path.join(f.kb, "incoming", "B.md"); await writeFile(secondSource, "B");
	const before = await readFile(queuePath(f.root, f.kb), "utf8");
	const second = f.make();
	await assert.rejects(second.enqueue({ kbPath: f.kb, filePaths: [secondSource] }), { code: "BUSY" });
	await second.close();
	assert.equal(await readFile(queuePath(f.root, f.kb), "utf8"), before);
	assert.equal((await first.list(f.kb)).find((job) => job.id === a.id)!.status, "running");
});

test("queue records cannot be symlinked to external files", async (t) => {
	const f = await fixture(t); const first = f.make();
	const job = await first.enqueue({ kbPath: f.kb, filePaths: [f.source] });
	await waitJob(first, f.kb, job.id, (value) => value.status === "completed"); await first.close();
	const record = queuePath(f.root, f.kb); const original = await readFile(record, "utf8");
	const external = path.join(f.directory, "external-state.json"); await writeFile(external, original);
	await unlink(record); await symlink(external, record);
	const second = f.make(); await second.recover();
	await assert.rejects(second.list(f.kb), { code: "FORBIDDEN_PATH" });
	assert.equal(await readFile(external, "utf8"), original);
});

test("an empty damaged queue does not prevent another library's pending job from recovering", async (t) => {
	const f = await fixture(t, { generate: async () => new Promise(() => undefined) });
	const secondKb = path.join(f.directory, "second-kb"); await mkdir(secondKb); f.registered.add(secondKb);
	const sourceB = path.join(secondKb, "B.md"); await writeFile(sourceB, "B evidence");
	const first = f.make(); await first.enqueue({ kbPath: f.kb, filePaths: [f.source] });
	const b = await first.enqueue({ kbPath: secondKb, filePaths: [sourceB] }); await first.close();
	await writeFile(queuePath(f.root, f.kb), "");
	const second = f.make({ generate: async () => "Restored B" }); await second.recover();
	await waitJob(second, secondKb, b.id, (value) => value.status === "completed");
	await assert.rejects(second.list(f.kb), /损坏/);
	assert.equal(await readFile(queuePath(f.root, f.kb), "utf8"), "");
});
