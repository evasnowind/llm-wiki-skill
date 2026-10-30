import { homedir } from "node:os";

import type { AgentEvent } from "@earendil-works/pi-agent-core";

import {
  type ArtifactKind,
  type PromptSseEvent,
  type WorkbenchErrorCode,
  type EvidenceCitation,
  type RetrievalMode,
} from "@llm-wiki/workbench-contracts";

import {
	getAssistantTerminalMessage,
	getAssistantTerminalReason,
	MODEL_FAILURE_MESSAGE,
	type AssistantTerminalReason,
} from "./extensions/prompt-terminal.js";

export const TOOL_STATUS_SCHEMA_VERSION = 1;

export type ToolStatusKind = PromptSseEvent["type"];

export type ToolRunStatus = "running" | "done" | "failed" | "cancelled";

export interface ToolDisplay {
	toolCallId: string;
	toolName: string;
	action: string;
	target: string;
}

export type ToolStatusStartEvent = Extract<
  PromptSseEvent,
  { type: "tool_status_start" }
>;
export type ToolStatusUpdateEvent = Extract<
  PromptSseEvent,
  { type: "tool_status_update" }
>;
export type ToolStatusEndEvent = Extract<
  PromptSseEvent,
  { type: "tool_status_end" }
>;
export type ToolStatusSummaryEvent = Extract<
  PromptSseEvent,
  { type: "tool_status_summary" }
>;
export type AssistantTextDeltaEvent = Extract<
  PromptSseEvent,
  { type: "assistant_text_delta" }
>;
export type AssistantDoneEvent = Extract<
  PromptSseEvent,
  { type: "assistant_done" }
>;
export type AssistantCancelledEvent = Extract<
  PromptSseEvent,
  { type: "assistant_cancelled" }
>;
export type AssistantErrorEvent = Extract<
  PromptSseEvent,
  { type: "assistant_error" }
>;

/**
 * prompt SSE 事件集合（不含 artifact_created，artifact 由 adapter.artifactCreated 单独构造）。
 */
export type ToolStatusContractEvent = Exclude<
  PromptSseEvent,
  { type: "artifact_created" }
>;

type ToolStatusEventDraft = ToolStatusContractEvent extends infer Event
	? Event extends ToolStatusContractEvent
		? Omit<Event, "schemaVersion" | "runId" | "messageId" | "seq">
		: never
	: never;

export interface ToolStatusAdapterOptions {
	runId: string;
	messageId: string;
	startSeq?: number;
	now?: () => number;
	homeDir?: string;
}

type RedactionOptions = Required<Pick<ToolStatusAdapterOptions, "homeDir">>;

interface RunningToolState extends ToolDisplay {
	args: Record<string, unknown>;
	startedAt: number;
}

interface CompletedToolState extends ToolDisplay {
	status: Exclude<ToolRunStatus, "running">;
	summary: string | null;
}

type ToolExecutionEvent = Extract<
	AgentEvent,
  {
    type:
      "tool_execution_start" | "tool_execution_update" | "tool_execution_end";
  }
>;

export interface ToolStatusStartInput {
	toolCallId: string;
	toolName: string;
	args?: unknown;
}

export interface ToolStatusUpdateInput extends ToolStatusStartInput {
	partialResult?: unknown;
}

export interface ToolStatusEndInput {
	toolCallId: string;
	toolName: string;
	result?: unknown;
	isError?: boolean;
}

export interface SsePayload {
	event: string;
	data: string;
}

export type SsePayloadWriter = (payload: SsePayload) => Promise<void>;

export class OrderedSseWriter {
	private queue: Promise<void> = Promise.resolve();
	private closed = false;

	constructor(private readonly writePayload: SsePayloadWriter) {}

  writeContract(event: PromptSseEvent): Promise<boolean> {
		return this.write({ event: event.type, data: JSON.stringify(event) });
	}

  writeNamed(event: string, data: unknown): Promise<boolean> {
    return this.write({
      event,
      data: typeof data === "string" ? data : JSON.stringify(data),
    });
	}

	write(payload: SsePayload): Promise<boolean> {
		if (this.closed) return Promise.resolve(false);
		const next = this.queue.then(async () => {
				if (this.closed) return false;
				await this.writePayload(payload);
				return true;
			});
		this.queue = next.then(
			() => {},
			() => {},
		);
		return next;
	}

