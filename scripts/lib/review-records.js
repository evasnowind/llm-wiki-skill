"use strict";

// Pure versioned Review records shared by the publisher and Markdown readers.
// Keep IO, state-io and retrieval out of this module to prevent import cycles.
const path = require("node:path");
const { sha256, validateBinding } = require("./markdown-package");
const STATE = ".wiki-review/state.json";
const JOURNALS = ".wiki-review/journals";
const TYPES = new Set(["contradiction", "duplicate", "missing", "unverified", "suggestion"]);
const HASH = /^[a-f0-9]{64}$/;
const ISSUE = /^issue-[a-f0-9]{24}$/;
const CANDIDATE = /^candidate-[a-f0-9]{24}$/;
const MAX_BODY = 256 * 1024;
const MAX_ISSUES = 500;
const MAX_CANDIDATES = 100;
const MAX_PACKET_BYTES = 2 * 1024 * 1024;
const TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u;
function fail(code) { const error = new Error(code); error.code = code; throw error; }
function json(value) { return `${JSON.stringify(value, null, 2)}\n`; }
function validateRelativePath(relative) {
  if (typeof relative !== "string" || !relative || relative.length > 2048
    || /[\\:\x00-\x1f\x7f]/.test(relative) || relative.startsWith("/")
    || relative.split("/").some((part) => !part || part === "." || part === "..")) fail("unsafe_path");
  return relative;
}

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

function validateSnapshot(value) {
  return value === null || (value && typeof value.content === "string" && Buffer.byteLength(value.content) <= MAX_BODY * 2
    && HASH.test(value.sha256) && sha256(value.content) === value.sha256);
}

function issueIdentity(issue) {
  return `issue-${sha256(JSON.stringify({ type: issue.type, title: issue.title, reason: issue.reason, paths: issue.paths, evidence: issue.evidence })).slice(0, 24)}`;
}

function candidateIdentity(candidate) {
  const identity = { title: candidate.title, target: candidate.target,
    targetBeforeHash: candidate.targetBefore?.sha256 || null, bodySha256: candidate.bodySha256,
    packet: candidate.packet, issueId: candidate.issueId };
  // Preserve the exact identity of every pre-Markdown candidate.
  if (candidate.markdownSource !== undefined) identity.markdownSource = candidate.markdownSource;
  return `candidate-${sha256(JSON.stringify(identity)).slice(0, 24)}`;
}

