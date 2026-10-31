import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { lstat } from "node:fs/promises";

import {
	CreateSourceCandidatesBodySchema, SourceCandidateSchema, SourceViewSchema, SourceDirectoryViewSchema,
	type CreateSourceCandidatesBody, type SourceCandidate, type SourceCandidateDetail,
	type SourceChangeCheck, type SourceDirectoryView, type SourceHistoryData,
	type SourceRevisionsData, type SourceVersion, type SourceVersionDetail, type SourceView,
} from "@llm-wiki/workbench-contracts";

import type { ModelRef } from "../config.js";
import { ensureSafeDirectory, readRegularFile, sha256Bytes } from "../graph-rename-safe-io.js";
import type { readInspectedMarkdownSources } from "../knowledge-bases.js";
import type { SourceRevisionGenerator } from "./revision-generator.js";
import { atomicWrite, readOptional } from "./storage.js";
import { inspectPublishedSource, publishSource, readPublishedSourceSummary } from "./publish.js";

const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9-]{36}$/;
const MAX_PREVIEW_BYTES = 128 * 1024;
const MAX_PREVIEW_LINES = 2000;

interface LegacyFile { id: string; name: string; extension: string; sourceHash: string; status: string; outputPath: string | null; canonicalPath?: string }
interface LegacyJob { id: string; createdAt: string; model: ModelRef | null; files: LegacyFile[] }
export interface RevisionContext {
	root: string; directory: string; kbPath: string; jobs: LegacyJob[];
	commit<T>(operation: () => Promise<T>): Promise<T>;
	checkBoundary(): Promise<void>;
}
export interface SourceRevisionsDeps {
	withContext<T>(kbPath: string, create: boolean, operation: (context: RevisionContext) => Promise<T>): Promise<T>;
	withPublication<T>(kbPath: string, operation: (context: RevisionContext) => Promise<T>): Promise<T>;
	scan: typeof readInspectedMarkdownSources;
	generate?: SourceRevisionGenerator;
	resolveModel?: () => Promise<ModelRef | null>;
	beforePublish?: (kbPath: string) => void;
	afterPublish?: (kbPath: string, changed: boolean) => void;
	afterPublicationWrite?: (relativePath: string) => void | Promise<void>;
	afterPublicationRead?: (relativePath: string) => void | Promise<void>;
}
interface StoredSource extends SourceView { canonicalPath: string | null; observedHash: string; legacyIds: string[] }
interface StoredVersion extends SourceVersion { inputId: string; inputExtension: string }
interface StoredCandidate extends SourceCandidate {
	inputId: string; inputHash: string; generatedHash: string | null; expectedSummaryHash: string | null;
	outputPath: string; rawPath: string; feedback?: string; relativePath: string; directoryId: string | null;
	canonicalPath: string | null; plannedVersionId: string; requestId: string;
}
interface StoredCheck extends SourceChangeCheck { scanId: string; paths: Record<string, string> }
interface Store {
	version: 1; kbPath: string; directories: SourceDirectoryView[]; sources: StoredSource[];
	versions: StoredVersion[]; candidates: StoredCandidate[]; checks: StoredCheck[];
	requests: Record<string, { fingerprint: string; ids: string[] }>;
}

export interface SourceRevisionsService {
	check(kbPath: string, scanId: string): Promise<SourceChangeCheck>;
	list(kbPath: string): Promise<SourceRevisionsData>;
	create(input: CreateSourceCandidatesBody): Promise<{ candidates: SourceCandidate[] }>;
	detail(kbPath: string, id: string): Promise<SourceCandidateDetail>;
	adopt(kbPath: string, id: string, expectedRevision: number): Promise<SourceCandidate>;
	cancel(kbPath: string, id: string, expectedRevision: number): Promise<SourceCandidate>;
	retry(kbPath: string, id: string, expectedRevision: number): Promise<SourceCandidate>;
	history(kbPath: string, id: string): Promise<SourceHistoryData>;
	version(kbPath: string, sourceIdOrVersionId: string, versionId?: string): Promise<SourceVersionDetail>;
	recover(kbPath: string): Promise<void>;
	inspectLegacyCompletion(context: RevisionContext, fileId: string): Promise<"valid" | "changed" | null>;
	findAdoptedCompletion(context: RevisionContext, fileId: string, sourceHash: string, canonicalPath?: string): Promise<{ outputPath: string; versionId: string } | null>;
	close(): Promise<void>;
}