	flush(): Promise<void> {
		return this.queue;
	}

	close(): void {
		this.closed = true;
	}
}

export class PromptRunRegistry {
	private readonly activeRunIds = new Map<string, string>();

	begin(sessionId: string, runId: string): boolean {
		if (this.activeRunIds.has(sessionId)) return false;
		this.activeRunIds.set(sessionId, runId);
		return true;
	}

	end(sessionId: string, runId: string): void {
    if (this.activeRunIds.get(sessionId) === runId)
      this.activeRunIds.delete(sessionId);
	}

	get(sessionId: string): string | null {
		return this.activeRunIds.get(sessionId) ?? null;
	}
}

export class ToolStatusEventAdapter {
	private seq: number;
	private readonly now: () => number;
	private readonly redaction: RedactionOptions;
	private readonly runningTools = new Map<string, RunningToolState>();
	private readonly completedTools: CompletedToolState[] = [];
	private pendingAssistantTerminal: AssistantTerminalReason | null = null;
	private recoveringPendingAssistantError = false;
  /** 是否已生成 terminal 事件（assistant_done/cancelled/error）。terminal 后不再生成任何事件。 */
  private terminalEmitted = false;

	constructor(private readonly options: ToolStatusAdapterOptions) {
		this.seq = options.startSeq ?? 0;
		this.now = options.now ?? Date.now;
		this.redaction = { homeDir: options.homeDir ?? homedir() };
	}

  get isFinished(): boolean {
    return this.terminalEmitted;
  }

	get pendingTerminalReason(): AssistantTerminalReason | null {
		return this.pendingAssistantTerminal;
	}

	recordCancellation(): void {
		if (
			!this.terminalEmitted
			&& (this.pendingAssistantTerminal !== "error" || this.recoveringPendingAssistantError)
		) {
			this.pendingAssistantTerminal = "aborted";
		}
	}

	adapt(event: unknown): ToolStatusContractEvent[] {
    if (this.terminalEmitted) return [];
		const eventRecord = toRecord(event);
		if (eventRecord.type === "auto_retry_start") {
			this.recoveringPendingAssistantError = this.pendingAssistantTerminal === "error";
			return [];
		}
		if (eventRecord.type === "auto_retry_end") {
			this.recoveringPendingAssistantError = false;
			return [];
		}
		if (eventRecord.type === "compaction_start") {
			if (eventRecord.reason === "overflow") {
				this.recoveringPendingAssistantError = this.pendingAssistantTerminal === "error";
			}
			return [];
		}
		if (eventRecord.type === "compaction_end") {
			if (eventRecord.reason === "overflow" && eventRecord.willRetry !== true) {
				this.recoveringPendingAssistantError = false;
			}
			return [];
		}
		if (isAgentEventType(event, "message_update")) {
			const inner = event.assistantMessageEvent;
			if (inner.type === "text_delta") {
        return [
          this.makeEvent({ type: "assistant_text_delta", delta: inner.delta }),
        ];
			}
			return [];
		}
    if (isAgentEventType(event, "message_end"))
      return this.assistantMessageEnded(event.message);
    if (isAgentEventType(event, "tool_execution_start"))
      return [this.toolStart(event)];
    if (isAgentEventType(event, "tool_execution_update"))
      return [this.toolUpdate(event)];
    if (isAgentEventType(event, "tool_execution_end"))
      return [this.toolEnd(event)];
		return [];
	}

  /**
   * 构造 artifact_created 共享事件，纳入同一 run 的 seq 序列。
   * terminal 后返回 null（artifact 不允许在结束事件后追加）。
   */
  artifactCreated(input: {
    id: string;
    kind: ArtifactKind;
    title: string;
  }): Extract<PromptSseEvent, { type: "artifact_created" }> | null {
    if (this.terminalEmitted) return null;
    this.seq += 1;
    return {
      schemaVersion: TOOL_STATUS_SCHEMA_VERSION,
      type: "artifact_created",
      runId: this.options.runId,
      messageId: this.options.messageId,
      seq: this.seq,
      id: input.id,
      kind: input.kind,
      title: input.title,
    };
  }

