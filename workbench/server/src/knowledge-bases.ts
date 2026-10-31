/**
 * knowledge-bases.ts - 知识库扫描与登记
 *
 * 数据源（PRODUCT.md §6.1 混合模式）：
 *   1. ~/llm-wiki/ 默认根 → 扫描含 .wiki-schema.md 的子目录
 *   2. ~/.llm-wiki-agent/config.json 的 externalKnowledgeBases → 用户登记的外部路径
 *
 * 返回结构含 valid 标志；失效路径不自动删除（避免数据丢失），由 UI 提示用户处理
 * （PRODUCT.md §6.7 边界场景）。
 */

import type { Dirent } from "node:fs";
import { lstat, mkdir, readdir, realpath, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, extname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { readRegularFile, sha256Bytes } from "./graph-rename-safe-io.js";

import {
	type AppConfig,
	DEFAULT_KNOWLEDGE_BASE_ROOT,
	loadConfig,
	saveConfig,
} from "./config.js";

export interface KnowledgeBaseInfo {
	path: string; // 绝对路径
	name: string; // 目录最后一段
	origin: "default" | "external";
	valid: boolean;
	reason?: string; // valid=false 时说明
}

export interface InspectPathResult {
	exists: boolean;
	isDirectory: boolean;
	hasWikiSchema: boolean;
	resolvedPath?: string;
	ingestibleFiles?: {
		scanId: string;
		count: number;
		samples: string[];
		paths: string[];
		truncated: boolean;
	};
}

const SKIP_DIRS = new Set([
	".git",
	".obsidian",
	".wiki-tmp",
	"node_modules",
	"venv",
	".venv",
	"dist",
	"build",
]);
const INGEST_EXTS = new Set([".md", ".txt", ".pdf", ".html"]);
const MAX_SCAN_DEPTH = 5;
const MAX_INGESTIBLE_FILES = 500;
const INSPECT_SCAN_TTL_MS = 30 * 60 * 1000;

const inspectScans = new Map<
	string,
	{ root: string; paths: Set<string>; expiresAt: number; dev: number; ino: number; complete: boolean; warnings: string[]; hashes: Record<string, string> }
>();

export function expandUserPath(rawPath: string): string {
	const trimmed = rawPath.trim();
	if (trimmed === "~") return homedir();
	if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
	return trimmed;
}

/**
 * 验证给定路径是否是一个合法知识库（不抛错，返回结构化结果）。
 * 规则：路径存在 + 是目录 + 含 .wiki-schema.md
 */
export async function inspectKnowledgeBasePath(
	absolutePath: string,
): Promise<{ valid: true } | { valid: false; reason: string }> {
	const info = await stat(absolutePath).catch(() => null);
	if (!info) return { valid: false, reason: "Path does not exist" };
	if (!info.isDirectory()) return { valid: false, reason: "Not a directory" };

	const schemaInfo = await stat(join(absolutePath, ".wiki-schema.md")).catch(() => null);
	if (!schemaInfo) return { valid: false, reason: "Missing .wiki-schema.md" };

	return { valid: true };
}

async function comparablePath(rawPath: string): Promise<string> {
	const absolutePath = resolve(expandUserPath(rawPath));
	return realpath(absolutePath).catch(() => absolutePath);
}

export async function findRegisteredKnowledgeBase(
	rawPath: string,
	knownBases: KnowledgeBaseInfo[],
): Promise<KnowledgeBaseInfo | null> {
	const targetPath = await comparablePath(rawPath);
	for (const kb of knownBases) {
		if (!kb.valid) continue;
		const registeredPath = await comparablePath(kb.path);
		if (registeredPath === targetPath) return kb;
	}
	return null;
}

export async function assertRegisteredKnowledgeBase(rawPath: string): Promise<string> {
	const match = await findRegisteredKnowledgeBase(rawPath, await listKnowledgeBases());
	if (!match) {
		throw Object.assign(new Error("knowledge base is not registered"), {
			code: "KB_NOT_REGISTERED",
			statusCode: 403,
		});
	}
	return match.path;
}

export async function inspectPath(rawPath: string): Promise<InspectPathResult> {
	const expanded = expandUserPath(rawPath);
	if (!expanded) throw new Error("path 不能为空");
	const absolutePath = resolve(expanded);
	const info = await stat(absolutePath).catch((err: NodeJS.ErrnoException) => {
		if (err.code === "EACCES" || err.code === "EPERM") {
			throw Object.assign(new Error("path is not accessible"), {
				code: "FORBIDDEN_PATH",
				details: { reason: "outside-root" },
			});
		}
		return null;
	});
	if (!info) return { exists: false, isDirectory: false, hasWikiSchema: false };

	const resolvedPath = await realpath(absolutePath).catch(() => absolutePath);
	const isDirectory = info.isDirectory();
	const schemaInfo = isDirectory ? await stat(join(resolvedPath, ".wiki-schema.md")).catch(() => null) : null;
	return {
		exists: true,
		isDirectory,
		hasWikiSchema: Boolean(schemaInfo?.isFile()),
		resolvedPath,
		...(isDirectory ? { ingestibleFiles: await scanIngestibleFiles(resolvedPath) } : {}),
	};
}

async function scanIngestibleFiles(root: string): Promise<NonNullable<InspectPathResult["ingestibleFiles"]>> {
	const paths: string[] = [];
	let truncated = false;
	const warnings = new Set<string>();
	const rootInfo = await lstat(root);
	if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw Object.assign(new Error("来源目录已变化"), { code: "FORBIDDEN_PATH" });

	async function walk(dir: string, depth: number): Promise<void> {
		if (depth > MAX_SCAN_DEPTH || paths.length >= MAX_INGESTIBLE_FILES) {
			truncated = true;
			return;
		}
		const entries = await readdir(dir, { withFileTypes: true }).catch(() => { warnings.add("部分目录不可读，不能判断删除"); return []; });
		entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
		for (const entry of entries) {
			if (paths.length >= MAX_INGESTIBLE_FILES) {
				truncated = true;
				return;
			}
			if (entry.name === ".DS_Store") continue;
			if (entry.isSymbolicLink()) { warnings.add("符号链接未纳入扫描，不能判断删除"); continue; }
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name.startsWith(".") && ![".wiki-tmp"].includes(entry.name)) continue;
				if (SKIP_DIRS.has(entry.name)) continue;
				await walk(fullPath, depth + 1);
			} else if (entry.isFile() && INGEST_EXTS.has(extname(entry.name).toLowerCase())) {
				paths.push(fullPath);
			}
		}
	}

	await walk(root, 0);
	if (truncated) warnings.add("扫描达到深度或数量上限，不能判断删除");
	const hashes: Record<string, string> = {};
	let markdownBytes = 0;
	for (const file of paths.filter((value) => extname(value).toLowerCase() === ".md")) {
		try {
			const metadata = await lstat(file);
			if (!metadata.isFile() || metadata.isSymbolicLink() || !metadata.size || metadata.size > 20 * 1024 * 1024) { warnings.add("部分 Markdown 为空或超过 20 MiB，不能判断删除"); continue; }
			if (markdownBytes + metadata.size > 100 * 1024 * 1024) { warnings.add("扫描达到 100 MiB 上限，不能判断删除"); continue; }
			const bytes = await readRegularFile(root, file, false);
			if (!bytes || !bytes.length || bytes.length > 20 * 1024 * 1024) { warnings.add("部分 Markdown 为空或超过 20 MiB，不能判断删除"); continue; }
			markdownBytes += bytes.length;
			hashes[file] = sha256Bytes(bytes);
		} catch { warnings.add("部分 Markdown 无法安全读取，不能判断删除"); }
	}
	for (const [id, grant] of inspectScans) if (grant.expiresAt < Date.now()) inspectScans.delete(id);
	const scanId = randomUUID();
	inspectScans.set(scanId, {
		root, dev: rootInfo.dev, ino: rootInfo.ino, complete: warnings.size === 0, warnings: [...warnings], hashes,
		paths: new Set(paths),
		expiresAt: Date.now() + INSPECT_SCAN_TTL_MS,
	});
	return {
		scanId,
		count: paths.length,
		samples: paths.slice(0, 5).map((file) => file.slice(root.length + 1)),
		paths,
		truncated,
	};
}

