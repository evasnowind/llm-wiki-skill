import assert from "node:assert/strict";
import test from "node:test";

import {
	AppConfigSchema,
	AuthConnectionTestBodySchema,
	AuthConnectionTestDataSchema,
	AuthSetBodySchema,
	AuthSetDataSchema,
	AuthStatusDataSchema,
	AvailableModelsDataSchema,
	CommandListDataSchema,
	CommandListQuerySchema,
	ConflictDetailsSchema,
	errorCodeToHttpStatus,
	FailureEnvelopeSchema,
	failure,
	ForbiddenPathDetailsSchema,
	HealthDataSchema,
	InvalidRequestDetailsSchema,
	KnowledgeBaseContextBodySchema,
	KnowledgeBaseContextQuerySchema,
	JsonEnvelopeSchema,
	MissingFieldDetailsSchema,
	ModelRefSchema,
	NotFoundDetailsSchema,
	SuccessEnvelopeSchema,
	success,
	WorkbenchErrorCodeSchema,
	PromptRequestBodySchema,
	PromptSseEventSchema,
	PROMPT_SSE_EVENT_TYPES,
	isPromptTerminalEvent,
} from "../src/index.js";

test("WorkbenchErrorCode 包含第一批稳定错误码", () => {
	const codes = WorkbenchErrorCodeSchema.options;
	for (const expected of [
		"INVALID_JSON",
		"INVALID_REQUEST",
		"MISSING_FIELD",
		"NO_ACTIVE_KB",
		"KB_NOT_REGISTERED",
		"FORBIDDEN_PATH",
		"FORBIDDEN_ORIGIN",
		"FORBIDDEN_LOCAL_API",
		"AUTHENTICATION_FAILED",
		"NOT_FOUND",
		"CONFLICT",
		"UNSUPPORTED_PLATFORM",
		"BUSY",
		"INTERNAL_ERROR",
	]) {
		assert.ok(codes.includes(expected as never), `missing code ${expected}`);
	}
});

test("errorCodeToHttpStatus 覆盖所有 code 且只用 spec 约定的大类状态码", () => {
	const allowed = [400, 403, 404, 409, 500, 501];
	for (const code of WorkbenchErrorCodeSchema.options) {
		const status = errorCodeToHttpStatus[code];
		assert.ok(allowed.includes(status), `${code} -> ${status}`);
	}
	assert.equal(errorCodeToHttpStatus.NOT_FOUND, 404);
	assert.equal(errorCodeToHttpStatus.FORBIDDEN_PATH, 403);
	assert.equal(errorCodeToHttpStatus.FORBIDDEN_ORIGIN, 403);
	assert.equal(errorCodeToHttpStatus.AUTHENTICATION_FAILED, 400);
	assert.equal(errorCodeToHttpStatus.CONFLICT, 409);
	assert.equal(errorCodeToHttpStatus.BUSY, 409);
	assert.equal(errorCodeToHttpStatus.UNSUPPORTED_PLATFORM, 501);
	assert.equal(errorCodeToHttpStatus.INTERNAL_ERROR, 500);
});

test("成功 envelope 接受 { ok: true, data } 并保留 data", () => {
	const schema = SuccessEnvelopeSchema(HealthDataSchema);
	const parsed = schema.parse({
		ok: true,
		data: { status: "ok", timestamp: 1, service: "s" },
	});
	assert.deepEqual(parsed.data, {
		status: "ok",
		timestamp: 1,
		service: "s",
	});
});

test("失败 envelope 接受 { ok: false, code, message, details? }", () => {
	assert.equal(
		FailureEnvelopeSchema.safeParse({
			ok: false,
			code: "MISSING_FIELD",
			message: "缺少 path",
		}).success,
		true,
	);
	assert.equal(
		FailureEnvelopeSchema.safeParse({
			ok: false,
			code: "INVALID_REQUEST",
			message: "x",
			details: { issues: [{ path: "name", message: "required" }] },
		}).success,
		true,
	);
});

test("失败 envelope 拒绝未知 code 和缺字段", () => {
	assert.equal(
		FailureEnvelopeSchema.safeParse({ ok: false, code: "NOPE", message: "x" })
			.success,
		false,
	);
	assert.equal(
		FailureEnvelopeSchema.safeParse({ ok: false, code: "NOT_FOUND" }).success,
		false,
	);
});

test("JsonEnvelopeSchema 按 ok 判别，能区分成功/失败", () => {
	const schema = JsonEnvelopeSchema(HealthDataSchema);
	assert.equal(
		schema.safeParse({
			ok: true,
			data: { status: "ok", timestamp: 1, service: "s" },
		}).success,
		true,
	);
	assert.equal(
		schema.safeParse({ ok: false, code: "BUSY", message: "忙" }).success,
		true,
	);
});