	assistantEvidence(mode: RetrievalMode, evidence: EvidenceCitation[]): Extract<PromptSseEvent, { type: "assistant_evidence" }> | null {
		if (this.terminalEmitted) return null;
		return this.makeEvent({ type: "assistant_evidence", mode, evidence: [...evidence] });
	}

  startTool(input: ToolStatusStartInput): ToolStatusStartEvent | null {
    if (this.terminalEmitted) return null;
		return this.toolStart({
			type: "tool_execution_start",
			toolCallId: input.toolCallId,
			toolName: input.toolName,
			args: input.args,
		});
	}

  updateTool(input: ToolStatusUpdateInput): ToolStatusUpdateEvent | null {
    if (this.terminalEmitted) return null;
		return this.toolUpdate({
			type: "tool_execution_update",
			toolCallId: input.toolCallId,
			toolName: input.toolName,
			args: input.args,
			partialResult: input.partialResult,
		});
	}

  endTool(input: ToolStatusEndInput): ToolStatusEndEvent | null {
    if (this.terminalEmitted) return null;
		return this.toolEnd({
			type: "tool_execution_end",
			toolCallId: input.toolCallId,
			toolName: input.toolName,
			result: input.result,
			isError: input.isError ?? false,
		});
	}

	finishAssistant(): ToolStatusContractEvent[] {
    if (this.terminalEmitted) return [];
		if (this.pendingAssistantTerminal === "error") return this.failAssistant(null);
		if (this.pendingAssistantTerminal === "aborted")
			return this.cancelAssistant(getAssistantTerminalMessage("aborted"));
		const events: ToolStatusContractEvent[] = [];
		const summary = this.toolSummary();
		if (summary) events.push(summary);
		events.push(this.makeEvent({ type: "assistant_done" }));
		return events;
	}

  /**
   * 生成稳定的 assistant_error：code + 中文 message + 可选 typed details。
   * 原始异常只用于内部判别，绝不把 raw message / stack / 路径写入公开事件。
   * terminal 已生成后返回空数组（错误事件唯一）。
   */
	failAssistant(error: unknown): ToolStatusContractEvent[] {
    if (this.terminalEmitted) return [];
    const { code, message } = classifyPromptError(error, this.redaction);
		const events: ToolStatusContractEvent[] = [...this.failActiveTools(message)];
		const summary = this.toolSummary();
		if (summary) events.push(summary);
		events.push(this.makeEvent({ type: "assistant_error", code, message }));
		return events;
	}

	cancelAssistant(reason = "cancelled"): ToolStatusContractEvent[] {
    if (this.terminalEmitted) return [];
		return [
			...this.cancelActiveTools(reason),
      this.makeEvent({
        type: "assistant_cancelled",
        reason: redactText(reason, this.redaction, 160),
      }),
		];
	}

	cancelActiveTools(reason = "cancelled"): ToolStatusEndEvent[] {
		return this.finishActiveTools("cancelled", reason);
	}

	private failActiveTools(reason: string): ToolStatusEndEvent[] {
		return this.finishActiveTools("failed", reason);
	}

	private finishActiveTools(
		status: Exclude<ToolRunStatus, "running" | "done">,
		reason: string,
	): ToolStatusEndEvent[] {
    if (this.terminalEmitted) return [];
		const events: ToolStatusEndEvent[] = [];
		for (const tool of [...this.runningTools.values()]) {
			this.runningTools.delete(tool.toolCallId);
			const summary = redactText(reason, this.redaction, 160);
			this.completedTools.push({
				toolCallId: tool.toolCallId,
				toolName: tool.toolName,
				action: tool.action,
				target: tool.target,
				status,
				summary,
			});
			events.push(
				this.makeEvent({
					type: "tool_status_end",
					toolCallId: tool.toolCallId,
					toolName: tool.toolName,
					action: tool.action,
					target: tool.target,
					status,
					result: null,
					summary,
					error: status === "failed" ? summary : null,
					durationMs: Math.max(0, this.now() - tool.startedAt),
					runningToolCount: this.runningTools.size,
					otherRunningCount: this.runningTools.size,
				}),
			);
		}
		return events;
	}

