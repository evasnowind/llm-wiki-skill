import { isUtf8 } from "node:buffer";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

import { digestFileWithSubagent } from "../digest/subagent.js";
import type { IngestGeneratorInput } from "./queue.js";

export function validateIngestSourceBytes(bytes: Buffer, extension: string): void {
	if (extension.toLowerCase() === ".pdf") throw Object.assign(new Error("PDF text extraction is required"), { code: "PDF_EXTRACTION_REQUIRED" });
	if (!isUtf8(bytes) || bytes.includes(0) || !bytes.toString("utf8").trim()) throw Object.assign(new Error("UTF-8 source text is required"), { code: "SOURCE_TEXT_REQUIRED" });
}

export async function generateIngestSummary(input: IngestGeneratorInput, progress: (chars: number) => void, signal: AbortSignal): Promise<string> {
	if (path.extname(input.filePath).toLowerCase() === ".pdf") validateIngestSourceBytes(Buffer.alloc(0), ".pdf");
	const handle = await open(input.filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	let bytes: Buffer;
	try {
		const info = await handle.stat();
		if (!info.isFile() || info.size > 20 * 1024 * 1024) throw Object.assign(new Error("UTF-8 source text is required"), { code: "SOURCE_TEXT_REQUIRED" });
		bytes = await handle.readFile();
	} finally { await handle.close(); }
	validateIngestSourceBytes(bytes, path.extname(input.filePath));
	return digestFileWithSubagent(input, progress, signal);
}
