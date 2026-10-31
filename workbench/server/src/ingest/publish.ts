import { randomUUID } from "node:crypto";
import { lstat, open, rename, unlink } from "node:fs/promises";
import path from "node:path";

import {
	assertParentBoundary, assertSafePath, captureParentBoundary, ensureSafeDirectory,
	linkNoReplace, readRegularFile, sha256Bytes,
} from "../graph-rename-safe-io.js";
import { atomicWrite, readOptional, syncDirectory } from "./storage.js";

interface PublicationWrite {
	path: string;
	before: string | null;
	after: string;
	bytes: string;
	temporary: string;
	guard: string;
}
interface Publication { version: 1; writes: PublicationWrite[] }

export async function inspectPublishedSource(input: {
	kbPath: string; stateRoot: string; journalPath: string; rawPath: string; outputPath: string;
}): Promise<"valid" | "missing" | "changed"> {
	try {
		const saved = await readOptional(input.stateRoot, input.journalPath);
		if (saved === null) return "changed";
		const publication = parsePublication(saved);
		assertExpectedPaths(publication, input.rawPath, input.outputPath);
		let missing = false;
		for (const relative of [input.rawPath, input.outputPath]) {
			const write = publication.writes.find((item) => item.path === relative)!;
			const current = await readRegularFile(input.kbPath, path.join(input.kbPath, relative), true).catch((error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return null;
				throw error;
			});
			if (!current) missing = true;
			else if (sha256Bytes(current) !== write.after) return "changed";
		}
		return missing ? "missing" : "valid";
	} catch { return "changed"; }
}

export interface PublishInput {
	kbPath: string;
	stateRoot: string;
	journalPath: string;
	fileId: string;
	name: string;
	rawPath: string;
	outputPath: string;
	bytes: Buffer;
	generated: string;
	createdAt: string;
	afterWrite?: (relativePath: string) => void | Promise<void>;
	afterReadShared?: (relativePath: string) => void | Promise<void>;
	allowMetadataRebase?: boolean;
	/** Explicit compare-and-swap authorization for a reviewed summary update. */
	expectedSummaryHash?: string | null;
	operation?: "revision";
}

