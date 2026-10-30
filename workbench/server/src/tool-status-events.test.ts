import assert from "node:assert/strict";
import test from "node:test";

import { PromptSseEventSchema } from "@llm-wiki/workbench-contracts";

import type { AgentEvent } from "@earendil-works/pi-agent-core";

import {
	buildToolStatusContractFixture,
	formatToolDisplay,
	OrderedSseWriter,
	PromptRunRegistry,
	ToolStatusEventAdapter,
	type ToolStatusContractEvent,
} from "./tool-status-events.js";

test("tool status adapter emits v1 ordered contract fields", () => {
	const adapter = createAdapter();
	const events = [
		...adapter.adapt(textDelta("hello")),
    ...adapter.adapt(
      startEvent("read-1", "read", { path: "/Users/example/private/a.md" }),
    ),
		...adapter.finishAssistant(),
	];

	assert.deepEqual(
		events.map((event) => ({
			schemaVersion: event.schemaVersion,
			runId: event.runId,
			messageId: event.messageId,
			seq: event.seq,
			type: event.type,
		})),
		[
      {
        schemaVersion: 1,
        runId: "run-1",
        messageId: "message-1",
        seq: 1,
        type: "assistant_text_delta",
      },
      {
        schemaVersion: 1,
        runId: "run-1",
        messageId: "message-1",
        seq: 2,
        type: "tool_status_start",
      },
      {
        schemaVersion: 1,
        runId: "run-1",
        messageId: "message-1",
        seq: 3,
        type: "tool_status_summary",
      },
      {
        schemaVersion: 1,
        runId: "run-1",
        messageId: "message-1",
        seq: 4,
        type: "assistant_done",
      },
		],
	);
});

test("tool status adapter covers start, update, end, failure, and missing args", () => {
	const adapter = createAdapter();

  const start = expectEvent(
    adapter.adapt(startEvent("bash-1", "bash", undefined))[0],
    "tool_status_start",
  );
  const update = expectEvent(
    adapter.adapt({
		type: "tool_execution_update",
		toolCallId: "bash-1",
		toolName: "bash",
		args: undefined,
		partialResult: { details: { command: "npm run typecheck" } },
    })[0],
    "tool_status_update",
  );
  const failed = expectEvent(
    adapter.adapt({
		type: "tool_execution_end",
		toolCallId: "bash-1",
		toolName: "bash",
		result: { error: "failed in /Users/example/private/project" },
		isError: true,
    })[0],
    "tool_status_end",
  );

	assert.equal(start.type, "tool_status_start");
	assert.equal(start.action, "运行命令");
	assert.equal(start.target, "未知命令");
	assert.deepEqual(start.args, {});
	assert.equal(update.type, "tool_status_update");
	assert.equal(update.target, "npm run typecheck");
	assert.equal(failed.type, "tool_status_end");
	assert.equal(failed.status, "failed");
	assert.equal(failed.error, "failed in ~/private/project");
	assert.equal(failed.runningToolCount, 0);
});

test("tool status adapter formats common tool actions and targets", () => {
	const redaction = { homeDir: "/Users/example" };

  assert.deepEqual(
    formatToolDisplay(
      "read",
      { path: "/Users/example/wiki/index.md" },
      undefined,
      redaction,
    ),
    {
		action: "读取",
		target: "~/wiki/index.md",
    },
  );
  assert.deepEqual(
    formatToolDisplay(
      "write",
      { filePath: "/Users/example/wiki/new.md" },
      undefined,
      redaction,
    ),
    {
		action: "写入",
		target: "~/wiki/new.md",
    },
  );
  assert.deepEqual(
    formatToolDisplay(
      "bash",
      { command: "npm run typecheck --workspace=@llm-wiki-agent/server" },
      undefined,
      redaction,
    ),
    {
		action: "运行命令",
		target: "npm run typecheck --workspace=@llm-wiki-agent/server",
    },
  );
  assert.deepEqual(
    formatToolDisplay(
      "search",
      { query: "tool status", path: "/Users/example/wiki" },
      undefined,
      redaction,
    ),
    {
		action: "搜索",
		target: "tool status in ~/wiki",
    },
  );
  assert.deepEqual(
    formatToolDisplay("skill", { skillName: "llm-wiki" }, undefined, redaction),
    {
		action: "调用 Skill",
		target: "llm-wiki",
    },
  );
});