	private toolSummary(): ToolStatusSummaryEvent | null {
		if (this.completedTools.length === 0 && this.runningTools.size === 0) return null;
		return this.makeEvent({
			type: "tool_status_summary",
			items: this.completedTools.map((item) => ({ ...item })),
			remainingRunningCount: this.runningTools.size,
		});
	}

	getRunningTools(): ToolDisplay[] {
    return [...this.runningTools.values()].map(
      ({ toolCallId, toolName, action, target }) => ({
			toolCallId,
			toolName,
			action,
			target,
      }),
    );
	}

	private assistantMessageEnded(message: unknown): ToolStatusContractEvent[] {
		const record = toRecord(message);
		if (record.role !== "assistant") return [];
		const terminalReason = getAssistantTerminalReason(record.stopReason);
		if (terminalReason) {
			this.pendingAssistantTerminal = terminalReason;
			this.recoveringPendingAssistantError = false;
			return [];
		}
		this.pendingAssistantTerminal = null;
		this.recoveringPendingAssistantError = false;
    return [];
  }

  private toolStart(
    event: Extract<ToolExecutionEvent, { type: "tool_execution_start" }>,
  ): ToolStatusStartEvent {
		const args = sanitizeRecord(event.args, this.redaction);
    const display = formatToolDisplay(
      event.toolName,
      args,
      undefined,
      this.redaction,
    );
		this.runningTools.set(event.toolCallId, {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			...display,
			args,
			startedAt: this.now(),
		});
		return this.makeEvent({
			type: "tool_status_start",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			...display,
			status: "running",
			args,
			runningToolCount: this.runningTools.size,
			otherRunningCount: Math.max(0, this.runningTools.size - 1),
		});
	}

  private toolUpdate(
    event: Extract<ToolExecutionEvent, { type: "tool_execution_update" }>,
  ): ToolStatusUpdateEvent {
		const args = sanitizeRecord(event.args, this.redaction);
		const detail = sanitizeValue(event.partialResult, this.redaction);
    const display = formatToolDisplay(
      event.toolName,
      args,
      detail,
      this.redaction,
    );
		const existing = this.runningTools.get(event.toolCallId);
		this.runningTools.set(event.toolCallId, {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			...display,
			args,
			startedAt: existing?.startedAt ?? this.now(),
		});
		return this.makeEvent({
			type: "tool_status_update",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			...display,
			status: "running",
			args,
			detail,
			runningToolCount: this.runningTools.size,
			otherRunningCount: Math.max(0, this.runningTools.size - 1),
		});
	}

  private toolEnd(
    event: Extract<ToolExecutionEvent, { type: "tool_execution_end" }>,
  ): ToolStatusEndEvent {
		const existing = this.runningTools.get(event.toolCallId);
		const result = sanitizeValue(event.result, this.redaction);
    const display = existing ?? {
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				...formatToolDisplay(event.toolName, {}, result, this.redaction),
				args: {},
				startedAt: this.now(),
			};
		this.runningTools.delete(event.toolCallId);
		const status = event.isError ? "failed" : "done";
		const summary = summarizeResult(result, this.redaction);
    const error =
      status === "failed" ? normalizeError(result, this.redaction) : null;
		this.completedTools.push({
			toolCallId: display.toolCallId,
			toolName: display.toolName,
			action: display.action,
			target: display.target,
			status,
			summary,
		});
		return this.makeEvent({
			type: "tool_status_end",
			toolCallId: display.toolCallId,
			toolName: display.toolName,
			action: display.action,
			target: display.target,
			status,
			result,
			summary,
			error,
			durationMs: Math.max(0, this.now() - display.startedAt),
			runningToolCount: this.runningTools.size,
			otherRunningCount: this.runningTools.size,
		});
	}

	private makeEvent<T extends ToolStatusEventDraft>(
		event: T,
	): Extract<ToolStatusContractEvent, { type: T["type"] }> {
    if (
      event.type === "assistant_done" ||
      event.type === "assistant_cancelled" ||
      event.type === "assistant_error"
    ) {
      this.terminalEmitted = true;
    }
		this.seq += 1;
		const fullEvent = {
			schemaVersion: TOOL_STATUS_SCHEMA_VERSION,
			runId: this.options.runId,
			messageId: this.options.messageId,
			seq: this.seq,
			...event,
		};
    return fullEvent as unknown as Extract<
      ToolStatusContractEvent,
      { type: T["type"] }
    >;
	}
}

