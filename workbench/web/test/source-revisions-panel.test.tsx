import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { act } from "@testing-library/react";
import type { CreateSourceCandidatesBody } from "@llm-wiki/workbench-contracts";
import { SourceRevisionsPanel } from "../src/components/SourceRevisionsPanel";
import { IngestQueuePanel } from "../src/components/IngestQueuePanel";
import { changeText, click, render, screen, waitFor, within } from "./render";
import { candidate, check, data, deferred, fakeApi, jobId } from "./source-revisions-fixtures";

describe("source revision review UI", () => {
	it("checks only after choosing or confirming a directory and keeps deleted/unchanged rows unselectable", async () => {
		const calls: string[] = [];
		const creates: CreateSourceCandidatesBody[] = [];
		const api = fakeApi({ chooseDirectory: async () => { calls.push("choose"); return "/source"; }, check: async () => { calls.push("check"); return check(); }, create: async (body) => { creates.push(body); return [candidate()]; } });
		render(<SourceRevisionsPanel kbPath="/a" api={api} />);
		await waitFor(() => assert.ok(screen.getByRole("button", { name: "确认并检查目录：/素材 目录" })));
		assert.deepEqual(calls, []);
		await click(screen.getByRole("button", { name: "检查 Markdown 变化" }));
		await waitFor(() => assert.ok(screen.getByLabelText("选择 added.md")));
		assert.deepEqual(calls, ["choose", "check"]);
		assert.equal(screen.getByLabelText("选择 deleted.md").hasAttribute("disabled"), true);
		assert.equal(screen.getByLabelText("选择 unchanged.md").hasAttribute("disabled"), true);
		await click(screen.getByLabelText("选择 modified.md"));
		await click(screen.getByRole("button", { name: "为选中变化生成候选（1）" }));
		await waitFor(() => assert.equal(creates.length, 1));
		assert.equal(creates[0].type, "changes");
		if (creates[0].type === "changes") assert.deepEqual(creates[0].changeIds, ["modified"]);
		await changeText(screen.getByLabelText("筛选素材路径"), "deleted");
		assert.equal(screen.queryByLabelText("选择 added.md"), null);
	});
	it("regenerates a completed legacy task from its retained snapshot with stable request identity on retry", async () => {
		const creates: CreateSourceCandidatesBody[] = [];
		const api = fakeApi({ create: async (body) => { creates.push(body); if (creates.length === 1) throw Error("连接中断"); return [candidate()]; } });
		render(<SourceRevisionsPanel kbPath="/a" api={api} regenerateTarget={{ jobId, fileId: "legacy", name: "旧任务.md" }} />);
		const form = within(screen.getByLabelText("重新生成素材摘要"));
		await changeText(form.getByLabelText("摘要改进要求"), "保留边界条件");
		await click(form.getByRole("button", { name: "生成摘要候选" }));
		await waitFor(() => assert.ok(screen.getByText("连接中断")));
		await click(form.getByRole("button", { name: "生成摘要候选" }));
		await waitFor(() => assert.equal(creates.length, 2));
		assert.equal(creates[0].requestId, creates[1].requestId);
		assert.equal(creates[1].feedback, "保留边界条件");
		assert.deepEqual(creates[1].type === "regenerate" && creates[1].target, { type: "ingest-file", jobId, fileId: "legacy" });
	});
	it("presents read-only source and summary comparisons, requiring explicit review before adopting", async () => {
		const calls: string[] = [];
		let adopted = false;
		const api = fakeApi({ list: async () => data("/a", adopted ? "v2" : "v1", adopted ? 2 : 1, adopted ? "adopted" : "ready"), action: async (action) => { calls.push(action); adopted = true; return candidate("/a", 2, "adopted"); } });
		render(<SourceRevisionsPanel kbPath="/a" api={api} />);
		await waitFor(() => assert.ok(screen.getByRole("button", { name: "查看对照" })));
		await click(screen.getByRole("button", { name: "查看对照" }));
		await waitFor(() => assert.ok(screen.getByText("新摘要")));
		assert.ok(screen.getByText("旧原文")); assert.ok(screen.getByText("新原文"));
		assert.equal(screen.getByRole("button", { name: "确认采用此候选" }).hasAttribute("disabled"), true);
		assert.deepEqual(calls, []);
		await click(screen.getByLabelText("已核对原文与摘要对照"));
		await click(screen.getByRole("button", { name: "确认采用此候选" }));
		await waitFor(() => assert.deepEqual(calls, ["adopt"]));
		await waitFor(() => assert.equal(screen.queryByRole("button", { name: "确认采用此候选" }), null));
	});
	it("shows saving honestly, offers retry only for failed/cancelled candidates, and never auto-adopts", async () => {
		const actions: string[] = [];
		const saving = { ...candidate("/a", 1, "adopting"), id: "saving", name: "保存.md" };
		const failed = { ...candidate("/a", 1, "failed"), id: "failed", name: "失败.md", error: "模型请求失败" };
		const ready = { ...candidate(), id: "ready", name: "待确认.md" };
		const api = fakeApi({ list: async () => ({ ...data(), candidates: [saving, failed, ready] }), action: async (action, id) => { actions.push(`${action}:${id}`); return { ...candidate("/a", 2, action === "retry" ? "pending" : "cancelled"), id }; } });
		render(<SourceRevisionsPanel kbPath="/a" api={api} />);
		await waitFor(() => assert.ok(screen.getByLabelText("摘要候选 保存.md")));
		const savingCard = within(screen.getByLabelText("摘要候选 保存.md"));
		assert.equal(savingCard.queryByRole("button", { name: "取消候选" }), null);
		assert.ok(savingCard.getByText(/正在保存，无法承诺取消/));
		await click(within(screen.getByLabelText("摘要候选 失败.md")).getByRole("button", { name: "重试候选" }));
		await click(within(screen.getByLabelText("摘要候选 待确认.md")).getByRole("button", { name: "取消候选" }));
		await waitFor(() => assert.deepEqual(actions, ["retry:failed", "cancel:ready"]));
	});
	it("opens version history on demand and reads and compares immutable historical content", async () => {
		const reads: string[] = [];
		const api = fakeApi({ version: async (_kb, id) => { reads.push(id); return { version: { id, sourceId: "source", action: "modified", rawHash: "raw", summaryHash: "summary", rawPath: "raw/x.md", summaryPath: "wiki/sources/x.md", model: null, createdAt: "2026-10-31T00:00:00Z" }, original: { text: `${id} 原文`, hash: "raw" }, summary: { text: `${id} 摘要`, hash: "summary" }, truncated: true }; } });
		render(<SourceRevisionsPanel kbPath="/a" api={api} />);
		await waitFor(() => assert.ok(screen.getByRole("button", { name: "版本历史", exact: true })));
		assert.deepEqual(reads, []);
		await click(screen.getByRole("button", { name: "版本历史", exact: true }));
		await waitFor(() => assert.ok(screen.getByRole("button", { name: "查看版本 v1", exact: true })));
		await click(screen.getByRole("button", { name: "查看版本 v1", exact: true }));
		await waitFor(() => assert.ok(screen.getByText("v1 摘要")));
		await click(screen.getByRole("button", { name: "与所选版本比较 v2", exact: true }));
		await waitFor(() => assert.ok(screen.getByText("v2 原文")));
		assert.deepEqual(reads, ["v1", "v2"]);
		assert.ok(screen.getAllByText(/对照已截断/).length > 0);
		assert.equal(screen.queryByRole("button", { name: /恢复|采用/ }), null);
	});
	it("does not re-open comparison after the user closes while content is loading", async () => {
		const detail = deferred<Awaited<ReturnType<ReturnType<typeof fakeApi>["detail"]>>>();
		const api = fakeApi({ detail: () => detail.promise });
		render(<SourceRevisionsPanel kbPath="/a" api={api} />);
		await waitFor(() => assert.ok(screen.getByRole("button", { name: "查看对照" })));
		await click(screen.getByRole("button", { name: "查看对照" }));
		await click(screen.getByRole("button", { name: "关闭版本详情" }));
		await act(async () => { detail.resolve(await fakeApi().detail("/a", "candidate")); });
		assert.equal(screen.queryByLabelText("素材版本详情"), null);
	});
	it("renders explicit regeneration for completed legacy queue files without requiring a sourceId", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input) => new Response(JSON.stringify({ ok: true, data: String(input).includes("models") ? [] : String(input).includes("config") ? { version: 1, externalKnowledgeBases: [] } : { directories: [], sources: [], candidates: [] } }), { status: 200, headers: { "Content-Type": "application/json" } });
		try {
			render(<IngestQueuePanel open kbPath="/a" knowledgeBaseName="A" jobs={[{ id: jobId, kbPath: "/a", revision: 1, createdAt: "2026-10-31T00:00:00Z", updatedAt: "2026-10-31T00:00:00Z", concurrency: 1, status: "completed", files: [{ id: "old", name: "旧任务.md", status: "completed", attempts: 1, progressChars: 1, outputPath: "wiki/sources/old.md", error: null }] }]} loading={false} error={null} actionError={null} pendingIds={[]} onClose={() => {}} onCancel={() => {}} onRetry={() => {}} onRefresh={() => {}} onOpenOutput={() => {}} />);
			await click(screen.getByRole("button", { name: "重新生成 旧任务.md 的摘要" }));
			assert.ok(screen.getByLabelText("重新生成素材摘要"));
		} finally { globalThis.fetch = originalFetch; }
	});
});
