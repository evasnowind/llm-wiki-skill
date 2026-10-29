import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React, { useState } from "react";
import { act } from "@testing-library/react";
import type { IngestJob } from "@llm-wiki/workbench-contracts";

import { useIngestQueue, type IngestQueueApi } from "../src/lib/use-ingest-queue";
import { click, render, screen, waitFor } from "./render";

describe("persistent ingest subscriptions", () => {
	it("restores backend tasks on mount and remount without cancelling on hide", async () => {
		let cancelCalls = 0;
		let reads = 0;
		const api = fakeApi({
			list: async () => { reads++; return [fixture("/a")]; },
			cancel: async () => { cancelCalls++; return fixture("/a", 2, "cancelled"); },
		});
		const view = render(<Harness kbPath="/a" api={api} />);
		await waitFor(() => assert.match(screen.getByTestId("jobs").textContent ?? "", /running/));
		await click(screen.getByRole("button", { name: "hide" }));
		assert.equal(cancelCalls, 0);
		view.unmount();
		render(<Harness kbPath="/a" api={api} />);
		await waitFor(() => assert.match(screen.getByTestId("jobs").textContent ?? "", /running/));
		assert.equal(reads, 2);
		assert.equal(cancelCalls, 0);
	});

	it("clears the visible scope immediately and ignores delayed reads from an old KB selection", async () => {
		const oldRead = deferred<IngestJob[]>();
		const api = fakeApi({ list: (kbPath) => kbPath === "/a" ? oldRead.promise : Promise.resolve([fixture("/b")]) });
		const view = render(<Harness kbPath="/a" api={api} />);
		await act(async () => { await Promise.resolve(); });
		view.rerender(<Harness kbPath="/b" api={api} />);
		await waitFor(() => assert.match(screen.getByTestId("jobs").textContent ?? "", /\/b/));
		await act(async () => { oldRead.resolve([fixture("/a")]); });
		assert.doesNotMatch(screen.getByTestId("jobs").textContent ?? "", /\/a/);
		assert.match(screen.getByTestId("jobs").textContent ?? "", /\/b/);
	});

	it("does not regress a mutation result when an older poll arrives later", async () => {
		const latePoll = deferred<IngestJob[]>();
		let reads = 0;
		const api = fakeApi({
			list: async () => ++reads === 1 ? [fixture("/a", 1)] : latePoll.promise,
			cancel: async () => fixture("/a", 3, "cancelled"),
		});
		render(<Harness kbPath="/a" api={api} />);
		await waitFor(() => assert.match(screen.getByTestId("jobs").textContent ?? "", /running/));
		await click(screen.getByRole("button", { name: "refresh" }));
		await click(screen.getByRole("button", { name: "cancel" }));
		await waitFor(() => assert.match(screen.getByTestId("jobs").textContent ?? "", /cancelled/));
		await act(async () => { latePoll.resolve([fixture("/a", 2, "running")]); });
		assert.match(screen.getByTestId("jobs").textContent ?? "", /cancelled/);
		assert.match(screen.getByTestId("jobs").textContent ?? "", /"revision":3/);
	});

	it("does not reuse a delayed subscription when the user returns to the same KB", async () => {
		const firstA = deferred<IngestJob[]>();
		let aReads = 0;
		const api = fakeApi({ list: (kbPath) => {
			if (kbPath === "/a" && ++aReads === 1) return firstA.promise;
			return Promise.resolve([fixture(kbPath, 7, "completed")]);
		} });
		const view = render(<Harness kbPath="/a" api={api} />);
		await act(async () => { await Promise.resolve(); });
		view.rerender(<Harness kbPath="/b" api={api} />);
		await waitFor(() => assert.match(screen.getByTestId("jobs").textContent ?? "", /\/b/));
		view.rerender(<Harness kbPath="/a" api={api} />);
		await waitFor(() => assert.match(screen.getByTestId("jobs").textContent ?? "", /"revision":7/));
		await act(async () => { firstA.resolve([fixture("/a", 99, "running")]); });
		assert.match(screen.getByTestId("jobs").textContent ?? "", /"revision":7/);
		assert.doesNotMatch(screen.getByTestId("jobs").textContent ?? "", /running/);
	});

	it("keeps the last task state during disconnection and automatically recovers polling", async () => {
		let reads = 0;
		const api = fakeApi({
			list: async () => {
				reads++;
				if (reads === 1) return [fixture("/a", 1)];
				if (reads === 2) throw new Error("offline");
				return [fixture("/a", 2, "completed")];
			},
		});
		render(<Harness kbPath="/a" api={api} interval={80} />);
		await waitFor(() => assert.match(screen.getByTestId("error").textContent ?? "", /暂时无法更新任务状态/));
		assert.match(screen.getByTestId("jobs").textContent ?? "", /running/);
		await waitFor(() => assert.match(screen.getByTestId("jobs").textContent ?? "", /completed/));
		assert.equal(screen.getByTestId("error").textContent, "");
	});

	it("ignores a late mutation from another KB and surfaces scoped action errors", async () => {
		const lateCancel = deferred<IngestJob>();
		const api = fakeApi({
			list: async (kbPath) => [fixture(kbPath)],
			cancel: () => lateCancel.promise,
			retry: async () => { throw new Error("保存中，请刷新后再试"); },
		});
		const view = render(<Harness kbPath="/a" api={api} />);
		await waitFor(() => assert.match(screen.getByTestId("jobs").textContent ?? "", /\/a/));
		await click(screen.getByRole("button", { name: "cancel" }));
		view.rerender(<Harness kbPath="/b" api={api} />);
		await waitFor(() => assert.match(screen.getByTestId("jobs").textContent ?? "", /\/b/));
		await act(async () => { lateCancel.resolve(fixture("/a", 3, "cancelled")); });
		assert.doesNotMatch(screen.getByTestId("jobs").textContent ?? "", /cancelled/);
		await click(screen.getByRole("button", { name: "retry" }));
		await waitFor(() => assert.match(screen.getByTestId("action-error").textContent ?? "", /保存中/));
	});
});

