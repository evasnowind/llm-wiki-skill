import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { AuthStorage, ModelRegistry, SessionManager, SettingsManager, DefaultResourceLoader, createAgentSession, type AgentSession } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type Context } from "@earendil-works/pi-ai";
import type { EvidenceCitation, PromptSseEvent } from "@llm-wiki/workbench-contracts";
import { isolateTestHome } from "../test/support/isolated-home.js";

const sandbox = await mkdtemp(path.join(tmpdir(), "wiki-source-runtime-"));
const restoreHome = isolateTestHome(sandbox, path.join(sandbox, "agent-config"));
after(async () => {
  restoreHome();
  await rm(sandbox, { recursive: true, force: true });
});
const { createSourcesOnlySession, buildSourcesOnlyQuestion, localSourcesOnlyAssistant, NO_SOURCE_EVIDENCE_REPLY } = await import("./sources-only.js");
const { runSourcesOnlyPrompt, PromptSessionEventQueue, defaultPromptRouteService } = await import("./routes/prompt.js");
const { ToolStatusEventAdapter } = await import("./tool-status-events.js");
const { protectSessionTerminalMessages, finalizeSessionTerminalMessages } = await import("./extensions/prompt-terminal.js");
const { piMessagesToUIMessages } = await import("./conversations.js");
const { branchEntryIds, persistTurnEvidence } = await import("./evidence-metadata.js");
const kb = path.join(sandbox, "kb");
await mkdir(path.join(kb, "raw"), { recursive: true });
await mkdir(path.join(kb, ".pi", "skills", "leak"), { recursive: true });
await writeFile(path.join(kb, "AGENTS.md"), "WIKI_AGENTS_SECRET");
await writeFile(path.join(kb, "purpose.md"), "WIKI_PURPOSE_SECRET");
await writeFile(path.join(kb, "wiki-schema.yaml"), "WIKI_SCHEMA_SECRET");
await writeFile(path.join(kb, ".pi", "skills", "leak", "SKILL.md"), "---\nname: leak\ndescription: WIKI_SKILL_SECRET\n---\nWIKI_SKILL_BODY");
const evidence: EvidenceCitation[] = [{ id: "E1", kind: "raw", path: "raw/handbook.md", title: "Original", headingPath: ["Budget"], startLine: 2, endLine: 3, fileHash: "a".repeat(64), excerptHash: "b".repeat(64), excerpt: "RAW_EVIDENCE_ONLY: budget is 17.\n原文第二行" }];
const auth = AuthStorage.inMemory();
const registry = ModelRegistry.inMemory(auth);
const captures: Context[] = [];
let waitStarted: (() => void) | undefined;
function registerFixture(target: ModelRegistry) {
 target.registerProvider("source-runtime-fixture", {
  api: "openai-completions", baseUrl: "http://invalid.fixture", apiKey: "fixture-key",
  models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 2048, maxTokens: 128 }],
  streamSimple(model, context, options) {
    captures.push(JSON.parse(JSON.stringify(context)) as Context);
    const stream = createAssistantMessageEventStream();
    const text = JSON.stringify(context.messages.at(-1)).includes("WAIT_FOR_CANCEL") ? "visible cancellation fragment" : "Budget is 17 [1](#evidence-E1).";
    const partial = localSourcesOnlyAssistant(text, model);
    queueMicrotask(() => {
      stream.push({ type: "start", partial });
      stream.push({ type: "text_start", contentIndex: 0, partial });
      stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial });
      if (JSON.stringify(context.messages.at(-1)).includes("WAIT_FOR_CANCEL")) {
        const abort = () => {
          const cancelled = { ...partial, stopReason: "aborted" as const, errorMessage: "fixture private provider detail" };
          stream.push({ type: "error", reason: "aborted", error: cancelled });
          stream.end(cancelled);
        };
        options?.signal?.addEventListener("abort", abort, { once: true });
        waitStarted?.();
        if (options?.signal?.aborted) abort();
      } else {
        stream.push({ type: "text_end", contentIndex: 0, content: text, partial });
        stream.push({ type: "done", reason: "stop", message: partial });
        stream.end(partial);
      }
    });
    return stream;
  },
});
}
registerFixture(registry);
const model = registry.find("source-runtime-fixture", "fixture")!;
const isolatedFactory: typeof createSourcesOnlySession = (input) => createSourcesOnlySession({ ...input, authStorage: auth, modelRegistry: registry });

