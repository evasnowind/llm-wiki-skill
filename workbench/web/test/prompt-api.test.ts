import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { PromptSseEventSchema, type PromptSseEvent } from "@llm-wiki/workbench-contracts";

import { ApiError } from "../src/lib/api/client";
import { parsePromptEvents, PromptProtocolError, streamPrompt } from "../src/lib/api/prompt";
import { citation } from "./markdown-evidence-fixture";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("prompt API client", () => {
	it("sends the selected identity and mode, and validates scoped evidence before answer text", async () => {
		const fixture = [event("assistant_evidence", 1, { mode: "sources-only", evidence: [citation] }), event("assistant_text_delta", 2, { delta: "[1](#evidence-E1)" }), event("assistant_done", 3)];
		let body: unknown;
		globalThis.fetch = (async (_input, init) => { body = JSON.parse(String(init?.body)); return new Response(sseStream(fixture)); }) as typeof fetch;
		assert.deepEqual(await collect(await streamPrompt("question", undefined, { retrievalMode: "sources-only", kbPath: "/kb", conversationId: "conversation-1" })), fixture);
		assert.deepEqual(body, { message: "question", retrievalMode: "sources-only", kbPath: "/kb", conversationId: "conversation-1" });
		await assert.rejects(collect(parsePromptEvents(sseStream([event("assistant_done", 1), event("assistant_evidence", 2, { mode: "knowledge", evidence: [citation] })]))), PromptProtocolError);
		await assert.rejects(collect(parsePromptEvents(sseStream([event("assistant_evidence", 1, { mode: "knowledge", evidence: [{ ...citation, fileHash: "invalid" }] }), event("assistant_done", 2)]))), PromptProtocolError);
	});
	it("returns typed events and validates the full fixture with the shared schema", async () => {
		const fixture = [event("assistant_text_delta", 1, { delta: "部分" }), event("assistant_done", 2)];
		for (const item of fixture) PromptSseEventSchema.parse(item);

		const received = await collect(parsePromptEvents(sseStream(fixture)));
		assert.deepEqual(received, fixture);
	});

	it("turns a non-2xx failure envelope into ApiError", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ ok: false, code: "BUSY", message: "正在生成" }), {
				status: 409,
				headers: { "Content-Type": "application/json" },
			})) as typeof fetch;

		await assert.rejects(streamPrompt("hello"), (error: unknown) => {
			assert.ok(error instanceof ApiError);
			assert.equal(error.code, "BUSY");
			return true;
		});
	});

	it("keeps AbortError from an actively aborted request", async () => {
		globalThis.fetch = ((_input, init) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
			})) as typeof fetch;
		const controller = new AbortController();
		const request = streamPrompt("hello", controller.signal);
		controller.abort();
		await assert.rejects(request, (error: unknown) => error instanceof Error && error.name === "AbortError");
	});

		it("rejects a low-frequency event with missing required fields", async () => {
			const invalidArtifact = {
				schemaVersion: 1,
				type: "artifact_created",
				runId: "run-1",
				messageId: "message-1",
				seq: 1,
				id: "artifact-1",
				kind: "html",
			};
			await assert.rejects(
				collect(parsePromptEvents(sseStream([invalidArtifact as PromptSseEvent]))),
				(error: unknown) => error instanceof PromptProtocolError && error.recoverable,
			);
		});

		it("rejects an unknown event and unsupported schema version", async () => {
			for (const invalid of [
				{ ...event("assistant_done", 1), type: "unknown" },
				{ ...event("assistant_done", 1), schemaVersion: 2 },
			]) {
				await assert.rejects(
					collect(parsePromptEvents(sseStream([invalid as PromptSseEvent]))),
					(error: unknown) => error instanceof PromptProtocolError && error.recoverable,
				);
			}
		});

	for (const [name, fixture] of [
		["首事件不是 seq=1", [event("assistant_done", 2)]],
		["seq 不连续", [event("assistant_text_delta", 1, { delta: "部分" }), event("assistant_done", 3)]],
		["identity 改变", [event("assistant_text_delta", 1, { delta: "部分" }), event("assistant_done", 2, {}, "run-2")]],
		["terminal 后追加事件", [event("assistant_done", 1), event("assistant_done", 2)]],
		["EOF 缺少 terminal", [event("assistant_text_delta", 1, { delta: "部分" })]],
	] as const) {
		it(`rejects ${name} as a recoverable protocol error`, async () => {
			await assert.rejects(collect(parsePromptEvents(sseStream(fixture))), (error: unknown) => {
				assert.ok(error instanceof PromptProtocolError);
				assert.equal(error.recoverable, true);
				return true;
			});
		});
	}
});

function event(
	type: PromptSseEvent["type"],
	seq: number,
	extra: Record<string, unknown> = {},
	runId = "run-1",
): PromptSseEvent {
	return {
		schemaVersion: 1,
		type,
		runId,
		messageId: "message-1",
		seq,
		...extra,
	} as PromptSseEvent;
}

function sseStream(events: readonly PromptSseEvent[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const item of events) {
				controller.enqueue(encoder.encode(`event: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`));
			}
			controller.close();
		},
	});
}

async function collect<T>(stream: AsyncGenerator<T, void, undefined>): Promise<T[]> {
	const values: T[] = [];
	for await (const value of stream) values.push(value);
	return values;
}
