"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  validateRoot, validateRelativePath, safeReadFile, verifyPacket, sha256, MAX_PACKET_BYTES,
} = require("./skill-retrieval");
const { STORE, MAX_STATE_BYTES, MAX_JOURNAL_BYTES, fail, checkedPath, readOptional, readJson, atomicWrite, syncDirectory, json, withLock } = require("./skill-state-io");
const { validateBinding, verifyPackage } = require("./markdown-package");
const { HISTORY, HISTORY_INDEX, MAX_HISTORY_INDEX_BYTES, MAX_HISTORY_ENTRIES, MAX_RECORD_BYTES,
  MAX_WRITER_METADATA_BYTES, recordPath, journalPath: coldJournalPath, validateHistoryIndex, readReviewRecords } = require("./review-history");
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

function records(root) {
  const result = readReviewRecords(root, { maxMetadataBytes: MAX_WRITER_METADATA_BYTES });
  if (!result.complete) fail(result.warnings[0]?.code || "invalid_review_history");
  return result;
}

function originalCandidate(candidate) {
  const result = clone(candidate); result.status = "ready"; delete result.adoptedAt;
  return result;
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
  const view = records(root);
  for (const relative of journalPaths(root)) {
    const journal = validateJournal(readJson(root, relative, MAX_JOURNAL_BYTES));
    if (relative !== `${JOURNALS}/${journal.candidateId}.json`) fail("invalid_journal");
    if (!journal.committed) fail("recovery_required");
    const candidate = view.candidates.find((item) => item.id === journal.candidateId);
    if (!candidate || candidate.status !== "adopted" || candidate.adoptedAt !== journal.createdAt
      || JSON.stringify(originalCandidate(candidate)) !== JSON.stringify(journal.candidate)) fail("invalid_journal");
    const archived = view.index.entries.find((item) => item.id === journal.candidateId)?.journal;
    if (archived) {
      const file = readOptional(root, relative, MAX_JOURNAL_BYTES);
      if (!file || file.sha256 !== archived.sha256 || file.buffer.length !== archived.size) fail("history_conflict");
    }
  }
  return view;
}