async function mainSession() {
  const settings = SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 1024 }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: kb, agentDir: path.join(sandbox, "agent-config"), settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, systemPrompt: "WIKI_NORMAL_SYSTEM_SECRET" });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: kb, model, authStorage: auth, modelRegistry: registry, resourceLoader: loader, sessionManager: SessionManager.inMemory(kb), settingsManager: settings, tools: ["read"] });
  protectSessionTerminalMessages(session.sessionManager);
  const user = { role: "user" as const, content: "WIKI_HISTORY_QUESTION_SECRET", timestamp: 1 };
  const assistant = localSourcesOnlyAssistant("WIKI_HISTORY_ANSWER_SECRET", model);
  assistant.usage.input = 5000;
  assistant.usage.totalTokens = 5000;
  session.sessionManager.appendMessage(user);
  session.sessionManager.appendMessage(assistant);
  session.agent.state.messages = [user, assistant];
  return { session, settings };
}
function context(session: AgentSession, message = "What is the budget?") {
  const events: PromptSseEvent[] = [];
  const ctx: import("./routes/prompt.js").PromptRunContext = {
    runId: "run-sources", messageId: "assistant-sources", message, retrievalMode: "sources-only" as const,
    active: { kbPath: kb, name: "Fixture", conversationId: "conversation", sessionId: "conversation" },
    session, adapter: new ToolStatusEventAdapter({ runId: "run-sources", messageId: "assistant-sources" }),
    sessionEvents: new PromptSessionEventQueue(),
    writer: { open: true, write: async (event: PromptSseEvent | null) => { if (event) events.push(event); return true; }, flush: async () => {} },
  };
  return { ctx, events };
}

test("real SDK sources-only payload excludes old Wiki/history/skills/tools and pre-prompt compaction", async () => {
  captures.length = 0;
  const { session, settings } = await mainSession();
  const { ctx, events } = context(session);
  const before = branchEntryIds(session.sessionManager);
  await ctx.writer.write(ctx.adapter.assistantEvidence("sources-only", evidence));
  await runSourcesOnlyPrompt(ctx, evidence, () => true, isolatedFactory);
  persistTurnEvidence(session.sessionManager, before, { runId: ctx.runId, mode: "sources-only", evidence });
  for (const event of ctx.adapter.finishAssistant()) await ctx.writer.write(event);
  assert.equal(captures.length, 1, "no compaction provider call may precede the isolated prompt");
  const payload = JSON.stringify(captures[0]);
  assert.match(payload, /RAW_EVIDENCE_ONLY/);
  assert.equal(captures[0]!.messages.length, 1);
  assert.equal(captures[0]!.messages[0]!.role, "user");
  assert.deepEqual(captures[0]!.tools ?? [], []);
  assert.doesNotMatch(payload, /WIKI_|AGENTS\.md|wiki-schema|SKILL\.md/);
  assert.equal(events[0]?.type, "assistant_evidence");
  assert.equal(events.at(-1)?.type, "assistant_done");
  assert.deepEqual(events.map((event) => event.seq), events.map((_, index) => index + 1));
  const history = piMessagesToUIMessages(session.messages, session.sessionManager.getBranch());
  assert.equal(history.at(-1)?.retrievalMode, "sources-only");
  assert.deepEqual(history.at(-1)?.evidence, evidence);
  assert.match(history.at(-1)?.content ?? "", /Budget is 17/);
  const modelHistory = JSON.stringify(session.sessionManager.buildSessionContext().messages);
  assert.doesNotMatch(modelHistory, /fileHash|excerptHash|llm-wiki-turn-evidence/);
  settings.setCompactionEnabled(false);
  await session.prompt("ordinary follow-up");
  assert.equal(captures.length, 2, JSON.stringify(session.messages.at(-1)));
  const normal = JSON.stringify(captures.at(-1));
  assert.match(normal, /WIKI_NORMAL_SYSTEM_SECRET/);
  assert.match(normal, /WIKI_HISTORY_ANSWER_SECRET/);
  assert.ok((captures.at(-1)?.tools?.length ?? 0) > 0);
  session.dispose();
});