function Harness({ kbPath, api, interval = 60_000 }: { kbPath: string; api: IngestQueueApi; interval?: number }) {
	const queue = useIngestQueue(kbPath, api, interval);
	const [visible, setVisible] = useState(true);
	return <>
		<div data-testid="jobs">{JSON.stringify(queue.jobs)}</div>
		<div data-testid="error">{queue.error}</div>
		<div data-testid="action-error">{queue.actionError}</div>
		<button onClick={() => setVisible((value) => !value)}>hide</button>
		{visible && <span>panel</span>}
		<button onClick={() => { void queue.refresh(); }}>refresh</button>
		<button onClick={() => { void queue.cancel("11111111-1111-4111-8111-111111111111").catch(() => {}); }}>cancel</button>
		<button onClick={() => { void queue.retry("11111111-1111-4111-8111-111111111111").catch(() => {}); }}>retry</button>
	</>;
}

function fakeApi(overrides: Partial<IngestQueueApi>): IngestQueueApi {
	return {
		list: async () => [], create: async () => fixture("/a"),
		cancel: async () => fixture("/a", 2, "cancelled"), retry: async () => fixture("/a", 3),
		...overrides,
	};
}

function fixture(kbPath: string, revision = 1, status: IngestJob["status"] = "running"): IngestJob {
	return {
		id: "11111111-1111-4111-8111-111111111111", kbPath, revision,
		createdAt: "2026-10-29T01:00:00.000Z", updatedAt: "2026-10-29T01:00:01.000Z", concurrency: 1, status,
		files: [{ id: "1", name: "材料.md", status, attempts: 1, progressChars: 30, outputPath: status === "completed" ? "wiki/sources/result.md" : null, error: null }],
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}
