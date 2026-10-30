import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { act } from "@testing-library/react";
import { ChatPanel } from "../src/components/ChatPanel";
import { EvidenceReader } from "../src/components/EvidenceReader";
import { MarkdownView } from "../src/components/MarkdownView";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { evidenceDrawer, shouldApplyEvidenceResult } from "../src/lib/drawer-state";
import { citation, sourceContent } from "./markdown-evidence-fixture";
import { changeText, click, render, screen, waitFor } from "./render";

const selection = { kbPath: "/kb/a", conversationId: "conversation-a", citation };
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("Markdown evidence", () => {
	it("opens only a citation bound to this message and preserves safe links", async () => {
		const opened: string[] = [];
		render(<MarkdownView content="出处 [1](#evidence-E1)，未知 [2](#evidence-E2)，[恶意](javascript:alert%281%29)，[协议](evidence:raw/secret.md)，[外链](https://example.org)。" evidence={[citation]} onOpenEvidence={(item) => opened.push(item.path)} />);
		await click(screen.getByRole("button", { name: /查看出处 1/ }));
		assert.deepEqual(opened, ["raw/guide.md"]);
		assert.equal(screen.getByText("2").tagName, "SPAN");
		assert.equal(screen.getByText("恶意").getAttribute("href"), "");
		assert.equal(screen.getByText("协议").getAttribute("href"), "");
		assert.equal(screen.getByRole("link", { name: "外链" }).getAttribute("href"), "https://example.org");
	});

	it("uses Markdown source lines to highlight and focus the exact paragraph", () => {
		render(<EvidenceReader drawer={evidenceDrawer(selection, "request-1", { result: { path: citation.path, kind: "raw", content: sourceContent, locationStatus: "exact", startLine: 5, endLine: 5, fileHash: citation.fileHash } })} />);
		const highlighted = document.querySelector("[data-evidence-highlight]");
		assert.equal(highlighted?.textContent, "原始段落。");
		assert.equal(highlighted?.getAttribute("data-source-start"), "5");
		assert.equal(document.activeElement, highlighted);
		assert.match(screen.getByRole("status").textContent ?? "", /第 5–5 行/);
	});

	it("keeps frontmatter readable without changing the cited paragraph's source lines", () => {
		const content = `---\naliases: [资料别名]\n---\n${sourceContent}`;
		render(<EvidenceReader drawer={evidenceDrawer(selection, "frontmatter", { result: { path: citation.path, kind: "raw", content, locationStatus: "exact", startLine: 8, endLine: 8, fileHash: citation.fileHash } })} />);
		assert.match(document.querySelector(".evidence-frontmatter pre")?.textContent ?? "", /aliases: \[资料别名\]/);
		assert.equal(screen.getAllByRole("heading").some((heading) => heading.textContent?.includes("aliases")), false);
		const paragraph = screen.getByText("原始段落。");
		assert.equal(paragraph.getAttribute("data-source-start"), "8");
		assert.equal(paragraph.getAttribute("data-evidence-highlight"), "true");
		assert.equal(document.activeElement, paragraph);
	});

	it("shows the original quotation without stale highlights when source changed, and safely renders text", () => {
		render(<EvidenceReader drawer={evidenceDrawer({ ...selection, citation: { ...citation, path: "raw/guide.txt" } }, "request-2", { result: { path: "raw/guide.txt", kind: "raw", content: "<script>alert('unsafe')</script>\n不同原文", locationStatus: "changed", startLine: null, endLine: null, fileHash: "c".repeat(64) } })} />);
		assert.ok(screen.getByText("原文已变化"));
		assert.ok(screen.getByText("原始段落。"));
		assert.equal(document.querySelector("[data-evidence-highlight]"), null);
		assert.equal(document.querySelector("script"), null);
		assert.ok(screen.getByText("<script>alert('unsafe')</script>"));
	});

	it("rejects late read results across KBs, conversations, requests, and closed drawers", () => {
		const current = evidenceDrawer(selection, "request-1");
		assert.equal(shouldApplyEvidenceResult(current, selection, "request-1"), true);
		for (const stale of [{ ...selection, kbPath: "/kb/b" }, { ...selection, conversationId: "conversation-b" }]) assert.equal(shouldApplyEvidenceResult(current, stale, "request-1"), false);
		assert.equal(shouldApplyEvidenceResult(current, selection, "request-2"), false);
		assert.equal(shouldApplyEvidenceResult({ mode: "closed" }, selection, "request-1"), false);
	});

	it("restores history citations and per-message modes; sends bound mode and disables changing while streaming", async () => {
		let body: unknown;
		let finish: (() => void) | undefined;
		const enc = new TextEncoder();
		globalThis.fetch = (async (url, init) => {
			if (String(url) !== "/api/prompt") return new Response(JSON.stringify({ ok: true, data: [] }));
			body = JSON.parse(String(init?.body));
			return new Response(new ReadableStream({ start(controller) {
				const event = (type: string, seq: number, extra = {}) => controller.enqueue(enc.encode(`event: ${type}\ndata: ${JSON.stringify({ schemaVersion: 1, runId: "run", messageId: "message", seq, type, ...extra })}\n\n`));
				event("assistant_evidence", 1, { mode: "sources-only", evidence: [citation] });
				event("assistant_text_delta", 2, { delta: "新回答 [1](#evidence-E1)" });
				finish = () => { event("assistant_done", 3); controller.close(); };
			} }));
		}) as typeof fetch;
		const opened: string[] = [];
		render(<TooltipProvider><ChatPanel currentKnowledgeBaseName="示例库" currentKnowledgeBasePath="/kb/a" conversationId="conversation-a" initialMessages={[
			{ id: "old", role: "assistant", content: "旧回答 [1](#evidence-E1)", tools: [], evidence: [citation], retrievalMode: "knowledge" },
			{ id: "legacy", role: "assistant", content: "兼容旧历史。", tools: [] },
		]} onOpenEvidence={(item) => opened.push(`${item.kbPath}:${item.conversationId}:${item.citation.path}`)} /></TooltipProvider>);
		await click(screen.getByRole("button", { name: /查看出处 1/ }));
		assert.deepEqual(opened, ["/kb/a:conversation-a:raw/guide.md"]);
		await click(screen.getByRole("radio", { name: "仅原文" }));
		assert.match(document.querySelector(".message-retrieval-mode")?.textContent ?? "", /知识综合/);
		await changeText(screen.getByPlaceholderText(/写下想法/), "支付如何处理？");
		await click(screen.getByRole("button", { name: "发送" }));
		await waitFor(() => assert.equal(screen.getByRole("radio", { name: "知识综合" }).closest("fieldset")?.disabled, true));
		assert.deepEqual(body, { message: "支付如何处理？", retrievalMode: "sources-only", kbPath: "/kb/a", conversationId: "conversation-a" });
		await waitFor(() => assert.equal(screen.getAllByRole("button", { name: /查看出处 1/ }).length, 2));
		await act(async () => finish?.());
		await waitFor(() => assert.equal(screen.getByRole("radio", { name: "知识综合" }).closest("fieldset")?.disabled, false));
		assert.deepEqual(Array.from(document.querySelectorAll(".message-retrieval-mode"), (node) => node.textContent), ["知识综合", "仅原文"]);
	});
});