/** Only fixed snapshots are used after candidate acceptance. No durable record grants source access. */
export function createSourceRevisions(deps: SourceRevisionsDeps): SourceRevisionsService {
	const stores = new Map<string, Store>();
	const active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
	let closing = false;
	async function load(ctx: RevisionContext): Promise<Store> {
		const cached = stores.get(ctx.kbPath);
		if (cached) return cached;
		const exists = await lstat(ctx.directory).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
		const raw = exists ? await readOptional(ctx.root, path.join(ctx.directory, "revisions.json")) : null;
		const store: Store = raw === null ? { version: 1, kbPath: ctx.kbPath, directories: [], sources: [], versions: [], candidates: [], checks: [], requests: {} } : JSON.parse(raw);
		if (store.version !== 1 || store.kbPath !== ctx.kbPath || ![store.directories, store.sources, store.versions, store.candidates, store.checks].every(Array.isArray) || !store.requests) throw conflict("素材版本记录损坏，原记录已保留");
		for (const source of store.sources) {
			SourceViewSchema.parse(publicSource(source));
			if (!HASH.test(source.id) || !UUID.test(source.currentVersionId) || !safeSummary(source.outputPath) || !Array.isArray(source.legacyIds) || source.legacyIds.some((id) => !HASH.test(id)) || !HASH.test(source.observedHash)) throw conflict("素材版本记录损坏，原记录已保留");
		}
		for (const directory of store.directories) SourceDirectoryViewSchema.parse(directory);
		for (const candidate of store.candidates) {
			publicCandidate(candidate);
			if (!HASH.test(candidate.inputId) || !HASH.test(candidate.inputHash) || !UUID.test(candidate.plannedVersionId)
				|| (candidate.generatedHash !== null && !HASH.test(candidate.generatedHash)) || !safeRaw(candidate.rawPath) || !safeSummary(candidate.outputPath)) throw conflict("素材版本记录损坏，原记录已保留");
		}
		for (const version of store.versions) if (!HASH.test(version.inputId) || !HASH.test(version.rawHash) || !HASH.test(version.summaryHash) || !UUID.test(version.id) || !safeRaw(version.rawPath) || !safeSummary(version.summaryPath) || ![".md", ".txt", ".pdf", ".html"].includes(version.inputExtension)) throw conflict("素材版本记录损坏，原记录已保留");
		for (const collection of [store.sources, store.versions, store.candidates, store.checks, store.directories]) {
			if (new Set(collection.map((item) => item.id)).size !== collection.length) throw conflict("素材版本记录损坏，原记录已保留");
		}
		for (const source of store.sources) if (!store.versions.some((version) => version.id === source.currentVersionId && version.sourceId === source.id)) throw conflict("素材版本记录损坏，原记录已保留");
		for (const version of store.versions) if (!store.sources.some((source) => source.id === version.sourceId)) throw conflict("素材版本记录损坏，原记录已保留");
		for (const candidate of store.candidates) if (["ready", "adopting", "adopted"].includes(candidate.status) && candidate.generatedHash === null || candidate.baseVersionId && !store.versions.some((version) => version.id === candidate.baseVersionId && version.sourceId === candidate.sourceId)) throw conflict("素材版本记录损坏，原记录已保留");
		stores.set(ctx.kbPath, store);
		return store;
	}
	async function save(ctx: RevisionContext, store: Store): Promise<void> {
		for (const part of ["revision-results", "revision-summaries", "revision-publications"]) await ensureSafeDirectory(ctx.root, path.join(ctx.directory, part));
		await atomicWrite(ctx.root, path.join(ctx.directory, "revisions.json"), `${JSON.stringify(store)}\n`);
	}
	async function mutate<T>(ctx: RevisionContext, store: Store, change: () => T): Promise<T> {
		const before = structuredClone(store);
		try { const result = change(); await save(ctx, store); return result; }
		catch (error) { stores.set(ctx.kbPath, before); throw error; }
	}
	const context = <T>(kb: string, create: boolean, operation: (ctx: RevisionContext, store: Store) => Promise<T>) => deps.withContext(kb, create, async (ctx) => operation(ctx, await load(ctx)));
	async function inputBytes(ctx: RevisionContext, id: string, extension = ".md"): Promise<Buffer> {
		if (!HASH.test(id) || ![".md", ".txt", ".pdf", ".html"].includes(extension)) throw conflict();
		const bytes = await readRegularFile(ctx.root, path.join(ctx.directory, "inputs", `${id}${extension}`), false);
		if (!bytes) throw conflict("素材快照缺失");
		return bytes;
	}
	async function versionBytes(ctx: RevisionContext, version: StoredVersion): Promise<{ raw: Buffer; summary: Buffer }> {
		const raw = await inputBytes(ctx, version.inputId, version.inputExtension);
		const summary = await readRegularFile(ctx.root, path.join(ctx.directory, "revision-summaries", `${version.id}.md`), false);
		if (sha256Bytes(raw) !== version.rawHash || !summary || sha256Bytes(summary) !== version.summaryHash) throw conflict("素材历史记录已变化");
		return { raw, summary };
	}
	async function registerLegacy(ctx: RevisionContext, store: Store, job: LegacyJob, file: LegacyFile, canonicalPath: string | null = file.canonicalPath ?? null): Promise<StoredSource> {
		if (file.status !== "completed" || !file.outputPath || ![".md", ".txt"].includes(file.extension)) throw invalid("只支持已完成的 Markdown 或文本素材");
		const existing = store.sources.find((source) => source.legacyIds.includes(file.id)
			|| store.versions.some((version) => version.sourceId === source.id && version.inputId === file.id));
		if (existing) {
			// Ordinary intake may have reused this managed publication rather than created a legacy journal.
			await verifyCurrentPublication(ctx, store, existing);
			return existing;
		}
		const rawPath = `raw/notes/${file.id}${file.extension}`;
		if (await inspectPublishedSource({ kbPath: ctx.kbPath, stateRoot: ctx.root, journalPath: path.join(ctx.directory, "publications", `${file.id}.json`), rawPath, outputPath: file.outputPath }) !== "valid") throw conflict("原入库产物已变化，请检查后重试");
		const proof = await readPublishedSourceSummary({ stateRoot: ctx.root, journalPath: path.join(ctx.directory, "publications", `${file.id}.json`), rawPath, outputPath: file.outputPath });
		const bytes = await inputBytes(ctx, file.id, file.extension);
		const summary = await readRegularFile(ctx.kbPath, path.join(ctx.kbPath, file.outputPath), false);
		if (!summary || sha256Bytes(summary) !== proof.hash || sha256Bytes(bytes) !== file.sourceHash || proof.rawHash !== file.sourceHash) throw conflict();
		const sourceId = canonicalPath ? hash(canonicalPath) : hash(`legacy:${file.id}`);
		const same = store.sources.find((source) => source.id === sourceId);
		const version: StoredVersion = { id: randomUUID(), sourceId, action: "added", rawHash: file.sourceHash, summaryHash: sha256Bytes(summary), rawPath,
			summaryPath: file.outputPath, model: job.model, createdAt: job.createdAt, inputId: file.id, inputExtension: file.extension };
		await ensureSafeDirectory(ctx.root, path.join(ctx.directory, "revision-summaries"));
		await atomicWrite(ctx.root, path.join(ctx.directory, "revision-summaries", `${version.id}.md`), summary);
		const source: StoredSource = same ?? { id: sourceId, kbPath: ctx.kbPath, directoryId: null, relativePath: file.name, name: file.name,
			currentVersionId: version.id, outputPath: file.outputPath, updatedAt: job.createdAt, canonicalPath, observedHash: file.sourceHash, legacyIds: [] };
		store.versions.push(version); source.legacyIds.push(file.id);
		if (!same) store.sources.push(source);
		// Callers enumerate legacy jobs chronologically. The latest verified completion is the baseline.
		if (job.createdAt >= source.updatedAt) { source.currentVersionId = version.id; source.outputPath = file.outputPath; source.updatedAt = job.createdAt; source.observedHash = file.sourceHash; }
		return source;
	}
	async function associate(ctx: RevisionContext, store: Store, canonical: string): Promise<StoredSource | undefined> {
		const found = store.sources.find((source) => source.canonicalPath === canonical);
		if (found) return found;
		let source: StoredSource | undefined;
		for (const job of [...ctx.jobs].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))) {
			for (const file of job.files) {
				if (file.status !== "completed" || file.extension !== ".md" || hash(`${canonical}\0${file.sourceHash}`) !== file.id) continue;
				source = store.sources.find((item) => item.legacyIds.includes(file.id)) ?? await registerLegacy(ctx, store, job, file, canonical);
				source.canonicalPath = canonical;
			}
		}
		return source;
	}
	async function check(kb: string, scanId: string): Promise<SourceChangeCheck> {
		const scan = await deps.scan(scanId);
		return context(kb, true, async (ctx, store) => {
			const directoryId = hash(scan.root);
			const now = new Date().toISOString();
			const checked: StoredCheck = { id: randomUUID(), kbPath: ctx.kbPath, directoryId, directoryPath: scan.root, createdAt: now,
				complete: scan.complete, warnings: scan.warnings, changes: [], scanId, paths: {} };
			const next = structuredClone(store);
			if (!next.directories.some((item) => item.id === directoryId)) next.directories.push({ id: directoryId, kbPath: ctx.kbPath, path: scan.root, createdAt: now });
			for (const file of scan.files) {
				const source = await associate(ctx, next, file.path);
				if (source) { source.directoryId = directoryId; source.relativePath = path.relative(scan.root, file.path).split(path.sep).join("/"); source.observedHash = file.hash; }
				const current = source ? findVersion(next, source.currentVersionId) : undefined;
				const id = randomUUID(); checked.paths[id] = file.path;
				checked.changes.push({ id, sourceId: source?.id ?? null, relativePath: path.relative(scan.root, file.path).split(path.sep).join("/"),
					kind: current ? current.rawHash === file.hash ? "unchanged" : "modified" : "added", baseVersionId: source?.currentVersionId ?? null, contentHash: file.hash });
				for (const candidate of next.candidates) if (candidate.canonicalPath === file.path && candidate.inputHash !== file.hash && ["pending", "generating", "ready", "failed", "cancelled"].includes(candidate.status)) stale(candidate);
			}
			if (scan.complete) for (const source of next.sources.filter((item) => item.directoryId === directoryId && item.canonicalPath && !scan.files.some((file) => file.path === item.canonicalPath))) {
				checked.changes.push({ id: randomUUID(), sourceId: source.id, relativePath: source.relativePath, kind: "deleted", baseVersionId: source.currentVersionId, contentHash: null });
				for (const candidate of next.candidates) if (candidate.sourceId === source.id && ["pending", "generating", "ready", "failed", "cancelled"].includes(candidate.status)) stale(candidate);
			}
			next.checks.unshift(checked);
			await save(ctx, next); stores.set(ctx.kbPath, next);
			for (const candidate of next.candidates) if (candidate.status === "stale") active.get(`${ctx.kbPath}\0${candidate.id}`)?.controller.abort();
			return publicCheck(checked);
		});
	}
	async function create(input: CreateSourceCandidatesBody): Promise<{ candidates: SourceCandidate[] }> {
		if (closing) throw busy();
		const request = CreateSourceCandidatesBodySchema.parse(input);
		const answer = await context(request.kbPath, true, async (ctx, store) => {
			const fingerprint = hash(JSON.stringify(request));
			const replay = store.requests[request.requestId];
			if (replay) {
				if (replay.fingerprint !== fingerprint) throw conflict("同一请求编号不能用于不同内容");
				return replay.ids.map((id) => publicCandidate(findCandidate(store, id)));
			}
			const next = structuredClone(store);
			const fixedModel = request.digestModel ?? await deps.resolveModel?.() ?? null;
			const selections: Array<{ source?: StoredSource; inputId: string; bytes: Buffer; name: string; kind: StoredCandidate["kind"]; canonical: string | null; relative: string; directoryId: string | null; extension: string }> = [];
			if (request.type === "changes") {
				const checked = next.checks.find((item) => item.id === request.checkId);
				if (!checked) throw missing();
				const scan = await deps.scan(checked.scanId);
				if (scan.root !== checked.directoryPath) throw conflict();
				for (const id of [...new Set(request.changeIds)]) {
					const change = checked.changes.find((item) => item.id === id);
					if (!change || !["added", "modified"].includes(change.kind)) throw invalid("只能为新增或修改的 Markdown 生成候选");
					const canonical = checked.paths[id];
					if (!canonical) throw conflict();
					const file = scan.files.find((item) => item.path === canonical && item.hash === change.contentHash);
					if (!file) throw conflict("来源内容已变化，请重新检查");
					const source = next.sources.find((item) => item.id === (change.sourceId ?? hash(canonical)));
					if (change.baseVersionId !== (source?.currentVersionId ?? null)) throw conflict("基础版本已变化，请重新检查");
					selections.push({ source, inputId: hash(`${canonical}\0${file.hash}`), bytes: file.bytes, name: path.basename(canonical), kind: change.kind as "added" | "modified", canonical, relative: change.relativePath, directoryId: checked.directoryId, extension: ".md" });
				}
			} else {
				let source: StoredSource;
				const target = request.target;
				if (target.type === "source") {
					const found = next.sources.find((item) => item.id === target.sourceId);
					if (!found) throw missing(); source = found;
					if (source.currentVersionId !== target.baseVersionId) throw conflict("基础版本已变化，请刷新后重新生成");
				} else {
					const job = ctx.jobs.find((item) => item.id === target.jobId);
					const file = job?.files.find((item) => item.id === target.fileId);
					if (!job || !file) throw missing();
					source = await registerLegacy(ctx, next, job, file);
					if (findVersion(next, source.currentVersionId).rawHash !== file.sourceHash) throw conflict("原任务已成为历史版本，请从当前素材重新生成");
				}
				const version = findVersion(next, source.currentVersionId);
				const bytes = (await versionBytes(ctx, version)).raw;
				selections.push({ source, inputId: version.inputId, bytes, name: source.name, kind: "regenerated", canonical: source.canonicalPath, relative: source.relativePath, directoryId: source.directoryId, extension: version.inputExtension });
			}
			const created: StoredCandidate[] = [];
			for (const selection of selections) {
				const { source, bytes } = selection;
				const base = source ? findVersion(next, source.currentVersionId) : null;
				if (source) {
					const current = await readRegularFile(ctx.kbPath, path.join(ctx.kbPath, source.outputPath), true);
					if (!current || sha256Bytes(current) !== base!.summaryHash) throw conflict("正式摘要已被外部修改，请先核对");
				}
				await atomicWrite(ctx.root, path.join(ctx.directory, "inputs", `${selection.inputId}${selection.extension}`), bytes);
				const now = new Date().toISOString();
				created.push({ id: randomUUID(), kbPath: ctx.kbPath, sourceId: source?.id ?? hash(selection.canonical!), name: selection.name, kind: selection.kind,
					status: "pending", revision: 1, baseVersionId: source?.currentVersionId ?? null, adoptedVersionId: null, model: fixedModel,
					createdAt: now, updatedAt: now, error: null, progressChars: 0, attempts: 0, inputId: selection.inputId, inputHash: sha256Bytes(bytes),
					generatedHash: null, expectedSummaryHash: base?.summaryHash ?? null, outputPath: source?.outputPath ?? `wiki/sources/${selection.inputId}.md`,
					rawPath: selection.kind === "regenerated" ? base!.rawPath : `raw/notes/${selection.inputId}.md`, feedback: request.feedback,
					relativePath: selection.relative, directoryId: selection.directoryId, canonicalPath: selection.canonical, plannedVersionId: randomUUID(), requestId: request.requestId });
			}
			next.candidates.unshift(...created); next.requests[request.requestId] = { fingerprint, ids: created.map((item) => item.id) };
			await save(ctx, next); stores.set(ctx.kbPath, next);
			return created.map(publicCandidate);
		});
		for (const candidate of answer) schedule(candidate.kbPath, candidate.id);
		return { candidates: answer };
	}
	function schedule(kb: string, id: string): void {
		const key = `${kb}\0${id}`;
		if (closing || active.has(key) || active.size >= 5) return;
		const controller = new AbortController();
		const promise = generate(kb, id, controller.signal).finally(() => {
			active.delete(key);
			queueMicrotask(() => {
				if (closing) return;
				for (const [library, store] of stores) for (const candidate of [...store.candidates].reverse()) if (candidate.status === "pending") schedule(library, candidate.id);
			});
		});
		active.set(key, { controller, promise });
	}
	async function generate(kb: string, id: string, signal: AbortSignal): Promise<void> {
		try {
			const fixed = await context(kb, true, async (ctx, store) => {
				const candidate = findCandidate(store, id);
				if (candidate.status !== "pending" || signal.aborted) return null;
				const extension = path.extname(candidate.rawPath);
				const bytes = await inputBytes(ctx, candidate.inputId, extension);
				if (sha256Bytes(bytes) !== candidate.inputHash) throw conflict("素材快照已变化");
				const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
				await mutate(ctx, store, () => { candidate.status = "generating"; candidate.attempts++; touch(candidate); });
				return { text, name: candidate.name, modelRef: candidate.model ?? undefined, feedback: candidate.feedback };
			});
			if (!fixed || signal.aborted) return;
			if (!deps.generate) throw invalid("摘要生成器不可用");
			const generated = await abortable(deps.generate({ ...fixed, signal, onProgress: (chars) => {
				const live = stores.get(kb)?.candidates.find((item) => item.id === id);
				if (live?.status === "generating" && !signal.aborted) live.progressChars = Math.max(live.progressChars, Math.floor(Math.max(0, chars)));
			} }), signal);
			if (signal.aborted) return;
			if (!generated.trim() || Buffer.byteLength(generated) > 2 * 1024 * 1024) throw invalid("模型未生成有效摘要");
			await context(kb, true, async (ctx, store) => {
				const candidate = findCandidate(store, id);
				if (candidate.status !== "generating" || signal.aborted) return;
				await atomicWrite(ctx.root, path.join(ctx.directory, "revision-results", `${id}.md`), generated);
				await mutate(ctx, store, () => { candidate.generatedHash = hash(generated); candidate.status = baseCurrent(store, candidate) ? "ready" : "stale"; touch(candidate); });
			});
		} catch {
			if (signal.aborted || closing) return;
			await context(kb, true, async (ctx, store) => {
				const candidate = findCandidate(store, id);
				if (!["pending", "generating"].includes(candidate.status)) return;
				await mutate(ctx, store, () => { candidate.status = "failed"; candidate.error = "摘要生成失败，请检查模型配置、素材和磁盘后重试"; touch(candidate); });
			}).catch(() => undefined);
		}
	}
	async function publish(kb: string, id: string): Promise<SourceCandidate> {
		return deps.withPublication(kb, async (ctx) => {
			const canonicalKb = ctx.kbPath;
			const store = await load(ctx);
			const candidate = findCandidate(store, id);
			if (candidate.status === "adopted") return publicCandidate(candidate);
			if (candidate.status !== "adopting") throw conflict();
			const savedPublication = await readOptional(ctx.root, path.join(ctx.directory, "revision-publications", `${id}.json`));
			const source = store.sources.find((item) => item.id === candidate.sourceId);
			if ((source?.currentVersionId ?? null) !== candidate.baseVersionId || savedPublication === null && !baseCurrent(store, candidate)) {
				// An existing journal is a prior adoption decision. New observations cannot discard a partial commit.
				if (savedPublication === null) await mutate(ctx, store, () => stale(candidate));
				throw conflict("基础版本已变化，请重新生成");
			}
			const bytes = await inputBytes(ctx, candidate.inputId, path.extname(candidate.rawPath));
			const generated = await readRegularFile(ctx.root, path.join(ctx.directory, "revision-results", `${id}.md`), false);
			if (sha256Bytes(bytes) !== candidate.inputHash || !generated || sha256Bytes(generated) !== candidate.generatedHash) throw conflict("候选快照已变化");
			await ctx.checkBoundary();
			deps.beforePublish?.(canonicalKb);
			try {
				const proof = await publishSource({ kbPath: canonicalKb, stateRoot: ctx.root, journalPath: path.join(ctx.directory, "revision-publications", `${id}.json`),
					fileId: hash(`revision:${id}`), name: candidate.name, rawPath: candidate.rawPath, outputPath: candidate.outputPath,
					bytes, generated: generated.toString("utf8"), createdAt: candidate.createdAt, operation: "revision", expectedSummaryHash: candidate.expectedSummaryHash,
					afterWrite: deps.afterPublicationWrite, afterReadShared: deps.afterPublicationRead });
				if (await inspectPublishedSource({ kbPath: canonicalKb, stateRoot: ctx.root, journalPath: path.join(ctx.directory, "revision-publications", `${id}.json`), rawPath: candidate.rawPath, outputPath: candidate.outputPath }) !== "valid") throw conflict();
				const summary = await readRegularFile(canonicalKb, path.join(canonicalKb, candidate.outputPath), false);
				if (!summary || sha256Bytes(summary) !== proof.hash || proof.rawHash !== candidate.inputHash) throw conflict();
				const version: StoredVersion = { id: candidate.plannedVersionId, sourceId: candidate.sourceId!, action: candidate.kind,
					rawHash: candidate.inputHash, summaryHash: proof.hash, rawPath: candidate.rawPath, summaryPath: candidate.outputPath,
					model: candidate.model, createdAt: candidate.updatedAt, inputId: candidate.inputId, inputExtension: path.extname(candidate.rawPath) };
				await atomicWrite(ctx.root, path.join(ctx.directory, "revision-summaries", `${version.id}.md`), proof.bytes);
				await mutate(ctx, store, () => {
					if (!store.versions.some((item) => item.id === version.id)) store.versions.push(version);
					let source = store.sources.find((item) => item.id === candidate.sourceId);
					if (!source) {
						source = { id: candidate.sourceId!, kbPath: canonicalKb, directoryId: candidate.directoryId, relativePath: candidate.relativePath, name: candidate.name,
							currentVersionId: version.id, outputPath: candidate.outputPath, updatedAt: version.createdAt, canonicalPath: candidate.canonicalPath,
							observedHash: candidate.inputHash, legacyIds: [] };
						store.sources.push(source);
					}
					source.currentVersionId = version.id; source.updatedAt = version.createdAt;
					candidate.status = "adopted"; candidate.adoptedVersionId = version.id; candidate.error = null; touch(candidate);
					for (const other of store.candidates) if (other.id !== id && other.sourceId === candidate.sourceId && ["pending", "generating", "ready", "failed", "cancelled"].includes(other.status)) stale(other);
				});
				for (const other of store.candidates) if (other.status === "stale") active.get(`${canonicalKb}\0${other.id}`)?.controller.abort();
				return publicCandidate(candidate);
			} finally { deps.afterPublish?.(canonicalKb, true); }
		});
	}
	async function adopt(kb: string, id: string, expectedRevision: number): Promise<SourceCandidate> {
		await recover(kb);
		await context(kb, true, async (ctx, store) => {
			const candidate = findCandidate(store, id);
			// Replaying a completed adoption is safe even after its revision advances.
			if (candidate.status === "adopted") return;
			assertRevision(candidate, expectedRevision);
			if (candidate.status !== "ready") throw conflict("只有待确认候选可以采用");
			if (!baseCurrent(store, candidate)) { await mutate(ctx, store, () => stale(candidate)); throw conflict("基础版本已变化，请重新生成"); }
			await mutate(ctx, store, () => { candidate.status = "adopting"; candidate.error = null; touch(candidate); });
		});
		try { return await publish(kb, id); }
		catch (error) {
			await context(kb, true, async (ctx, store) => {
				const candidate = findCandidate(store, id);
				if (candidate.status !== "adopting") return;
				// Once a journal exists, forward recovery must finish that exact result without a model call.
				const journal = await readOptional(ctx.root, path.join(ctx.directory, "revision-publications", `${id}.json`));
				await mutate(ctx, store, () => {
					if (journal === null && ["CONFLICT", "FORBIDDEN_PATH"].includes((error as { code?: string }).code ?? "")) stale(candidate);
					else { candidate.error = "保存尚未完成，恢复时将继续同一提交；现有内容已保留"; touch(candidate); }
				});
			}).catch(() => undefined);
			throw error;
		}
	}
	async function action(kb: string, id: string, expectedRevision: number, retry: boolean): Promise<SourceCandidate> {
		if (closing) throw busy();
		const result = await context(kb, true, async (ctx, store) => {
			const candidate = findCandidate(store, id);
			assertRevision(candidate, expectedRevision);
			if (retry && !["failed", "cancelled"].includes(candidate.status)) throw conflict("当前候选不能重试");
			if (!retry && ["adopting", "adopted"].includes(candidate.status)) throw conflict("保存已经开始，不能取消");
			if (!baseCurrent(store, candidate)) { await mutate(ctx, store, () => stale(candidate)); throw conflict("基础版本已变化，请重新生成"); }
			await mutate(ctx, store, () => { candidate.status = retry ? "pending" : "cancelled"; candidate.error = null; candidate.progressChars = 0; touch(candidate); });
			return publicCandidate(candidate);
		});
		if (retry) schedule(result.kbPath, id);
		else active.get(`${result.kbPath}\0${id}`)?.controller.abort();
		return result;
	}
	async function list(kb: string): Promise<SourceRevisionsData> {
		return context(kb, false, async (_ctx, store) => ({ directories: store.directories.map((item) => ({ ...item })), sources: store.sources.map(publicSource), candidates: store.candidates.map(publicCandidate) }));
	}
	async function detail(kb: string, id: string): Promise<SourceCandidateDetail> {
		return context(kb, false, async (ctx, store) => {
			const candidate = findCandidate(store, id);
			const base = candidate.baseVersionId ? await versionBytes(ctx, findVersion(store, candidate.baseVersionId)) : null;
			const raw = await inputBytes(ctx, candidate.inputId, path.extname(candidate.rawPath));
			if (sha256Bytes(raw) !== candidate.inputHash) throw conflict();
			const generated = await readRegularFile(ctx.root, path.join(ctx.directory, "revision-results", `${id}.md`), true);
			if (generated && candidate.generatedHash && sha256Bytes(generated) !== candidate.generatedHash) throw conflict();
			const pieces = [base?.raw ?? null, raw, base?.summary ?? null, generated].map(preview);
			return { candidate: publicCandidate(candidate), original: { before: pieces[0]!.value, after: pieces[1]!.value }, summary: { before: pieces[2]!.value, after: pieces[3]!.value }, truncated: pieces.some((piece) => piece.truncated) };
		});
	}
	async function history(kb: string, id: string): Promise<SourceHistoryData> {
		return context(kb, false, async (_ctx, store) => {
			const source = store.sources.find((item) => item.id === id);
			if (!source) throw missing();
			return { source: publicSource(source), versions: store.versions.filter((item) => item.sourceId === id).map(publicVersion) };
		});
	}
	async function version(kb: string, sourceId: string, versionId?: string): Promise<SourceVersionDetail> {
		return context(kb, false, async (ctx, store) => {
			const version = findVersion(store, versionId ?? sourceId);
			if (versionId && version.sourceId !== sourceId || !store.sources.some((source) => source.id === version.sourceId)) throw missing();
			const bytes = await versionBytes(ctx, version);
			const raw = preview(bytes.raw); const summary = preview(bytes.summary);
			return { version: publicVersion(version), original: raw.value!, summary: summary.value!, truncated: raw.truncated || summary.truncated };
		});
	}
	async function recover(kb: string): Promise<void> {
		const hasWork = await context(kb, false, async (_ctx, store) => store.candidates.some((candidate) => ["pending", "generating", "adopting"].includes(candidate.status)));
		if (!hasWork) return;
		// Recovery is a mutation and must acquire the same process owner as ordinary intake.
		const work = await context(kb, true, async (ctx, store) => {
			const resumable = store.candidates.filter((candidate) => ["pending", "generating", "adopting"].includes(candidate.status));
			if (resumable.some((candidate) => candidate.status === "generating" && !active.has(`${ctx.kbPath}\0${candidate.id}`))) await mutate(ctx, store, () => { for (const candidate of resumable) if (candidate.status === "generating" && !active.has(`${ctx.kbPath}\0${candidate.id}`)) { candidate.status = "pending"; touch(candidate); } });
			return resumable.map((item) => ({ id: item.id, status: item.status, kbPath: ctx.kbPath }));
		});
		for (const item of work) {
			if (item.status !== "adopting") { schedule(item.kbPath, item.id); continue; }
			try { await publish(kb, item.id); }
			catch (error) {
				await context(kb, true, async (ctx, store) => {
					const candidate = findCandidate(store, item.id);
					if (candidate.status !== "adopting") return;
					await mutate(ctx, store, () => { candidate.error = "保存恢复遇到内容冲突或磁盘错误，请核对正式文件；已有提交和历史已保留"; touch(candidate); });
				}).catch(() => undefined);
				throw error;
			}
		}
	}

	async function verifyCurrentPublication(ctx: RevisionContext, store: Store, source: StoredSource): Promise<StoredVersion> {
		const current = findVersion(store, source.currentVersionId);
		await versionBytes(ctx, current);
		const candidate = store.candidates.find((item) => item.status === "adopted" && item.adoptedVersionId === current.id && item.sourceId === source.id);
		const journalPath = candidate
			? path.join(ctx.directory, "revision-publications", `${candidate.id}.json`)
			: source.legacyIds.includes(current.inputId) ? path.join(ctx.directory, "publications", `${current.inputId}.json`) : null;
		if (!journalPath || current.summaryPath !== source.outputPath) throw conflict("当前采用版本缺少可验证的发布记录");
		const proof = await readPublishedSourceSummary({ stateRoot: ctx.root, journalPath, rawPath: current.rawPath, outputPath: source.outputPath });
		if (proof.rawHash !== current.rawHash || proof.hash !== current.summaryHash) throw conflict("当前采用版本的发布记录已变化");
		const raw = await readRegularFile(ctx.kbPath, path.join(ctx.kbPath, current.rawPath), false);
		const summary = await readRegularFile(ctx.kbPath, path.join(ctx.kbPath, source.outputPath), false);
		if (!raw || sha256Bytes(raw) !== current.rawHash || !summary || sha256Bytes(summary) !== proof.hash) throw conflict("已采用原文或正式摘要已被外部修改");
		return current;
	}
	async function findAdoptedCompletion(ctx: RevisionContext, fileId: string, sourceHash: string, canonicalPath?: string): Promise<{ outputPath: string; versionId: string } | null> {
		const store = await load(ctx);
		const source = store.sources.find((item) => canonicalPath && item.canonicalPath === canonicalPath
			|| store.versions.some((version) => version.sourceId === item.id && version.inputId === fileId));
		if (!source) return null;
		const current = findVersion(store, source.currentVersionId);
		if (canonicalPath && source.canonicalPath && canonicalPath !== source.canonicalPath || current.inputId !== fileId || current.rawHash !== sourceHash) {
			throw conflict("来源已有采用版本；内容变化请通过 Markdown 变化检查生成候选");
		}
		try { await verifyCurrentPublication(ctx, store, source); }
		catch { throw conflict("已采用内容、历史快照或发布记录已变化，请核对后重试"); }
		return { outputPath: source.outputPath, versionId: current.id };
	}
	async function inspectLegacyCompletion(ctx: RevisionContext, fileId: string): Promise<"valid" | "changed" | null> {
		const store = await load(ctx);
		const source = store.sources.find((item) => item.legacyIds.includes(fileId) || store.versions.some((version) => version.sourceId === item.id && version.inputId === fileId));
		if (!source) return null;
		try {
			const version = store.versions.find((item) => item.sourceId === source.id && item.inputId === fileId);
			if (!version) return "changed";
			await versionBytes(ctx, version);
			const raw = await readRegularFile(ctx.kbPath, path.join(ctx.kbPath, version.rawPath), false);
			if (!raw || sha256Bytes(raw) !== version.rawHash) return "changed";
			await verifyCurrentPublication(ctx, store, source);
			return "valid";
		} catch { return "changed"; }
	}

	async function close(): Promise<void> {
		closing = true;
		for (const { controller } of active.values()) controller.abort();
		await Promise.allSettled([...active.values()].map((value) => value.promise));
	}
	return { check, list, create, detail, adopt, cancel: (kb, id, revision) => action(kb, id, revision, false), retry: (kb, id, revision) => action(kb, id, revision, true), history, version, recover, inspectLegacyCompletion, findAdoptedCompletion, close };
}