function renderCandidate(candidate) {
  const sources = [...new Set(candidate.packet.evidence.map((item) => item.path))].sort();
  const type = candidate.markdownSource ? "source" : candidate.target.startsWith("wiki/queries/") ? "query" : "research";
  const lines = ["---", `type: ${type}`, "derived: true", `title: ${JSON.stringify(candidate.title)}`,
    `created: ${JSON.stringify(candidate.createdAt)}`, `review-candidate: ${candidate.id}`, "sources:",
    ...sources.map((source) => `  - ${JSON.stringify(source)}`)];
  if (candidate.markdownSource) lines.push(
    "source_id: local_document", 'source_type: "Markdown/文本/HTML"',
    `source_path: ${JSON.stringify(candidate.markdownSource.primaryPath)}`,
    `markdown-source-id: ${candidate.markdownSource.sourceId}`,
    `markdown-revision: ${candidate.markdownSource.revision}`,
    `reading_path: ${JSON.stringify(candidate.markdownSource.readingPath || candidate.markdownSource.primaryPath.replace("/files/", "/reading/"))}`,
  );
  lines.push("---", "", candidate.body, "", "## Evidence / 证据", "");
  if (candidate.packet.coverage?.complete === false) lines.push("> Coverage is incomplete / 本次检索覆盖不完整；结论限于列出的证据。", "");
  for (const evidence of candidate.packet.evidence) {
    const relative = path.posix.relative(path.posix.dirname(candidate.target), evidence.path);
    const encoded = relative.split("/").map(encodeURIComponent).join("/");
    lines.push(`- [${evidence.id}](${encoded}) — ${evidence.path}:${evidence.startLine}-${evidence.endLine}; SHA256 ${evidence.fileSha256}`);
    if (candidate.markdownSource) {
      // Source excerpts are literal: their relative images/links resolve from
      // the source directory, not the summary directory. Open the reading copy
      // to render them. A longer fence also contains fences in the excerpt.
      let fenceLength = 3;
      for (const match of evidence.excerpt.matchAll(/`+/gu)) fenceLength = Math.max(fenceLength, match[0].length + 1);
      const fence = "`".repeat(fenceLength);
      lines.push("", `  ${fence}text`, ...evidence.excerpt.split("\n").map((line) => `  ${line.replace(/\r$/u, "")}`), `  ${fence}`, "");
    } else lines.push(...evidence.excerpt.split("\n").map((line) => `  > ${line.replace(/\r$/u, "")}`), "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function validateCandidate(candidate) {
  if (!candidate || !CANDIDATE.test(candidate.id) || !["ready", "adopted", "cancelled", "superseded"].includes(candidate.status)
    || !validateSnapshot(candidate.targetBefore) || typeof candidate.body !== "string" || Buffer.byteLength(candidate.body) > MAX_BODY
    || sha256(candidate.body) !== candidate.bodySha256 || typeof candidate.content !== "string"
    || Buffer.byteLength(candidate.content) > MAX_BODY * 2 || sha256(candidate.content) !== candidate.contentSha256
    || !candidate.packet || !Array.isArray(candidate.packet.evidence) || !candidate.packet.evidence.length
    || Buffer.byteLength(JSON.stringify(candidate.packet)) > MAX_PACKET_BYTES
    || typeof candidate.createdAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(candidate.createdAt)
    || (candidate.issueId !== null && !ISSUE.test(candidate.issueId))) fail("invalid_state");
  targetPath(candidate.target);
  text(candidate.title, 240, "invalid_state");
  if (candidate.status === "cancelled") {
    if (!TIME.test(candidate.cancelledAt) || candidate.supersededAt !== undefined || candidate.supersededBy !== undefined
      || candidate.adoptedAt !== undefined) fail("invalid_state");
    if (candidate.cancelReason !== undefined) text(candidate.cancelReason, 4000, "invalid_state");
  } else if (candidate.status === "superseded") {
    if (!TIME.test(candidate.supersededAt) || !CANDIDATE.test(candidate.supersededBy)
      || candidate.supersededBy === candidate.id || candidate.cancelledAt !== undefined
      || candidate.cancelReason !== undefined || candidate.adoptedAt !== undefined) fail("invalid_state");
  } else if (candidate.cancelledAt !== undefined || candidate.cancelReason !== undefined
    || candidate.supersededAt !== undefined || candidate.supersededBy !== undefined) fail("invalid_state");
  if (candidate.markdownSource !== undefined) {
    validateBinding(candidate.markdownSource);
    if (candidate.target !== `wiki/sources/${candidate.markdownSource.sourceId}.md`
      || candidate.packet.mode !== "raw"
      || !candidate.packet.evidence.some((item) => item.path === candidate.markdownSource.primaryPath
        && item.fileSha256 === candidate.markdownSource.primarySha256)) fail("invalid_state");
  }
  if (candidate.id !== candidateIdentity(candidate) || renderCandidate(candidate) !== candidate.content) fail("invalid_state");
}

function validateIssue(issue) {
  if (!issue || !ISSUE.test(issue.id) || !TYPES.has(issue.type) || !["open", "dismissed", "resolved"].includes(issue.status)
    || !Array.isArray(issue.paths) || !Array.isArray(issue.evidence) || issue.paths.length > 50 || issue.evidence.length > 50
    || issue.id !== issueIdentity(issue)) fail("invalid_state");
  text(issue.title, 240, "invalid_state"); text(issue.reason, 4000, "invalid_state");
  for (const item of issue.paths) { validateRelativePath(item.path); if (item.sha256 !== null && !HASH.test(item.sha256)) fail("invalid_state"); }
  for (const item of issue.evidence) { validateRelativePath(item.path); if (!HASH.test(item.fileSha256)) fail("invalid_state"); }
  return issue;
}

function validateState(state) {
  if (!state || state.version !== 1 || !Array.isArray(state.issues) || !Array.isArray(state.candidates)
    || state.issues.length > MAX_ISSUES || state.candidates.length > MAX_CANDIDATES) fail("invalid_state");
  const ids = new Set();
  for (const issue of state.issues) {
    validateIssue(issue);
    if (ids.has(issue.id)) fail("invalid_state");
    ids.add(issue.id);
  }
  for (const candidate of state.candidates) {
    validateCandidate(candidate);
    if (ids.has(candidate.id) || (candidate.issueId && !ids.has(candidate.issueId))) fail("invalid_state");
    ids.add(candidate.id);
  }
  return state;
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

function updatedIndex(before, state, candidate, format = "wikilink-v1", previousCandidate) {
  const content = before?.content || "";
  const marker = `<!-- review-target:${sha256(candidate.target).slice(0, 24)} -->`;
  if (!content.includes(marker)) return appendRecord(before, indexEntry(candidate, format));
  const previous = [...state.candidates].reverse().find((item) => item.status === "adopted" && item.target === candidate.target) || previousCandidate;
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

function validateJournal(journal) {
  if (!journal || journal.version !== 1 || typeof journal.committed !== "boolean" || !CANDIDATE.test(journal.candidateId)
    || (journal.indexFormat !== undefined && journal.indexFormat !== "wikilink-v1")
    || typeof journal.createdAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(journal.createdAt)
    || !Array.isArray(journal.writes) || journal.writes.length !== 4) fail("invalid_journal");
  validateCandidate(journal.candidate);
  if (journal.candidate.id !== journal.candidateId || journal.target !== journal.candidate.target
    || journal.candidate.status !== "ready") fail("invalid_journal");
  if (journal.previousCandidate !== undefined) {
    validateCandidate(journal.previousCandidate);
    if (journal.previousCandidate.status !== "adopted" || journal.previousCandidate.target !== journal.target
      || journal.previousCandidate.id === journal.candidateId || !TIME.test(journal.previousCandidate.adoptedAt)) fail("invalid_journal");
  }
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
  if (journal.writes[1].content !== updatedIndex(before(1), expectedState, journal.candidate, journal.indexFormat || "markdown-v1", journal.previousCandidate)
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

module.exports = { STATE, JOURNALS, TYPES, HASH, ISSUE, CANDIDATE, MAX_BODY, MAX_ISSUES, MAX_CANDIDATES,
  validateRelativePath, text, targetPath, issueIdentity, candidateIdentity, renderCandidate,
  validateCandidate, validateIssue, validateState, appendRecord, indexEntry, updatedIndex, validateJournal };