test("tool status adapter redacts home paths and long command targets", () => {
	const adapter = createAdapter();
	const longCommand = [
		"node",
		"/Users/example/private/really/long/path/that/should/not/leak/source.js",
		"--token",
		"secret",
		"--output",
		"/Users/example/private/really/long/path/that/should/not/leak/output.json",
	].join(" ");

  const start = expectEvent(
    adapter.adapt(startEvent("bash-1", "bash", { command: longCommand }))[0],
    "tool_status_start",
  );
  const end = expectEvent(
    adapter.adapt({
		type: "tool_execution_end",
		toolCallId: "bash-1",
		toolName: "bash",
		result: {
			content: [
				{
					type: "text",
					text: `wrote /Users/example/private/really/long/path/that/should/not/leak/output.json`,
				},
			],
		},
		isError: false,
    })[0],
    "tool_status_end",
  );

	assert.equal(start.type, "tool_status_start");
	assert.equal(end.type, "tool_status_end");
	assert.equal(start.target.includes("/Users/example"), false);
	assert.equal(JSON.stringify(start).includes("/Users/example"), false);
	assert.equal(JSON.stringify(end).includes("/Users/example"), false);
	assert.ok(start.target.length <= 120);
	assert.ok(end.summary && end.summary.length <= 160);
});

test("tool status adapter keeps parallel tools independent", () => {
	const adapter = createAdapter();

  const startA = expectEvent(
    adapter.adapt(
      startEvent("read-1", "read", { path: "/Users/example/a.md" }),
    )[0],
    "tool_status_start",
  );
  const startB = expectEvent(
    adapter.adapt(
      startEvent("write-1", "write", { path: "/Users/example/b.md" }),
    )[0],
    "tool_status_start",
  );
  const endB = expectEvent(
    adapter.adapt({
		type: "tool_execution_end",
		toolCallId: "write-1",
		toolName: "write",
		result: { content: [{ type: "text", text: "wrote b.md" }] },
		isError: false,
    })[0],
    "tool_status_end",
  );

	assert.equal(startA.type, "tool_status_start");
	assert.equal(startA.runningToolCount, 1);
	assert.equal(startA.otherRunningCount, 0);
	assert.equal(startB.type, "tool_status_start");
	assert.equal(startB.runningToolCount, 2);
	assert.equal(startB.otherRunningCount, 1);
	assert.equal(endB.type, "tool_status_end");
	assert.equal(endB.toolCallId, "write-1");
	assert.equal(endB.runningToolCount, 1);
  assert.deepEqual(
    adapter.getRunningTools().map((tool) => tool.toolCallId),
    ["read-1"],
  );
});

test("tool status adapter emits cancelled endings for active tools", () => {
	const adapter = createAdapter();
	adapter.adapt(startEvent("read-1", "read", { path: "/Users/example/a.md" }));
  adapter.adapt(
    startEvent("write-1", "write", { path: "/Users/example/b.md" }),
  );

  const cancelled = adapter.cancelAssistant(
    "client disconnected from /Users/example/private",
  );

  assert.deepEqual(
    cancelled.map((event) => event.type),
    ["tool_status_end", "tool_status_end", "assistant_cancelled"],
  );
	assert.equal(JSON.stringify(cancelled).includes("/Users/example"), false);
	assert.deepEqual(adapter.getRunningTools(), []);
});

test("manual tool events cover knowledge-base retrieval lifecycle", () => {
	const adapter = createAdapter();

	const start = adapter.startTool({
		toolCallId: "knowledge-search-1",
		toolName: "knowledge_search",
		args: { query: "OpenClaw", path: "/Users/example/wiki" },
	});
	const done = adapter.endTool({
		toolCallId: "knowledge-search-1",
		toolName: "knowledge_search",
		result: { summary: "found 2 pages", paths: ["/Users/example/wiki/a.md"] },
	});
	const failed = adapter.endTool({
		toolCallId: "knowledge-search-2",
		toolName: "knowledge_search",
		result: { error: "read failed at /Users/example/wiki/private.md" },
		isError: true,
	});

  assert.ok(start);
  assert.ok(done);
  assert.ok(failed);

	assert.equal(start.type, "tool_status_start");
	assert.equal(start.action, "搜索");
	assert.equal(start.target, "OpenClaw in ~/wiki");
	assert.equal(done.type, "tool_status_end");
	assert.equal(done.status, "done");
	assert.equal(done.summary, "found 2 pages");
	assert.equal(failed.status, "failed");
	assert.equal(failed.error, "read failed at ~/wiki/private.md");
});

