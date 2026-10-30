import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

import {
  PromptRequestBodySchema,
  type PromptSseEvent,
  type EvidenceCitation,
  type RetrievalMode,
} from "@llm-wiki/workbench-contracts";

import type { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";

import { artifactEvents, type ArtifactCreatedEvent } from "../artifacts.js";
import { authStorage, modelRegistry, finalizeSessionTerminalPersistence, getActive } from "../agent.js";
import { branchEntryIds, persistTurnEvidence } from "../evidence-metadata.js";
import { registerSessionDependent } from "../session-lifecycle.js";
import { appendSourcesOnlyAssistant, appendSourcesOnlyUser, buildSourcesOnlyQuestion, createSourcesOnlySession, localSourcesOnlyAssistant, NO_SOURCE_EVIDENCE_REPLY } from "../sources-only.js";
import { PublishedAssistantText } from "../extensions/prompt-terminal.js";
import {
  clearPendingKnowledgeContext,
  runWithPendingKnowledgeContextOwner,
  setPendingKnowledgeContext,
} from "../extensions/knowledge-base.js";
import { HttpContractError, parseValidatedBody } from "../http/request.js";
import {
  buildKnowledgeContextMessage,
  contextBudgetFromWindow,
  parseExplicitPageRefs,
  searchKnowledgeBase,
  shouldUseKnowledgeBase,
  writeRetrievalLog,
  type SearchKnowledgeBaseOutput,
} from "../retrieval.js";
import {
  OrderedSseWriter,
  PromptRunRegistry,
  ToolStatusEventAdapter,
} from "../tool-status-events.js";

export interface PromptSession {
  subscribe: (listener: (event: unknown) => void | Promise<void>) => () => void;
  prompt: (message: string) => Promise<void>;
  abort?: () => void;
  abortCompaction?: () => void;
  sessionManager?: SessionManager;
  state: { model?: { contextWindow?: unknown } };
}

export interface PromptActiveContext {
  kbPath: string;
  name: string;
  conversationId: string;
  /** 用于 BUSY 去重与 session 归属；同一会话同时只允许一个 run。 */
  sessionId: string;
}

/**
 * route 提供给 service 驱动 SSE 的句柄。
 * writer 负责终态门禁（terminal 后忽略后续写入）与 transport 断开检测。
 */
export interface PromptRunHandle {
  adapter: ToolStatusEventAdapter;
  writer: PromptEventWriter;
}

export interface PromptRunContext extends PromptRunHandle {
  runId: string;
  messageId: string;
  message: string;
  retrievalMode?: RetrievalMode;
  isolatedSession?: PromptSession;
  active: PromptActiveContext;
  session: PromptSession;
  sessionEvents: PromptSessionEventQueue;
}

export interface PromptEventWriter {
  /** 写入共享契约事件；返回是否已实际写入（terminal 后或 transport 断开后为 false）。 */
  write: (event: PromptSseEvent | null) => Promise<boolean>;
  /** 等待已排队写入落盘。 */
  flush: () => Promise<void>;
  /** writer 是否仍可写（未断开、未写过 terminal）。 */
  readonly open: boolean;
}

/** Keeps non-awaited SDK listener events in order and records only delivered text. */
export class PromptSessionEventQueue {
  private queue: Promise<void> = Promise.resolve();
  readonly publishedAssistantText = new PublishedAssistantText();

  enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).catch(() => {});
  }

	recordCancellation(adapter: ToolStatusEventAdapter): void {
		this.enqueue(async () => {
			adapter.recordCancellation();
		});
	}

	enqueueAgentEvent(
		adapter: ToolStatusEventAdapter,
		writer: PromptEventWriter,
		agentEvent: unknown,
	): void {
		this.enqueue(async () => {
			for (const contractEvent of adapter.adapt(agentEvent)) {
				const delivered = await writer.write(contractEvent);
				if (delivered && contractEvent.type === "assistant_text_delta") {
					this.publishedAssistantText.append(contractEvent.delta);
				}
			}
			this.recordAssistantMessageEnd(agentEvent);
		});
	}

  recordAssistantMessageEnd(event: unknown): void {
    const message = getAssistantMessageEnd(event);
    if (message) this.publishedAssistantText.endAssistantMessage(message.stopReason);
  }

	flush(): Promise<void> {
		return this.waitForIdle();
	}

	private async waitForIdle(): Promise<void> {
		while (true) {
			const pending = this.queue;
			await pending;
			if (this.queue === pending) return;
		}
	}
}

