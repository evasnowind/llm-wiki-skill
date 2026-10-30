import {
	ArtifactCreatedPromptEventSchema,
	AssistantCancelledEventSchema,
	AssistantDoneEventSchema,
	AssistantErrorEventSchema,
	AssistantEvidenceEventSchema,
	FailureEnvelopeSchema,
	PROMPT_SSE_EVENT_TYPES,
	PROMPT_SSE_SCHEMA_VERSION,
	PROMPT_SSE_TERMINAL_EVENT_TYPES,
	PromptRequestBodySchema,
	ToolStatusEndEventSchema,
	ToolStatusStartEventSchema,
	ToolStatusSummaryEventSchema,
	ToolStatusUpdateEventSchema,
	type PromptSseEvent,
	type RetrievalMode,
} from "@llm-wiki/workbench-contracts";

import { parseSSE } from "../sse";
import { ApiError } from "./client";
import {
	parseSseJson,
	RecoverableSseProtocolError,
	SseLifecycleGuard,
} from "./sse-contract";

export class PromptProtocolError extends RecoverableSseProtocolError {
	constructor(message: string) {
		super(message);
		this.name = "PromptProtocolError";
	}
}

export async function streamPrompt(
	message: string,
	signal?: AbortSignal,
	context?: { retrievalMode: RetrievalMode; kbPath: string; conversationId: string },
): Promise<AsyncGenerator<PromptSseEvent, void, undefined>> {
	const body = PromptRequestBodySchema.parse({ message, ...context });
	const response = await fetch("/api/prompt", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal,
	});

	if (!response.ok) {
		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			throw new PromptProtocolError("启动请求失败，响应不符合统一错误契约");
		}
		const failure = FailureEnvelopeSchema.safeParse(payload);
		if (!failure.success) {
			throw new PromptProtocolError("启动请求失败，响应不符合统一错误契约");
		}
		throw new ApiError(failure.data);
	}
	if (!response.body) {
		throw new PromptProtocolError("回复流缺少响应内容");
	}
	return parsePromptEvents(response.body);
}

export async function* parsePromptEvents(
	stream: ReadableStream<Uint8Array>,
): AsyncGenerator<PromptSseEvent, void, undefined> {
	const guard = new SseLifecycleGuard({
		schemaVersion: PROMPT_SSE_SCHEMA_VERSION,
		eventTypes: PROMPT_SSE_EVENT_TYPES,
		identityFields: ["runId", "messageId"],
		terminalEventTypes: PROMPT_SSE_TERMINAL_EVENT_TYPES,
		requireTerminal: true,
		eventName: "matches-type",
		error: promptProtocolError,
	});

	for await (const message of parseSSE(stream)) {
		const value = parseSseJson(message.data, promptProtocolError);
		const record = guard.accept(value, message.event);
		yield parsePromptEvent(record);
	}
	guard.finish();
}

function parsePromptEvent(value: Record<string, unknown>): PromptSseEvent {
	if (value.type === "assistant_text_delta") {
		if (typeof value.delta !== "string") {
			throw new PromptProtocolError("文本增量事件缺少 delta");
		}
		return value as PromptSseEvent;
	}
	const schema = promptEventSchema(
		value.type as Exclude<PromptSseEvent["type"], "assistant_text_delta">,
	);
	const parsed = schema.safeParse(value);
	if (!parsed.success) {
		throw new PromptProtocolError("回复流事件缺少必要字段或不符合契约");
	}
	return parsed.data;
}

function promptEventSchema(type: Exclude<PromptSseEvent["type"], "assistant_text_delta">) {
	switch (type) {
		case "tool_status_start":
			return ToolStatusStartEventSchema;
		case "tool_status_update":
			return ToolStatusUpdateEventSchema;
		case "tool_status_end":
			return ToolStatusEndEventSchema;
		case "tool_status_summary":
			return ToolStatusSummaryEventSchema;
		case "artifact_created":
			return ArtifactCreatedPromptEventSchema;
		case "assistant_evidence":
			return AssistantEvidenceEventSchema;
		case "assistant_done":
			return AssistantDoneEventSchema;
		case "assistant_cancelled":
			return AssistantCancelledEventSchema;
		case "assistant_error":
			return AssistantErrorEventSchema;
	}
}

function promptProtocolError(message: string): PromptProtocolError {
	return new PromptProtocolError(message);
}
