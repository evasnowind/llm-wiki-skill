"use strict";

// Read-only leaf shared by Review, source adoption and freshness. Do not import
// the publisher, state-io or retrieval: those modules depend on this reader.
const { readSafeBinary, sha256 } = require("./markdown-package");
const { STATE, JOURNALS, HASH, ISSUE, CANDIDATE, validateState, validateIssue,
  validateCandidate, validateJournal } = require("./review-records");

const HISTORY = ".wiki-review/history";
const HISTORY_INDEX = `${HISTORY}/index.json`;
const MAX_HISTORY_ENTRIES = 10000;
const MAX_HISTORY_INDEX_BYTES = 4 * 1024 * 1024;
const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_METADATA_BYTES = 64 * 1024 * 1024;
const MAX_WRITER_METADATA_BYTES = 160 * 1024 * 1024;
const MAX_STATE_BYTES = 16 * 1024 * 1024;
const MAX_JOURNAL_BYTES = 128 * 1024 * 1024;
function fail(code) { throw Object.assign(new Error(code), { code }); }
const recordPath = (kind, id) => `${HISTORY}/${kind === "candidate" ? "candidates" : "issues"}/${id}.json`;
const journalPath = (id) => `${HISTORY}/journals/${id}.json`;

function validateHistoryIndex(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > MAX_HISTORY_ENTRIES) fail("invalid_review_history");
  const ids = new Set();
  for (const entry of value.entries) {
    if (!entry || !["candidate", "issue"].includes(entry.kind)
      || !(entry.kind === "candidate" ? CANDIDATE : ISSUE).test(entry.id) || ids.has(entry.id)
      || entry.path !== recordPath(entry.kind, entry.id) || !HASH.test(entry.sha256)
      || !Number.isSafeInteger(entry.size) || entry.size < 1 || entry.size > MAX_RECORD_BYTES) fail("invalid_review_history");
    ids.add(entry.id);
    if (entry.journal !== undefined && (entry.kind !== "candidate" || !entry.journal
      || entry.journal.path !== journalPath(entry.id) || !HASH.test(entry.journal.sha256)
      || !Number.isSafeInteger(entry.journal.size) || entry.journal.size < 1 || entry.journal.size > MAX_JOURNAL_BYTES)) fail("invalid_review_history");
  }
  return value;
}