export function validateInspectedSourceFiles(
	scanId: string | undefined,
	filePaths: string[],
): { ok: true; root: string; paths: Set<string> } | { ok: false; error: string } {
	if (!scanId) return { ok: false, error: "缺少来源扫描凭据，请重新选择目录" };
	const scan = inspectScans.get(scanId);
	if (!scan) return { ok: false, error: "来源扫描已过期，请重新选择目录" };
	if (scan.expiresAt < Date.now()) {
		inspectScans.delete(scanId);
		return { ok: false, error: "来源扫描已过期，请重新选择目录" };
	}
	for (const filePath of filePaths) {
		if (!scan.paths.has(filePath)) {
			return { ok: false, error: `文件不在刚才扫描确认的目录内：${filePath}` };
		}
	}
	return { ok: true, root: scan.root, paths: scan.paths };
}

/** This grant is process-local and expires; durable source records never authorize a rescan. */
export async function readInspectedMarkdownSources(scanId: string): Promise<{
	root: string; complete: boolean; warnings: string[]; files: Array<{ path: string; bytes: Buffer; hash: string }>;
}> {
	const grant = inspectScans.get(scanId);
	if (!grant || grant.expiresAt < Date.now()) throw Object.assign(new Error("来源扫描已失效，请重新选择目录"), { code: "INVALID_REQUEST" });
	const info = await lstat(grant.root);
	if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== grant.dev || info.ino !== grant.ino || await realpath(grant.root) !== grant.root) {
		throw Object.assign(new Error("来源目录已变化，请重新选择"), { code: "FORBIDDEN_PATH" });
	}
	// Re-enumeration detects files added after approval, instead of expanding the approved set.
	const observed = await scanIngestibleFiles(grant.root);
	const current = inspectScans.get(observed.scanId)!;
	inspectScans.delete(observed.scanId);
	if (JSON.stringify([...grant.paths].sort()) !== JSON.stringify([...current.paths].sort()) || JSON.stringify(Object.entries(grant.hashes).sort()) !== JSON.stringify(Object.entries(current.hashes).sort())) {
		throw Object.assign(new Error("来源内容已变化，请重新检查"), { code: "CONFLICT" });
	}
	const files: Array<{ path: string; bytes: Buffer; hash: string }> = [];
	let total = 0;
	for (const [file, hash] of Object.entries(grant.hashes)) {
		const bytes = await readRegularFile(grant.root, file, false);
		if (!bytes || sha256Bytes(bytes) !== hash) throw Object.assign(new Error("来源内容已变化，请重新检查"), { code: "CONFLICT" });
		total += bytes.length;
		if (total > 100 * 1024 * 1024) throw Object.assign(new Error("单批素材不能超过 100 MiB"), { code: "INVALID_REQUEST" });
		files.push({ path: file, bytes, hash });
	}
	const after = await lstat(grant.root);
	if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== grant.dev || after.ino !== grant.ino) throw Object.assign(new Error("来源目录已变化，请重新选择"), { code: "FORBIDDEN_PATH" });
	return { root: grant.root, complete: grant.complete && current.complete, warnings: [...new Set([...grant.warnings, ...current.warnings])], files };
}