/** A durable write-set is replayed forward; unknown external versions are never replaced. */
export async function publishSource(input: PublishInput): Promise<{ bytes: Buffer; hash: string; rawHash: string }> {
	const saved = await readOptional(input.stateRoot, input.journalPath);
	let publication: Publication;
	if (saved !== null) {
		publication = parsePublication(saved);
	} else {
		const date = input.createdAt.slice(0, 10);
		const title = input.name.replace(/[\r\n]/g, " ");
		const marker = `<!-- reliable-ingest:${input.fileId} -->`;
		const generated = input.generated.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
		const source = ["---", "tags: [素材摘要]", `created: ${date}`, `updated: ${date}`,
			`sources: []`, `source_type: ${path.extname(input.name).toLowerCase() === ".pdf" ? "PDF" : "笔记"}`,
			`source_path: ${input.rawPath}`, "images: 0", "image_paths: []", "---", "",
			`# ${title}`, "", `原文位置：${input.rawPath}`, "", marker, "", generated, ""].join("\n");
		const desired: Array<[string, Buffer, Buffer | null | undefined]> = [[input.rawPath, input.bytes, undefined], [input.outputPath, Buffer.from(source), undefined]];
		for (const [relative, addition] of [
			["index.md", `- [[${input.outputPath.replace(/\.md$/, "")}]] — ${title} ${marker}\n`],
			["log.md", `\n- ${date} ${input.operation === "revision" ? "采用素材版本" : "入库"}：${title} → [[${input.outputPath.replace(/\.md$/, "")}]] ${marker}\n`],
		] as const) {
			const current = await readRegularFile(input.kbPath, path.join(input.kbPath, relative), true);
			await input.afterReadShared?.(relative);
			const text = current?.toString("utf8") ?? (relative === "index.md" ? "# 知识库索引\n\n" : "# 操作日志\n");
			desired.push([relative, Buffer.from(text.includes(marker) || relative === "index.md" && input.operation === "revision" && text.includes(`[[${input.outputPath.replace(/\.md$/, "")}]]`) ? text : `${text}${text.endsWith("\n") ? "" : "\n"}${addition}`), current]);
		}
		publication = { version: 1, writes: [] };
		for (const [relative, bytes, original] of desired) {
			await ensureSafeDirectory(input.kbPath, path.dirname(path.join(input.kbPath, relative)));
			const target = path.join(input.kbPath, relative);
			const current = original === undefined ? await readRegularFile(input.kbPath, target, true) : original;
			if (relative === input.outputPath && input.expectedSummaryHash !== undefined) {
				if ((current ? sha256Bytes(current) : null) !== input.expectedSummaryHash) throw conflict();
			} else if ((relative === input.rawPath || relative === input.outputPath) && current && !current.equals(bytes)) throw conflict();
			const token = randomUUID();
			publication.writes.push({ path: relative, before: current ? sha256Bytes(current) : null,
				after: sha256Bytes(bytes), bytes: bytes.toString("base64"),
				temporary: `.ingest-${token}.prepared`, guard: `.ingest-${token}.previous` });
		}
		await atomicWrite(input.stateRoot, input.journalPath, `${JSON.stringify(publication)}\n`);
	}
	assertExpectedPaths(publication, input.rawPath, input.outputPath);
	if (saved && input.allowMetadataRebase) {
		let rebased = false;
		for (const write of publication.writes.filter((item) => [input.rawPath, input.outputPath].includes(item.path))) {
			const target = path.join(input.kbPath, write.path);
			await ensureSafeDirectory(input.kbPath, path.dirname(target));
			const current = await readRegularFile(input.kbPath, target, true);
			const previous = await readRegularFile(input.kbPath, path.join(path.dirname(target), write.guard), true);
			if (!current && !previous && write.before !== null) { write.before = null; rebased = true; }
		}
		for (const write of publication.writes.filter((item) => ["index.md", "log.md"].includes(item.path))) {
			const target = path.join(input.kbPath, write.path);
			const current = await readRegularFile(input.kbPath, target, true);
			if (!current || [write.before, write.after].includes(sha256Bytes(current))) continue;
			const marker = `<!-- reliable-ingest:${input.fileId} -->`;
			const addition = Buffer.from(write.bytes, "base64").toString("utf8").split("\n").find((line) => line.includes(marker));
			if (!addition) throw new Error("入库索引恢复记录缺少任务标记");
			await removeOwned(input.kbPath, path.join(path.dirname(target), write.temporary), write.after);
			if (write.before !== null) await removeOwned(input.kbPath, path.join(path.dirname(target), write.guard), write.before);
			const text = current.toString("utf8");
			const after = Buffer.from(text.includes(marker) ? text : `${text}${text.endsWith("\n") ? "" : "\n"}${addition}\n`);
			write.before = sha256Bytes(current); write.after = sha256Bytes(after); write.bytes = after.toString("base64");
			const token = randomUUID(); write.temporary = `.ingest-${token}.prepared`; write.guard = `.ingest-${token}.previous`;
			rebased = true;
		}
		if (rebased) await atomicWrite(input.stateRoot, input.journalPath, `${JSON.stringify(publication)}\n`);
	}
	for (const write of publication.writes) { await applyWrite(input.kbPath, write); await input.afterWrite?.(write.path); }
	return summaryProof(publication, input.rawPath, input.outputPath);
}

/** Journal bytes, rather than a later mutable filesystem read, define the approved version. */
export async function readPublishedSourceSummary(input: {
	stateRoot: string; journalPath: string; rawPath: string; outputPath: string;
}): Promise<{ bytes: Buffer; hash: string; rawHash: string }> {
	const raw = await readOptional(input.stateRoot, input.journalPath);
	if (!raw) throw conflict();
	const publication = parsePublication(raw);
	assertExpectedPaths(publication, input.rawPath, input.outputPath);
	return summaryProof(publication, input.rawPath, input.outputPath);
}
function summaryProof(publication: Publication, rawPath: string, outputPath: string): { bytes: Buffer; hash: string; rawHash: string } {
	const summary = publication.writes.find((item) => item.path === outputPath)!;
	return { bytes: Buffer.from(summary.bytes, "base64"), hash: summary.after, rawHash: publication.writes.find((item) => item.path === rawPath)!.after };
}

