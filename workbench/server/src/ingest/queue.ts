import { createHash, randomUUID } from "node:crypto";
import { lstat, open, readdir, realpath, unlink } from "node:fs/promises";
import path from "node:path";

import {
	IngestJobRequestBodySchema, IngestJobSchema, ModelRefSchema,
	type IngestFile, type IngestJob, type IngestJobRequestBody,
} from "@llm-wiki/workbench-contracts";

import type { ModelRef } from "../config.js";
import { ensureSafeDirectory, isWithin, readRegularFile, sha256Bytes } from "../graph-rename-safe-io.js";
import { atomicWrite, readOptional, storageRoot } from "./storage.js";
import { inspectPublishedSource, publishSource } from "./publish.js";
import { createSourceRevisions, type RevisionContext, type SourceRevisionsService } from "./source-revisions.js";
import type { SourceRevisionGenerator } from "./revision-generator.js";
import { readInspectedMarkdownSources } from "../knowledge-bases.js";

const EXTENSIONS = new Set([".md", ".txt", ".pdf", ".html"]);
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_BATCH_BYTES = 100 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;

interface StoredFile extends IngestFile { extension: string; sourceHash: string; prepared: boolean; allowMetadataRebase?: boolean; canonicalPath?: string }
interface StoredJob extends Omit<IngestJob, "files"> { files: StoredFile[]; model: ModelRef | null }
interface DiskState { version: 1; kbPath: string; kbDev: number; kbIno: number; jobs: StoredJob[] }
interface QueueState extends DiskState {
	directory: string;
	tail: Promise<void>;
	commitTail: Promise<void>;
	active: Map<string, { controller: AbortController; promise: Promise<void>; jobId: string }>;
	pumping: boolean;
	pumpPromise?: Promise<void>;
	storageError?: Error;
}

export interface IngestGeneratorInput { kbPath: string; filePath: string; purpose: string; model: ModelRef | null }
export interface IngestQueueDeps {
	root: string;
	assertRegisteredKnowledgeBase: (kbPath: string) => Promise<string>;
	validateSources: (scanId: string | undefined, files: string[]) => { ok: true; root: string } | { ok: false; error: string };
	generateRevision?: SourceRevisionGenerator;
	resolveRevisionModel?: () => Promise<ModelRef | null>;
	scanMarkdown?: typeof readInspectedMarkdownSources;
	generate: (input: IngestGeneratorInput, progress: (chars: number) => void, signal: AbortSignal) => Promise<string>;
	beforePublish?: (kbPath: string) => void;
	afterPublish?: (kbPath: string, changed: boolean) => void;
	retryDelayMs?: number;
	/** Fault injection and publication instrumentation; no production side effect by default. */
	beforeComplete?: (fileId: string) => void | Promise<void>;
	afterPublicationWrite?: (relativePath: string) => void | Promise<void>;
	afterPublicationRead?: (relativePath: string) => void | Promise<void>;
}

export interface IngestQueueService {
	sourceRevisions: SourceRevisionsService;
	enqueue(input: IngestJobRequestBody): Promise<IngestJob>;
	list(kbPath: string): Promise<IngestJob[]>;
	cancel(kbPath: string, id: string): Promise<IngestJob>;
	retry(kbPath: string, id: string): Promise<IngestJob>;
	recover(): Promise<void>;
	close(): Promise<void>;
}