/**
 * 列出所有已知知识库（默认根扫描 + 外部登记），含 valid 状态。
 * 同绝对路径去重：默认根优先于外部登记。
 */
export async function listKnowledgeBases(): Promise<KnowledgeBaseInfo[]> {
	// 1. 确保默认根存在（首次启动）
	await mkdir(DEFAULT_KNOWLEDGE_BASE_ROOT, { recursive: true });

	// 2. 扫默认根
	let entries: Dirent[] = [];
	try {
		entries = await readdir(DEFAULT_KNOWLEDGE_BASE_ROOT, { withFileTypes: true });
	} catch {
		// 极端情况（比如权限问题）：仅返回外部部分，不崩
	}

	const seen = new Set<string>();
	const results: KnowledgeBaseInfo[] = [];

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		if (entry.name.startsWith(".")) continue;
		const path = join(DEFAULT_KNOWLEDGE_BASE_ROOT, entry.name);
		const check = await inspectKnowledgeBasePath(path);
		results.push({
			path,
			name: entry.name,
			origin: "default",
			...(check.valid ? { valid: true } : { valid: false, reason: check.reason }),
		});
		seen.add(path);
	}

	// 3. 加外部登记
	const config = await loadConfig();
	for (const externalPath of config.externalKnowledgeBases) {
		if (seen.has(externalPath)) continue; // 已经被默认扫描覆盖
		const check = await inspectKnowledgeBasePath(externalPath);
		results.push({
			path: externalPath,
			name: basename(externalPath),
			origin: "external",
			...(check.valid ? { valid: true } : { valid: false, reason: check.reason }),
		});
		seen.add(externalPath);
	}

	// 4. 排序：default 在前，按名字
	results.sort((a, b) => {
		if (a.origin !== b.origin) return a.origin === "default" ? -1 : 1;
		return a.name.localeCompare(b.name, "zh");
	});

	return results;
}

