import { constants } from "node:fs";
import {
	copyFile,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	readlink,
	realpath,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { APP_DIR, DEFAULT_KNOWLEDGE_BASE_ROOT } from "./config.js";
import { expandUserPath, registerExternalKnowledgeBase } from "./knowledge-bases.js";
import { executeBashScript, toBashPath } from "./platform/bash.js";

export interface CreateWikiResult {
	name: string;
	path: string;
	stdout: string;
	stderr: string;
}

export interface InitExistingWikiResult {
	path: string;
	stdout: string;
	stderr: string;
	backedUpFiles: string[];
}

export class InitConflictError extends Error {
	statusCode = 409;
	constructor(public conflicts: string[]) {
		super(`目标目录已有将被初始化覆盖的文件：${conflicts.join(", ")}`);
	}
}

export class KnowledgeBaseSetupInputError extends Error {
	readonly code = "INVALID_REQUEST";
}

export class WikiInitializationBusyError extends Error {
	readonly code = "BUSY";

	constructor() {
		super("知识库正在初始化，请稍后重试");
		this.name = "WikiInitializationBusyError";
	}
}

export const KNOWLEDGE_BASE_SETUP_REQUIRED_MESSAGE =
	"未找到 llm-wiki 初始化工具，请先安装后重试";

export class KnowledgeBaseSetupRequiredError extends Error {
	readonly code = "SETUP_REQUIRED";

	constructor() {
		super(KNOWLEDGE_BASE_SETUP_REQUIRED_MESSAGE);
		this.name = "KnowledgeBaseSetupRequiredError";
	}
}

const INIT_WRITTEN_FILES = [
	".gitignore",
	".wiki-schema.md",
	"index.md",
	"log.md",
	path.join("wiki", "overview.md"),
	"purpose.md",
	".wiki-cache.json",
];

const initializingWikiTargets = new Set<string>();
const WIKI_CREATE_STAGING_PREFIX = "wiki-create-";

export function truncateOutput(text: string): string {
	return text.length > 4096 ? text.slice(0, 4096) + "\n...[truncated]" : text;
}

export function validateWikiName(name: string): string {
	const trimmed = name.trim();
	if (!trimmed) throw new KnowledgeBaseSetupInputError("知识库名不能为空");
	if (trimmed.includes("/") || trimmed.includes("\\")) {
		throw new KnowledgeBaseSetupInputError("知识库名不能包含路径分隔符");
	}
	if (trimmed === "." || trimmed === "..") {
		throw new KnowledgeBaseSetupInputError("知识库名不能是 . 或 ..");
	}
	if (trimmed.startsWith(".")) {
		throw new KnowledgeBaseSetupInputError("知识库名不能以 . 开头");
	}
	if (/[<>:"|?*\u0000-\u001f\u007f]/u.test(trimmed) || /[ .]$/u.test(trimmed)) {
		throw new KnowledgeBaseSetupInputError("知识库名含有系统不支持的字符，或以点号结尾");
	}
	if (/^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\s*\.|$)/iu.test(trimmed)) {
		throw new KnowledgeBaseSetupInputError("知识库名不能使用 Windows 保留名称");
	}
	return trimmed;
}

function assertInside(baseDir: string, target: string): void {
	const resolvedBase = path.resolve(baseDir);
	const resolvedTarget = path.resolve(target);
	if (resolvedTarget !== resolvedBase && !resolvedTarget.startsWith(resolvedBase + path.sep)) {
		throw new Error("目标路径不在默认知识库根目录内");
	}
}

async function fileExists(filePath: string): Promise<boolean> {
	const info = await stat(filePath).catch(() => null);
	return Boolean(info?.isFile());
}

export function initScriptCandidates(homeDir = homedir()): string[] {
	const skillDirs = [
		path.join(homeDir, ".codex", "skills", "llm-wiki"),
		path.join(homeDir, ".codex", "skills", "llm-wiki-skill"),
		path.join(homeDir, ".claude", "skills", "llm-wiki-skill"),
		path.join(homeDir, ".claude", "skills", "llm-wiki"),
	];
	return skillDirs.flatMap((skillDir) => [
		path.join(skillDir, "init-wiki.sh"),
		path.join(skillDir, "scripts", "init-wiki.sh"),
	]);
}

async function findInitScript(): Promise<string | null> {
	const candidates = initScriptCandidates();
	for (const candidate of candidates) {
		if (await fileExists(candidate)) return candidate;
	}
	return null;
}

async function initializationTargetKey(
	targetPath: string,
	seenPaths = new Set<string>(),
): Promise<string> {
	const resolvedPath = path.resolve(targetPath);
	if (seenPaths.has(resolvedPath)) {
		throw new Error("初始化目标包含循环链接");
	}
	seenPaths.add(resolvedPath);
	const linkInfo = await lstat(resolvedPath).catch(() => null);
	if (linkInfo?.isSymbolicLink()) {
		const linkTarget = await readlink(resolvedPath);
		return initializationTargetKey(path.resolve(path.dirname(resolvedPath), linkTarget), seenPaths);
	}
	const resolvedTarget = await realpath(resolvedPath).catch(async () => {
		const resolvedParent = await realpath(path.dirname(resolvedPath)).catch(() =>
			path.dirname(resolvedPath),
		);
		return path.join(resolvedParent, path.basename(resolvedPath));
	});
	// Serialize case variants as well: an APFS default volume can resolve both
	// spellings to the same directory after the target is created.
	return path.resolve(resolvedTarget).normalize("NFC").toLowerCase();
}

async function withWikiInitializationLock<T>(
	targetPath: string,
	operation: () => Promise<T>,
): Promise<T> {
	const targetKey = await initializationTargetKey(targetPath);
	if (initializingWikiTargets.has(targetKey)) {
		throw new WikiInitializationBusyError();
	}
	initializingWikiTargets.add(targetKey);
	try {
		return await operation();
	} finally {
		initializingWikiTargets.delete(targetKey);
	}
}

export async function createWiki(nameInput: string, purposeInput: string): Promise<CreateWikiResult> {
	const name = validateWikiName(nameInput);
	const scriptPath = await findInitScript();
	if (!scriptPath) {
		throw new KnowledgeBaseSetupRequiredError();
	}

	const targetPath = path.join(DEFAULT_KNOWLEDGE_BASE_ROOT, name);
	assertInside(DEFAULT_KNOWLEDGE_BASE_ROOT, targetPath);
	await mkdir(DEFAULT_KNOWLEDGE_BASE_ROOT, { recursive: true });

	return withWikiInitializationLock(targetPath, async () => {
		const stagingPath = await createWikiStagingDirectory();
		try {
			const { stdout, stderr } = await executeBashScript(scriptPath, [toBashPath(stagingPath), purposeInput.trim() || name, "中文"], {
				cwd: stagingPath, env: { HOME: homedir(), PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin" },
				timeoutMs: 60_000, maxOutputBytes: 1024 * 1024,
			});
			await replaceGeneratedWikiRoot(stagingPath, targetPath);
			await publishNewWiki(stagingPath, targetPath);
			await rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);

			return {
				name,
				path: targetPath,
				stdout: truncateOutput(replaceStagingPath(stdout, stagingPath, targetPath)),
				stderr: truncateOutput(replaceStagingPath(stderr, stagingPath, targetPath)),
			};
		} catch (err) {
			replaceStagingPathInError(err, stagingPath, targetPath);
			await rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
			throw err;
		}
	});
}

async function createWikiStagingDirectory(): Promise<string> {
	await mkdir(APP_DIR, { recursive: true });
	return mkdtemp(path.join(APP_DIR, WIKI_CREATE_STAGING_PREFIX));
}

async function replaceGeneratedWikiRoot(stagingPath: string, targetPath: string): Promise<void> {
	const schemaPath = path.join(stagingPath, ".wiki-schema.md");
	const schema = await readFile(schemaPath, "utf8");
	await writeFile(schemaPath, replaceStagingPath(schema, stagingPath, targetPath), "utf8");
}

function replaceStagingPath(value: string, stagingPath: string, targetPath: string): string {
	const normalized = toBashPath(stagingPath);
	const aliases = new Set([stagingPath, normalized]);
	if (/^[A-Za-z]:\//u.test(normalized)) aliases.add(`/${normalized[0]!.toLowerCase()}${normalized.slice(2)}`);
	let result = value;
	for (const alias of aliases) result = result.replaceAll(alias, targetPath);
	return result;
}

function replaceStagingPathInError(err: unknown, stagingPath: string, targetPath: string): void {
	if (!(err instanceof Error)) return;
	err.message = replaceStagingPath(err.message, stagingPath, targetPath);
	const output = err as Error & { stdout?: unknown; stderr?: unknown };
	if (typeof output.stdout === "string") {
		output.stdout = replaceStagingPath(output.stdout, stagingPath, targetPath);
	}
	if (typeof output.stderr === "string") {
		output.stderr = replaceStagingPath(output.stderr, stagingPath, targetPath);
	}
}

async function publishNewWiki(stagingPath: string, targetPath: string): Promise<void> {
	await reserveNewWikiTarget(targetPath);
	await copyStagedWiki(stagingPath, targetPath);
	await assertPublishedWikiMatchesStaging(stagingPath, targetPath);
}

async function reserveNewWikiTarget(targetPath: string): Promise<void> {
	try {
		await mkdir(targetPath);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EEXIST") {
			throw new KnowledgeBaseSetupInputError("该知识库名称已存在，请换一个名称");
		}
		throw err;
	}
}

async function copyStagedWiki(stagingPath: string, targetPath: string): Promise<void> {
	const entries = await readdir(stagingPath, { withFileTypes: true });
	for (const entry of entries) {
		const sourcePath = path.join(stagingPath, entry.name);
		const destinationPath = path.join(targetPath, entry.name);
		if (entry.isDirectory()) {
			await mkdir(destinationPath);
			await copyStagedWiki(sourcePath, destinationPath);
			continue;
		}
		if (entry.isFile()) {
			await copyFile(sourcePath, destinationPath, constants.COPYFILE_EXCL);
			continue;
		}
		throw new Error("初始化脚本生成了不受支持的文件类型");
	}
}

async function assertPublishedWikiMatchesStaging(
	stagingPath: string,
	targetPath: string,
): Promise<void> {
	const [stagedEntries, publishedEntries] = await Promise.all([
		listRelativeEntries(stagingPath),
		listRelativeEntries(targetPath),
	]);
	if (
		stagedEntries.length !== publishedEntries.length ||
		stagedEntries.some((entry, index) => entry !== publishedEntries[index])
	) {
		throw new Error("创建知识库时目标目录发生变化");
	}
}

async function listRelativeEntries(rootPath: string, relativePath = ""): Promise<string[]> {
	const entries = await readdir(path.join(rootPath, relativePath), { withFileTypes: true });
	const result: string[] = [];
	for (const entry of entries) {
		const childPath = path.join(relativePath, entry.name);
		if (!entry.isDirectory() && !entry.isFile()) {
			throw new Error("初始化脚本生成了不受支持的文件类型");
		}
		result.push(childPath);
		if (entry.isDirectory()) result.push(...(await listRelativeEntries(rootPath, childPath)));
	}
	return result.sort();
}

export async function initExistingWiki(
	rawPath: string,
	purposeInput: string,
	overwrite = false,
): Promise<InitExistingWikiResult> {
	const absolutePath = path.resolve(expandUserPath(rawPath));
	const purpose = purposeInput.trim();
	if (!purpose) throw new KnowledgeBaseSetupInputError("研究方向不能为空");

	return withWikiInitializationLock(absolutePath, async () => {
		const info = await stat(absolutePath).catch((err: NodeJS.ErrnoException) => {
			if (err.code === "EACCES" || err.code === "EPERM") {
				throw Object.assign(new Error("path is not accessible"), {
					code: "FORBIDDEN_PATH",
					details: { reason: "outside-root" },
				});
			}
			return null;
		});
		if (!info?.isDirectory()) {
			throw new KnowledgeBaseSetupInputError("请选择一个存在的文件夹");
		}

		const conflicts = await findInitConflicts(absolutePath);
		if (conflicts.length > 0 && !overwrite) {
			throw new InitConflictError(conflicts);
		}

		const backedUpFiles =
			conflicts.length > 0 ? await backupConflicts(absolutePath, conflicts) : [];
		const scriptPath = await findInitScript();
		if (!scriptPath) {
			throw new KnowledgeBaseSetupRequiredError();
		}

		const { stdout, stderr } = await executeBashScript(scriptPath, [toBashPath(absolutePath), purpose, "中文"], {
			cwd: absolutePath, env: { HOME: homedir(), PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin" },
			timeoutMs: 60_000, maxOutputBytes: 1024 * 1024,
		});

		await registerExternalKnowledgeBase(absolutePath);
		return {
			path: absolutePath,
			stdout: truncateOutput(stdout),
			stderr: truncateOutput(stderr),
			backedUpFiles,
		};
	});
}

async function findInitConflicts(targetPath: string): Promise<string[]> {
	const conflicts: string[] = [];
	for (const relPath of INIT_WRITTEN_FILES) {
		const info = await stat(path.join(targetPath, relPath)).catch(() => null);
		if (info?.isFile()) conflicts.push(relPath);
	}
	return conflicts;
}

async function backupConflicts(targetPath: string, conflicts: string[]): Promise<string[]> {
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const backupRoot = path.join(targetPath, ".llm-wiki-agent-backup", timestamp);
	const backedUp: string[] = [];
	for (const relPath of conflicts) {
		const src = path.join(targetPath, relPath);
		const dest = path.join(backupRoot, relPath);
		await mkdir(path.dirname(dest), { recursive: true });
		await copyFile(src, dest);
		backedUp.push(dest);
	}
	return backedUp;
}