test("knowledge search uses a safe target without query or path", () => {
  const adapter = createAdapter();
  const event = adapter.startTool({
    toolCallId: "knowledge-search-safe",
    toolName: "knowledge_search",
    args: {},
  });

  assert.ok(event);
  assert.equal(event.target, "当前知识库");
  assert.deepEqual(event.args, {});
});
test("adapter terminal 后拒绝任何后续 prompt 事件", () => {
	const adapter = createAdapter();
	const done = adapter.finishAssistant();

  assert.equal(done.at(-1)?.type, "assistant_done");
  assert.equal(adapter.adapt(textDelta("late")).length, 0);
  assert.equal(
    adapter.startTool({ toolCallId: "late", toolName: "read" }),
    null,
  );
  assert.equal(
    adapter.updateTool({ toolCallId: "late", toolName: "read" }),
    null,
  );
  assert.equal(adapter.endTool({ toolCallId: "late", toolName: "read" }), null);
  assert.equal(
    adapter.artifactCreated({ id: "late", kind: "html", title: "late" }),
    null,
  );
	assert.deepEqual(adapter.cancelAssistant(), []);
});

test("已保存的模型错误结束会在本轮结束时成为唯一安全失败终态，而不是成功完成", () => {
	const adapter = createAdapter();
	const intermediate = adapter.adapt(
		assistantMessageEnd("error", "fictional provider detail that must not reach the page"),
	);
	assert.deepEqual(intermediate, []);
	assert.equal(adapter.isFinished, false);
	const events = adapter.finishAssistant();

	assert.deepEqual(events.map((event) => event.type), ["assistant_error"]);
	assert.equal(events[0]?.type, "assistant_error");
	if (events[0]?.type === "assistant_error") {
		assert.equal(events[0].message, "生成回复时发生错误，请重试");
	}
	assert.equal(JSON.stringify(events).includes("fictional provider detail"), false);
	assert.deepEqual(adapter.finishAssistant(), []);
});

test("模型错误会安全结束运行中的工具，并保留已完成工具摘要", () => {
	const adapter = createAdapter();
	adapter.startTool({ toolCallId: "completed-tool", toolName: "read", args: { path: "done.md" } });
	adapter.endTool({
		toolCallId: "completed-tool",
		toolName: "read",
		result: { summary: "已完成" },
	});
	adapter.startTool({ toolCallId: "running-tool", toolName: "read", args: { path: "running.md" } });
	adapter.adapt(assistantMessageEnd("error"));

	const events = adapter.finishAssistant();
	assert.deepEqual(events.map((event) => event.type), [
		"tool_status_end",
		"tool_status_summary",
		"assistant_error",
	]);
	assert.equal(events[0]?.type, "tool_status_end");
	if (events[0]?.type === "tool_status_end") {
		assert.equal(events[0].toolCallId, "running-tool");
		assert.equal(events[0].status, "failed");
		assert.equal(events[0].error, "生成回复时发生错误，请重试");
	}
	assert.equal(events[1]?.type, "tool_status_summary");
	if (events[1]?.type === "tool_status_summary") {
		assert.deepEqual(events[1].items.map((item) => item.status), ["done", "failed"]);
		assert.equal(events[1].remainingRunningCount, 0);
	}
	assert.equal(events.some((event) => event.type === "assistant_done"), false);
});

test("后续正常助手结束会替代暂存的模型错误，保留正常完成", () => {
	const adapter = createAdapter();

	assert.deepEqual(adapter.adapt(assistantMessageEnd("error")), []);
	assert.deepEqual(adapter.adapt(assistantMessageEnd("stop")), []);
	assert.deepEqual(adapter.finishAssistant().map((event) => event.type), ["assistant_done"]);
});

test("最终模型错误在传输随后断开时仍保持失败终态", () => {
	const adapter = createAdapter();

	assert.deepEqual(adapter.adapt(assistantMessageEnd("error")), []);
	adapter.recordCancellation();
	assert.deepEqual(adapter.finishAssistant().map((event) => event.type), ["assistant_error"]);
});

test("模型重试间隙取消会替代暂存模型错误，保持取消终态", () => {
	const adapter = createAdapter();

	assert.deepEqual(adapter.adapt(assistantMessageEnd("error")), []);
	assert.deepEqual(adapter.adapt({ type: "auto_retry_start" }), []);
	adapter.recordCancellation();
	assert.deepEqual(adapter.finishAssistant().map((event) => event.type), ["assistant_cancelled"]);
});