export function createIngestQueue(deps: IngestQueueDeps): IngestQueueService {
	const states = new Map<string, Promise<QueueState>>();
	const requestedRoot = path.resolve(deps.root);
	let root = requestedRoot;
	let canonicalRoot: string | undefined;
	let closing = false;
	let closePromise: Promise<void> | undefined;
	const owner = randomUUID();
	let owned = false;
	let ownerPromise: Promise<void> | undefined;
	function revisionContext(state: QueueState): RevisionContext {
		return { root, directory: state.directory, kbPath: state.kbPath, jobs: state.jobs,
			commit: async (operation) => { const result = state.commitTail.catch(() => undefined).then(operation); state.commitTail = result.then(() => undefined, () => undefined); return result; },
			checkBoundary: () => checkBoundary(state) };
	}
	const sourceRevisions = createSourceRevisions({
		withContext: async (requested, create, operation) => {
			if (create) ensureOpen();
			const state = await load(await registered(requested));
			return lock(state, async () => {
				await checkBoundary(state);
				if (state.storageError) throw state.storageError;
				if (create) { await initialize(state); await save(state); }
				return operation(revisionContext(state));
			});
		},
		withPublication: async (requested, operation) => {
			const state = await load(await registered(requested));
			const publication = state.commitTail.catch(() => undefined).then(() => lock(state, async () => {
				await checkBoundary(state); await initialize(state);
				if (state.storageError) throw state.storageError;
				return operation(revisionContext(state));
			}));
			state.commitTail = publication.then(() => undefined, () => undefined);
			return publication;
		},
		scan: deps.scanMarkdown ?? readInspectedMarkdownSources, generate: deps.generateRevision, resolveModel: deps.resolveRevisionModel,
		beforePublish: deps.beforePublish, afterPublish: deps.afterPublish,
		afterPublicationWrite: deps.afterPublicationWrite, afterPublicationRead: deps.afterPublicationRead,
	});

	async function checkStorage(create: boolean): Promise<boolean> {
		const parent = await lstat(path.dirname(requestedRoot)).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
		if (parent?.isSymbolicLink()) throw forbidden();
		let info = await lstat(requestedRoot).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
		if (!info && !create) return false;
		if (!info) { await storageRoot(requestedRoot); info = await lstat(requestedRoot); }
		if (!info.isDirectory() || info.isSymbolicLink()) throw forbidden();
		const resolved = await realpath(requestedRoot);
		if (canonicalRoot !== undefined && canonicalRoot !== resolved) throw forbidden();
		canonicalRoot = resolved;
		root = resolved;
		return true;
	}

	function acquire(): Promise<void> {
		ownerPromise ??= (async () => {
			await checkStorage(true);
			const target = path.join(root, ".owner.lock");
			for (let attempt = 0; attempt < 2; attempt++) {
				try {
					const handle = await open(target, "wx", 0o600);
					try { await handle.writeFile(JSON.stringify({ pid: process.pid, token: owner })); await handle.sync(); }
					finally { await handle.close(); }
					owned = true;
					return;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
					const bytes = await readRegularFile(root, target, false);
					const previous = JSON.parse(bytes?.toString("utf8") ?? "null") as { pid?: unknown; token?: unknown } | null;
					if (!previous || !Number.isSafeInteger(previous.pid) || typeof previous.token !== "string") throw new Error("入库锁记录损坏，已保留原文件");
					let alive = true;
					try { process.kill(previous.pid as number, 0); } catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ESRCH") alive = false; }
					if (alive) throw Object.assign(new Error("另一个入库服务正在使用队列"), { code: "BUSY" });
					const current = await readRegularFile(root, target, false);
					if (!current || !current.equals(bytes!)) throw Object.assign(new Error("入库锁已变化"), { code: "BUSY" });
					await unlink(target);
				}
			}
			throw Object.assign(new Error("入库队列正在使用中"), { code: "BUSY" });
		})().catch((error) => { ownerPromise = undefined; throw error; });
		return ownerPromise;
	}

	async function registered(requested: string): Promise<string> {
		return realpath(await deps.assertRegisteredKnowledgeBase(requested));
	}

	async function load(kbPath: string): Promise<QueueState> {
		const existing = states.get(kbPath);
		if (existing) return existing;
		const promise = (async () => {
			const exists = await checkStorage(false);
			const directory = path.join(root, hash(kbPath));
			const directoryInfo = exists ? await lstat(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; }) : null;
			if (directoryInfo && (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink())) throw forbidden();
			const raw = directoryInfo ? await readOptional(root, path.join(directory, "queue.json")) : null;
			const info = await lstat(kbPath);
			let disk: DiskState;
			try { disk = raw !== null ? parseDisk(raw, kbPath) : { version: 1 as const, kbPath, kbDev: info.dev, kbIno: info.ino, jobs: [] }; }
			catch { throw Object.assign(new Error("入库队列记录损坏，原文件已保留"), { code: "CORRUPT_INGEST_QUEUE" }); }
			if (disk.kbDev !== info.dev || disk.kbIno !== info.ino || !info.isDirectory() || info.isSymbolicLink()) throw forbidden();
			return { ...disk, directory, tail: Promise.resolve(), commitTail: Promise.resolve(), active: new Map(), pumping: false };
		})();
		states.set(kbPath, promise);
		try { return await promise; } catch (error) { states.delete(kbPath); throw error; }
	}

	async function initialize(state: QueueState): Promise<void> {
		await acquire();
		root = await storageRoot(root);
		state.directory = await ensureSafeDirectory(root, path.join(root, hash(state.kbPath)));
		for (const part of ["inputs", "results", "publications"]) await ensureSafeDirectory(root, path.join(state.directory, part));
	}

	function lock<T>(state: QueueState, operation: () => Promise<T>): Promise<T> {
		const result = state.tail.catch(() => undefined).then(operation);
		state.tail = result.then(() => undefined, () => undefined);
		return result;
	}

	async function save(state: QueueState): Promise<void> {
		try {
			await checkStorage(false);
			await atomicWrite(root, path.join(state.directory, "queue.json"), `${JSON.stringify({
				version: 1, kbPath: state.kbPath, kbDev: state.kbDev, kbIno: state.kbIno, jobs: state.jobs,
			})}\n`);
		} catch (error) { state.storageError = new Error("入库状态无法保存，请检查磁盘后重启服务"); throw error; }
	}

	async function change<T>(state: QueueState, operation: () => T): Promise<T> {
		if (state.storageError) throw state.storageError;
		const before = structuredClone(state.jobs);
		try { const result = operation(); await save(state); return result; }
		catch (error) { state.jobs = before; throw error; }
	}

	function ensureOpen(): void { if (closing) throw Object.assign(new Error("入库服务正在关闭"), { code: "BUSY" }); }
	async function checkBoundary(state: QueueState): Promise<void> {
		const canonical = await registered(state.kbPath);
		const info = await lstat(canonical);
		if (canonical !== state.kbPath || info.dev !== state.kbDev || info.ino !== state.kbIno) throw forbidden();
	}

	async function enqueue(request: IngestJobRequestBody): Promise<IngestJob> {
		ensureOpen();
		const input = IngestJobRequestBodySchema.parse(request);
		const kbPath = await registered(input.kbPath);
		const state = await load(kbPath);
		await sourceRevisions.recover(kbPath);
		const sources: Array<{ id: string; name: string; extension: string; sourceHash: string; bytes: Buffer; canonicalPath: string }> = [];
		let totalBytes = 0;
		for (const rawPath of [...new Set(input.filePaths)]) {
			if (!path.isAbsolute(rawPath) || !EXTENSIONS.has(path.extname(rawPath).toLowerCase())) throw invalid("只支持 Markdown、文本、PDF 和 HTML 文件");
			const candidate = path.resolve(rawPath);
			const canonical = await realpath(candidate);
			let allowedRoot = kbPath;
			if (!isWithin(kbPath, canonical)) {
				const grant = deps.validateSources(input.sourceScanId, [rawPath]);
				if (!grant.ok) throw invalid("来源扫描已失效或文件未获授权，请重新选择目录");
				allowedRoot = await realpath(grant.root);
			}
			if (!isWithin(allowedRoot, canonical)) throw forbidden();
			const bytes = await readSource(allowedRoot, canonical);
			totalBytes += bytes.length;
			if (totalBytes > MAX_BATCH_BYTES) throw invalid("单批素材不能超过 100 MiB");
			const sourceHash = sha256Bytes(bytes);
			const id = hash(`${canonical}\0${sourceHash}`);
			if (!sources.some((source) => source.id === id)) sources.push({ id, name: path.basename(candidate), extension: path.extname(candidate).toLowerCase(), sourceHash, bytes, canonicalPath: canonical });
		}
		return lock(state, async () => {
			ensureOpen();
			await checkBoundary(state);
			await checkStorage(false);
			if (state.storageError) throw state.storageError;
			const adopted = new Map<string, { outputPath: string; versionId: string }>();
			for (const source of sources) {
				const completion = await sourceRevisions.findAdoptedCompletion(revisionContext(state), source.id, source.sourceHash, source.canonicalPath);
				if (completion) adopted.set(source.id, completion);
			}
			const ids = sources.map((source) => source.id).sort().join(",");
			const matching = state.jobs.find((job) => job.files.map((file) => file.id).sort().join(",") === ids);
			if (matching) {
				if (matching.files.some((file) => adopted.has(file.id) && (file.status !== "completed" || file.outputPath !== adopted.get(file.id)!.outputPath))) {
					await initialize(state);
					await change(state, () => {
						for (const file of matching.files) {
							const completion = adopted.get(file.id);
							if (completion) { file.status = "completed"; file.outputPath = completion.outputPath; file.error = null; }
						}
						touch(matching);
					});
					for (const file of matching.files) if (adopted.has(file.id)) state.active.get(`${matching.id}/${file.id}`)?.controller.abort();
				}
				const restorations = new Map<string, "missing" | "changed">();
				for (const file of matching.files.filter((item) => item.status === "completed")) {
					const published = await inspectCompletion(state, file);
					if (published !== "valid") restorations.set(file.id, published);
				}
				if (restorations.size > 0) {
					await initialize(state);
					await change(state, () => {
						for (const file of matching.files) {
							const restoration = restorations.get(file.id);
							if (restoration) restoreCompletion(file, restoration);
						}
						touch(matching);
					});
					queueMicrotask(() => void pump(state));
				}
				return publicJob(matching);
			}
			const overlapping = state.jobs.some((job) => job.files.some((file) => sources.some((source) => source.id === file.id && !adopted.has(source.id)) && ["pending", "running", "committing"].includes(file.status)));
			if (overlapping) throw Object.assign(new Error("部分素材已有入库任务，请等待现有任务完成"), { code: "BUSY" });
			await initialize(state);
			const files: StoredFile[] = [];
			for (const source of sources) {
				const completion = adopted.get(source.id);
				if (completion) {
					files.push({ id: source.id, name: source.name, extension: source.extension, sourceHash: source.sourceHash, canonicalPath: source.canonicalPath,
						prepared: false, status: "completed", attempts: 0, progressChars: 0, outputPath: completion.outputPath, error: null });
					continue;
				}
				const completed = state.jobs.flatMap((job) => job.files).find((file) => file.id === source.id && file.status === "completed");
				if (completed) {
					const reused = structuredClone(completed);
					const published = await inspectCompletion(state, completed);
					if (published !== "valid") restoreCompletion(reused, published);
					files.push(reused);
					continue;
				}
				await atomicWrite(root, path.join(state.directory, "inputs", `${source.id}${source.extension}`), source.bytes);
				files.push({ id: source.id, name: source.name, extension: source.extension, sourceHash: source.sourceHash, canonicalPath: source.canonicalPath, prepared: false,
					status: "pending", attempts: 0, progressChars: 0, outputPath: null, error: null });
			}
			const now = new Date().toISOString();
			const job: StoredJob = { id: randomUUID(), kbPath, revision: 1, createdAt: now, updatedAt: now,
				concurrency: input.concurrency ?? 3, status: "pending", files, model: input.digestModel ?? null };
			touch(job);
			await change(state, () => state.jobs.unshift(job));
			queueMicrotask(() => void pump(state));
			return publicJob(job);
		});
	}

	async function inspectCompletion(state: QueueState, file: StoredFile): Promise<"valid" | "missing" | "changed"> {
		const managed = await sourceRevisions.inspectLegacyCompletion(revisionContext(state), file.id);
		if (managed) return managed;
		return inspectPublishedSource({ kbPath: state.kbPath, stateRoot: root,
			journalPath: path.join(state.directory, "publications", `${file.id}.json`),
			rawPath: `raw/${file.extension === ".pdf" ? "pdfs" : "notes"}/${file.id}${file.extension}`,
			outputPath: `wiki/sources/${file.id}.md` });
	}
	function restoreCompletion(file: StoredFile, restoration: "missing" | "changed"): void {
		file.outputPath = null;
		if (restoration === "missing") {
			file.status = "pending"; file.error = null; file.allowMetadataRebase = true;
		} else {
			file.status = "failed"; file.error = "已完成入库的产物或恢复记录已变化，请检查后重试；现有内容不会被覆盖";
		}
	}

	async function list(requested: string): Promise<IngestJob[]> {
		const state = await load(await registered(requested));
		return lock(state, async () => { if (state.storageError) throw state.storageError; return state.jobs.map(publicJob); });
	}

	async function action(requested: string, id: string, retry: boolean): Promise<IngestJob> {
		ensureOpen();
		const state = await load(await registered(requested));
		return lock(state, async () => {
			await checkBoundary(state);
			await acquire();
			const job = state.jobs.find((candidate) => candidate.id === id);
			if (!job) throw Object.assign(new Error("入库任务不存在"), { code: "NOT_FOUND" });
			const adopted = new Map<string, { outputPath: string; versionId: string }>();
			if (retry) for (const file of job.files.filter((item) => ["failed", "cancelled"].includes(item.status))) {
				const completion = await sourceRevisions.findAdoptedCompletion(revisionContext(state), file.id, file.sourceHash, file.canonicalPath);
				if (completion) adopted.set(file.id, completion);
			}
			await change(state, () => {
				for (const file of job.files) {
					if (retry && adopted.has(file.id)) {
						file.status = "completed"; file.outputPath = adopted.get(file.id)!.outputPath; file.error = null;
					} else if (retry && ["failed", "cancelled"].includes(file.status)) {
						file.status = "pending"; file.error = null; file.progressChars = 0; file.allowMetadataRebase = true;
					} else if (!retry && ["pending", "running"].includes(file.status)) {
						file.status = "cancelled"; file.error = null;
					}
				}
				touch(job);
			});
			if (!retry) {
				for (const [key, active] of state.active) if (active.jobId === id && findFile(state, id, key.split("/")[1]!).status === "cancelled") active.controller.abort();
			} else queueMicrotask(() => void pump(state));
			return publicJob(job);
		});
	}

	function pump(state: QueueState): Promise<void> {
		if (state.pumping || closing || state.storageError) return Promise.resolve();
		const promise = runPump(state);
		state.pumpPromise = promise;
		return promise;
	}
	async function runPump(state: QueueState): Promise<void> {
		if (state.pumping || closing || state.storageError) return;
		state.pumping = true;
		try {
			while (!closing && !state.storageError && state.active.size < 5) {
				const next = await lock(state, async () => {
					if (closing) return null;
					for (const job of [...state.jobs].reverse()) {
						const running = [...state.active.values()].filter((active) => active.jobId === job.id).length;
						if (running >= job.concurrency) continue;
						const file = job.files.find((candidate) => candidate.status === "pending" && !state.active.has(`${job.id}/${candidate.id}`));
						if (!file) continue;
						await change(state, () => { file.status = "running"; touch(job); });
						return { jobId: job.id, fileId: file.id };
					}
					return null;
				});
				if (!next || closing) break;
				const controller = new AbortController();
				const key = `${next.jobId}/${next.fileId}`;
				const promise = execute(state, next.jobId, next.fileId, controller.signal).catch(() => undefined).finally(() => {
					state.active.delete(key);
					queueMicrotask(() => void pump(state));
				});
				state.active.set(key, { controller, promise, jobId: next.jobId });
			}
		} catch (error) { state.storageError ??= error instanceof Error ? error : new Error("入库队列无法运行"); }
		finally { state.pumping = false; }
	}

	async function execute(state: QueueState, jobId: string, fileId: string, signal: AbortSignal): Promise<void> {
		try {
			let failures = 0;
			while (true) {
				const file = findFile(state, jobId, fileId);
				if (closing || signal.aborted || file.status !== "running") return;
				await checkBoundary(state);
				if (file.prepared) break;
				try {
					await lock(state, () => change(state, () => { findFile(state, jobId, fileId).attempts++; touch(findJob(state, jobId)); }));
					const snapshot = path.join(state.directory, "inputs", `${file.id}${file.extension}`);
					const bytes = await readRegularFile(root, snapshot, false);
					if (!bytes || sha256Bytes(bytes) !== file.sourceHash) throw new Error("素材快照损坏");
					const purposeBytes = await readRegularFile(state.kbPath, path.join(state.kbPath, "purpose.md"), true);
					const generated = await abortable(deps.generate({ kbPath: state.kbPath, filePath: snapshot, purpose: purposeBytes?.toString("utf8").slice(0, 2000) ?? "", model: findJob(state, jobId).model }, (chars) => {
						const live = findFile(state, jobId, fileId);
						if (live.status !== "running" || signal.aborted) return;
						live.progressChars = Math.max(live.progressChars, Math.floor(Math.max(0, chars)));
					}, signal), signal);
					if (signal.aborted || findFile(state, jobId, fileId).status !== "running") return;
					if (!generated.trim() || generated.length > 2 * 1024 * 1024) throw new Error("模型未生成有效摘要");
					await atomicWrite(root, path.join(state.directory, "results", `${fileId}.md`), generated);
					await lock(state, async () => {
						if (findFile(state, jobId, fileId).status !== "running" || signal.aborted) return;
						await change(state, () => { findFile(state, jobId, fileId).prepared = true; touch(findJob(state, jobId)); });
					});
					break;
				} catch (error) {
					if (signal.aborted || findFile(state, jobId, fileId).status !== "running") return;
					if (!isTransient(error) || ++failures >= 3 || state.storageError) throw error;
					await delay((deps.retryDelayMs ?? 1000) * failures, signal);
				}
			}
			await lock(state, async () => {
				const file = findFile(state, jobId, fileId);
				if (signal.aborted || file.status !== "running") return;
				await change(state, () => { file.status = "committing"; touch(findJob(state, jobId)); });
			});
			if (findFile(state, jobId, fileId).status !== "committing") return;
			await sourceRevisions.recover(state.kbPath);
			const publication = state.commitTail.catch(() => undefined).then(async () => {
				await checkBoundary(state);
				const file = findFile(state, jobId, fileId);
				const completion = await sourceRevisions.findAdoptedCompletion(revisionContext(state), file.id, file.sourceHash, file.canonicalPath);
				if (completion) {
					await lock(state, () => change(state, () => { const live = findFile(state, jobId, fileId); live.status = "completed"; live.outputPath = completion.outputPath; live.error = null; touch(findJob(state, jobId)); }));
					return;
				}
				const bytes = await readRegularFile(root, path.join(state.directory, "inputs", `${fileId}${file.extension}`), false);
				const generated = await readRegularFile(root, path.join(state.directory, "results", `${fileId}.md`), false);
				if (!bytes || sha256Bytes(bytes) !== file.sourceHash || !generated) throw new Error("入库检查点损坏");
				const outputPath = `wiki/sources/${fileId}.md`;
				deps.beforePublish?.(state.kbPath);
				const changed = true;
				try {
					await publishSource({ kbPath: state.kbPath, stateRoot: root, journalPath: path.join(state.directory, "publications", `${fileId}.json`),
						fileId, name: file.name, rawPath: `raw/${file.extension === ".pdf" ? "pdfs" : "notes"}/${fileId}${file.extension}`,
						outputPath, bytes, generated: generated.toString("utf8"), createdAt: findJob(state, jobId).createdAt,
						afterWrite: deps.afterPublicationWrite, afterReadShared: deps.afterPublicationRead, allowMetadataRebase: file.allowMetadataRebase });
					await deps.beforeComplete?.(fileId);
					await lock(state, () => change(state, () => { const live = findFile(state, jobId, fileId); live.status = "completed"; live.outputPath = outputPath; live.error = null; touch(findJob(state, jobId)); }));
				} finally { deps.afterPublish?.(state.kbPath, changed); }
			});
			state.commitTail = publication;
			await publication;
		} catch (error) {
			if (state.storageError || closing) return;
			await lock(state, async () => {
				const file = findFile(state, jobId, fileId);
				if (file.status === "cancelled") return;
				await change(state, () => { file.status = "failed"; file.error = publicError(error); touch(findJob(state, jobId)); });
			});
		}
	}

	async function recover(): Promise<void> {
		ensureOpen();
		if (!(await checkStorage(false))) return;
		const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
		if (entries.some((entry) => HASH.test(entry.name) && entry.isDirectory() && !entry.isSymbolicLink())) await acquire();
		for (const entry of entries) {
			if (!HASH.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
			try {
			const raw = await readOptional(root, path.join(root, entry.name, "queue.json"));
			if (raw === null) continue;
			const record = JSON.parse(raw) as { kbPath?: unknown };
			if (typeof record.kbPath !== "string" || hash(record.kbPath) !== entry.name) throw new Error("入库队列损坏，已保留原文件");
			let kbPath: string;
			try { kbPath = await registered(record.kbPath); } catch { continue; }
			const state = await load(kbPath);
			await sourceRevisions.recover(kbPath);
			await lock(state, async () => {
				if (!state.jobs.some((job) => job.files.some((file) => ["running", "committing"].includes(file.status)))) return;
				await change(state, () => { for (const job of state.jobs) { for (const file of job.files) if (["running", "committing"].includes(file.status)) file.status = "pending"; touch(job); } });
			});
			queueMicrotask(() => void pump(state));
			} catch {
				// Keep damaged records untouched; one library must not prevent the others from resuming.
				console.error("[ingest] 入库队列恢复失败，原记录已保留");
			}
		}
	}

	async function close(): Promise<void> {
		closePromise ??= (async () => {
			closing = true;
			await sourceRevisions.close();
			const loaded = await Promise.all([...states.values()]);
			if (!owned) return;
			for (const state of loaded) {
				if (!state.storageError && state.jobs.some((job) => job.files.some((file) => file.status === "running"))) {
					await lock(state, () => change(state, () => { for (const job of state.jobs) { for (const file of job.files) if (file.status === "running") file.status = "pending"; touch(job); } }));
				}
				for (const active of state.active.values()) active.controller.abort();
			}
			await Promise.all(loaded.map((state) => state.pumpPromise));
			await Promise.all(loaded.flatMap((state) => [...state.active.values()].map((active) => active.promise)));
			await Promise.all(loaded.map((state) => state.commitTail.catch(() => undefined)));
			if (owned) {
				const target = path.join(root, ".owner.lock");
				const current = await readRegularFile(root, target, true);
				if (current && (JSON.parse(current.toString("utf8")) as { token?: unknown }).token === owner) await unlink(target);
				owned = false;
			}
		})();
		return closePromise;
	}

	return { sourceRevisions, enqueue, list, cancel: (kb, id) => action(kb, id, false), retry: (kb, id) => action(kb, id, true), recover, close };
}

