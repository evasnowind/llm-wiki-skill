import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";

import { assertParentBoundary, assertSafePath, captureParentBoundary, readRegularFile } from "../graph-rename-safe-io.js";

/** Application-owned records use rename, so a crash never removes the previous record. */
export async function atomicWrite(root: string, target: string, bytes: Buffer | string): Promise<void> {
	await assertSafePath(root, target, true);
	const boundary = await captureParentBoundary(root, target);
	const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
	const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
	try {
		await handle.writeFile(bytes);
		await handle.sync();
	} finally { await handle.close(); }
	try {
		await assertParentBoundary(root, target, boundary);
		await assertSafePath(root, target, true);
		await rename(temporary, target);
		await syncDirectory(path.dirname(target));
	} catch (error) {
		await unlink(temporary).catch(() => undefined);
		throw error;
	}
}

export async function syncDirectory(directory: string): Promise<void> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(directory, constants.O_RDONLY);
		await handle.sync();
	}
	catch (error) {
		if (!["EINVAL", "ENOTSUP", "EBADF", "EPERM", "EISDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
	} finally { await handle?.close(); }
}

export async function storageRoot(directory: string): Promise<string> {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const info = await lstat(directory);
	if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("入库状态目录不可用");
	return realpath(directory);
}

export async function readOptional(root: string, target: string): Promise<string | null> {
	try { return (await readRegularFile(root, target, true))?.toString("utf8") ?? null; }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
