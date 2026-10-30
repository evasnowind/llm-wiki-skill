import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";

import { EvidenceCitationSchema, EvidencePathSchema, type EvidenceCitation, type EvidenceReadResult } from "@llm-wiki/workbench-contracts";

import { assertSafePath, readRegularFile, sha256Bytes } from "./graph-rename-safe-io.js";

export const MAX_EVIDENCE_FILE_BYTES = 2_000_000;

export function normalizeEvidenceText(text: string): string {
	return text.replace(/\r\n?/g, "\n");
}

export function hashExcerpt(excerpt: string): string {
	return createHash("sha256").update(normalizeEvidenceText(excerpt), "utf8").digest("hex");
}

/** Never use the page reader's lexical-only boundary for evidence, including retrieval. */
export async function readEvidenceFile(kbPath: string, relativePath: string): Promise<{ content: string; fileHash: string; mtime: number }> {
	if (!EvidencePathSchema.safeParse(relativePath).success) throw new Error("Invalid evidence path");
	const absolute = await assertSafePath(kbPath, path.join(kbPath, relativePath), false);
	const info = await lstat(absolute);
	if (!info.isFile() || info.isSymbolicLink()) throw new Error("Evidence must be a regular file");
	if (info.size > MAX_EVIDENCE_FILE_BYTES) throw new Error("Evidence file exceeds the 2 MB reading limit");
	const bytes = await readRegularFile(kbPath, absolute, false);
	if (!bytes) throw new Error("Evidence file is unavailable");
	if (bytes.length > MAX_EVIDENCE_FILE_BYTES) throw new Error("Evidence file exceeds the 2 MB reading limit");
	let content: string;
	try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
	catch { throw new Error("Evidence file is not valid UTF-8"); }
	return { content: normalizeEvidenceText(content), fileHash: sha256Bytes(bytes), mtime: info.mtimeMs };
}

/** Revalidate a saved citation against the current file before highlighting it. */
export async function readEvidence(kbPath: string, input: EvidenceCitation): Promise<EvidenceReadResult> {
	const citation = EvidenceCitationSchema.parse(input);
	if (citation.excerpt !== normalizeEvidenceText(citation.excerpt) || hashExcerpt(citation.excerpt) !== citation.excerptHash) {
		throw new Error("Evidence excerpt hash is invalid");
	}
	const current = await readEvidenceFile(kbPath, citation.path);
	const result: EvidenceReadResult = {
		path: citation.path, kind: citation.kind, content: current.content, fileHash: current.fileHash,
		locationStatus: "changed", startLine: null, endLine: null,
	};
	const lines = current.content.split("\n");
	if (current.fileHash === citation.fileHash) {
		const range = lines.slice(citation.startLine - 1, citation.endLine).join("\n");
		if (citation.endLine <= lines.length && range.includes(citation.excerpt)
			&& citation.excerpt.split("\n").length === citation.endLine - citation.startLine + 1) {
			return { ...result, locationStatus: "exact", startLine: citation.startLine, endLine: citation.endLine };
		}
		return result;
	}
	const first = current.content.indexOf(citation.excerpt);
	if (first < 0 || current.content.indexOf(citation.excerpt, first + 1) >= 0) return result;
	const startLine = current.content.slice(0, first).split("\n").length;
	return { ...result, locationStatus: "relocated", startLine, endLine: startLine + citation.excerpt.split("\n").length - 1 };
}