export interface PromptRunSeed {
  active: PromptActiveContext;
  session: PromptSession;
}

export interface PromptRouteService {
  getRunSeed: () => PromptRunSeed;
  createRunId: () => string;
  createMessageId: (runId: string) => string;
  beginRun: (sessionId: string, runId: string) => boolean;
  endRun: (sessionId: string, runId: string) => void;
  /** 订阅 agent 事件；service 内部把事件喂给 ctx.adapter。 */
  subscribeSession: (ctx: PromptRunContext) => () => void;
  /** 订阅 artifact 事件；service 内部按 conversation 归属喂给 ctx.adapter。 */
  subscribeArtifacts: (ctx: PromptRunContext) => () => void;
  /**
   * 执行检索 + prompt，并在成功时写出 terminal。
   * 失败由 route 兜底 failAssistant。
   */
  runPrompt: (ctx: PromptRunContext) => Promise<void>;
  /** transport 断开时由 route 调用，取消正在运行的 agent。 */
  abortSession: (ctx: PromptRunContext) => void;
  clearPendingKnowledgeContext: (ctx: PromptRunContext) => void;
}

export function createPromptRoutes(service: PromptRouteService): Hono {
  const router = new Hono();

  router.post("/prompt", async (c) => {
    const body = await parseValidatedBody(c, PromptRequestBodySchema);
    const { active, session } = resolveRunSeed(service);
    if ((body.kbPath !== undefined && body.kbPath !== active.kbPath)
      || (body.conversationId !== undefined && body.conversationId !== active.conversationId)) {
      throw new HttpContractError("INVALID_REQUEST", "对话或知识库已切换，请刷新后重试");
    }

    const runId = service.createRunId();
    const messageId = service.createMessageId(runId);
    if (!service.beginRun(active.sessionId, runId)) {
      throw new HttpContractError(
        "BUSY",
        "当前对话正在生成，请等待上一条回复完成",
      );
    }

    return streamSSE(c, async (stream) => {
      const state = { transportOpen: true, terminalWritten: false };
      const adapter = new ToolStatusEventAdapter({ runId, messageId });
      const rawWriter = new OrderedSseWriter(async (payload) => {
        await stream.writeSSE(payload);
      });
      const writer: PromptEventWriter = {
        get open() {
          return state.transportOpen && !state.terminalWritten;
        },
        async write(event) {
          if (!event || state.terminalWritten || !state.transportOpen) return false;
          if (
            event.type === "assistant_done" ||
            event.type === "assistant_cancelled" ||
            event.type === "assistant_error"
          ) {
            state.terminalWritten = true;
          }
          return rawWriter.writeContract(event);
        },
        flush: () => rawWriter.flush(),
      };
      const ctx: PromptRunContext = {
        runId,
        messageId,
        message: body.message,
        retrievalMode: body.retrievalMode ?? "knowledge",
        active,
        session,
        adapter,
        writer,
        sessionEvents: new PromptSessionEventQueue(),
      };

      let unsubscribeSession: (() => void) | undefined;
      let unsubscribeArtifacts: (() => void) | undefined;

      try {
        unsubscribeSession = service.subscribeSession(ctx);
        unsubscribeArtifacts = service.subscribeArtifacts(ctx);

        stream.onAbort(() => {
          state.transportOpen = false;
          rawWriter.close();
          service.clearPendingKnowledgeContext(ctx);
          service.abortSession(ctx);
        });

        await service.runPrompt(ctx);
        if (!adapter.isFinished && writer.open) {
          for (const event of adapter.failAssistant(
            new Error("missing terminal event"),
          )) {
            await writer.write(event);
          }
        }
      } catch (err) {
        if (writer.open) {
          for (const event of adapter.failAssistant(err)) {
            await writer.write(event);
          }
        }
      } finally {
        await writer.flush();
        unsubscribeArtifacts?.();
        unsubscribeSession?.();
        service.clearPendingKnowledgeContext(ctx);
        service.endRun(active.sessionId, runId);
        rawWriter.close();
      }
    });
  });

  return router;
}