/**
 * 登记一个外部知识库。
 * - 绝对路径化（解析 ~ 由调用方负责，这里只做 resolve）
 * - 验证有效性（路径合法、含 schema 文件）
 * - 已存在则幂等（不重复追加，不报错）
 * - 若该路径正好在默认根下，提示但仍登记（用户自己选择）
 */
export async function registerExternalKnowledgeBase(rawPath: string): Promise<{
	registered: boolean;
	path: string;
	info: KnowledgeBaseInfo;
}> {
	const absolutePath = await realpath(resolve(expandUserPath(rawPath))).catch(() =>
		resolve(expandUserPath(rawPath)),
	);

	const check = await inspectKnowledgeBasePath(absolutePath);
	if (!check.valid) {
		throw Object.assign(new Error("path is not a valid knowledge base"), {
			code: "KB_NOT_REGISTERED",
		});
	}

	const config = await loadConfig();
	const alreadyRegistered = config.externalKnowledgeBases.includes(absolutePath);

	if (!alreadyRegistered) {
		const updated: AppConfig = {
			...config,
			externalKnowledgeBases: [...config.externalKnowledgeBases, absolutePath],
		};
		await saveConfig(updated);
	}

	return {
		registered: !alreadyRegistered,
		path: absolutePath,
		info: {
			path: absolutePath,
			name: basename(absolutePath),
			origin: "external",
			valid: true,
		},
	};
}

/**
 * 取消登记一个外部知识库。从 config.externalKnowledgeBases 移除（不删文件系统）。
 */
export async function unregisterExternalKnowledgeBase(rawPath: string): Promise<{
	removed: boolean;
	path: string;
}> {
	const absolutePath = resolve(rawPath);
	const config = await loadConfig();
	const before = config.externalKnowledgeBases.length;
	const after = config.externalKnowledgeBases.filter((p) => p !== absolutePath);

	if (after.length === before) {
		return { removed: false, path: absolutePath };
	}

	await saveConfig({ ...config, externalKnowledgeBases: after });
	return { removed: true, path: absolutePath };
}