function immutableCopy(root, relative, buffer, maximum) {
  if (buffer.length > maximum) fail("review_history_limit");
  const existing = readOptional(root, relative, maximum);
  if (existing) {
    if (!existing.buffer.equals(buffer)) fail("history_conflict");
    return;
  }
  const target = checkedPath(root, relative, true);
  const temporary = `${relative}.tmp-${crypto.randomBytes(10).toString("hex")}`;
  const temporaryPath = checkedPath(root, temporary);
  let fd;
  try {
    fd = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(fd, buffer); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    checkedPath(root, relative); checkedPath(root, temporary);
    // Publish without replacement. The write is complete before its name can
    // be observed, and a concurrently created unknown file is never replaced.
    try { fs.linkSync(temporaryPath, target); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (!readOptional(root, relative, maximum)?.buffer.equals(buffer)) fail("history_conflict");
    }
    syncDirectory(path.dirname(target));
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporaryPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

function compactUnlocked(root, { afterWrite } = {}) {
  const view = assertNoPending(root), state = view.activeState;
  const stateBefore = readOptional(root, STATE), indexBefore = readOptional(root, HISTORY_INDEX, MAX_HISTORY_INDEX_BYTES);
  const candidates = state.candidates.filter((item) => item.status !== "ready");
  const retained = state.candidates.filter((item) => item.status === "ready");
  const requiredIssues = new Set(retained.map((item) => item.issueId).filter(Boolean));
  const issues = state.issues.filter((item) => item.status !== "open" && !requiredIssues.has(item.id));
  const planned = [...issues.map((record) => ({ kind: "issue", record })), ...candidates.map((record) => ({ kind: "candidate", record }))];
  const index = clone(view.index), byId = new Map(index.entries.map((entry) => [entry.id, entry]));
  const plannedPaths = new Set(index.entries.flatMap((entry) => [entry.path, ...(entry.journal ? [entry.journal.path] : [])]));
  for (const { kind, record } of planned) {
    plannedPaths.add(recordPath(kind, record.id));
    if (kind === "candidate" && record.status === "adopted") plannedPaths.add(coldJournalPath(record.id));
  }
  // Only known indexed files or exact retry targets may be present. Unknown
  // copies from another interrupted operation need inspection, not deletion.
  for (const directory of ["candidates", "issues", "journals"]) {
    const relative = `${HISTORY}/${directory}`, target = checkedPath(root, relative);
    if (!fs.existsSync(target)) continue;
    const entries = fs.readdirSync(target, { withFileTypes: true });
    if (entries.length > MAX_HISTORY_ENTRIES + MAX_CANDIDATES + MAX_ISSUES) fail("review_history_limit");
    for (const entry of entries) if (!entry.name.includes(".tmp-")) {
      if (!entry.isFile() || !plannedPaths.has(`${relative}/${entry.name}`)) fail("history_conflict");
    }
  }
  if (new Set([...byId.keys(), ...planned.map(({ record }) => record.id)]).size > MAX_HISTORY_ENTRIES) fail("review_history_limit");
  const copies = [];
  for (const { kind, record } of planned) {
    const buffer = Buffer.from(json(record));
    const entry = { kind, id: record.id, path: recordPath(kind, record.id), size: buffer.length, sha256: sha256(buffer) };
    let journalFile, journalRelative;
    if (kind === "candidate" && record.status === "adopted") {
      journalRelative = `${JOURNALS}/${record.id}.json`;
      journalFile = readOptional(root, journalRelative, MAX_JOURNAL_BYTES);
      if (!journalFile) { journalRelative = coldJournalPath(record.id); journalFile = readOptional(root, journalRelative, MAX_JOURNAL_BYTES); }
      if (!journalFile) fail("invalid_journal");
      const journal = validateJournal(JSON.parse(journalFile.text));
      if (!journal.committed || journal.createdAt !== record.adoptedAt
        || JSON.stringify(originalCandidate(record)) !== JSON.stringify(journal.candidate)) fail("invalid_journal");
      entry.journal = { path: coldJournalPath(record.id), size: journalFile.buffer.length, sha256: journalFile.sha256 };
    }
    const previous = byId.get(record.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(entry)) fail("history_conflict");
    if (buffer.length > MAX_RECORD_BYTES) fail("review_history_limit");
    copies.push({ entry, buffer, journalRelative });
    if (!previous) { index.entries.push(entry); byId.set(entry.id, entry); }
  }
  validateHistoryIndex(index);
  const nextIndex = json(index);
  if (Buffer.byteLength(nextIndex) > MAX_HISTORY_INDEX_BYTES) fail("review_history_limit");
  // Check every bounded descriptor before creating any copies. Keep only the
  // small active records in memory; journals are copied one at a time.
  let boundary = 0;
  const checkpoint = (label) => { if (afterWrite) afterWrite(boundary++, label); };
  checkpoint("before-copy");
  for (const { entry, buffer, journalRelative } of copies) {
    immutableCopy(root, entry.path, buffer, MAX_RECORD_BYTES); checkpoint(`record:${entry.id}`);
    if (entry.journal) {
      const source = readOptional(root, journalRelative, MAX_JOURNAL_BYTES);
      if (!source || source.sha256 !== entry.journal.sha256 || source.buffer.length !== entry.journal.size) fail("history_conflict");
      immutableCopy(root, entry.journal.path, source.buffer, MAX_JOURNAL_BYTES); checkpoint(`journal:${entry.id}`);
    }
  }
  const expectedState = stateBefore?.sha256 || null;
  if ((readOptional(root, STATE)?.sha256 || null) !== expectedState
    || (readOptional(root, HISTORY_INDEX, MAX_HISTORY_INDEX_BYTES)?.sha256 || null) !== (indexBefore?.sha256 || null)) fail("history_conflict");
  let indexHash = indexBefore?.sha256 || null;
  if (index.entries.length !== view.index.entries.length) {
    atomicWrite(root, HISTORY_INDEX, nextIndex, MAX_HISTORY_INDEX_BYTES); indexHash = sha256(nextIndex);
  }
  checkpoint("index");
  const nextState = { ...state, issues: state.issues.filter((item) => !issues.some((entry) => entry.id === item.id)), candidates: retained };
  let stateHash = expectedState;
  if (planned.length) {
    if ((readOptional(root, STATE)?.sha256 || null) !== expectedState) fail("history_conflict");
    saveState(root, nextState); stateHash = sha256(json(nextState));
  }
  checkpoint("state");
  let removedJournals = 0;
  for (const relative of journalPaths(root)) {
    const id = path.posix.basename(relative, ".json"), descriptor = byId.get(id)?.journal;
    if (!descriptor) continue;
    if ((readOptional(root, STATE)?.sha256 || null) !== stateHash
      || (readOptional(root, HISTORY_INDEX, MAX_HISTORY_INDEX_BYTES)?.sha256 || null) !== indexHash) fail("history_conflict");
    const live = readOptional(root, relative, MAX_JOURNAL_BYTES), backup = readOptional(root, descriptor.path, MAX_JOURNAL_BYTES);
    if (!live || !backup || live.sha256 !== descriptor.sha256 || backup.sha256 !== descriptor.sha256
      || live.buffer.length !== descriptor.size || backup.buffer.length !== descriptor.size) fail("history_conflict");
    fs.unlinkSync(checkedPath(root, relative)); syncDirectory(path.join(root, JOURNALS)); removedJournals++;
    checkpoint(`remove:${id}`);
  }
  return { version: 1, archivedCandidates: candidates.length, archivedIssues: issues.length,
    removedJournals, historyEntries: index.entries.length, activeCandidates: retained.length, activeIssues: nextState.issues.length };
}

function compact(kbRoot, options = {}) {
  const root = validateRoot(kbRoot);
  return withLock(root, () => compactUnlocked(root, options));
}

function expectedPaths(root, values) {
  if (values === undefined) return;
  if (!Array.isArray(values) || values.length > 250) fail("invalid_arguments");
  const seen = new Set();
  for (const item of values) {
    if (!item || (item.sha256 !== null && !HASH.test(item.sha256))) fail("invalid_arguments");
    validateRelativePath(item.path);
    if (seen.has(item.path)) fail("invalid_arguments");
    seen.add(item.path);
    if ((readOptional(root, item.path)?.sha256 || null) !== item.sha256) fail("issue_changed");
  }
}

function add(kbRoot, input) {
  const root = validateRoot(kbRoot);
  return withLock(root, () => {
    const view = assertNoPending(root);
    let state = view.activeState;
    if (!TYPES.has(input.type) || !Array.isArray(input.paths || []) || (input.paths || []).length > 50) fail("invalid_arguments");
    expectedPaths(root, input.expectedPaths);
    if (input.packet) checkPacket(root, input.packet);
    const paths = [...new Set(input.paths || [])].sort().map((relative) => {
      validateRelativePath(relative);
      if (!(relative.startsWith("wiki/") || relative.startsWith("raw/") || ["index.md", "log.md", ".wiki-schema.md", "purpose.md"].includes(relative))) fail("invalid_path");
      return { path: relative, sha256: readOptional(root, relative)?.sha256 || null };
    });
    const evidence = [...new Map((input.packet?.evidence || []).map((item) => [item.path, { path: item.path, fileSha256: item.fileSha256 }])).values()].sort((a, b) => a.path.localeCompare(b.path));
    const issue = { type: input.type, title: text(input.title, 240), reason: text(input.reason, 4000), paths, evidence, status: "open", createdAt: new Date().toISOString() };
    issue.id = issueIdentity(issue);
    const existing = view.issues.find((item) => item.id === issue.id);
    if (existing) return clone(existing);
    if (state.candidates.some((item) => item.status !== "ready") || state.issues.some((item) => item.status !== "open")) {
      compactUnlocked(root); state = loadState(root);
    }
    if (state.issues.length >= MAX_ISSUES) fail("review_limit");
    state.issues.push(issue);
    saveState(root, state);
    return clone(issue);
  });
}

function list(kbRoot, { status = "open", scope = "all", candidateStatus = "all", limit = 100, offset = 0 } = {}) {
  const root = validateRoot(kbRoot);
  if (!["open", "dismissed", "resolved", "all"].includes(status) || !["active", "history", "all"].includes(scope)
    || !["ready", "adopted", "cancelled", "superseded", "all"].includes(candidateStatus)
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 500 || !Number.isSafeInteger(offset) || offset < 0) fail("invalid_arguments");
  const view = records(root), archived = new Set(view.index.entries.map((item) => item.id));
  const selected = (item) => scope === "all" || (scope === "history" ? archived.has(item.id) : !archived.has(item.id));
  const issues = view.issues.filter((item) => selected(item) && (status === "all" || item.status === status));
  const candidates = view.candidates.filter((item) => selected(item) && (candidateStatus === "all" || item.status === candidateStatus));
  return { version: 1, issues: issues.slice(offset, offset + limit),
    candidates: candidates.slice(offset, offset + limit).map(({ id, title, target, status: state, issueId, cancelledAt, cancelReason, supersededAt, supersededBy }) =>
      ({ id, title, target, status: state, issueId, ...(cancelledAt ? { cancelledAt } : {}), ...(cancelReason ? { cancelReason } : {}), ...(supersededAt ? { supersededAt, supersededBy } : {}) })),
    pagination: { scope, offset, limit, issues: issues.length, candidates: candidates.length,
      nextOffset: Math.max(issues.length, candidates.length) > offset + limit ? offset + limit : null } };
}

function show(kbRoot, id) {
  const root = validateRoot(kbRoot);
  const view = records(root);
  const issue = view.issues.find((item) => item.id === id);
  if (issue) return clone(issue);
  const candidate = view.candidates.find((item) => item.id === id);
  if (!candidate) fail("not_found");
  if (candidate.status === "adopted" && !view.readJournal(id)?.committed) fail("invalid_journal");
  return { ...clone(candidate), currentTarget: snapshot(root, candidate.target), evidenceVerification: verifyPacket(root, candidate.packet) };
}

function dismiss(kbRoot, id) {
  const root = validateRoot(kbRoot);
  return withLock(root, () => {
    const view = assertNoPending(root), state = view.activeState;
    const issue = view.issues.find((item) => item.id === id);
    if (!issue) fail("not_found");
    if (issue.status === "resolved") fail("issue_already_resolved");
    if (issue.status === "dismissed") return clone(issue);
    issue.status = "dismissed";
    saveState(root, state);
    return clone(issue);
  });
}

function stage(kbRoot, input) {
  const root = validateRoot(kbRoot);
  return withLock(root, () => {
    const view = assertNoPending(root);
    let state = view.activeState;
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
    const packet = clone(input.packet);
    // Freshness is a live diagnostic, not an immutable evidence assertion.
    // Keep the original packet identity contract and never mutate caller data.
    delete packet.freshness;
    const candidate = { title, target, body, bodySha256: sha256(body), targetBefore, packet, issueId,
      status: "ready", createdAt: new Date().toISOString() };
    if (markdownSource) candidate.markdownSource = clone(markdownSource);
    candidate.id = candidateIdentity(candidate);
    const existing = view.candidates.find((item) => item.id === candidate.id);
    if (existing) return clone(existing);
    candidate.content = renderCandidate(candidate);
    candidate.contentSha256 = sha256(candidate.content);
    validateCandidate(candidate);
    if (state.candidates.some((item) => item.status !== "ready") || state.issues.some((item) => item.status !== "open")) {
      compactUnlocked(root); state = loadState(root);
    }
    if (state.candidates.length >= MAX_CANDIDATES) fail("review_limit");
    state.candidates.push(candidate);
    saveState(root, state);
    return clone(candidate);
  });
}

function cancel(kbRoot, id, { reason } = {}) {
  const root = validateRoot(kbRoot);
  if (!CANDIDATE.test(id)) fail("invalid_arguments");
  const cancelReason = reason === undefined ? undefined : text(reason, 4000);
  return withLock(root, () => {
    const view = assertNoPending(root), candidate = view.candidates.find((item) => item.id === id);
    if (!candidate) fail("not_found");
    if (candidate.status === "cancelled" && (cancelReason === undefined || cancelReason === candidate.cancelReason)) return clone(candidate);
    if (candidate.status !== "ready") fail("candidate_not_ready");
    candidate.status = "cancelled"; candidate.cancelledAt = new Date().toISOString();
    if (cancelReason !== undefined) candidate.cancelReason = cancelReason;
    // activeState and the merged view share validated record objects.
    validateState(view.activeState); saveState(root, view.activeState);
    return clone(candidate);
  });
}

function supersede(kbRoot, id, replacementId) {
  const root = validateRoot(kbRoot);
  if (!CANDIDATE.test(id) || !CANDIDATE.test(replacementId) || id === replacementId) fail("invalid_arguments");
  return withLock(root, () => {
    const view = assertNoPending(root), candidate = view.candidates.find((item) => item.id === id), replacement = view.candidates.find((item) => item.id === replacementId);
    if (!candidate || !replacement) fail("not_found");
    if (candidate.status === "superseded" && candidate.supersededBy === replacementId) return clone(candidate);
    if (candidate.status !== "ready" || replacement.status !== "ready") fail("candidate_not_ready");
    if (candidate.target !== replacement.target) fail("replacement_target_mismatch");
    candidate.status = "superseded"; candidate.supersededAt = new Date().toISOString(); candidate.supersededBy = replacementId;
    validateState(view.activeState); saveState(root, view.activeState);
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
  let previousCandidate;
  if (indexBefore?.content.includes(`<!-- review-target:${sha256(candidate.target).slice(0, 24)} -->`)
    && !state.candidates.some((item) => item.status === "adopted" && item.target === candidate.target)) {
    const view = records(root);
    previousCandidate = [...view.candidates].reverse().find((item) => item.status === "adopted" && item.target === candidate.target);
    if (!previousCandidate || !view.readJournal(previousCandidate.id)?.committed) fail("index_managed_entry_changed");
  }
  const journal = { version: 1, indexFormat: "wikilink-v1", candidateId: candidate.id, target: candidate.target, createdAt: adoptedAt, committed: false,
    candidate: clone(candidate), writes: [
      makeWrite(candidate.target, candidate.targetBefore, candidate.content),
      makeWrite("index.md", indexBefore, updatedIndex(indexBefore, state, candidate, "wikilink-v1", previousCandidate)),
      makeWrite("log.md", logBefore, appendRecord(logBefore, `${marker}\n## ${adoptedAt.slice(0, 10)} research | ${label}\n\nAdopted ${candidate.id}: ${candidate.target}`)),
      makeWrite(STATE, stateBefore, json(next)),
    ] };
  if (previousCandidate) journal.previousCandidate = clone(previousCandidate);
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
    const view = assertNoPending(root), state = view.activeState;
    const candidate = view.candidates.find((item) => item.id === id);
    if (!candidate) fail("not_found");
    if (candidate.status === "adopted") {
      if (!view.readJournal(id)?.committed) fail("invalid_journal");
      return { id, status: "adopted", recovered: false };
    }
    if (candidate.status !== "ready") fail("candidate_not_ready");
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
    if (id && !selected.length) {
      const view = records(root), candidate = view.candidates.find((item) => item.id === id);
      if (!candidate || candidate.status !== "adopted") fail("not_found");
      if (!view.readJournal(id)?.committed) fail("invalid_journal");
      return { version: 1, recovered: [] };
    }
    const results = [];
    for (const relative of selected) {
      const journal = validateJournal(readJson(root, relative, MAX_JOURNAL_BYTES));
      if (relative !== `${JOURNALS}/${journal.candidateId}.json`) fail("invalid_journal");
      if (!journal.committed) results.push(replay(root, journal, options));
    }
    return { version: 1, recovered: results };
  }, { recover: true });
}

module.exports = { TYPES, STATE, JOURNALS, MAX_BODY, add, list, show, dismiss, stage, adopt, recover,
  cancel, supersede, compact, loadState, validateJournal, assertNoPending };
