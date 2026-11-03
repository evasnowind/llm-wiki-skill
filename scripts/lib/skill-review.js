"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  validateRoot, validateRelativePath, safeReadFile, verifyPacket, sha256, MAX_PACKET_BYTES,
} = require("./skill-retrieval");
const { STORE, MAX_STATE_BYTES, MAX_JOURNAL_BYTES, fail, checkedPath, readOptional, readJson, atomicWrite, json, withLock } = require("./skill-state-io");
const { validateBinding, verifyPackage } = require("./markdown-package");
const { STATE, JOURNALS, TYPES, HASH, ISSUE, CANDIDATE, MAX_BODY, MAX_ISSUES, MAX_CANDIDATES,
  text, targetPath, issueIdentity, candidateIdentity, renderCandidate, validateCandidate, validateState,
  appendRecord, updatedIndex, validateJournal } = require("./review-records");

const clone = (value) => JSON.parse(JSON.stringify(value));

function checkPortableTarget(root, relative) {
  let directory = root;
  for (const component of relative.split("/")) {
    if (!fs.existsSync(directory)) break;
    const matches = fs.readdirSync(directory).filter((item) => item.normalize("NFC").toLowerCase() === component.normalize("NFC").toLowerCase());
    if (matches.some((item) => item !== component)) fail("target_path_collision");
    directory = path.join(directory, component);
  }
  checkedPath(root, relative);
}

function snapshot(root, relative) {
  const file = readOptional(root, relative, MAX_BODY * 2);
  return file ? { sha256: file.sha256, content: file.text } : null;
}

function checkPacket(root, packet) {
  if (!packet || Buffer.byteLength(JSON.stringify(packet)) > MAX_PACKET_BYTES || !Array.isArray(packet.evidence) || !packet.evidence.length) fail("evidence_required");
  const result = verifyPacket(root, packet);
  if (!result.ok) fail("evidence_changed_or_invalid");
}

function checkIssueVersion(root, issue, writes = []) {
  if (!issue) return;
  const versions = new Map();
  for (const item of [...issue.paths.map((entry) => ({ path: entry.path, hash: entry.sha256 })),
    ...issue.evidence.map((entry) => ({ path: entry.path, hash: entry.fileSha256 }))]) {
    if (versions.has(item.path) && versions.get(item.path) !== item.hash) fail("issue_changed");
    versions.set(item.path, item.hash);
  }
  for (const [relative, expected] of versions) {
    let actual;
    try { actual = readOptional(root, relative)?.sha256 || null; }
    catch { fail("issue_changed"); }
    if (actual === expected) continue;
    // A partially replayed publication may already have changed an issue's
    // target/index/log. Only its exact fixed before -> after transition counts.
    const write = writes.find((item) => item.path === relative);
    if (write && write.beforeSha256 === expected && write.afterSha256 === actual) continue;
    fail("issue_changed");
  }
}

function checkMarkdownSource(root, binding, target, packet) {
  validateBinding(binding);
  if (target !== `wiki/sources/${binding.sourceId}.md` || packet.mode !== "raw") fail("invalid_markdown_source");
  const verified = verifyPackage(root, binding);
  if (!verified.ok) fail("markdown_package_changed");
  const base = path.posix.dirname(binding.manifestPath);
  const originals = new Map(verified.manifest.files.filter((item) => item.kind !== "reading" && /\.(md|txt)$/iu.test(item.path))
    .map((item) => [`${base}/${item.path}`, item.sha256]));
  if (!packet.evidence.some((item) => item.path === binding.primaryPath && item.fileSha256 === binding.primarySha256)
    || packet.evidence.some((item) => originals.get(item.path) !== item.fileSha256)) fail("invalid_markdown_evidence");
  return verified.binding;
}

function loadState(root) {
  return validateState(readJson(root, STATE) || { version: 1, issues: [], candidates: [] });
}

