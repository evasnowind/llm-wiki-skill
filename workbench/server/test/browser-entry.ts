import { appendFileSync, existsSync, unlinkSync } from "node:fs";
import { appendFile, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Api,
	type Context,
	type Model,
	type StreamOptions,
} from "@earendil-works/pi-ai";

import { modelRegistry } from "../src/agent.js";
import { triggerGraphRebuild } from "../src/graph.js";
import { createGraphRenameService } from "../src/graph-renames.js";
import { defaultGraphRenameRouteService } from "../src/routes/graph-renames.js";
import { defaultGraphRouteService } from "../src/routes/graph.js";
import { createRuntimeApplication } from "../src/runtime-app.js";
import { startWorkbenchServer } from "../src/startup.js";
import { createIngestQueue } from "../src/ingest/queue.js";
import { assertRegisteredKnowledgeBase, validateInspectedSourceFiles } from "../src/knowledge-bases.js";

const FAKE_MODEL_MARKER = "browser-foundation-fake-model";
const FAUX_PROVIDER = "browser-test-provider";
const FAUX_MODEL = "browser-test-model";
const modelFailureFlag = path.join(process.env.HOME ?? "", ".llm-wiki-agent", "browser-model-fail");
const modelErrorAttemptsFile = path.join(process.env.HOME ?? "", ".llm-wiki-agent", "browser-model-error-attempts");
const modelCancelStartedFlag = path.join(process.env.HOME ?? "", ".llm-wiki-agent", "browser-model-cancel-started");
const modelCancelSettledFlag = path.join(process.env.HOME ?? "", ".llm-wiki-agent", "browser-model-cancel-settled");
const modelDisconnectStartedFlag = path.join(process.env.HOME ?? "", ".llm-wiki-agent", "browser-model-disconnect-started");
const modelDisconnectSettledFlag = path.join(process.env.HOME ?? "", ".llm-wiki-agent", "browser-model-disconnect-settled");
const browserAppDir = path.join(process.env.HOME ?? "", ".llm-wiki-agent");
const renamePauseBeforeCommitFlag = path.join(browserAppDir, "browser-rename-pause-before-commit");
const renamePausedFlag = path.join(browserAppDir, "browser-rename-paused");
const renameResumeFlag = path.join(browserAppDir, "browser-rename-resume");
const renameCrashAfterWriteFlag = path.join(browserAppDir, "browser-rename-crash-after-write");
const renameRebuildFailOnceFlag = path.join(browserAppDir, "browser-rename-rebuild-fail-once");
const renameEventsFile = path.join(browserAppDir, "browser-rename-events.jsonl");
const selectedDirectory = process.env.LLM_WIKI_BROWSER_SELECTED_DIRECTORY;
if (!selectedDirectory) {
	throw new Error("browser test entry requires LLM_WIKI_BROWSER_SELECTED_DIRECTORY");
}

for (const key of [
	"OPENAI_API_KEY",
	"ANTHROPIC_API_KEY",
	"GOOGLE_API_KEY",
	"GEMINI_API_KEY",
	"PI_CONFIG_DIR",
	"XDG_CONFIG_HOME",
]) {
	if (process.env[key]) throw new Error(`browser test entry received forbidden environment: ${key}`);
}

modelRegistry.registerProvider(FAUX_PROVIDER, {
	api: "browser-test-api",
	baseUrl: "http://127.0.0.1/browser-test-model",
	apiKey: "fictional-browser-test-key",
	streamSimple: streamBrowserModel,
	models: [{
		id: FAUX_MODEL,
		name: "Browser Test Model",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	}],
});
const fauxModel = modelRegistry.find(FAUX_PROVIDER, FAUX_MODEL);
if (!fauxModel) throw new Error("browser test model registration failed");
const hasConfiguredAuth = modelRegistry.hasConfiguredAuth.bind(modelRegistry);
modelRegistry.hasConfiguredAuth = (model) => {
	if (model.provider === FAUX_PROVIDER && existsSync(modelFailureFlag)) return false;
	return hasConfiguredAuth(model);
};