test("no source evidence gives a local explicit refusal without creating a model session", async () => {
  captures.length = 0;
  const { session } = await mainSession();
  const { ctx, events } = context(session);
  let created = false;
  await runSourcesOnlyPrompt(ctx, [], () => true, async () => { created = true; throw new Error("must not call"); });
  assert.equal(created, false);
  assert.equal(captures.length, 0);
  assert.match(JSON.stringify(events), /原文证据不足/);
  assert.equal(piMessagesToUIMessages(session.messages).at(-1)?.content, NO_SOURCE_EVIDENCE_REPLY);
  session.dispose();
});

test("cancelling an isolated source session preserves only visible text and leaves ordinary session usable", async () => {
  captures.length = 0;
  const { session, settings } = await mainSession();
  const { ctx, events } = context(session, "WAIT_FOR_CANCEL");
  const started = new Promise<void>((resolve) => { waitStarted = resolve; });
  const running = runSourcesOnlyPrompt(ctx, evidence, () => true, isolatedFactory);
  await started;
  await ctx.sessionEvents.flush();
  defaultPromptRouteService.abortSession(ctx);
  await running;
  await ctx.sessionEvents.flush();
  finalizeSessionTerminalMessages(session.sessionManager, ctx.adapter.pendingTerminalReason, ctx.sessionEvents.publishedAssistantText.terminalText);
  for (const event of ctx.adapter.finishAssistant()) await ctx.writer.write(event);
  assert.equal(events.at(-1)?.type, "assistant_cancelled");
  assert.equal(ctx.isolatedSession, undefined);
  assert.doesNotMatch(JSON.stringify(session.sessionManager.getBranch()), /fixture private provider detail/);
  settings.setCompactionEnabled(false);
  session.agent.state.messages = session.sessionManager.buildSessionContext().messages;
  await session.prompt("ordinary turn after cancel");
  assert.equal(captures.length, 2, JSON.stringify(session.messages.at(-1)));
  assert.match(JSON.stringify(captures.at(-1)), /ordinary turn after cancel/);
  assert.match(JSON.stringify(captures.at(-1)), /WIKI_HISTORY_ANSWER_SECRET/);
  session.dispose();
  waitStarted = undefined;
});

test("source question embeds only current raw excerpts even if given an unexpected wiki item", () => {
  const result = buildSourcesOnlyQuestion("question", [...evidence, { ...evidence[0]!, kind: "wiki", path: "wiki/a.md", excerpt: "WIKI_UNEXPECTED_SECRET" }]);
  assert.match(result, /RAW_EVIDENCE_ONLY/);
  assert.doesNotMatch(result, /WIKI_UNEXPECTED_SECRET/);
});

test("cancel or switch while the isolated session initializes cannot append a user or assistant to the main transcript", async () => {
  const { session } = await mainSession();
  const { ctx } = context(session);
  const before = JSON.stringify(session.sessionManager.getBranch());
  let current = true;
  let finishInitialization!: (value: AgentSession) => void;
  const initialized = new Promise<AgentSession>((resolve) => { finishInitialization = resolve; });
  const running = runSourcesOnlyPrompt(ctx, evidence, () => current, () => initialized);
  current = false;
  defaultPromptRouteService.abortSession(ctx);
  const isolated = await isolatedFactory({ kbPath: kb, model, authStorage: auth, modelRegistry: registry });
  finishInitialization(isolated);
  await running;
  assert.equal(JSON.stringify(session.sessionManager.getBranch()), before);
  assert.equal(ctx.isolatedSession, undefined);
  assert.equal(ctx.adapter.pendingTerminalReason, "aborted");
  let invoked = false;
  await runSourcesOnlyPrompt(ctx, [], () => false, async () => { invoked = true; throw new Error("must not run"); });
  assert.equal(invoked, false);
  assert.equal(JSON.stringify(session.sessionManager.getBranch()), before);
  session.dispose();
});

