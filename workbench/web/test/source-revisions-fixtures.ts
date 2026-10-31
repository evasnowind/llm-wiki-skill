import type { SourceCandidate, SourceChangeCheck, SourceRevisionsData, SourceView, SourceVersion } from "@llm-wiki/workbench-contracts";
import type { SourceRevisionsApi } from "../src/lib/use-source-revisions";
export const now = "2026-10-31T00:00:00.000Z";
export const jobId = "11111111-1111-4111-8111-111111111111";
export function candidate(kbPath = "/a", revision = 1, status: SourceCandidate["status"] = "ready"): SourceCandidate {
	return { id: "candidate", kbPath, sourceId: "source", name: "材料.md", kind: "modified", status, revision, baseVersionId: "v1", adoptedVersionId: status === "adopted" ? "v2" : null, model: null, createdAt: now, updatedAt: now, error: null, progressChars: 50, attempts: 1 };
}
export function source(kbPath = "/a", currentVersionId = "v1"): SourceView {
	return { id: "source", kbPath, directoryId: "directory", relativePath: "材料.md", name: "材料.md", currentVersionId, outputPath: "wiki/sources/material.md", updatedAt: now };
}
export function version(id = "v1"): SourceVersion {
	return { id, sourceId: "source", action: "modified", rawHash: "raw-hash", summaryHash: "summary-hash", rawPath: "raw/material.md", summaryPath: "wiki/sources/material.md", model: null, createdAt: now };
}
export function data(kbPath = "/a", currentVersionId = "v1", revision = 1, status: SourceCandidate["status"] = "ready"): SourceRevisionsData {
	return { directories: [{ id: "directory", kbPath, path: "/素材 目录", createdAt: now }], sources: [source(kbPath, currentVersionId)], candidates: [candidate(kbPath, revision, status)] };
}
export function check(kbPath = "/a"): SourceChangeCheck {
	return { id: "check", kbPath, directoryId: "directory", directoryPath: "/素材 目录", createdAt: now, complete: true, warnings: [], changes: ["added", "modified", "deleted", "unchanged"].map((kind) => ({ id: kind, sourceId: kind === "added" ? null : "source", relativePath: `${kind}.md`, kind: kind as "added" | "modified" | "deleted" | "unchanged", baseVersionId: kind === "added" ? null : "v1", contentHash: kind === "deleted" ? null : "raw-hash" })) };
}
export function fakeApi(overrides: Partial<SourceRevisionsApi> = {}): SourceRevisionsApi {
	return {
		list: async (kb) => data(kb), check: async ({ kbPath }) => check(kbPath), create: async ({ kbPath }) => [candidate(kbPath, 1, "pending")],
		detail: async (kbPath) => ({ candidate: candidate(kbPath), original: { before: { text: "旧原文", hash: "old" }, after: { text: "新原文", hash: "new" } }, summary: { before: { text: "旧摘要", hash: "old-summary" }, after: { text: "新摘要", hash: "new-summary" } }, truncated: false }),
		history: async (kbPath) => ({ source: source(kbPath), versions: [version(), version("v2")] }),
		version: async (_kb, id) => ({ version: version(id), original: { text: `${id} 原文`, hash: "raw" }, summary: { text: `${id} 摘要`, hash: "summary" }, truncated: false }),
		action: async (action, _id, { kbPath }) => candidate(kbPath, 2, action === "adopt" ? "adopted" : action === "cancel" ? "cancelled" : "pending"),
		chooseDirectory: async () => "/素材 目录",
		inspect: async () => ({ exists: true, isDirectory: true, hasWikiSchema: false, ingestibleFiles: { scanId: "scan", count: 4, samples: [], paths: [], truncated: false } }),
		...overrides,
	};
}
export function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (cause: Error) => void;
	const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
	return { promise, resolve, reject };
}