function saveState(root, state) {
  const content = json(state);
  // Reserve bounded metadata space for adopting every accepted candidate.
  // Otherwise a completely full store could stage work it can never publish.
  if (Buffer.byteLength(content) > MAX_STATE_BYTES - 128 * 1024) fail("review_limit");
  atomicWrite(root, STATE, content);
}

function journalPaths(root) {
  const directory = checkedPath(root, JOURNALS);
  if (!fs.existsSync(directory)) return [];
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  if (entries.length > MAX_CANDIDATES + 20) fail("invalid_journal");
  return entries.filter((entry) => {
    if (entry.name.includes(".tmp-")) return false;
    if (!entry.isFile() || !/^candidate-[a-f0-9]{24}\.json$/u.test(entry.name)) fail("invalid_journal");
    return true;
  }).map((entry) => `${JOURNALS}/${entry.name}`).sort();
}

function assertNoPending(root) {
  const state = loadState(root);
  for (const relative of journalPaths(root)) {
    const journal = validateJournal(readJson(root, relative, MAX_JOURNAL_BYTES));
    if (relative !== `${JOURNALS}/${journal.candidateId}.json`) fail("invalid_journal");
    if (!journal.committed) fail("recovery_required");
    if (!state.candidates.some((item) => item.id === journal.candidateId && item.status === "adopted" && item.contentSha256 === journal.candidate.contentSha256)) fail("invalid_journal");
  }
}

function add(kbRoot, input) {
  const root = validateRoot(kbRoot);
  return withLock(root, () => {
    assertNoPending(root);
    const state = loadState(root);
    if (!TYPES.has(input.type) || !Array.isArray(input.paths || []) || (input.paths || []).length > 50) fail("invalid_arguments");
    if (input.packet) checkPacket(root, input.packet);
    const paths = [...new Set(input.paths || [])].sort().map((relative) => {
      validateRelativePath(relative);
      if (!(relative.startsWith("wiki/") || relative.startsWith("raw/") || ["index.md", "log.md", ".wiki-schema.md", "purpose.md"].includes(relative))) fail("invalid_path");
      return { path: relative, sha256: readOptional(root, relative)?.sha256 || null };
    });
    const evidence = [...new Map((input.packet?.evidence || []).map((item) => [item.path, { path: item.path, fileSha256: item.fileSha256 }])).values()].sort((a, b) => a.path.localeCompare(b.path));
    const issue = { type: input.type, title: text(input.title, 240), reason: text(input.reason, 4000), paths, evidence, status: "open", createdAt: new Date().toISOString() };
    issue.id = issueIdentity(issue);
    const existing = state.issues.find((item) => item.id === issue.id);
    if (existing) return clone(existing);
    if (state.issues.length >= MAX_ISSUES) fail("review_limit");
    state.issues.push(issue);
    saveState(root, state);
    return clone(issue);
  });
}

function list(kbRoot, { status = "open" } = {}) {
  const root = validateRoot(kbRoot);
  if (!["open", "dismissed", "resolved", "all"].includes(status)) fail("invalid_arguments");
  const state = loadState(root);
  return { version: 1, issues: state.issues.filter((item) => status === "all" || item.status === status),
    candidates: state.candidates.map(({ id, title, target, status: candidateStatus, issueId }) => ({ id, title, target, status: candidateStatus, issueId })) };
}

function show(kbRoot, id) {
  const root = validateRoot(kbRoot);
  const state = loadState(root);
  const issue = state.issues.find((item) => item.id === id);
  if (issue) return clone(issue);
  const candidate = state.candidates.find((item) => item.id === id);
  if (!candidate) fail("not_found");
  return { ...clone(candidate), currentTarget: snapshot(root, candidate.target), evidenceVerification: verifyPacket(root, candidate.packet) };
}

function dismiss(kbRoot, id) {
  const root = validateRoot(kbRoot);
  return withLock(root, () => {
    assertNoPending(root);
    const state = loadState(root);
    const issue = state.issues.find((item) => item.id === id);
    if (!issue) fail("not_found");
    if (issue.status === "resolved") fail("issue_already_resolved");
    issue.status = "dismissed";
    saveState(root, state);
    return clone(issue);
  });
}