const browserGraphRenameService = {
	...createGraphRenameService({
		beforeFileCommit: async () => {
			if (!existsSync(renamePauseBeforeCommitFlag)) return;
			await writeFile(renamePausedFlag, "paused\n");
			await waitForRenameResume();
			await Promise.all([
				rm(renamePauseBeforeCommitFlag, { force: true }),
				rm(renamePausedFlag, { force: true }),
				rm(renameResumeFlag, { force: true }),
			]);
		},
		afterFileCommit: () => {
			if (!existsSync(renameCrashAfterWriteFlag)) return;
			unlinkSync(renameCrashAfterWriteFlag);
			process.exit(86);
		},
		beforeSourceRename: () => recordRenameEvent({ event: "source_rename_started" }),
		afterSourceRenameStep: (state) => recordRenameEvent({ event: "source_rename_step", state }),
		triggerRebuild: (kbPath) => {
			if (existsSync(renameRebuildFailOnceFlag)) {
				unlinkSync(renameRebuildFailOnceFlag);
				recordRenameEvent({ event: "graph_rebuild", outcome: "failed" });
				throw new Error("browser-controlled graph rebuild failure");
			}
			try {
				const result = triggerGraphRebuild(kbPath);
				recordRenameEvent({ event: "graph_rebuild", outcome: "started" });
				return result;
			} catch (error) {
				recordRenameEvent({ event: "graph_rebuild", outcome: "failed" });
				throw error;
			}
		},
	}),
	getActiveKnowledgeBasePath: defaultGraphRenameRouteService.getActiveKnowledgeBasePath,
};
Object.assign(defaultGraphRenameRouteService, browserGraphRenameService);
defaultGraphRouteService.triggerGraphRebuild = (kbPath) => {
	const result = triggerGraphRebuild(kbPath);
	recordRenameEvent({ event: "graph_rebuild", outcome: "started" });
	return { status: result.status };
};