test("incomplete or failed retrieval is stated locally and included in the isolated model payload", async () => {
  const { session } = await mainSession();
  const warnings = ["部分素材超过读取上限，未完成检索"];
  const missing = context(session);
  await runSourcesOnlyPrompt(missing.ctx, [], () => true, isolatedFactory, warnings);
  assert.match(piMessagesToUIMessages(session.messages).at(-1)?.content ?? "", /未能完整读取素材/);
  assert.doesNotMatch(piMessagesToUIMessages(session.messages).at(-1)?.content ?? "", /没有检索到相关/);
  const present = context(session);
  await runSourcesOnlyPrompt(present.ctx, evidence, () => true, isolatedFactory, warnings);
  assert.match(JSON.stringify(captures.at(-1)), /部分素材超过读取上限/);
  assert.match(JSON.stringify(captures.at(-1)), /回答需说明这一限制/);
  session.dispose();
});

test("direct server-side conversation and KB switches abort their isolated provider and leave the next ordinary conversation usable", async () => {
  const runtime = await import("./agent.js");
  const { saveConfig } = await import("./config.js");
  const { disposeSessionWithDependents } = await import("./session-lifecycle.js");
  registerFixture(runtime.modelRegistry);
  await writeFile(path.join(kb, ".wiki-schema.md"), "# Fixture schema");
  const otherKb = path.join(sandbox, "other-kb");
  await mkdir(otherKb, { recursive: true });
  await writeFile(path.join(otherKb, ".wiki-schema.md"), "# Other fixture schema");
  await saveConfig({ version: 1, externalKnowledgeBases: [kb, otherKb], modelRoles: { main: { provider: "source-runtime-fixture", modelId: "fixture" } } });
  let active = await runtime.createNewConversation(kb);
  for (const switchKind of ["conversation", "kb"] as const) {
    captures.length = 0;
    const previous = active;
    const { ctx, events } = context(previous.session, "WAIT_FOR_CANCEL");
    const started = new Promise<void>((resolve) => { waitStarted = resolve; });
    const running = runSourcesOnlyPrompt(ctx, evidence, () => runtime.getActive()?.session === previous.session, isolatedFactory);
    await started;
    await ctx.sessionEvents.flush();
    active = switchKind === "conversation" ? await runtime.createNewConversation(kb) : await runtime.selectKb(otherKb);
    await running;
    await ctx.sessionEvents.flush();
    runtime.finalizeSessionTerminalPersistence(previous.session, ctx.adapter.pendingTerminalReason, ctx.sessionEvents.publishedAssistantText.terminalText);
    for (const event of ctx.adapter.finishAssistant()) await ctx.writer.write(event);
    assert.equal(events.at(-1)?.type, "assistant_cancelled", `direct ${switchKind} replacement cancels the isolated run`);
    assert.equal(captures.length, 1, "an aborted provider must not continue or retry");
    assert.equal(ctx.isolatedSession, undefined);
    assert.equal(runtime.getActive()?.session, active.session);
    assert.doesNotMatch(JSON.stringify(active.session.messages), /WAIT_FOR_CANCEL|visible cancellation fragment/);
    active.session.settingsManager.setCompactionEnabled(false);
    await active.session.prompt(`ordinary after direct ${switchKind} switch`);
    assert.equal(captures.length, 2);
    assert.match(JSON.stringify(captures.at(-1)), /ordinary after direct/);
  }
  disposeSessionWithDependents(active.session);
  waitStarted = undefined;
});