test("上下文超限自动恢复期间取消会替代暂存模型错误，保持取消终态", () => {
	const adapter = createAdapter();

	assert.deepEqual(adapter.adapt(assistantMessageEnd("error")), []);
	assert.deepEqual(
		adapter.adapt({ type: "compaction_start", reason: "overflow" }),
		[],
	);
	adapter.recordCancellation();
	assert.deepEqual(adapter.finishAssistant().map((event) => event.type), ["assistant_cancelled"]);
});

test("上下文超限恢复完成并继续下一次模型调用时仍可取消", () => {
	const adapter = createAdapter();

	assert.deepEqual(adapter.adapt(assistantMessageEnd("error")), []);
	assert.deepEqual(
		adapter.adapt({ type: "compaction_start", reason: "overflow" }),
		[],
	);
	assert.deepEqual(
		adapter.adapt({ type: "compaction_end", reason: "overflow", willRetry: true }),
		[],
	);
	adapter.recordCancellation();
	assert.deepEqual(adapter.finishAssistant().map((event) => event.type), ["assistant_cancelled"]);
});

test("上下文超限自动恢复结束后的最终模型错误不被随后断线改成取消", () => {
	const adapter = createAdapter();

	assert.deepEqual(adapter.adapt(assistantMessageEnd("error")), []);
	assert.deepEqual(
		adapter.adapt({ type: "compaction_start", reason: "overflow" }),
		[],
	);
	assert.deepEqual(
		adapter.adapt({ type: "compaction_end", reason: "overflow", willRetry: false }),
		[],
	);
	adapter.recordCancellation();
	assert.deepEqual(adapter.finishAssistant().map((event) => event.type), ["assistant_error"]);
});

test("重试结束后的最终模型错误不被随后断线改成取消", () => {
	const adapter = createAdapter();

	assert.deepEqual(adapter.adapt(assistantMessageEnd("error")), []);
	assert.deepEqual(adapter.adapt({ type: "auto_retry_start" }), []);
	assert.deepEqual(adapter.adapt({ type: "auto_retry_end" }), []);
	adapter.recordCancellation();
	assert.deepEqual(adapter.finishAssistant().map((event) => event.type), ["assistant_error"]);
});

test("tool status fixture 的每个事件都通过共享 prompt schema", () => {
  const fixture = buildToolStatusContractFixture();
  for (const event of fixture) PromptSseEventSchema.parse(event);
});
test("ordered SSE writer serializes mixed async writes", async () => {
	const order: string[] = [];
	const writer = new OrderedSseWriter(async (payload) => {
    await new Promise((resolve) =>
      setTimeout(resolve, payload.event === "slow" ? 5 : 0),
    );
		order.push(`${payload.event}:${payload.data}`);
	});

	const first = writer.writeNamed("slow", "1");
	const second = writer.writeNamed("fast", "2");
	assert.deepEqual(await Promise.all([second, first]), [true, true]);
	await writer.flush();

	assert.deepEqual(order, ["slow:1", "fast:2"]);
});

test("ordered SSE writer reports queued writes skipped after transport close", async () => {
	const written: string[] = [];
	const writer = new OrderedSseWriter(async (payload) => {
		written.push(payload.data);
	});

	const queued = writer.writeNamed("assistant_text_delta", "未展示的虚构文字");
	writer.close();

	assert.equal(await queued, false);
	await writer.flush();
	assert.deepEqual(written, []);
});

test("prompt run registry rejects same-session concurrency and releases owner", () => {
	const registry = new PromptRunRegistry();

	assert.equal(registry.begin("session-1", "run-a"), true);
	assert.equal(registry.begin("session-1", "run-b"), false);
	assert.equal(registry.get("session-1"), "run-a");
	registry.end("session-1", "run-b");
	assert.equal(registry.get("session-1"), "run-a");
	registry.end("session-1", "run-a");
	assert.equal(registry.begin("session-1", "run-b"), true);
});

