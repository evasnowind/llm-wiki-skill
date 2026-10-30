import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { EvidenceCitation } from "@llm-wiki/workbench-contracts";
import { branchEntryIds, persistTurnEvidence, readTurnEvidence, TURN_EVIDENCE_CUSTOM_TYPE } from "./evidence-metadata.js";
import { piMessagesToUIMessages } from "./conversations.js";
import { localSourcesOnlyAssistant } from "./sources-only.js";

const base: EvidenceCitation = { id: "E1", kind: "wiki", path: "wiki/a.md", title: "A", headingPath: [], startLine: 1, endLine: 1, fileHash: "a".repeat(64), excerptHash: "b".repeat(64), excerpt: "quote" };
const question = { role: "user" as const, content: "identical question", timestamp: 7 };

test("identical questions and timestamps keep evidence bound to real user entry ids through reload and branches", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "wiki-evidence-metadata-"));
  try {
    const manager = SessionManager.create(sandbox, sandbox);
    const beforeFirst = branchEntryIds(manager);
    const first = manager.appendMessage({ ...question });
    manager.appendMessage(localSourcesOnlyAssistant("first"));
    persistTurnEvidence(manager, beforeFirst, { runId: "run-one", mode: "knowledge", evidence: [base] });
    const branchBeforeSecond = manager.getLeafId()!;
    const beforeSecond = branchEntryIds(manager);
    const second = manager.appendMessage({ ...question });
    manager.appendMessage(localSourcesOnlyAssistant("second"));
    const raw = { ...base, kind: "raw" as const, path: "raw/a.md" };
    persistTurnEvidence(manager, beforeSecond, { runId: "run-two", mode: "sources-only", evidence: [raw] });
    assert.notEqual(first, second);
    const reloaded = SessionManager.open(manager.getSessionFile()!, sandbox);
    const serialized = piMessagesToUIMessages(reloaded.buildSessionContext().messages, reloaded.getBranch());
    assert.deepEqual(serialized.filter((message) => message.role === "assistant").map((message) => [message.id, message.retrievalMode, message.evidence?.[0]?.path]), [
      [`a-${first}`, "knowledge", "wiki/a.md"], [`a-${second}`, "sources-only", "raw/a.md"],
    ]);
    assert.doesNotMatch(JSON.stringify(reloaded.buildSessionContext()), /fileHash|excerptHash|run-two|llm-wiki-turn-evidence/);
    reloaded.branch(branchBeforeSecond);
    const branch = piMessagesToUIMessages(reloaded.buildSessionContext().messages, reloaded.getBranch());
    assert.equal(branch.length, 2);
    assert.equal(branch.at(-1)?.retrievalMode, "knowledge");
    assert.equal(branch.at(-1)?.evidence?.[0]?.path, "wiki/a.md");
  } finally { await rm(sandbox, { recursive: true, force: true }); }
});

test("failed prompt before a new user append cannot attach evidence to a previous turn", () => {
  const manager = SessionManager.inMemory();
  const previous = manager.appendMessage(question);
  manager.appendMessage(localSourcesOnlyAssistant("old"));
  const before = branchEntryIds(manager);
  assert.equal(persistTurnEvidence(manager, before, { runId: "failed-new-run", mode: "sources-only", evidence: [base] }), null);
  assert.equal(readTurnEvidence(manager.getBranch()).has(previous), false);
  const messages = piMessagesToUIMessages(manager.buildSessionContext().messages, manager.getBranch());
  assert.equal(messages.at(-1)?.evidence, undefined);
});

test("cancelled turns merge assistants, orphan/other-branch metadata is ignored and old history stays unchanged", () => {
  const manager = SessionManager.inMemory();
  const before = branchEntryIds(manager);
  const user = manager.appendMessage(question);
  manager.appendMessage(localSourcesOnlyAssistant("prefix"));
  manager.appendMessage(localSourcesOnlyAssistant("visible", undefined, "aborted"));
  persistTurnEvidence(manager, before, { runId: "cancelled", mode: "knowledge", evidence: [base] });
  manager.appendCustomEntry(TURN_EVIDENCE_CUSTOM_TYPE, { userEntryId: "missing-user", runId: "orphan", mode: "sources-only", evidence: [] });
  const branch = piMessagesToUIMessages(manager.buildSessionContext().messages, manager.getBranch());
  assert.equal(branch.length, 2);
  assert.equal(branch.at(-1)?.id, `a-${user}`);
  assert.equal(branch.at(-1)?.retrievalMode, "knowledge");
  assert.deepEqual(branch.at(-1)?.evidence, [base]);
  const old = piMessagesToUIMessages(manager.buildSessionContext().messages);
  assert.equal(old.at(-1)?.evidence, undefined);
  assert.equal(old.at(-1)?.retrievalMode, undefined);
});