function stage(kbRoot, input) {
  const root = validateRoot(kbRoot);
  return withLock(root, () => {
    assertNoPending(root);
    const state = loadState(root);
    checkPacket(root, input.packet);
    const target = targetPath(input.target);
    if (input.packet.evidence.some((item) => item.path === target)) fail("target_is_evidence");
    checkPortableTarget(root, target);
    const title = text(input.title, 240);
    let markdownSource;
    if (input.markdownSource !== undefined) markdownSource = checkMarkdownSource(root, input.markdownSource, target, input.packet);
    let body;
    if (markdownSource) {
      // User-owned notes may contain decomposed Unicode and CRLF. Validate
      // these bodies without transforming their bytes as generic text() does.
      text(input.body, MAX_BODY);
      body = input.body;
    } else body = text(input.body, MAX_BODY);
    if (Buffer.byteLength(body) > MAX_BODY) fail("body_too_large");
    if (/^---(?:\r?\n|$)/u.test(body)) fail("body_frontmatter_not_allowed");
    const issueId = input.issueId || null;
    if (issueId && !state.issues.some((item) => item.id === issueId && item.status === "open")) fail("issue_not_open");
    if (issueId) checkIssueVersion(root, state.issues.find((item) => item.id === issueId));
    const targetBefore = snapshot(root, target);
    if (markdownSource && Object.hasOwn(input, "expectedTargetSha256")
      && input.expectedTargetSha256 !== (targetBefore?.sha256 || null)) fail("target_changed");
    const candidate = { title, target, body, bodySha256: sha256(body), targetBefore, packet: clone(input.packet), issueId,
      status: "ready", createdAt: new Date().toISOString() };
    if (markdownSource) candidate.markdownSource = clone(markdownSource);
    candidate.id = candidateIdentity(candidate);
    const existing = state.candidates.find((item) => item.id === candidate.id);
    if (existing) return clone(existing);
    if (state.candidates.length >= MAX_CANDIDATES) fail("review_limit");
    candidate.content = renderCandidate(candidate);
    candidate.contentSha256 = sha256(candidate.content);
    validateCandidate(candidate);
    state.candidates.push(candidate);
    saveState(root, state);
    return clone(candidate);
  });
}

function makeWrite(relative, before, content) {
  return { path: relative, beforeSha256: before?.sha256 || null, beforeContent: before ? (before.content ?? before.text) : null,
    afterSha256: sha256(content), content };
}

function createJournal(root, state, candidate) {
  const adoptedAt = new Date().toISOString();
  const next = clone(state);
  const adopted = next.candidates.find((item) => item.id === candidate.id);
  adopted.status = "adopted"; adopted.adoptedAt = adoptedAt;
  if (candidate.issueId) {
    const issue = next.issues.find((item) => item.id === candidate.issueId);
    if (!issue || issue.status !== "open") fail("issue_not_open");
    issue.status = "resolved"; issue.resolvedBy = candidate.id; issue.resolvedAt = adoptedAt;
  }
  const indexBefore = snapshot(root, "index.md");
  const logBefore = snapshot(root, "log.md");
  const stateBefore = readOptional(root, STATE);
  const label = candidate.title.replace(/[\[\]\r\n]/gu, " ");
  const marker = `<!-- review-adopt:${candidate.id} -->`;
  const journal = { version: 1, indexFormat: "wikilink-v1", candidateId: candidate.id, target: candidate.target, createdAt: adoptedAt, committed: false,
    candidate: clone(candidate), writes: [
      makeWrite(candidate.target, candidate.targetBefore, candidate.content),
      makeWrite("index.md", indexBefore, updatedIndex(indexBefore, state, candidate)),
      makeWrite("log.md", logBefore, appendRecord(logBefore, `${marker}\n## ${adoptedAt.slice(0, 10)} research | ${label}\n\nAdopted ${candidate.id}: ${candidate.target}`)),
      makeWrite(STATE, stateBefore, json(next)),
    ] };
  validateJournal(journal);
  return journal;
}