function readReviewRecords(root, { readBinary = (relative, maximum) => readSafeBinary(root, relative, maximum), maxMetadataBytes = MAX_METADATA_BYTES } = {}) {
  if (!Number.isSafeInteger(maxMetadataBytes) || maxMetadataBytes < 1 || maxMetadataBytes > MAX_WRITER_METADATA_BYTES) fail("invalid_limit");
  let bytes = 0;
  const cache = new Map(), candidates = new Map(), issues = new Map(), descriptors = new Map();
  const result = { version: 1, activeState: { version: 1, issues: [], candidates: [] },
    candidates: [], issues: [], index: { version: 1, entries: [] }, complete: true, warnings: [],
    get metadataBytes() { return bytes; }, readJournal };
  const warn = (code, path) => {
    result.complete = false;
    if (result.warnings.length < 40 && !result.warnings.some((item) => item.code === code && item.path === path)) result.warnings.push({ code, ...(path ? { path } : {}) });
  };
  function binary(relative, maximum, optional = false) {
    if (cache.has(relative)) return cache.get(relative);
    if (bytes >= maxMetadataBytes) fail("metadata_budget_exceeded");
    let value;
    try { value = readBinary(relative, Math.min(maximum, maxMetadataBytes - bytes)); }
    catch (error) {
      if (optional && error.code === "ENOENT") return null;
      if (["file_budget_exceeded", "file_too_large"].includes(error.code) && maxMetadataBytes - bytes < maximum) fail("metadata_budget_exceeded");
      throw error;
    }
    if (!value || !Buffer.isBuffer(value.buffer) || value.buffer.length > maximum
      || value.buffer.length > maxMetadataBytes - bytes) fail("metadata_budget_exceeded");
    bytes += value.buffer.length;
    const file = { buffer: value.buffer, size: value.buffer.length, sha256: sha256(value.buffer) };
    cache.set(relative, file);
    return file;
  }
  function parsed(file) {
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.buffer)); }
    catch { fail("invalid_review_history"); }
  }
  function readJournal(id) {
    if (!CANDIDATE.test(id)) fail("invalid_arguments");
    try {
      const candidate = candidates.get(id);
      if (!candidate) fail("not_found");
      const descriptor = descriptors.get(id)?.journal;
      let file = binary(`${JOURNALS}/${id}.json`, MAX_JOURNAL_BYTES, true);
      if (file && descriptor && (file.sha256 !== descriptor.sha256 || file.size !== descriptor.size)) fail("history_conflict");
      if (!file && descriptor) {
        file = binary(descriptor.path, MAX_JOURNAL_BYTES);
        if (file.sha256 !== descriptor.sha256 || file.size !== descriptor.size) fail("history_conflict");
      }
      if (!file) {
        if (candidate.status === "adopted") fail("invalid_journal");
        return null;
      }
      const journal = validateJournal(parsed(file));
      if (journal.candidateId !== id || !["ready", "adopted"].includes(candidate.status)) fail("invalid_journal");
      const original = { ...candidate, status: "ready" }; delete original.adoptedAt;
      if (JSON.stringify(original) !== JSON.stringify(journal.candidate)
        || (candidate.status === "adopted" && journal.createdAt !== candidate.adoptedAt)
        || (journal.committed && candidate.status !== "adopted")
        || (descriptor && !journal.committed)) fail("invalid_journal");
      return journal;
    } catch (error) {
      warn(error.code || "invalid_review_history", `${JOURNALS}/${id}.json`);
      throw error;
    }
  }
  try {
    const active = binary(STATE, MAX_STATE_BYTES, true);
    if (active) result.activeState = validateState(parsed(active));
    const index = binary(HISTORY_INDEX, MAX_HISTORY_INDEX_BYTES, true);
    if (index) result.index = validateHistoryIndex(parsed(index));
    // Keep append order: it is the stable tie-break for same-time adoptions.
    for (const entry of result.index.entries) {
      const file = binary(entry.path, MAX_RECORD_BYTES);
      if (file.size !== entry.size || file.sha256 !== entry.sha256) fail("history_conflict");
      const record = parsed(file);
      if (record.id !== entry.id) fail("invalid_review_history");
      if (entry.kind === "candidate") {
        validateCandidate(record);
        if (record.status === "ready" || (record.status === "adopted") !== (entry.journal !== undefined)) fail("invalid_review_history");
        candidates.set(record.id, record);
      } else {
        validateIssue(record);
        if (record.status === "open" || entry.journal !== undefined) fail("invalid_review_history");
        issues.set(record.id, record);
      }
      descriptors.set(entry.id, entry);
    }
    for (const [records, activeRecords] of [[issues, result.activeState.issues], [candidates, result.activeState.candidates]]) {
      for (const record of activeRecords) {
        if (records.has(record.id) && JSON.stringify(records.get(record.id)) !== JSON.stringify(record)) fail("history_conflict");
        records.set(record.id, record);
      }
    }
    for (const candidate of candidates.values()) {
      if (candidate.issueId && !issues.has(candidate.issueId)) fail("invalid_review_history");
      if (candidate.status === "superseded") {
        const replacement = candidates.get(candidate.supersededBy);
        if (!replacement || replacement.target !== candidate.target) fail("invalid_review_history");
      }
    }
    // A replacement chain may end in any state, but cannot form a cycle.
    const finished = new Set();
    for (const candidate of candidates.values()) {
      const seen = new Set(); let cursor = candidate;
      while (cursor && !finished.has(cursor.id)) {
        if (seen.has(cursor.id)) fail("invalid_review_history");
        seen.add(cursor.id);
        cursor = cursor.status === "superseded" ? candidates.get(cursor.supersededBy) : null;
      }
      for (const id of seen) finished.add(id);
    }
    for (const issue of issues.values()) if (issue.status === "resolved") {
      const candidate = candidates.get(issue.resolvedBy);
      if (!candidate || candidate.status !== "adopted" || candidate.issueId !== issue.id) fail("invalid_review_history");
    }
    result.candidates = [...candidates.values()]; result.issues = [...issues.values()];
  } catch (error) {
    warn(error.code || "invalid_review_history");
    // Partial metadata cannot establish an older candidate as the latest one.
    result.candidates = []; result.issues = [];
  }
  return result;
}

module.exports = { HISTORY, HISTORY_INDEX, MAX_HISTORY_ENTRIES, MAX_HISTORY_INDEX_BYTES, MAX_RECORD_BYTES,
  MAX_METADATA_BYTES, MAX_WRITER_METADATA_BYTES, recordPath, journalPath, validateHistoryIndex, readReviewRecords };
