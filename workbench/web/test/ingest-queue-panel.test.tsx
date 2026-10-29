import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import type { IngestJob } from "@llm-wiki/workbench-contracts";

import { IngestQueuePanel } from "../src/components/IngestQueuePanel";
import { click, render, screen } from "./render";

describe("reliable ingest Paper panel", () => {
	it("shows per-file outcomes and invokes only explicit cancel or retry actions", async () => {
		const calls: string[] = [];
		const job = fixture();
		render(<IngestQueuePanel
			open knowledgeBaseName="示例知识库" jobs={[job]} loading={false} error={null} actionError={null} pendingIds={[]}
			onClose={() => calls.push("close")} onRefresh={() => calls.push("refresh")}
			onCancel={(id) => calls.push(`cancel:${id}`)} onRetry={(id) => calls.push(`retry:${id}`)}
			onOpenOutput={(kb, path) => calls.push(`${kb}:${path}`)}
		/>);
		assert.match(screen.getByLabelText("入库任务").className, /batch-panel/);
		assert.ok(screen.getByText("示例知识库"));
		assert.ok(screen.getByText(/第 2 次处理/));
		assert.ok(screen.getByText(/保存中，约/));
		assert.match(screen.getByLabelText("入库进度 50%").className, /batch-progress/);
		await click(screen.getByRole("button", { name: "打开 完成.md 的素材摘要" }));
		await click(screen.getByRole("button", { name: "关闭入库面板" }));
		assert.deepEqual(calls, ["/kb:wiki/sources/completed.md", "close"]);
		await click(screen.getByRole("button", { name: "取消未完成项" }));
		await click(screen.getByRole("button", { name: "重试失败或取消项" }));
		assert.deepEqual(calls.slice(2), [`cancel:${job.id}`, `retry:${job.id}`]);
	});

	it("hides without cancelling and keeps network errors separate from task failure", () => {
		const job = fixture();
		const props = {
			knowledgeBaseName: "示例知识库", jobs: [job], loading: false,
			error: "暂时无法更新任务状态，连接恢复后会自动更新。", actionError: null, pendingIds: [job.id],
			onClose() {}, onRefresh() {}, onCancel() { throw new Error("unexpected cancellation"); }, onRetry() {}, onOpenOutput() {},
		};
		const view = render(<IngestQueuePanel {...props} open={false} />);
		assert.equal(screen.queryByLabelText("入库任务"), null);
		view.rerender(<IngestQueuePanel {...props} open />);
		assert.ok(screen.getByText("暂时无法更新任务状态，连接恢复后会自动更新。"));
		assert.equal(screen.getByRole("button", { name: "取消未完成项" }).hasAttribute("disabled"), true);
		assert.equal(job.files[2]?.status, "running");
	});
});

function fixture(): IngestJob {
	return {
		id: "11111111-1111-4111-8111-111111111111", kbPath: "/kb", revision: 3,
		createdAt: "2026-10-29T01:00:00.000Z", updatedAt: "2026-10-29T01:00:01.000Z", concurrency: 3, status: "running",
		files: [
			{ id: "1", name: "完成.md", status: "completed", attempts: 1, progressChars: 300, outputPath: "wiki/sources/completed.md", error: null },
			{ id: "2", name: "失败.md", status: "failed", attempts: 2, progressChars: 0, outputPath: null, error: "服务暂不可用" },
			{ id: "3", name: "处理中.md", status: "running", attempts: 1, progressChars: 80, outputPath: null, error: null },
			{ id: "4", name: "保存中.md", status: "committing", attempts: 1, progressChars: 120, outputPath: null, error: null },
		],
	};
}