export function formatToolDisplay(
	toolName: string,
	args: unknown,
	detail?: unknown,
	redaction: RedactionOptions = { homeDir: homedir() },
): Pick<ToolDisplay, "action" | "target"> {
	const lower = toolName.toLowerCase();
	const argRecord = toRecord(args);
	const detailRecord = toRecord(detail);
	const details = toRecord(detailRecord.details);
	const merged = { ...details, ...detailRecord, ...argRecord };
	const pathTarget = firstString(merged, [
		"path",
		"filePath",
		"filepath",
		"targetPath",
		"target",
		"absolutePath",
		"relativePath",
	]);
  const queryTarget = firstString(merged, [
    "query",
    "pattern",
    "search",
    "term",
    "needle",
  ]);
	const commandTarget = firstString(merged, ["command", "cmd", "script"]);
  const skillTarget = firstString(merged, [
    "skill",
    "skillName",
    "name",
    "slug",
    "command",
  ]);

	if (lower.includes("read")) {
		return { action: "读取", target: redactPathTarget(pathTarget, redaction) };
	}
	if (lower.includes("write") || lower.includes("edit")) {
    return {
      action: lower.includes("edit") ? "编辑" : "写入",
      target: redactPathTarget(pathTarget, redaction),
    };
	}
  if (
    lower.includes("bash") ||
    lower.includes("shell") ||
    lower.includes("command")
  ) {
    return {
      action: "运行命令",
      target: redactCommandTarget(commandTarget ?? pathTarget, redaction),
    };
	}
  if (
    lower.includes("search") ||
    lower.includes("grep") ||
    lower.includes("find")
  ) {
    const target =
      queryTarget && pathTarget
        ? `${queryTarget} in ${pathTarget}`
        : (queryTarget ?? pathTarget);
    return {
      action: "搜索",
      target: redactText(target ?? "当前知识库", redaction, 96),
    };
	}
	if (lower.includes("skill")) {
    return {
      action: "调用 Skill",
      target: redactText(skillTarget ?? "未知 Skill", redaction, 96),
    };
	}
	return {
		action: `运行 ${toolName}`,
    target: redactText(
      pathTarget ?? queryTarget ?? commandTarget ?? skillTarget ?? "未知目标",
      redaction,
      96,
    ),
	};
}

export function buildToolStatusContractFixture(): ToolStatusContractEvent[] {
	let tick = 1_000;
	const adapter = new ToolStatusEventAdapter({
		runId: "fixture-run",
		messageId: "fixture-message",
		homeDir: "/Users/example",
		now: () => {
			tick += 10;
			return tick;
		},
	});
	return [
		...adapter.adapt({
			type: "message_update",
			message: { role: "assistant", content: [] },
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "我来检查。",
        partial: {
          role: "assistant",
          content: [{ type: "text", text: "我来检查。" }],
        },
			},
		} as unknown as AgentEvent),
		...adapter.adapt({
			type: "tool_execution_start",
			toolCallId: "read-1",
			toolName: "read",
			args: { path: "/Users/example/projects/private/source.md" },
		}),
		...adapter.adapt({
			type: "tool_execution_update",
			toolCallId: "read-1",
			toolName: "read",
			args: { path: "/Users/example/projects/private/source.md" },
      partialResult: {
        details: {
          bytes: 128,
          path: "/Users/example/projects/private/source.md",
        },
      },
		}),
		...adapter.adapt({
			type: "tool_execution_end",
			toolCallId: "read-1",
			toolName: "read",
      result: {
        content: [
          {
            type: "text",
            text: "ok /Users/example/projects/private/source.md",
          },
        ],
      },
			isError: false,
		}),
		...adapter.finishAssistant(),
	];
}

function sanitizeRecord(
  value: unknown,
  redaction: RedactionOptions,
): Record<string, unknown> {
	const sanitized = sanitizeValue(value, redaction);
	return toRecord(sanitized);
}