async function readSource(root: string, candidate: string): Promise<Buffer> {
	const info = await lstat(candidate);
	if (!info.isFile() || info.isSymbolicLink() || info.size === 0 || info.size > MAX_SOURCE_BYTES) throw invalid("素材必须非空且不超过 20 MiB");
	const bytes = await readRegularFile(root, candidate, false);
	if (!bytes || bytes.length === 0 || bytes.length > MAX_SOURCE_BYTES) throw invalid("素材必须非空且不超过 20 MiB");
	return bytes;
}

function publicJob(job: StoredJob): IngestJob {
	return IngestJobSchema.parse({ id: job.id, kbPath: job.kbPath, revision: job.revision, createdAt: job.createdAt, updatedAt: job.updatedAt,
		concurrency: job.concurrency, status: job.status, files: job.files.map(({ id, name, status, attempts, progressChars, outputPath, error }) => ({ id, name, status, attempts, progressChars, outputPath, error })) });
}
function parseDisk(raw: string, kbPath: string): DiskState {
	const disk = JSON.parse(raw) as DiskState;
	if (disk.version !== 1 || disk.kbPath !== kbPath || !Number.isFinite(disk.kbDev) || !Number.isFinite(disk.kbIno) || !Array.isArray(disk.jobs)) throw new Error("入库队列损坏，已保留原文件");
	const ids = new Set<string>();
	for (const job of disk.jobs) {
		publicJob(job);
		if (job.kbPath !== kbPath || ids.has(job.id)) throw new Error("入库队列损坏，已保留原文件");
		ids.add(job.id);
		if (job.model !== null) ModelRefSchema.parse(job.model);
		const fileIds = new Set<string>();
		for (const file of job.files) {
			if (!HASH.test(file.id) || !HASH.test(file.sourceHash) || !EXTENSIONS.has(file.extension) || typeof file.prepared !== "boolean" || fileIds.has(file.id)) throw new Error("入库队列损坏，已保留原文件");
			fileIds.add(file.id);
		}
	}
	return disk;
}
function findJob(state: QueueState, id: string): StoredJob { const job = state.jobs.find((value) => value.id === id); if (!job) throw new Error("入库任务不存在"); return job; }
function findFile(state: QueueState, jobId: string, id: string): StoredFile { const file = findJob(state, jobId).files.find((value) => value.id === id); if (!file) throw new Error("入库文件不存在"); return file; }
function touch(job: StoredJob): void {
	job.revision++; job.updatedAt = new Date().toISOString();
	job.status = ["committing", "running", "pending", "failed", "cancelled"].find((status) => job.files.some((file) => file.status === status)) as IngestJob["status"] ?? "completed";
}
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function forbidden(): Error { return Object.assign(new Error("路径不在已授权的知识库或素材目录内"), { code: "FORBIDDEN_PATH" }); }
function invalid(message: string): Error { return Object.assign(new Error(message), { code: "INVALID_REQUEST" }); }
function isTransient(error: unknown): boolean {
	const message = error instanceof Error ? error.message : "";
	const code = (error as { code?: unknown; status?: unknown })?.code;
	const status = Number((error as { status?: unknown; statusCode?: unknown })?.status ?? (error as { statusCode?: unknown })?.statusCode);
	if (/auth|api.?key|not configured|credential|401|403/i.test(message)) return false;
	return [408, 429, 500, 502, 503, 504].includes(status) || ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"].includes(String(code)) || /timeout|rate limit|temporarily unavailable|fetch failed/i.test(message);
}
function publicError(error: unknown): string {
	const code = (error as { code?: unknown })?.code;
	if (code === "CONFLICT") return "目标已被外部修改，入库已停止；请检查冲突后重试";
	if (code === "FORBIDDEN_PATH" || code === "KB_NOT_REGISTERED") return "知识库或素材路径已变化，请检查后重试";
	if (code === "PDF_EXTRACTION_REQUIRED") return "当前未配置 PDF 文本提取，请先转为 Markdown 或文本后重新入库";
	if (code === "SOURCE_TEXT_REQUIRED") return "素材不是有效的 UTF-8 文本，请先转换为非空 Markdown 或文本后重新入库";
	return isTransient(error) ? "模型服务暂时不可用，可稍后重试" : "入库失败，请检查模型配置、素材和磁盘后重试";
}
function delay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => { const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); }; const timer = setTimeout(finish, ms); signal.addEventListener("abort", finish, { once: true }); if (signal.aborted) finish(); });
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	let onAbort: () => void = () => undefined;
	try {
		return await Promise.race([promise, new Promise<T>((_resolve, reject) => {
			onAbort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) onAbort();
		})]);
	} finally { signal.removeEventListener("abort", onAbort); }
}