test("success() / failure() helper 构造正确结构", () => {
	assert.deepEqual(success(1), { ok: true, data: 1 });
	assert.deepEqual(failure("NOT_FOUND", "找不到"), {
		ok: false,
		code: "NOT_FOUND",
		message: "找不到",
	});
	assert.deepEqual(failure("MISSING_FIELD", "缺少", { field: "path" }), {
		ok: false,
		code: "MISSING_FIELD",
		message: "缺少",
		details: { field: "path" },
	});
});

test("typed details schema 校验结构化形状", () => {
	assert.equal(
		MissingFieldDetailsSchema.safeParse({ field: "path" }).success,
		true,
	);
	assert.equal(MissingFieldDetailsSchema.safeParse({ field: 1 }).success, false);

	const issues = InvalidRequestDetailsSchema.parse({
		issues: [{ path: "name", message: "required" }],
	});
	assert.equal(issues.issues.length, 1);

	assert.equal(
		ForbiddenPathDetailsSchema.safeParse({ reason: "outside-root" }).success,
		true,
	);
	// FORBIDDEN_PATH reason 是固定枚举：拒绝把本机绝对路径塞进 reason
	assert.equal(
		ForbiddenPathDetailsSchema.safeParse({ reason: "/Users/leak" }).success,
		false,
	);

	assert.equal(
		NotFoundDetailsSchema.safeParse({ resource: "kb:demo" }).success,
		true,
	);
	assert.equal(
		ConflictDetailsSchema.safeParse({ conflicts: ["purpose.md"] }).success,
		true,
	);
});

test("ModelRef schema trim provider/modelId 且拒绝空字符串", () => {
	assert.deepEqual(
		ModelRefSchema.parse({ provider: " anthropic ", modelId: " claude-sonnet " }),
		{ provider: "anthropic", modelId: "claude-sonnet" },
	);
	assert.equal(
		ModelRefSchema.safeParse({ provider: " ", modelId: "claude-sonnet" }).success,
		false,
	);
	assert.equal(
		ModelRefSchema.safeParse({ provider: "anthropic", modelId: "" }).success,
		false,
	);
});

test("config / models / auth data schema 校验公开请求与响应 shape", () => {
	assert.equal(
		AppConfigSchema.safeParse({
			version: 1,
			externalKnowledgeBases: [],
			showUserGlobalSkills: true,
			modelRoles: { main: { provider: "anthropic", modelId: "claude-sonnet" }, digest: null },
			uiPrefs: { sidebarExpandedKbs: ["/kb/demo"] },
		}).success,
		true,
	);
	assert.equal(
		AvailableModelsDataSchema.safeParse([
			{
				provider: "anthropic",
				modelId: "claude-sonnet",
				name: "Claude Sonnet",
				reasoning: false,
				contextWindow: 200000,
				cost: { input: 3, output: 15 },
				hasAuth: true,
			},
		]).success,
		true,
	);
	assert.equal(
		AuthStatusDataSchema.safeParse({
			authFileExists: true,
			providers: [{ id: "anthropic", type: "api_key", configured: true }],
			envKeys: [{ name: "ANTHROPIC_API_KEY", present: false }],
		}).success,
		true,
	);
	assert.deepEqual(
		AuthSetBodySchema.parse({
			provider: " Anthropic ",
			type: "api_key",
			key: " sk-contract-test ",
		}),
		{ provider: "anthropic", type: "api_key", key: "sk-contract-test" },
	);
	assert.equal(
		AuthSetBodySchema.safeParse({ provider: " ", type: "api_key", key: "sk-contract-test" })
			.success,
		false,
	);
	assert.equal(
		AuthSetBodySchema.safeParse({ provider: "anthropic", type: "oauth", key: "sk-contract-test" })
			.success,
		false,
	);
	assert.equal(
		AuthConnectionTestBodySchema.safeParse({ provider: " " }).success,
		false,
	);
	assert.deepEqual(AuthSetDataSchema.parse({ saved: true }), { saved: true });
	assert.deepEqual(AuthConnectionTestDataSchema.parse({ message: "连接成功" }), {
		message: "连接成功",
	});
	assert.equal(AuthConnectionTestDataSchema.safeParse({ message: " " }).success, false);
});

test("命令清单契约不保留本机 skill 路径", () => {
	const commands = CommandListDataSchema.parse([
		{
			slug: "/project-skill",
			name: "project-skill",
			description: "Project capability",
			source: "builtin",
			isProjectSkill: true,
			skillPath: "/Users/example/.llm-wiki-agent/skills/project-skill",
		},
	]);
	assert.deepEqual(commands, [
		{
			slug: "/project-skill",
			name: "project-skill",
			description: "Project capability",
			source: "builtin",
			isProjectSkill: true,
		},
	]);
});

test("命令清单查询只接受明确的全局能力开关", () => {
	assert.deepEqual(CommandListQuerySchema.parse({}), {});
	assert.deepEqual(CommandListQuerySchema.parse({ includeUserGlobal: "true" }), {
		includeUserGlobal: "true",
	});
	assert.equal(
		CommandListQuerySchema.safeParse({ includeUserGlobal: "unexpected" }).success,
		false,
	);
	assert.equal(CommandListQuerySchema.safeParse({ unexpected: "true" }).success, false);
});