function resolveRunSeed(service: PromptRouteService): PromptRunSeed {
  try {
    return service.getRunSeed();
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code === "NO_ACTIVE_KB") {
      throw new HttpContractError("NO_ACTIVE_KB", "当前没有选择知识库");
    }
    throw new HttpContractError("INTERNAL_ERROR", "服务器内部错误");
  }
}

// ============= 默认实现：连接真实 agent / retrieval / artifact 运行时 =============

const defaultRegistry = new PromptRunRegistry();

export const defaultPromptRouteService: PromptRouteService = {
  getRunSeed() {
    const active = getActive();
    if (!active) {
      throw Object.assign(new Error("没有活跃对话"), { code: "NO_ACTIVE_KB" });
    }
    return {
      active: {
        kbPath: active.kb.path,
        name: active.kb.name,
        conversationId: active.conversationId,
        sessionId: active.conversationId,
      },
      session: active.session as unknown as PromptSession,
    };
  },
  createRunId() {
    return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  },
  createMessageId(runId) {
    return `assistant-${runId}`;
  },
  beginRun: (sessionId, runId) => defaultRegistry.begin(sessionId, runId),
  endRun: (sessionId, runId) => defaultRegistry.end(sessionId, runId),
  subscribeSession(ctx) {
    const listener = (agentEvent: unknown) => {
			ctx.sessionEvents.enqueueAgentEvent(ctx.adapter, ctx.writer, agentEvent);
    };
    return ctx.session.subscribe(listener);
  },
  subscribeArtifacts(ctx) {
    const conversationId = ctx.active.conversationId;
    const listener = async (event: ArtifactCreatedEvent) => {
      if (event.conversationId !== conversationId) return;
      const contractEvent = ctx.adapter.artifactCreated({
        id: event.id,
        kind: event.kind,
        title: event.title,
      });
      if (contractEvent) {
        try {
          await ctx.writer.write(contractEvent);
        } catch {
          // transport 写失败：忽略。
        }
      }
    };
    artifactEvents.on("artifact_created", listener);
    return () => {
      artifactEvents.off("artifact_created", listener);
    };
  },
  async runPrompt(ctx) {
    const session = ctx.session;
    const active = ctx.active;
    const message = ctx.message;
    const mode = ctx.retrievalMode ?? "knowledge";
    const beforeEntries = branchEntryIds(session.sessionManager);
    let evidence: EvidenceCitation[] = [];
    let retrievalWarnings: string[] = [];
    const isCurrentRun = () => {
      const current = getActive();
      return (
        ctx.writer.open &&
        defaultRegistry.get(active.sessionId) === ctx.runId &&
        current?.conversationId === active.conversationId &&
        current.session === session
      );
    };
    const explicitRefs = parseExplicitPageRefs(message);
    const shouldSearch = mode === "sources-only" || shouldUseKnowledgeBase(message, true);
    let knowledgeContext: string | null = null;
    {
      const baseLog = {
        ts: Date.now(),
        sessionId: active.conversationId,
        kbPath: active.kbPath,
      };
      if (shouldSearch) {
        const toolCallId = `${ctx.runId}-knowledge-search`;
        try {
          await ctx.writer.write(
            ctx.adapter.startTool({
              toolCallId,
              toolName: "knowledge_search",
              args: {},
            }),
          );
          await ctx.writer.write(
            ctx.adapter.updateTool({
              toolCallId,
              toolName: "knowledge_search",
              args: {},
              partialResult: { summary: "正在检索当前知识库" },
            }),
          );
          const search = await searchKnowledgeBase(active.kbPath, message, {
            explicitRefs,
            mode,
            totalBudgetChars: contextBudgetFromWindow(
              session.state?.model?.contextWindow,
            ),
          });
          retrievalWarnings = (search.warnings ?? []).slice(0, 10).map((warning) => warning.slice(0, 512));
          evidence = (search.evidence ?? []).filter((citation) => mode !== "sources-only" || citation.kind === "raw");
          knowledgeContext = mode === "knowledge" ? buildKnowledgeContextMessage({
            kb: { name: active.name, path: active.kbPath },
            search,
          }) : null;
          if (!isCurrentRun()) return;
          await ctx.writer.write(
            ctx.adapter.endTool({
              toolCallId,
              toolName: "knowledge_search",
              result: {
                summary:
                  (search.results.length > 0
                    ? `已检索到 ${search.results.length} 个相关页面`
                    : "本次检索未返回相关页面") + (retrievalWarnings.length ? "；部分内容未能检索" : ""),
                count: search.results.length,
              },
            }),
          );
          await writeRetrievalLog({
            ...baseLog,
            triggered: true,
            results: search.results.map((result) => ({
              path: result.path,
              hitReason: result.hitReason,
              score: result.score,
            })),
            error: null,
          }).catch(() => {});
        } catch {
          evidence = [];
          knowledgeContext = null;
          retrievalWarnings = ["知识库检索失败，本轮未能完整读取素材。"];
          const errorText = "知识库检索失败";
          await ctx.writer.write(
            ctx.adapter.endTool({
              toolCallId,
              toolName: "knowledge_search",
              result: { error: errorText },
              isError: true,
            }),
          );
          await writeRetrievalLog({
            ...baseLog,
            triggered: true,
            results: [],
            error: "retrieval_failed",
          }).catch(() => {});
        }
      } else {
        await writeRetrievalLog({
          ...baseLog,
          triggered: false,
          results: [],
          error: null,
        }).catch(() => {});
      }
    }
    if (!isCurrentRun()) return;
    await ctx.writer.write(ctx.adapter.assistantEvidence(mode, evidence));
    const contextOwner = {
      runId: ctx.runId,
      conversationId: active.conversationId,
      async publishSearchEvidence(search: SearchKnowledgeBaseOutput): Promise<SearchKnowledgeBaseOutput> {
        if (!isCurrentRun()) return { ...search, results: [], evidence: [] };
        await ctx.sessionEvents.flush();
        if (!isCurrentRun()) return { ...search, results: [], evidence: [] };
        const registered = registerSearchEvidence(evidence, search);
        await ctx.writer.write(ctx.adapter.assistantEvidence(mode, evidence));
        return registered;
      },
    };
    if (knowledgeContext) {
      setPendingKnowledgeContext(knowledgeContext, contextOwner);
    }
	try {
    if (mode === "sources-only") {
      await runSourcesOnlyPrompt(ctx, evidence, isCurrentRun, createSourcesOnlySession, retrievalWarnings);
    } else {
      await runWithPendingKnowledgeContextOwner(contextOwner, () => session.prompt(message));
    }
	} finally {
		await ctx.sessionEvents.flush();
		finalizeSessionTerminalPersistence(
			session,
			ctx.adapter.pendingTerminalReason,
			ctx.sessionEvents.publishedAssistantText.terminalText,
		);
    persistTurnEvidence(session.sessionManager, beforeEntries, { runId: ctx.runId, mode, evidence });
	}
    for (const event of ctx.adapter.finishAssistant()) {
      await ctx.writer.write(event);
    }
  },
  abortSession(ctx) {
		ctx.sessionEvents.recordCancellation(ctx.adapter);
    if (ctx.retrievalMode === "sources-only") {
      ctx.isolatedSession?.abort?.();
    } else {
      ctx.session.abortCompaction?.();
      ctx.session.abort?.();
    }
  },
  clearPendingKnowledgeContext(ctx) {
    clearPendingKnowledgeContext({
      runId: ctx.runId,
      conversationId: ctx.active.conversationId,
    });
  },
};

