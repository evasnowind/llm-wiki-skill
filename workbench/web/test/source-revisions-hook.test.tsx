import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { act } from "@testing-library/react";
import type { SourceCandidateDetail, SourceRevisionsData } from "@llm-wiki/workbench-contracts";
import { useSourceRevisions, type SourceRevisionsApi } from "../src/lib/use-source-revisions";
import { click, render, screen, waitFor } from "./render";
import { candidate, data, deferred, fakeApi } from "./source-revisions-fixtures";

describe("source revision subscriptions", () => {
	it("restores only persisted metadata and never scans, generates, adopts or cancels on mount/remount", async () => {
		const calls: string[] = [];
		const api = fakeApi({ check: async () => { calls.push("scan"); throw Error(); }, create: async () => { calls.push("generate"); return []; }, action: async () => { calls.push("write"); return candidate(); }, chooseDirectory: async () => { calls.push("choose"); return null; } });
		const view = render(<Harness kb="/a" api={api} />);
		await waitFor(() => assert.match(screen.getByTestId("data").textContent!, /ready/));
		view.unmount();
		render(<Harness kb="/a" api={api} />);
		await waitFor(() => assert.match(screen.getByTestId("data").textContent!, /ready/));
		assert.deepEqual(calls, []);
	});
	it("requires a fresh directory choice or explicit registered-directory confirmation for every check", async () => {
		const calls: string[] = [];
		const api = fakeApi({ chooseDirectory: async () => { calls.push("choose"); return "/picked"; }, inspect: async (path) => { calls.push(`inspect:${path}`); return { exists: true, isDirectory: true, hasWikiSchema: false, ingestibleFiles: { scanId: "fresh", count: 1, paths: [], samples: [], truncated: false } }; }, check: async (body) => { calls.push(`check:${body.sourceScanId}`); return { ...dataToCheck(), directoryPath: "/picked" }; } });
		render(<Harness kb="/a" api={api} />);
		await click(screen.getByRole("button", { name: "choose" }));
		await waitFor(() => assert.equal(calls.length, 3));
		await click(screen.getByRole("button", { name: "registered" }));
		await waitFor(() => assert.equal(calls.length, 5));
		assert.deepEqual(calls, ["choose", "inspect:/picked", "check:fresh", "inspect:/confirmed", "check:fresh"]);
	});
	it("invalidates in-flight GETs after adoption so old source heads cannot overwrite adopted versions", async () => {
		const old = deferred<SourceRevisionsData>();
		let reads = 0;
		const api = fakeApi({ list: async () => ++reads === 1 ? data() : reads === 2 ? old.promise : data("/a", "v2", 2, "adopted") });
		render(<Harness kb="/a" api={api} />);
		await waitFor(() => assert.match(screen.getByTestId("data").textContent!, /"currentVersionId":"v1"/));
		await click(screen.getByRole("button", { name: "refresh" }));
		await click(screen.getByRole("button", { name: "adopt" }));
		await waitFor(() => assert.match(screen.getByTestId("data").textContent!, /"currentVersionId":"v2"/));
		await act(async () => { old.resolve(data("/a", "v1", 1)); });
		assert.match(screen.getByTestId("data").textContent!, /"currentVersionId":"v2"/);
		assert.match(screen.getByTestId("data").textContent!, /adopted/);
	});
	it("rejects delayed A reads and operations after A to B to A", async () => {
		const old = deferred<SourceRevisionsData>();
		const lateAction = deferred<ReturnType<typeof candidate>>();
		let readsA = 0;
		const api = fakeApi({ list: async (kb) => kb === "/a" && ++readsA === 1 ? old.promise : data(kb, "v7", 7), action: () => lateAction.promise });
		const view = render(<Harness kb="/a" api={api} />);
		await click(screen.getByRole("button", { name: "adopt" }));
		view.rerender(<Harness kb="/b" api={api} />);
		await waitFor(() => assert.match(screen.getByTestId("data").textContent!, /\/b/));
		view.rerender(<Harness kb="/a" api={api} />);
		await waitFor(() => assert.match(screen.getByTestId("data").textContent!, /v7/));
		await act(async () => { old.resolve(data("/a", "v99", 99)); lateAction.resolve(candidate("/a", 99, "adopted")); });
		assert.doesNotMatch(screen.getByTestId("data").textContent!, /v99|"status":"adopted"/);
	});
	it("closing a comparison invalidates its delayed response", async () => {
		const detail = deferred<SourceCandidateDetail>();
		const api = fakeApi({ detail: () => detail.promise });
		render(<Harness kb="/a" api={api} />);
		await click(screen.getByRole("button", { name: "detail" }));
		await click(screen.getByRole("button", { name: "close" }));
		await act(async () => { detail.resolve(await fakeApi().detail("/a", "candidate")); });
		assert.equal(screen.getByTestId("reading").textContent, "null");
	});
	it("rejects a same-KB detail returned for a different candidate identity", async () => {
		const original = await fakeApi().detail("/a", "candidate");
		const api = fakeApi({ detail: async () => ({ ...original, candidate: { ...original.candidate, id: "other" } }) });
		render(<Harness kb="/a" api={api} />);
		await click(screen.getByRole("button", { name: "detail" }));
		await waitFor(() => assert.match(screen.getByTestId("errors").textContent!, /身份/));
		assert.equal(screen.getByTestId("reading").textContent, "null");
	});
	it("retains candidates through connection failure and exposes action failure separately", async () => {
		let reads = 0;
		const api = fakeApi({ list: async () => { if (++reads > 1) throw Error("offline"); return data(); }, action: async () => { throw Error("摘要被外部修改，请重新核对"); } });
		render(<Harness kb="/a" api={api} />);
		await waitFor(() => assert.match(screen.getByTestId("data").textContent!, /ready/));
		await click(screen.getByRole("button", { name: "refresh" }));
		await waitFor(() => assert.match(screen.getByTestId("errors").textContent!, /连接暂时中断/));
		assert.match(screen.getByTestId("data").textContent!, /ready/);
		await click(screen.getByRole("button", { name: "adopt" }));
		await waitFor(() => assert.match(screen.getByTestId("errors").textContent!, /外部修改/));
	});
	it("deduplicates double-click mutations while preserving the revision guard", async () => {
		const pending = deferred<ReturnType<typeof candidate>>();
		let calls = 0;
		const api = fakeApi({ action: async (_action, _id, body) => { calls++; assert.equal(body.expectedRevision, 1); return pending.promise; } });
		render(<Harness kb="/a" api={api} />);
		await click(screen.getByRole("button", { name: "adopt" }));
		await click(screen.getByRole("button", { name: "adopt" }));
		assert.equal(calls, 1);
		await act(async () => { pending.resolve(candidate("/a", 2, "adopting")); });
	});
});
function Harness({ kb, api }: { kb: string; api: SourceRevisionsApi }) {
	const state = useSourceRevisions(kb, api, 60_000);
	return <><div data-testid="data">{JSON.stringify(state.data)}</div><div data-testid="reading">{JSON.stringify(state.reading)}</div><div data-testid="errors">{state.error} {state.actionError} {state.readError}</div>
		<button onClick={() => { void state.refresh(); }}>refresh</button><button onClick={() => { void state.action(candidate(kb), "adopt").catch(() => {}); }}>adopt</button>
		<button onClick={() => { void state.checkDirectory().catch(() => {}); }}>choose</button><button onClick={() => { void state.checkDirectory("/confirmed").catch(() => {}); }}>registered</button>
		<button onClick={() => { void state.openReading("candidate", "candidate"); }}>detail</button><button onClick={state.closeReading}>close</button></>;
}
function dataToCheck() { return { id: "check", kbPath: "/a", directoryId: "dir", directoryPath: "/dir", createdAt: "2026-10-31T00:00:00Z", complete: true, warnings: [], changes: [] }; }