function sanitizeValue(value: unknown, redaction: RedactionOptions): unknown {
	if (typeof value === "string") return redactText(value, redaction, 300);
  if (Array.isArray(value))
    return value.map((item) => sanitizeValue(item, redaction));
	if (!value || typeof value !== "object") return value;
	const result: Record<string, unknown> = {};
	for (const [key, raw] of Object.entries(value)) {
		const max = /command|cmd|script/i.test(key) ? 140 : 300;
    result[key] =
      typeof raw === "string"
        ? redactText(raw, redaction, max)
        : sanitizeValue(raw, redaction);
	}
	return result;
}

function redactPathTarget(
  value: string | undefined,
  redaction: RedactionOptions,
): string {
	if (!value?.trim()) return "未知路径";
	return compactPath(redactHome(value, redaction), 96);
}

function redactCommandTarget(
  value: string | undefined,
  redaction: RedactionOptions,
): string {
	if (!value?.trim()) return "未知命令";
	return redactText(value, redaction, 120);
}

function redactText(
  value: string,
  redaction: RedactionOptions,
  maxLength: number,
): string {
  const redacted = redactHome(value, redaction).replace(
    /\/Users\/[^/\s]+/g,
    "/Users/<user>",
  );
	if (redacted.length <= maxLength) return redacted;
	const keep = Math.max(20, maxLength - 3);
	return `${redacted.slice(0, Math.ceil(keep * 0.6))}...${redacted.slice(-Math.floor(keep * 0.4))}`;
}

function redactHome(value: string, redaction: RedactionOptions): string {
	const home = redaction.homeDir.replace(/\/+$/, "");
	if (!home) return value;
	return value.split(home).join("~");
}

function compactPath(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	const parts = value.split("/").filter(Boolean);
	if (parts.length <= 3) return redactText(value, { homeDir: "" }, maxLength);
  const prefix = value.startsWith("~/")
    ? "~/"
    : value.startsWith("/")
      ? "/"
      : "";
	const tail = parts.slice(-3).join("/");
	return `${prefix}.../${tail}`;
}

function summarizeResult(
  result: unknown,
  redaction: RedactionOptions,
): string | null {
	if (!result) return null;
	if (typeof result === "string") return redactText(result, redaction, 160);
	const record = toRecord(result);
	const content = record.content;
	if (Array.isArray(content)) {
		const text = content
			.map((part) => {
				const p = toRecord(part);
				return typeof p.text === "string" ? p.text : "";
			})
			.filter(Boolean)
			.join(" ");
		if (text) return redactText(text, redaction, 160);
	}
	for (const key of ["summary", "message", "error", "stderr", "stdout"]) {
		const value = record[key];
    if (typeof value === "string" && value.trim())
      return redactText(value, redaction, 160);
	}
	return null;
}

function normalizeError(error: unknown, redaction: RedactionOptions): string {
	if (error instanceof Error) return redactText(error.message, redaction, 200);
	if (typeof error === "string") return redactText(error, redaction, 200);
	const record = toRecord(error);
	for (const key of ["error", "message", "stderr"]) {
		const value = record[key];
    if (typeof value === "string" && value.trim())
      return redactText(value, redaction, 200);
	}
	const summary = summarizeResult(error, redaction);
	return summary ?? "工具执行失败";
}

/**
 * 把任意 prompt 执行错误映射为公开 assistant_error 的稳定 code + 中文 message。
 * 只用稳定的、可对外的判别；原始异常文本、stack、路径绝不进入公开事件。
 */
function classifyPromptError(
  _error: unknown,
  _redaction: RedactionOptions,
): { code: WorkbenchErrorCode; message: string } {
  // 当前所有 prompt 运行期失败统一映射为 INTERNAL_ERROR + 稳定中文文案。
  // 若未来需要区分可公开的 code（如 NO_ACTIVE_KB 已在 pre-stream 处理），
  // 在此扩展，details 也只放白名单字段。
  return { code: "INTERNAL_ERROR", message: MODEL_FAILURE_MESSAGE };
}

function toRecord(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

function firstString(
  record: Record<string, unknown>,
  keys: string[],
): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

function isAgentEventType<T extends AgentEvent["type"]>(
	event: unknown,
	type: T,
): event is Extract<AgentEvent, { type: T }> {
	return isRecord(event) && event.type === type;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