function parsePublication(raw: string): Publication {
	const value = JSON.parse(raw) as Publication;
	if (value.version !== 1 || !Array.isArray(value.writes) || value.writes.length !== 4) throw new Error("入库提交记录损坏，已保留记录");
	for (const write of value.writes) {
		if (typeof write.path !== "string" || path.isAbsolute(write.path) || write.path.split(/[\\/]/).includes("..")
			|| !/^(raw\/(?:pdfs|notes)\/[a-f0-9]{64}\.(?:md|txt|pdf|html)|wiki\/sources\/[a-f0-9]{64}\.md|index\.md|log\.md)$/.test(write.path)
			|| !/^[a-f0-9]{64}$/.test(write.after) || (write.before !== null && !/^[a-f0-9]{64}$/.test(write.before))
			|| !/^\.ingest-[a-f0-9-]+\.prepared$/.test(write.temporary) || !/^\.ingest-[a-f0-9-]+\.previous$/.test(write.guard)
			|| typeof write.bytes !== "string" || sha256Bytes(Buffer.from(write.bytes, "base64")) !== write.after) throw new Error("入库提交记录损坏，已保留记录");
	}
	return value;
}

function assertExpectedPaths(publication: Publication, rawPath: string, outputPath: string): void {
	const expected = new Set([rawPath, outputPath, "index.md", "log.md"]);
	if (new Set(publication.writes.map((write) => write.path)).size !== expected.size || publication.writes.some((write) => !expected.has(write.path))) throw new Error("入库提交记录与任务不匹配");
}

async function applyWrite(root: string, write: PublicationWrite): Promise<void> {
	const target = path.join(root, write.path);
	await ensureSafeDirectory(root, path.dirname(target));
	const boundary = await captureParentBoundary(root, target);
	const temporary = path.join(path.dirname(target), write.temporary);
	const guard = path.join(path.dirname(target), write.guard);
	let current = await readRegularFile(root, target, true);
	const previous = await readRegularFile(root, guard, true);
	if (current && sha256Bytes(current) === write.after) {
		if (previous && sha256Bytes(previous) !== write.before) throw conflict();
		// The published hard link must be durable before either recovery copy is removed.
		await syncDirectory(path.dirname(target));
		await removeOwned(root, temporary, write.after);
		if (previous) await unlink(guard);
		await syncDirectory(path.dirname(target));
		return;
	}
	if (current && sha256Bytes(current) !== write.before) throw conflict();
	if (!current && write.before !== null && (!previous || sha256Bytes(previous) !== write.before)) throw conflict();
	if (previous && sha256Bytes(previous) !== write.before) throw conflict();
	const staged = await readRegularFile(root, temporary, true);
	if (staged && sha256Bytes(staged) !== write.after) throw conflict();
	if (!staged) {
		const handle = await open(await assertSafePath(root, temporary, true), "wx", 0o600);
		try { await handle.writeFile(Buffer.from(write.bytes, "base64")); await handle.sync(); }
		finally { await handle.close(); }
	}
	await assertParentBoundary(root, target, boundary);
	if (current) {
		if (previous) throw conflict();
		const latest = await readRegularFile(root, target, false);
		if (!latest || sha256Bytes(latest) !== write.before) throw conflict();
		await rename(target, guard);
		await syncDirectory(path.dirname(target));
		const guarded = await readRegularFile(root, guard, false);
		if (!guarded || sha256Bytes(guarded) !== write.before) {
			if (!(await lstat(target).catch(() => null))) { await linkNoReplace(guard, target); await syncDirectory(path.dirname(target)); }
			throw conflict();
		}
	}
	await assertParentBoundary(root, target, boundary);
	current = await readRegularFile(root, target, true);
	if (current) throw conflict();
	await linkNoReplace(temporary, target);
	await syncDirectory(path.dirname(target));
	await unlink(temporary);
	if (write.before !== null) await unlink(guard);
	await syncDirectory(path.dirname(target));
}

async function removeOwned(root: string, target: string, hash: string): Promise<void> {
	const bytes = await readRegularFile(root, target, true);
	if (!bytes) return;
	if (sha256Bytes(bytes) !== hash) throw conflict();
	await unlink(target);
}

function conflict(): Error { return Object.assign(new Error("入库目标发生外部变化，已停止提交并保留恢复记录"), { code: "CONFLICT" }); }