function baseCurrent(store: Store, candidate: StoredCandidate): boolean {
	const source = store.sources.find((item) => item.id === candidate.sourceId);
	return (source?.currentVersionId ?? null) === candidate.baseVersionId && (!source || source.observedHash === candidate.inputHash);
}
function publicCandidate(candidate: StoredCandidate): SourceCandidate {
	const { id, kbPath, sourceId, name, kind, status, revision, baseVersionId, adoptedVersionId, model, createdAt, updatedAt, error, progressChars, attempts } = candidate;
	return SourceCandidateSchema.parse({ id, kbPath, sourceId, name, kind, status, revision, baseVersionId, adoptedVersionId, model, createdAt, updatedAt, error, progressChars, attempts });
}
function publicSource(source: StoredSource): SourceView {
	const { id, kbPath, directoryId, relativePath, name, currentVersionId, outputPath, updatedAt } = source;
	return { id, kbPath, directoryId, relativePath, name, currentVersionId, outputPath, updatedAt };
}
function publicVersion(version: StoredVersion): SourceVersion {
	const { id, sourceId, action, rawHash, summaryHash, rawPath, summaryPath, model, createdAt } = version;
	return { id, sourceId, action, rawHash, summaryHash, rawPath, summaryPath, model, createdAt };
}
function publicCheck(checked: StoredCheck): SourceChangeCheck { const { scanId: _scanId, paths: _paths, ...result } = checked; return result; }
function findVersion(store: Store, id: string): StoredVersion { const result = store.versions.find((item) => item.id === id); if (!result) throw missing(); return result; }
function findCandidate(store: Store, id: string): StoredCandidate { const result = store.candidates.find((item) => item.id === id); if (!result) throw missing(); return result; }
function assertRevision(candidate: StoredCandidate, revision: number): void { if (candidate.revision !== revision) throw conflict("候选状态已变化，请刷新后重试"); }
function touch(candidate: StoredCandidate): void { candidate.revision++; candidate.updatedAt = new Date().toISOString(); }
function stale(candidate: StoredCandidate): void { candidate.status = "stale"; candidate.error = "来源或基础版本已变化，请重新检查并生成候选"; touch(candidate); }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function safeRaw(value: string): boolean { return /^raw\/(?:notes|pdfs)\/[a-f0-9]{64}\.(?:md|txt|pdf|html)$/.test(value); }
function safeSummary(value: string): boolean { return /^wiki\/sources\/[a-f0-9]{64}\.md$/.test(value); }
function conflict(message = "素材版本或正式内容已变化，请核对后重试"): Error { return Object.assign(new Error(message), { code: "CONFLICT" }); }
function missing(): Error { return Object.assign(new Error("素材版本或候选不存在"), { code: "NOT_FOUND" }); }
function invalid(message: string): Error { return Object.assign(new Error(message), { code: "INVALID_REQUEST" }); }
function busy(): Error { return Object.assign(new Error("服务正在关闭"), { code: "BUSY" }); }
function preview(bytes: Buffer | null): { value: { text: string; hash: string } | null; truncated: boolean } {
	if (!bytes) return { value: null, truncated: false };
	const prefix = bytes.subarray(0, MAX_PREVIEW_BYTES).toString("utf8");
	const lines = prefix.split("\n");
	return { value: { text: lines.slice(0, MAX_PREVIEW_LINES).join("\n"), hash: sha256Bytes(bytes) }, truncated: bytes.length > MAX_PREVIEW_BYTES || lines.length > MAX_PREVIEW_LINES };
}
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	let listener: () => void = () => undefined;
	try { return await Promise.race([promise, new Promise<T>((_resolve, reject) => { listener = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })); signal.addEventListener("abort", listener, { once: true }); if (signal.aborted) listener(); })]); }
	finally { signal.removeEventListener("abort", listener); }
}