function recordRenameEvent(event: {
	event: string;
	state?: "old" | "transit" | "target";
	outcome?: "failed" | "started";
}): void {
	appendFileSync(renameEventsFile, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
}

const browserIngestQueue = createIngestQueue({
	root: path.join(browserAppDir, "browser-ingest"),
	assertRegisteredKnowledgeBase,
	validateSources: validateInspectedSourceFiles,
	resolveRevisionModel: async () => ({ provider: FAUX_PROVIDER, modelId: FAUX_MODEL }),
	generateRevision: async (input) => {
		await appendFile(path.join(browserAppDir, "browser-revision-events.jsonl"), `${JSON.stringify({ event: "generate", name: input.name, feedback: input.feedback ?? "" })}\n`);
		input.onProgress?.(30);
		if (input.feedback?.includes("[revision-fail]") && existsSync(path.join(browserAppDir, "browser-revision-fail"))) {
			throw new Error("controlled revision fixture failure");
		}
		while (input.feedback?.includes("[revision-hold]") && !existsSync(path.join(browserAppDir, "browser-revision-release"))) {
			if (input.signal.aborted && !input.feedback.includes("[ignore-cancel]")) throw new DOMException("Aborted", "AbortError");
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		if (input.signal.aborted && !input.feedback?.includes("[ignore-cancel]")) throw new DOMException("Aborted", "AbortError");
		return `# 浏览器候选摘要\n\n${input.text}\n\n摘要要求：${input.feedback ?? "默认"}\n`;
	},
	generate: async (input, progress, signal) => {
		const content = await readFile(input.filePath, "utf8");
		await appendFile(path.join(browserAppDir, "browser-ingest-events.jsonl"), `${JSON.stringify({ kbPath: input.kbPath, event: "generate" })}\n`);
		await progress(30);
		if (content.includes("[ingest-fail]") && existsSync(path.join(browserAppDir, "browser-ingest-fail"))) {
			throw new Error("controlled ingest fixture failure");
		}
		while (content.includes("[ingest-hold]") && !existsSync(path.join(browserAppDir, "browser-ingest-release"))) {
			if (signal.aborted) throw new DOMException("Aborted", "AbortError");
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		if (signal.aborted) throw new DOMException("Aborted", "AbortError");
		return `# 可靠入库素材\n\n${content}\n`;
	},
});
await browserIngestQueue.recover();

const runningServer = await startWorkbenchServer({
	createApplication: (token) => createRuntimeApplication(token, {
		chooseDirectory: async () => selectedDirectory,
		graphRenameService: browserGraphRenameService,
		ingestJobService: { ...browserIngestQueue, assertRegisteredKnowledgeBase },
	}),
});

let shutdownPromise: Promise<void> | undefined;
function requestShutdown(): void {
	shutdownPromise ??= Promise.all([runningServer.close(), browserIngestQueue.close()]).then(() => {}).finally(() => {
		modelRegistry.hasConfiguredAuth = hasConfiguredAuth;
		modelRegistry.unregisterProvider(FAUX_PROVIDER);
		process.exitCode = 0;
	});
}

process.once("SIGINT", requestShutdown);
process.once("SIGTERM", requestShutdown);

function streamBrowserModel(model: Model<Api>, context: Context, options?: StreamOptions) {
	const prompt = latestUserMessage(context);
	console.log(`[browser-test-model] ${FAKE_MODEL_MARKER}`);
	const stream = createAssistantMessageEventStream();
	queueMicrotask(async () => {
		if (prompt.includes("[evidence]")) await appendFile(path.join(browserAppDir, "browser-evidence-contexts.jsonl"), `${JSON.stringify(context)}\n`);
		if (prompt.includes("[model-error]")) {
			await appendFile(modelErrorAttemptsFile, "attempt\n");
			const failure = browserAssistantMessage(
				model,
				"",
				"error",
				"fictional retryable server error that must not reach the page or session",
			);
			failure.diagnostics = [{
				type: "provider_failure",
				timestamp: 0,
				error: {
					message: "fictional diagnostic detail that must not reach the page or session",
					stack: "fictional diagnostic stack that must not reach the page or session",
				},
				details: { path: "/fictional/private/diagnostic" },
			}];
			stream.push({ type: "error", reason: "error", error: failure });
			stream.end(failure);
			return;
		}
		if (prompt.includes("cancel this response")) {
			await writeFile(modelCancelStartedFlag, "started");
		}
		if (prompt.includes("disconnect this response")) {
			await writeFile(modelDisconnectStartedFlag, "started");
		}
		if (prompt.includes("[slow]")) await waitForAbortOrTimeout(options?.signal, 3_000);
		if (prompt.includes("cancel this response")) {
			await writeFile(modelCancelSettledFlag, "settled");
		}
		if (prompt.includes("disconnect this response")) {
			await writeFile(modelDisconnectSettledFlag, "settled");
		}

		if (options?.signal?.aborted) {
			const aborted = browserAssistantMessage(model, "", "aborted", "Request was aborted");
			stream.push({ type: "error", reason: "aborted", error: aborted });
			stream.end(aborted);
			return;
		}
		const responseText = prompt.includes("[evidence]")
			? browserEvidenceReply(context, prompt)
			: prompt.includes("[retrieval-owner]")
			? `retrieval-owner:${retrievalOwner(context.systemPrompt)}`
			: prompt.includes("[refs]")
				? "请查看 [[wiki/entities/shared.md]]，也可打开 [[wiki/entities/missing.md]]。"
				: `可控的测试回复：${prompt}`;
		const message = browserAssistantMessage(model, responseText, "stop");
		const partial = { ...message, content: [] };
		stream.push({ type: "start", partial });
		stream.push({ type: "text_start", contentIndex: 0, partial });
		stream.push({
			type: "text_delta",
			contentIndex: 0,
			delta: responseText,
			partial: { ...message },
		});
		stream.push({ type: "text_end", contentIndex: 0, content: responseText, partial: message });
		stream.push({ type: "done", reason: "stop", message });
		stream.end(message);
	});
	return stream;
}

function browserEvidenceReply(context: Context, prompt: string): string {
	const fullContext = `${context.systemPrompt ?? ""}\n${JSON.stringify(context.messages)}`;
	let id = "";
	// The fake provider selects only a citation that the real retrieval pipeline supplied.
	const knowledgeMatch = context.systemPrompt?.match(/\[\d+\]\(#evidence-(E\d+)\)[^\n]*\n路径: raw\/handbook\.md\n/);
	if (knowledgeMatch) id = knowledgeMatch[1]!;
	if (!id) {
		const jsonStart = prompt.indexOf('[{"id":');
		if (jsonStart >= 0) {
			try { id = (JSON.parse(prompt.slice(jsonStart)) as Array<{ id: string; path: string }>).find((item) => item.path === "raw/handbook.md")?.id ?? ""; } catch { /* no evidence supplied */ }
		}
	}
	if (!id || !fullContext.includes("RAW_REFUND_48")) return "原文证据不足。";
	return `原文规定退款在 48 小时内完成。[1](#evidence-${id})`;
}

function retrievalOwner(systemPrompt: string | undefined): "atlas" | "harbor" | "none" {
	if (systemPrompt?.includes("Atlas-only fictional signal")) return "atlas";
	if (systemPrompt?.includes("Harbor-only fictional signal")) return "harbor";
	return "none";
}

function browserAssistantMessage(
	model: Model<Api>,
	text: string,
	stopReason: "stop" | "aborted" | "error",
	errorMessage?: string,
) {
	return {
		...fauxAssistantMessage(text, { stopReason, ...(errorMessage ? { errorMessage } : {}) }),
		api: model.api,
		provider: model.provider,
		model: model.id,
	};
}

function latestUserMessage(context: Context): string {
	let message: Context["messages"][number] | undefined;
	for (let index = context.messages.length - 1; index >= 0; index--) {
		const candidate = context.messages[index];
		if (candidate?.role === "user") {
			message = candidate;
			break;
		}
	}
	if (!message || message.role !== "user") return "";
	if (typeof message.content === "string") return message.content;
	return message.content
		.map((block) => block.type === "text" ? block.text : "")
		.filter(Boolean)
		.join("\n");
}

async function waitForAbortOrTimeout(signal: AbortSignal | undefined, timeoutMs: number): Promise<void> {
	if (signal?.aborted) return;
	await new Promise<void>((resolve) => {
		const timer = setTimeout(finish, timeoutMs);
		const onAbort = () => finish();
		signal?.addEventListener("abort", onAbort, { once: true });
		function finish() {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}
	});
}

async function waitForRenameResume(): Promise<void> {
	const deadline = Date.now() + 30_000;
	while (!existsSync(renameResumeFlag)) {
		if (Date.now() >= deadline) throw new Error("browser rename resume flag did not appear");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}
