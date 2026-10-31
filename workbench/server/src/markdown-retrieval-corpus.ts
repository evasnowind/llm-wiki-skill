import { readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import type { RetrievalMode } from "@llm-wiki/workbench-contracts";

import { readEvidenceFile } from "./evidence-reader.js";
import { assertSafePath } from "./graph-rename-safe-io.js";
import { assertRegisteredKnowledgeBase } from "./knowledge-bases.js";
import { parseMarkdownDocument, type MarkdownDocument } from "./markdown-retrieval.js";
import { findRepoRoot } from "./repo-root.js";
import { managedHistoricalHashes } from "./ingest/source-revision-history.js";

export interface RetrievalDocument extends MarkdownDocument {
	path: string;
	kind: "wiki" | "raw";
	content: string;
	fileHash: string;
	mtime: number;
}

const MAX_DOCUMENTS = 1500;
const MAX_ENTRIES = 10_000;
const MAX_TOTAL_BYTES = 20_000_000;

export async function loadRetrievalCorpus(kbPath: string, mode: RetrievalMode, assertRegistered = true, historyReader = managedHistoricalHashes): Promise<{ documents: RetrievalDocument[]; warnings: string[] }> {
	if (assertRegistered) await assertRegisteredKnowledgeBase(kbPath);
	const paths: string[] = [];
	const warnings = new Set<string>();
	let entriesSeen = 0;
	function warnUnreadableDirectory(error: unknown, depth: number): void {
		// Absent optional corpus roots are normal; disappearance of an enumerated child is a partial scan.
		if (depth === 0 && (error as NodeJS.ErrnoException).code === "ENOENT") return;
		warnings.add("部分目录不可访问或无法安全读取，检索范围不完整。");
	}
	async function walk(relative: string, depth = 0): Promise<void> {
		if (depth > 24 || entriesSeen >= MAX_ENTRIES || paths.length >= MAX_DOCUMENTS) {
			warnings.add("检索扫描达到目录或文件数量上限，结果可能不完整。");
			return;
		}
		let directory: string;
		try { directory = await assertSafePath(kbPath, path.join(kbPath, relative), false); }
		catch (error) { warnUnreadableDirectory(error, depth); return; }
		let entries: import("node:fs").Dirent[];
		try { entries = await readdir(directory, { withFileTypes: true }); }
		catch (error) { warnUnreadableDirectory(error, depth); return; }
		entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
		for (const entry of entries) {
			entriesSeen += 1;
			if (entriesSeen > MAX_ENTRIES || paths.length >= MAX_DOCUMENTS) {
				warnings.add("检索扫描达到目录或文件数量上限，结果可能不完整。");
				break;
			}
			if (entry.name.startsWith(".") || entry.name.includes(":") || entry.name.includes("\\")) continue;
			if (entry.isSymbolicLink()) { warnings.add("部分符号链接未纳入检索。"); continue; }
			const candidate = `${relative}/${entry.name}`;
			if (entry.isDirectory()) await walk(candidate, depth + 1);
			else if (entry.isFile() && (relative.startsWith("raw") ? /\.(md|txt)$/u : /\.md$/u).test(entry.name)) paths.push(candidate);
		}
	}
	if (mode === "knowledge") {
		await walk("wiki");
		paths.push("purpose.md", "index.md");
	}
	await walk("raw");
	const historical = await historyReader(kbPath);
	const documents: RetrievalDocument[] = [];
	let bytesSeen = 0;
	for (const relativePath of paths) {
		try {
			const file = await readEvidenceFile(kbPath, relativePath);
			if (historical.get(relativePath) === file.fileHash) continue;
			bytesSeen += Buffer.byteLength(file.content, "utf8");
			if (bytesSeen > MAX_TOTAL_BYTES) { warnings.add("检索扫描达到 20 MB 文本上限，结果可能不完整。"); break; }
			const name = path.posix.basename(relativePath).replace(/\.(md|txt)$/u, "");
			documents.push({ ...file, ...parseMarkdownDocument(file.content, name), path: relativePath, kind: relativePath.startsWith("raw/") ? "raw" : "wiki" });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			warnings.add(`无法读取 ${relativePath}：仅检索可安全读取的 UTF-8 文件（单文件上限 2 MB）。`);
		}
	}
	const reportedWarnings = [...warnings].slice(0, 10).map((warning) => warning.slice(0, 512));
	if (warnings.size > 10) reportedWarnings.push(`另有 ${warnings.size - 10} 项读取限制，检索范围不完整。`);
	return { documents, warnings: reportedWarnings };
}

interface LinkOccurrence { pending: boolean; link_kind: string; page_target: string }
interface LinkParser { parseWikilinks(bytes: Buffer, source: string): { occurrences: LinkOccurrence[] } }
interface LinkResolver {
	buildWikiTargetIndex(items: Array<{ path: string; kind: string }>): unknown;
	resolveWikilink(occurrence: LinkOccurrence, source: string, index: unknown): { status: string; target_path: string | null };
}
let linkLibraries: Promise<{ parser: LinkParser; resolver: LinkResolver }> | undefined;

/** Reuse the Skill parser/resolver: code, pending links and ambiguous bare names keep identical semantics. */
export async function oneHopTargets(seeds: RetrievalDocument[], corpus: RetrievalDocument[]): Promise<Map<string, string>> {
	if (seeds.length === 0) return new Map();
	linkLibraries ??= findRepoRoot().then((root) => {
		const require = createRequire(import.meta.url);
		return { parser: require(path.join(root, "scripts/lib/wikilink-parser.js")) as LinkParser, resolver: require(path.join(root, "scripts/lib/wiki-link-index.js")) as LinkResolver };
	});
	const { parser, resolver } = await linkLibraries;
	const index = resolver.buildWikiTargetIndex(corpus.map((document) => ({ path: document.path, kind: "markdown" })));
	const targets = new Map<string, string>();
	for (const seed of seeds) {
		for (const occurrence of parser.parseWikilinks(Buffer.from(seed.content), seed.path).occurrences) {
			if (occurrence.pending || occurrence.link_kind === "same_page_anchor") continue;
			const resolution = resolver.resolveWikilink(occurrence, seed.path, index);
			if (resolution.status === "resolved" && resolution.target_path && resolution.target_path !== seed.path) targets.set(resolution.target_path, seed.path);
		}
	}
	return targets;
}