function replay(root, journal, { afterWrite } = {}) {
  validateJournal(journal);
  if (journal.committed) return { id: journal.candidateId, status: "adopted", recovered: false };
  if (journal.candidate.markdownSource) checkMarkdownSource(root, journal.candidate.markdownSource, journal.target, journal.candidate.packet);
  checkPacket(root, journal.candidate.packet);
  if (journal.candidate.issueId) {
    const before = JSON.parse(journal.writes[3].beforeContent);
    checkIssueVersion(root, before.issues.find((item) => item.id === journal.candidate.issueId), journal.writes);
  }
  // Preflight the entire write-set before making any further partial changes.
  for (const write of journal.writes) {
    if (write.path === journal.target) checkPortableTarget(root, write.path);
    const current = readOptional(root, write.path);
    if ((current?.sha256 || null) !== write.beforeSha256 && (current?.sha256 || null) !== write.afterSha256) fail("publication_conflict");
  }
  if (afterWrite) afterWrite(0);
  for (const [index, write] of journal.writes.entries()) {
    const current = readOptional(root, write.path);
    if ((current?.sha256 || null) === write.afterSha256) continue;
    if ((current?.sha256 || null) !== write.beforeSha256) fail("publication_conflict");
    atomicWrite(root, write.path, write.content);
    if (afterWrite) afterWrite(index + 1);
  }
  journal.committed = true;
  atomicWrite(root, `${JOURNALS}/${journal.candidateId}.json`, json(journal), MAX_JOURNAL_BYTES);
  return { id: journal.candidateId, status: "adopted", recovered: true };
}

function adopt(kbRoot, id, options = {}) {
  const root = validateRoot(kbRoot);
  if (!CANDIDATE.test(id)) fail("invalid_arguments");
  return withLock(root, () => {
    const journalPath = `${JOURNALS}/${id}.json`;
    const existingJournal = readJson(root, journalPath, MAX_JOURNAL_BYTES);
    if (existingJournal && existingJournal.committed !== true) fail("recovery_required");
    assertNoPending(root);
    const state = loadState(root);
    const candidate = state.candidates.find((item) => item.id === id);
    if (!candidate) fail("not_found");
    if (candidate.status === "adopted") return { id, status: "adopted", recovered: false };
    if (candidate.markdownSource) checkMarkdownSource(root, candidate.markdownSource, candidate.target, candidate.packet);
    checkPacket(root, candidate.packet);
    if (candidate.packet.evidence.some((item) => item.path === candidate.target)) fail("target_is_evidence");
    if (candidate.issueId) checkIssueVersion(root, state.issues.find((item) => item.id === candidate.issueId));
    checkPortableTarget(root, candidate.target);
    if ((snapshot(root, candidate.target)?.sha256 || null) !== (candidate.targetBefore?.sha256 || null)) fail("target_changed");
    const journal = createJournal(root, state, candidate);
    atomicWrite(root, journalPath, json(journal), MAX_JOURNAL_BYTES);
    return replay(root, journal, options);
  });
}

function recover(kbRoot, id, options = {}) {
  const root = validateRoot(kbRoot);
  if (id && !CANDIDATE.test(id)) fail("invalid_arguments");
  return withLock(root, () => {
    const selected = journalPaths(root).filter((relative) => !id || relative === `${JOURNALS}/${id}.json`);
    if (id && !selected.length) fail("not_found");
    const results = [];
    for (const relative of selected) {
      const journal = validateJournal(readJson(root, relative, MAX_JOURNAL_BYTES));
      if (relative !== `${JOURNALS}/${journal.candidateId}.json`) fail("invalid_journal");
      if (!journal.committed) results.push(replay(root, journal, options));
    }
    return { version: 1, recovered: results };
  }, { recover: true });
}

module.exports = { TYPES, STATE, JOURNALS, MAX_BODY, add, list, show, dismiss, stage, adopt, recover, loadState, validateJournal, assertNoPending };