test("tool status contract fixture snapshots shared sample events", () => {
	const fixture = buildToolStatusContractFixture();
	const compact = fixture.map(compactEvent);

	assert.deepEqual(compact, [
		{
			type: "assistant_text_delta",
			seq: 1,
			delta: "我来检查。",
		},
		{
			type: "tool_status_start",
			seq: 2,
			toolCallId: "read-1",
			toolName: "read",
			action: "读取",
			target: "~/projects/private/source.md",
			status: "running",
			runningToolCount: 1,
			otherRunningCount: 0,
		},
		{
			type: "tool_status_update",
			seq: 3,
			toolCallId: "read-1",
			toolName: "read",
			action: "读取",
			target: "~/projects/private/source.md",
			status: "running",
			runningToolCount: 1,
			otherRunningCount: 0,
		},
		{
			type: "tool_status_end",
			seq: 4,
			toolCallId: "read-1",
			toolName: "read",
			action: "读取",
			target: "~/projects/private/source.md",
			status: "done",
			runningToolCount: 0,
			otherRunningCount: 0,
		},
		{
			type: "tool_status_summary",
			seq: 5,
			items: [
				{
					toolCallId: "read-1",
					toolName: "read",
					action: "读取",
					target: "~/projects/private/source.md",
					status: "done",
					summary: "ok ~/projects/private/source.md",
				},
			],
			remainingRunningCount: 0,
		},
		{
			type: "assistant_done",
			seq: 6,
		},
	]);
	assert.equal(JSON.stringify(fixture).includes("/Users/example"), false);
});

function createAdapter() {
	let now = 1_000;
	return new ToolStatusEventAdapter({
		runId: "run-1",
		messageId: "message-1",
		homeDir: "/Users/example",
		now: () => {
			now += 25;
			return now;
		},
	});
}

function textDelta(delta: string): AgentEvent {
	return {
		type: "message_update",
		message: { role: "assistant", content: [] },
		assistantMessageEvent: {
			type: "text_delta",
			contentIndex: 0,
			delta,
			partial: { role: "assistant", content: [{ type: "text", text: delta }] },
		},
	} as unknown as AgentEvent;
}

function startEvent(
  toolCallId: string,
  toolName: string,
  args: unknown,
): AgentEvent {
	return {
		type: "tool_execution_start",
		toolCallId,
		toolName,
		args,
	};
}

function assistantMessageEnd(
	stopReason: "error" | "aborted" | "stop" | "toolUse",
	errorMessage?: string,
): AgentEvent {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			content: [],
			stopReason,
			...(errorMessage ? { errorMessage } : {}),
		},
	} as unknown as AgentEvent;
}

function compactEvent(event: ToolStatusContractEvent): Record<string, unknown> {
	const base = { type: event.type, seq: event.seq };
	if (event.type === "assistant_evidence") return { ...base, mode: event.mode, evidence: event.evidence };
  if (event.type === "assistant_text_delta")
    return { ...base, delta: event.delta };
	if (
		event.type === "assistant_done" ||
		event.type === "assistant_error" ||
		event.type === "assistant_cancelled"
	) {
		return base;
	}
	if (event.type === "tool_status_summary") {
    return {
      ...base,
      items: event.items,
      remainingRunningCount: event.remainingRunningCount,
    };
	}
	return {
		...base,
		toolCallId: event.toolCallId,
		toolName: event.toolName,
		action: event.action,
		target: event.target,
		status: event.status,
		runningToolCount: event.runningToolCount,
		otherRunningCount: event.otherRunningCount,
	};
}

function expectEvent<T extends ToolStatusContractEvent["type"]>(
	event: ToolStatusContractEvent | undefined,
	type: T,
): Extract<ToolStatusContractEvent, { type: T }> {
	assert.ok(event);
	assert.equal(event.type, type);
	return event as Extract<ToolStatusContractEvent, { type: T }>;
}

test("assistant evidence shares the run sequence, snapshots its array and is blocked after terminal", () => {
  const adapter = new ToolStatusEventAdapter({ runId: "run-evidence", messageId: "message-evidence" });
  const citations: import("@llm-wiki/workbench-contracts").EvidenceCitation[] = [];
  const evidence = adapter.assistantEvidence("sources-only", citations)!;
  citations.push({ id: "E1", kind: "raw", path: "raw/a.md", title: "A", headingPath: [], startLine: 1, endLine: 1, fileHash: "a".repeat(64), excerptHash: "b".repeat(64), excerpt: "source" });
  assert.deepEqual(evidence.evidence, []);
  const delta = adapter.adapt(textDelta("answer"))[0]!;
  const done = adapter.finishAssistant().at(-1)!;
  assert.deepEqual([evidence.seq, delta.seq, done.seq], [1, 2, 3]);
  assert.equal(evidence.runId, "run-evidence");
  assert.equal(evidence.messageId, "message-evidence");
  assert.equal(adapter.assistantEvidence("knowledge", []), null);
});