test("知识库上下文明确 GET query kb 与 JSON body kbPath", () => {
	assert.deepEqual(KnowledgeBaseContextQuerySchema.parse({ kb: " /kb/query " }), {
		kb: "/kb/query",
	});
	assert.deepEqual(
		KnowledgeBaseContextBodySchema.parse({ kbPath: " /kb/body " }),
		{ kbPath: "/kb/body" },
	);
	assert.equal(
		KnowledgeBaseContextBodySchema.safeParse({ path: "/kb/legacy" }).success,
		false,
	);
});

test("prompt 启动 request 只接受非空 message", () => {
	assert.deepEqual(PromptRequestBodySchema.parse({ message: " 你好 " }), {
		message: "你好",
	});
	for (const input of [
		{},
		{ message: " " },
		{ message: 1 },
		{ message: "你好", rawPrompt: "secret" },
	]) {
		assert.equal(PromptRequestBodySchema.safeParse(input).success, false);
	}
});

test("prompt SSE schema 完整校验所有公开事件", () => {
	const base = { schemaVersion: 1, runId: "run-1", messageId: "message-1" } as const;
	const events = [
		{ ...base, seq: 1, type: "assistant_text_delta", delta: "你好" },
		{
			...base,
			seq: 2,
			type: "tool_status_start",
			toolCallId: "read-1",
			toolName: "read",
			action: "读取",
			target: "~/wiki/a.md",
			status: "running",
			args: { path: "~/wiki/a.md" },
			runningToolCount: 1,
			otherRunningCount: 0,
		},
		{
			...base,
			seq: 3,
			type: "tool_status_update",
			toolCallId: "read-1",
			toolName: "read",
			action: "读取",
			target: "~/wiki/a.md",
			status: "running",
			args: {},
			detail: { summary: "读取中" },
			runningToolCount: 1,
			otherRunningCount: 0,
		},
		{
			...base,
			seq: 4,
			type: "tool_status_end",
			toolCallId: "read-1",
			toolName: "read",
			action: "读取",
			target: "~/wiki/a.md",
			status: "done",
			result: { summary: "完成" },
			summary: "完成",
			error: null,
			durationMs: 12,
			runningToolCount: 0,
			otherRunningCount: 0,
		},
		{
			...base,
			seq: 5,
			type: "tool_status_summary",
			items: [{ toolCallId: "read-1", toolName: "read", action: "读取", target: "~/wiki/a.md", status: "done", summary: "完成" }],
			remainingRunningCount: 0,
		},
		{ ...base, seq: 6, type: "artifact_created", id: "artifact-1", kind: "html", title: "报告" },
		{ ...base, seq: 7, type: "assistant_done" },
		{ ...base, seq: 7, type: "assistant_cancelled", reason: "用户已停止" },
		{ ...base, seq: 7, type: "assistant_error", code: "INTERNAL_ERROR", message: "生成过程中发生错误", details: { diagnosticId: "safe-id" } },
		{ ...base, seq: 8, type: "assistant_evidence", mode: "sources-only", evidence: [] },
	];

	assert.equal(events.length, PROMPT_SSE_EVENT_TYPES.length);
	for (const event of events) assert.deepEqual(PromptSseEventSchema.parse(event), event);
	assert.equal(isPromptTerminalEvent(events[6]!), true);
	assert.equal(isPromptTerminalEvent(events[0]!), false);
});

test("prompt SSE schema 拒绝版本、关键字段和旧错误 shape 漂移", () => {
	const valid = {
		schemaVersion: 1,
		type: "assistant_error",
		runId: "run-1",
		messageId: "message-1",
		seq: 1,
		code: "INTERNAL_ERROR",
		message: "生成过程中发生错误",
	};
	for (const invalid of [
		{ ...valid, schemaVersion: 2 },
		{ ...valid, runId: "" },
		{ ...valid, messageId: undefined },
		{ ...valid, seq: 0 },
		{ ...valid, type: "unknown_event" },
		{ schemaVersion: 1, type: "assistant_error", runId: "run-1", messageId: "message-1", seq: 1, error: "/Users/private/stack" },
	]) {
		assert.equal(PromptSseEventSchema.safeParse(invalid).success, false);
	}
});

test("HealthData schema 校验心跳 data", () => {
	assert.equal(
		HealthDataSchema.safeParse({
			status: "ok",
			timestamp: 100,
			service: "s",
		}).success,
		true,
	);
	// status 不是 'ok' / timestamp 非正整数 都拒绝
	assert.equal(
		HealthDataSchema.safeParse({
			status: "down",
			timestamp: 100,
			service: "s",
		}).success,
		false,
	);
	assert.equal(
		HealthDataSchema.safeParse({
			status: "ok",
			timestamp: -1,
			service: "s",
		}).success,
		false,
	);
});