/** Assign citations across all searches in one turn without rewriting earlier ids. */
export function registerSearchEvidence(evidence: EvidenceCitation[], search: SearchKnowledgeBaseOutput): SearchKnowledgeBaseOutput {
  const key = (item: EvidenceCitation) => JSON.stringify([item.path, item.fileHash, item.startLine, item.endLine, item.excerptHash]);
  const assigned = new Map(evidence.map((item) => [key(item), item]));
  const citations = new Map<string, EvidenceCitation>();
  const results = search.results.flatMap((result) => {
    const item = result.citation;
    if (!item) return [];
    let next = assigned.get(key(item));
    if (!next && evidence.length < 50) {
      next = { ...item, id: `E${evidence.length + 1}` };
      evidence.push(next);
      assigned.set(key(item), next);
    }
    if (!next) return [];
    citations.set(next.id, next);
    return [{ ...result, citation: next }];
  });
  return { ...search, results, evidence: [...citations.values()] };
}

export async function runSourcesOnlyPrompt(
  ctx: PromptRunContext,
  evidence: EvidenceCitation[],
  isCurrentRun: () => boolean,
  createSession: typeof createSourcesOnlySession = createSourcesOnlySession,
  warnings: string[] = [],
): Promise<void> {
  if (!isCurrentRun()) return;
  const main = ctx.session as unknown as AgentSession;
  if (evidence.length === 0) {
    appendSourcesOnlyUser(main, ctx.message);
    const text = warnings.length
      ? `原文证据不足：本次检索未能完整读取素材，暂不能确认是否存在相关证据。\n\n检索提示：${warnings.join("；")}`
      : NO_SOURCE_EVIDENCE_REPLY;
    const assistant = localSourcesOnlyAssistant(text, main.model);
    ctx.sessionEvents.enqueueAgentEvent(ctx.adapter, ctx.writer, {
      type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text },
    });
    ctx.sessionEvents.enqueueAgentEvent(ctx.adapter, ctx.writer, { type: "message_end", message: assistant });
    await ctx.sessionEvents.flush();
    appendSourcesOnlyAssistant(main, assistant);
    return;
  }
  let isolated: AgentSession | null = null;
  let unsubscribe = () => {};
  let unregisterDependent = () => {};
  let failed = false;
  let userAppended = false;
  try {
    isolated = await createSession({ kbPath: ctx.active.kbPath, model: main.model, authStorage, modelRegistry });
    ctx.isolatedSession = isolated as unknown as PromptSession;
    unregisterDependent = registerSessionDependent(main, () => {
      ctx.sessionEvents.recordCancellation(ctx.adapter);
      isolated?.abort();
    });
    if (!isCurrentRun()) {
      ctx.sessionEvents.recordCancellation(ctx.adapter);
      return;
    }
    appendSourcesOnlyUser(main, ctx.message);
    userAppended = true;
    unsubscribe = isolated.subscribe((event) => ctx.sessionEvents.enqueueAgentEvent(ctx.adapter, ctx.writer, event));
    await isolated.prompt(buildSourcesOnlyQuestion(ctx.message, evidence, warnings));
  } catch {
    if (!isCurrentRun()) return;
    failed = true;
    if (!userAppended) {
      appendSourcesOnlyUser(main, ctx.message);
      userAppended = true;
    }
    ctx.sessionEvents.enqueueAgentEvent(ctx.adapter, ctx.writer, {
      type: "message_end", message: localSourcesOnlyAssistant("", main.model, "error"),
    });
  } finally {
    await ctx.sessionEvents.flush();
    const assistant = [...(isolated?.messages ?? [])].reverse().find((message) => message.role === "assistant");
    if (userAppended) appendSourcesOnlyAssistant(main,
      assistant?.role === "assistant" ? assistant : localSourcesOnlyAssistant("", main.model, ctx.adapter.pendingTerminalReason === "aborted" ? "aborted" : failed ? "error" : "stop"),
      ctx.sessionEvents.publishedAssistantText.terminalText,
    );
    unsubscribe();
    unregisterDependent();
    isolated?.dispose();
    delete ctx.isolatedSession;
  }
}

function getAssistantMessageEnd(event: unknown): { stopReason: unknown } | null {
  if (!isRecord(event) || event.type !== "message_end" || !isRecord(event.message)) return null;
  return event.message.role === "assistant" ? { stopReason: event.message.stopReason } : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
