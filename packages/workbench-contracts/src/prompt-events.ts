import { z } from "zod";
import { EvidenceCitationsSchema, RetrievalModeSchema } from "./evidence.js";

import { ArtifactKindSchema } from "./artifacts.js";
import { ErrorDetailsSchema, WorkbenchErrorCodeSchema } from "./errors.js";
import {
	RunSseEventIdentitySchema,
	WORKBENCH_SSE_SCHEMA_VERSION,
} from "./sse.js";

export const PROMPT_SSE_SCHEMA_VERSION = WORKBENCH_SSE_SCHEMA_VERSION;

export const PromptRequestBodySchema = z.object({
	message: z.string().trim().min(1),
		retrievalMode: RetrievalModeSchema.optional(),
		kbPath: z.string().trim().min(1).max(4096).optional(),
		conversationId: z.string().trim().min(1).max(512).optional(),
}).strict();
export type PromptRequestBody = z.infer<typeof PromptRequestBodySchema>;

const PromptEventIdentitySchema = RunSseEventIdentitySchema.extend({
	messageId: z.string().min(1),
});

const ToolDisplaySchema = z.object({
	toolCallId: z.string().min(1),
	toolName: z.string().min(1),
	action: z.string(),
	target: z.string(),
});

const RunningCountsSchema = z.object({
	runningToolCount: z.number().int().nonnegative(),
	otherRunningCount: z.number().int().nonnegative(),
});

export const AssistantTextDeltaEventSchema = PromptEventIdentitySchema.extend({
	type: z.literal("assistant_text_delta"),
	delta: z.string(),
}).strict();

export const AssistantEvidenceEventSchema = PromptEventIdentitySchema.extend({
	type: z.literal("assistant_evidence"),
	mode: RetrievalModeSchema,
	evidence: EvidenceCitationsSchema,
}).strict();

export const ToolStatusStartEventSchema = PromptEventIdentitySchema
	.extend({
		type: z.literal("tool_status_start"),
		...ToolDisplaySchema.shape,
		status: z.literal("running"),
		args: z.record(z.string(), z.unknown()),
		...RunningCountsSchema.shape,
	})
	.strict();

export const ToolStatusUpdateEventSchema = PromptEventIdentitySchema
	.extend({
		type: z.literal("tool_status_update"),
		...ToolDisplaySchema.shape,
		status: z.literal("running"),
		args: z.record(z.string(), z.unknown()),
		detail: z.unknown(),
		...RunningCountsSchema.shape,
	})
	.strict();

const CompletedToolStatusSchema = z.enum(["done", "failed", "cancelled"]);

export const ToolStatusEndEventSchema = PromptEventIdentitySchema
	.extend({
		type: z.literal("tool_status_end"),
		...ToolDisplaySchema.shape,
		status: CompletedToolStatusSchema,
		result: z.unknown(),
		summary: z.string().nullable(),
		error: z.string().nullable(),
		durationMs: z.number().nonnegative(),
		...RunningCountsSchema.shape,
	})
	.strict();

export const ToolStatusSummaryEventSchema = PromptEventIdentitySchema.extend({
	type: z.literal("tool_status_summary"),
	items: z.array(
		ToolDisplaySchema.extend({
			status: CompletedToolStatusSchema,
			summary: z.string().nullable(),
		}).strict(),
	),
	remainingRunningCount: z.number().int().nonnegative(),
}).strict();

export const ArtifactCreatedPromptEventSchema = PromptEventIdentitySchema.extend({
	type: z.literal("artifact_created"),
	id: z.string().min(1),
	kind: ArtifactKindSchema,
	title: z.string(),
}).strict();

export const AssistantDoneEventSchema = PromptEventIdentitySchema.extend({
	type: z.literal("assistant_done"),
}).strict();

export const AssistantCancelledEventSchema = PromptEventIdentitySchema.extend({
	type: z.literal("assistant_cancelled"),
	reason: z.string(),
}).strict();

export const AssistantErrorEventSchema = PromptEventIdentitySchema.extend({
	type: z.literal("assistant_error"),
	code: WorkbenchErrorCodeSchema,
	message: z.string().min(1),
	details: ErrorDetailsSchema.optional(),
}).strict();

export const PromptSseEventSchema = z.discriminatedUnion("type", [
	AssistantEvidenceEventSchema,
	AssistantTextDeltaEventSchema,
	ToolStatusStartEventSchema,
	ToolStatusUpdateEventSchema,
	ToolStatusEndEventSchema,
	ToolStatusSummaryEventSchema,
	ArtifactCreatedPromptEventSchema,
	AssistantDoneEventSchema,
	AssistantCancelledEventSchema,
	AssistantErrorEventSchema,
]);

export type PromptSseEvent = z.infer<typeof PromptSseEventSchema>;
export type AssistantTextDeltaEvent = z.infer<typeof AssistantTextDeltaEventSchema>;
export type AssistantEvidenceEvent = z.infer<typeof AssistantEvidenceEventSchema>;
export type ToolStatusStartEvent = z.infer<typeof ToolStatusStartEventSchema>;
export type ToolStatusUpdateEvent = z.infer<typeof ToolStatusUpdateEventSchema>;
export type ToolStatusEndEvent = z.infer<typeof ToolStatusEndEventSchema>;
export type ToolStatusSummaryEvent = z.infer<typeof ToolStatusSummaryEventSchema>;
export type ArtifactCreatedPromptEvent = z.infer<typeof ArtifactCreatedPromptEventSchema>;
export type AssistantDoneEvent = z.infer<typeof AssistantDoneEventSchema>;
export type AssistantCancelledEvent = z.infer<typeof AssistantCancelledEventSchema>;
export type AssistantErrorEvent = z.infer<typeof AssistantErrorEventSchema>;

export const PROMPT_SSE_EVENT_TYPES = PromptSseEventSchema.options.map(
	(schema) => schema.shape.type.value,
);

export const PROMPT_SSE_TERMINAL_EVENT_TYPES = [
	"assistant_done",
	"assistant_cancelled",
	"assistant_error",
] as const satisfies readonly PromptSseEvent["type"][];

const PROMPT_TERMINAL_EVENT_TYPE_SET = new Set<PromptSseEvent["type"]>(
	PROMPT_SSE_TERMINAL_EVENT_TYPES,
);

export type PromptTerminalEvent = Extract<
	PromptSseEvent,
	{ type: (typeof PROMPT_SSE_TERMINAL_EVENT_TYPES)[number] }
>;

export function isPromptTerminalEvent(
	event: Pick<PromptSseEvent, "type">,
): event is PromptTerminalEvent {
	return PROMPT_TERMINAL_EVENT_TYPE_SET.has(event.type);
}
