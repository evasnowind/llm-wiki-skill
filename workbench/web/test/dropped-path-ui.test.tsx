import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import React from "react";
import { fireEvent } from "@testing-library/react";
import { AddExternalDialog } from "../src/components/AddExternalDialog";
import { ChatPanel } from "../src/components/ChatPanel";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { click, render, screen, waitFor } from "./render";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("a dropped Windows directory reaches inspection and the confirmed batch intake action", async () => {
	const directory = "C:\\资料 空格\\source-materials";
	const kbPath = "C:\\wiki\\fixture";
	const source = directory + "\\hold.md";
	const inspected: unknown[] = [];
	const batches: unknown[] = [];
	stubInspection(inspected, [source]);
	render(<TooltipProvider><ChatPanel currentKnowledgeBaseName="fixture" currentKnowledgeBasePath={kbPath} initialMessages={[]} onStartBatchDigest={(input) => { batches.push(input); }} /></TooltipProvider>);
	fireEvent.drop(document.querySelector(".chat-input-area")!, { dataTransfer: transfer("text/plain", directory) });
	await click(await screen.findByRole("button", { name: /发现 1 个可入库文件，点击批量入库/ }));
	assert.deepEqual(inspected, [{ path: directory }]);
	assert.deepEqual(batches, [{ kbPath, filePaths: [source], sourceScanId: "windows-drop-scan", concurrency: 3 }]);
});

test("external library drops decode Windows file URLs before inspection", async () => {
	const inspected: unknown[] = [];
	stubInspection(inspected, []);
	render(<AddExternalDialog open onOpenChange={() => {}} onSubmit={async () => {}} />);
	const dropArea = screen.getByText("把文件夹拖到这里，或直接选择文件夹").parentElement!;
	fireEvent.drop(dropArea, { dataTransfer: transfer("text/uri-list", "file:///C:/%E8%B5%84%E6%96%99%20%E7%A9%BA%E6%A0%BC") });
	await waitFor(() => {
		assert.equal((screen.getByPlaceholderText("~/Documents/我的知识库") as HTMLInputElement).value, "C:/资料 空格");
		assert.deepEqual(inspected, [{ path: "C:/资料 空格" }]);
	});
});

function transfer(mime: string, path: string) {
	return { types: [mime], files: [], getData: (type: string) => type === mime ? path : "" };
}

function stubInspection(inspected: unknown[], paths: string[]) {
	globalThis.fetch = (async (input, init) => {
		const url = String(input);
		if (url === "/api/knowledge-bases/inspect") {
			inspected.push(JSON.parse(String(init?.body)));
			return json({ ok: true, data: { exists: true, isDirectory: true, hasWikiSchema: true, ingestibleFiles: { scanId: "windows-drop-scan", count: paths.length, samples: ["hold.md"], paths, truncated: false } } });
		}
		if (url === "/api/config") return json({ ok: true, data: { version: 1, externalKnowledgeBases: [] } });
		if (url === "/api/models" || url === "/api/commands") return json({ ok: true, data: [] });
		return json({ ok: false, code: "NOT_FOUND", message: "Unexpected fixture request" }, 404);
	}) as typeof globalThis.fetch;
}

function json(payload: unknown, status = 200) {
	return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}
