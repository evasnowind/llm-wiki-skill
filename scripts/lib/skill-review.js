"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  validateRoot, validateRelativePath, safeReadFile, verifyPacket, sha256, MAX_PACKET_BYTES,
} = require("./skill-retrieval");
const { STORE, MAX_STATE_BYTES, MAX_JOURNAL_BYTES, fail, checkedPath, readOptional, readJson, atomicWrite, json, withLock } = require("./skill-state-io");

const STATE = `${STORE}/state.json`;
const JOURNALS = `${STORE}/journals`;
const TYPES = new Set(["contradiction", "duplicate", "missing", "unverified", "suggestion"]);
const HASH = /^[a-f0-9]{64}$/;
const ISSUE = /^issue-[a-f0-9]{24}$/;
const CANDIDATE = /^candidate-[a-f0-9]{24}$/;
const MAX_BODY = 256 * 1024;
const MAX_ISSUES = 500;
const MAX_CANDIDATES = 100;
const clone = (value) => JSON.parse(JSON.stringify(value));

function text(value, maximum, code = "invalid_arguments") {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value)) fail(code);
  return value.trim().normalize("NFC");
}

function targetPath(value) {
  validateRelativePath(value);
  if (!/^wiki\/.+\.md$/u.test(value) || value.split("/").some((part) => part.startsWith(".")
    || /[<>"|?*\[\]#]/u.test(part) || /[. ]$/u.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) fail("invalid_target");
  return value;
}

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

function validateSnapshot(value) {
  return value === null || (value && typeof value.content === "string" && Buffer.byteLength(value.content) <= MAX_BODY * 2
    && HASH.test(value.sha256) && sha256(value.content) === value.sha256);
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

function issueIdentity(issue) {
  return `issue-${sha256(JSON.stringify({ type: issue.type, title: issue.title, reason: issue.reason, paths: issue.paths, evidence: issue.evidence })).slice(0, 24)}`;
}

function candidateIdentity(candidate) {
  return `candidate-${sha256(JSON.stringify({ title: candidate.title, target: candidate.target,
    targetBeforeHash: candidate.targetBefore?.sha256 || null, bodySha256: candidate.bodySha256,
    packet: candidate.packet, issueId: candidate.issueId })).slice(0, 24)}`;
}

function renderCandidate(candidate) {
  const sources = [...new Set(candidate.packet.evidence.map((item) => item.path))].sort();
  const lines = ["---", `type: ${candidate.target.startsWith("wiki/queries/") ? "query" : "research"}`, "derived: true", `title: ${JSON.stringify(candidate.title)}`,
    `created: ${JSON.stringify(candidate.createdAt)}`, `review-candidate: ${candidate.id}`, "sources:",
    ...sources.map((source) => `  - ${JSON.stringify(source)}`), "---", "", candidate.body, "", "## Evidence / 证据", ""];
  if (candidate.packet.coverage?.complete === false) lines.push("> Coverage is incomplete / 本次检索覆盖不完整；结论限于列出的证据。", "");
  for (const evidence of candidate.packet.evidence) {
    const relative = path.posix.relative(path.posix.dirname(candidate.target), evidence.path);
    const encoded = relative.split("/").map(encodeURIComponent).join("/");
    lines.push(`- [${evidence.id}](${encoded}) — ${evidence.path}:${evidence.startLine}-${evidence.endLine}; SHA256 ${evidence.fileSha256}`,
      ...evidence.excerpt.split("\n").map((line) => `  > ${line.replace(/\r$/u, "")}`), "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function validateCandidate(candidate) {
  if (!candidate || !CANDIDATE.test(candidate.id) || !["ready", "adopted"].includes(candidate.status)
    || !validateSnapshot(candidate.targetBefore) || typeof candidate.body !== "string" || Buffer.byteLength(candidate.body) > MAX_BODY
    || sha256(candidate.body) !== candidate.bodySha256 || typeof candidate.content !== "string"
    || Buffer.byteLength(candidate.content) > MAX_BODY * 2 || sha256(candidate.content) !== candidate.contentSha256
    || !candidate.packet || !Array.isArray(candidate.packet.evidence) || !candidate.packet.evidence.length
    || Buffer.byteLength(JSON.stringify(candidate.packet)) > MAX_PACKET_BYTES
    || typeof candidate.createdAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(candidate.createdAt)
    || (candidate.issueId !== null && !ISSUE.test(candidate.issueId))) fail("invalid_state");
  targetPath(candidate.target);
  text(candidate.title, 240, "invalid_state");
  if (candidate.id !== candidateIdentity(candidate) || renderCandidate(candidate) !== candidate.content) fail("invalid_state");
}

function validateState(state) {
  if (!state || state.version !== 1 || !Array.isArray(state.issues) || !Array.isArray(state.candidates)
    || state.issues.length > MAX_ISSUES || state.candidates.length > MAX_CANDIDATES) fail("invalid_state");
  const ids = new Set();
  for (const issue of state.issues) {
    if (!issue || !ISSUE.test(issue.id) || !TYPES.has(issue.type) || !["open", "dismissed", "resolved"].includes(issue.status)
      || !Array.isArray(issue.paths) || !Array.isArray(issue.evidence) || issue.paths.length > 50 || issue.evidence.length > 50
      || issue.id !== issueIdentity(issue) || ids.has(issue.id)) fail("invalid_state");
    text(issue.title, 240, "invalid_state"); text(issue.reason, 4000, "invalid_state");
    for (const item of issue.paths) { validateRelativePath(item.path); if (item.sha256 !== null && !HASH.test(item.sha256)) fail("invalid_state"); }
    for (const item of issue.evidence) { validateRelativePath(item.path); if (!HASH.test(item.fileSha256)) fail("invalid_state"); }
    ids.add(issue.id);
  }
  for (const candidate of state.candidates) {
    validateCandidate(candidate);
    if (ids.has(candidate.id) || (candidate.issueId && !ids.has(candidate.issueId))) fail("invalid_state");
    ids.add(candidate.id);
  }
  return state;
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
    const body = text(input.body, MAX_BODY);
    if (Buffer.byteLength(body) > MAX_BODY) fail("body_too_large");
    if (/^---(?:\r?\n|$)/u.test(body)) fail("body_frontmatter_not_allowed");
    const issueId = input.issueId || null;
    if (issueId && !state.issues.some((item) => item.id === issueId && item.status === "open")) fail("issue_not_open");
    if (issueId) checkIssueVersion(root, state.issues.find((item) => item.id === issueId));
    const candidate = { title, target, body, bodySha256: sha256(body), targetBefore: snapshot(root, target), packet: clone(input.packet), issueId,
      status: "ready", createdAt: new Date().toISOString() };
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

function appendRecord(before, entry) {
  const content = before?.content || "";
  return `${content}${content && !content.endsWith("\n") ? "\n" : ""}\n${entry}\n`;
}

function indexEntry(candidate, format = "wikilink-v1") {
  const marker = `<!-- review-target:${sha256(candidate.target).slice(0, 24)} -->`;
  const adopted = `<!-- review-adopt:${candidate.id} -->`;
  if (format === "markdown-v1") {
    const label = candidate.title.replace(/[\[\]\r\n]/gu, " ");
    const link = candidate.target.split("/").map(encodeURIComponent).join("/");
    return `${marker}\n- [${label}](${link}) — research / 研究 ${adopted}`;
  }
  const label = candidate.title.replace(/[\\\[\]|`\r\n]/gu, " ");
  return `${marker}\n- [[${candidate.target}|${label}]] — research / 研究 ${adopted}`;
}

function updatedIndex(before, state, candidate, format = "wikilink-v1") {
  const content = before?.content || "";
  const marker = `<!-- review-target:${sha256(candidate.target).slice(0, 24)} -->`;
  if (!content.includes(marker)) return appendRecord(before, indexEntry(candidate, format));
  const previous = [...state.candidates].reverse().find((item) => item.status === "adopted" && item.target === candidate.target);
  if (!previous) fail("index_managed_entry_changed");
  // Existing managed Markdown pairs are migrated only if the full pair is
  // unchanged. User-authored index text remains outside this replacement.
  const old = [indexEntry(previous, "wikilink-v1"), indexEntry(previous, "markdown-v1")].find((entry) => content.includes(entry));
  if (!old) fail("index_managed_entry_changed");
  const offset = content.indexOf(old);
  if (offset < 0 || content.indexOf(marker, content.indexOf(marker) + marker.length) >= 0
    || (offset > 0 && content[offset - 1] !== "\n") || (content[offset + old.length] && content[offset + old.length] !== "\n")) fail("index_managed_entry_changed");
  return content.slice(0, offset) + indexEntry(candidate, format) + content.slice(offset + old.length);
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

function validateJournal(journal) {
  if (!journal || journal.version !== 1 || typeof journal.committed !== "boolean" || !CANDIDATE.test(journal.candidateId)
    || (journal.indexFormat !== undefined && journal.indexFormat !== "wikilink-v1")
    || typeof journal.createdAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(journal.createdAt)
    || !Array.isArray(journal.writes) || journal.writes.length !== 4) fail("invalid_journal");
  validateCandidate(journal.candidate);
  if (journal.candidate.id !== journal.candidateId || journal.target !== journal.candidate.target) fail("invalid_journal");
  const expected = [journal.target, "index.md", "log.md", STATE];
  for (const [index, write] of journal.writes.entries()) {
    if (!write || write.path !== expected[index] || typeof write.content !== "string"
      || Buffer.byteLength(write.content) > 16 * 1024 * 1024 || !HASH.test(write.afterSha256)
      || (write.beforeSha256 !== null && !HASH.test(write.beforeSha256)) || sha256(write.content) !== write.afterSha256
      || (write.beforeSha256 === null ? write.beforeContent !== null : typeof write.beforeContent !== "string" || sha256(write.beforeContent) !== write.beforeSha256)) fail("invalid_journal");
  }
  if (journal.writes[0].content !== journal.candidate.content || journal.writes[0].beforeSha256 !== (journal.candidate.targetBefore?.sha256 || null)) fail("invalid_journal");
  let afterState;
  try { afterState = validateState(JSON.parse(journal.writes[3].content)); } catch { fail("invalid_journal"); }
  const after = afterState.candidates.find((item) => item.id === journal.candidateId);
  if (!after || after.status !== "adopted" || after.contentSha256 !== journal.candidate.contentSha256
    || (after.issueId && !afterState.issues.some((item) => item.id === after.issueId && item.status === "resolved" && item.resolvedBy === after.id))) fail("invalid_journal");
  const marker = `<!-- review-adopt:${journal.candidateId} -->`;
  const label = journal.candidate.title.replace(/[\[\]\r\n]/gu, " ");
  const before = (index) => journal.writes[index].beforeContent === null ? null : { content: journal.writes[index].beforeContent };
  let expectedState;
  try { expectedState = validateState(JSON.parse(journal.writes[3].beforeContent)); } catch { fail("invalid_journal"); }
  // The absent field identifies already-persisted v1 Markdown journals. Their
  // fixed write-set must remain replayable; new publications use wikilinks.
  if (journal.writes[1].content !== updatedIndex(before(1), expectedState, journal.candidate, journal.indexFormat || "markdown-v1")
    || journal.writes[2].content !== appendRecord(before(2), `${marker}\n## ${journal.createdAt.slice(0, 10)} research | ${label}\n\nAdopted ${journal.candidateId}: ${journal.target}`)) fail("invalid_journal");
  const expectedCandidate = expectedState.candidates.find((item) => item.id === journal.candidateId);
  if (!expectedCandidate || JSON.stringify(expectedCandidate) !== JSON.stringify(journal.candidate)) fail("invalid_journal");
  expectedCandidate.status = "adopted"; expectedCandidate.adoptedAt = journal.createdAt;
  if (expectedCandidate.issueId) {
    const issue = expectedState.issues.find((item) => item.id === expectedCandidate.issueId);
    if (!issue || issue.status !== "open") fail("invalid_journal");
    issue.status = "resolved"; issue.resolvedBy = journal.candidateId; issue.resolvedAt = journal.createdAt;
  }
  if (json(expectedState) !== journal.writes[3].content) fail("invalid_journal");
  return journal;
}

function replay(root, journal, { afterWrite } = {}) {
  validateJournal(journal);
  if (journal.committed) return { id: journal.candidateId, status: "adopted", recovered: false };
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

module.exports = { TYPES, STATE, JOURNALS, MAX_BODY, add, list, show, dismiss, stage, adopt, recover, loadState, validateJournal };
