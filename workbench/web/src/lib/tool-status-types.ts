import type { PromptSseEvent } from "@llm-wiki/workbench-contracts";

export type ToolRunStatus = "running" | "done" | "failed" | "cancelled";

export interface ToolDisplay {
	toolCallId: string;
	toolName: string;
	action: string;
	target: string;
}

export type ToolStatusContractEvent = Exclude<
	PromptSseEvent,
	{ type: "artifact_created" | "assistant_evidence" }
>;
