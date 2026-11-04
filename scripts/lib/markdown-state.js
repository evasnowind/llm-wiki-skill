"use strict";

// Leaf metadata reader shared by Markdown updates and retrieval. Do not import
// the Review publisher, retrieval or state-io here: those modules consume this
// reader. review-records contains only shared pure record validation.
const fs = require("node:fs");
const path = require("node:path");
const {
  validateBinding, validateRelativePath, readSafeBinary, checkedPath,
} = require("./markdown-package");
const { validateCandidate, validateJournal, candidateIdentity } = require("./review-records");

const REGISTRY = ".wiki-review/markdown-sources.json";
const MAX_STATE_BYTES = 16 * 1024 * 1024;
const MAX_METADATA_BYTES = 64 * 1024 * 1024;
const MAX_WRITER_METADATA_BYTES = 160 * 1024 * 1024;
const SOURCE_ID = /^md-[a-f0-9]{24}$/u;
const COLLECTION_ID = /^mdcol-[a-f0-9]{24}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u;
const SUMMARY_START = "<!-- llm-wiki-markdown:summary:start -->";
const SUMMARY_END = "<!-- llm-wiki-markdown:summary:end -->";
const MANUAL_START = "<!-- llm-wiki-markdown:manual:start -->";
const MANUAL_END = "<!-- llm-wiki-markdown:manual:end -->";
const DEFAULT_MANUAL = "\n## 我的补充 / My notes\n\n";

function fail(code) { const error = new Error(code); error.code = code; throw error; }
function clone(value) { return JSON.parse(JSON.stringify(value)); }

function readJson(root, relative, maximum = MAX_STATE_BYTES) {
  let file;
  try { file = readSafeBinary(root, relative, maximum); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.buffer)); }
  catch { fail("invalid_markdown_state"); }
}

function validateRegistry(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.collections) || !Array.isArray(value.sources)
    || value.collections.length > 200 || value.sources.length > 2000) fail("invalid_markdown_state");
  const collections = new Set(), sources = new Set(), paths = new Set();
  for (const collection of value.collections) {
    if (!collection || !COLLECTION_ID.test(collection.id) || collections.has(collection.id)
      || !HASH.test(collection.rootFingerprint)) fail("invalid_markdown_state");
    collections.add(collection.id);
  }
  for (const source of value.sources) {
    if (!source || !SOURCE_ID.test(source.id) || sources.has(source.id) || !collections.has(source.collectionId)
      || !Array.isArray(source.revisions) || !source.revisions.length || source.revisions.length > 1000
      || !/\.md$/iu.test(source.inputPath)) fail("invalid_markdown_state");
    validateRelativePath(source.inputPath);
    const key = `${source.collectionId}\0${source.inputPath.normalize("NFC").toLowerCase()}`;
    if (paths.has(key)) fail("invalid_markdown_state");
    paths.add(key); sources.add(source.id);
    if (source.aliases !== undefined) {
      if (!Array.isArray(source.aliases) || source.aliases.length > 1000) fail("invalid_markdown_state");
      source.aliases.forEach(validateRelativePath);
    }
    const revisions = new Set();
    for (const binding of source.revisions) {
      validateBinding(binding);
      if (binding.sourceId !== source.id || revisions.has(binding.revision)) fail("invalid_markdown_state");
      revisions.add(binding.revision);
    }
  }
  return value;
}

function readRegistry(root) {
  return validateRegistry(readJson(root, REGISTRY) || { version: 1, collections: [], sources: [] });
}

function controlMarkers(value) {
  return [SUMMARY_START, SUMMARY_END, MANUAL_START, MANUAL_END].some((marker) => value.includes(marker));
}

function region(value, startMarker, endMarker) {
  if (typeof value !== "string") fail("managed_summary_changed");
  const positions = (marker) => {
    const found = [];
    for (let index = value.indexOf(marker); index >= 0; index = value.indexOf(marker, index + marker.length)) {
      const after = index + marker.length;
      if ((index === 0 || value[index - 1] === "\n") && (after === value.length || value[after] === "\n"
        || (value[after] === "\r" && value[after + 1] === "\n"))) found.push(index);
    }
    return found;
  };
  const starts = positions(startMarker), ends = positions(endMarker);
  if (starts.length !== 1 || ends.length !== 1) fail("managed_summary_changed");
  const [start] = starts, [end] = ends;
  if (end < start + startMarker.length) fail("managed_summary_changed");
  return { start: start + startMarker.length, end };
}

function extractManual(value) {
  const { start, end } = region(value, MANUAL_START, MANUAL_END);
  return value.slice(start, end);
}

function stripManual(value) {
  const { start, end } = region(value, MANUAL_START, MANUAL_END);
  return value.slice(0, start) + value.slice(end);
}

function extractSummary(value) {
  const { start, end } = region(value, SUMMARY_START, SUMMARY_END);
  return value.slice(start, end);
}

function buildBody(binding, body, manual = DEFAULT_MANUAL) {
  validateBinding(binding);
  if (typeof body !== "string" || !body.trim() || Buffer.byteLength(body) > 250 * 1024
    || /^\uFEFF?---(?:\r?\n|$)/u.test(body) || controlMarkers(body)
    || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(body)) fail("invalid_summary_body");
  if (typeof manual !== "string" || controlMarkers(manual)) fail("managed_summary_changed");
  const target = `wiki/sources/${binding.sourceId}.md`;
  const reading = binding.readingPath || binding.primaryPath;
  const relative = path.posix.relative(path.posix.dirname(target), reading).split("/").map(encodeURIComponent).join("/");
  return `${SUMMARY_START}\n[阅读资料 / Read material](${relative})\n\n${body}${body.endsWith("\n") ? "" : "\n"}${SUMMARY_END}\n\n${MANUAL_START}${manual}${MANUAL_END}\n`;
}

function validCandidate(candidate) {
  validateCandidate(candidate);
  validateBinding(candidate.markdownSource);
  return candidate;
}

function validJournal(journal, candidate) {
  validateJournal(journal);
  const original = clone(candidate); original.status = "ready"; delete original.adoptedAt;
  if (JSON.stringify(original) !== JSON.stringify(journal.candidate)
    || (candidate.status === "adopted" && journal.createdAt !== candidate.adoptedAt)) fail("invalid_markdown_adoption");
  return journal;
}

function assessSummary(root, candidate, { readBinary = (relative, maximum) => readSafeBinary(root, relative, maximum) } = {}) {
  const binding = candidate.markdownSource, target = candidate.target;
  let file;
  try { file = readBinary(target, 512 * 1024); }
  catch (error) {
    if (error.code === "metadata_budget_exceeded") throw error;
    return { candidate, binding, target, healthy: false, currentText: null, currentSha256: null,
      manual: null, reason: error.code === "ENOENT" ? "summary_missing" : "summary_unreadable" };
  }
  let currentText;
  try { currentText = new TextDecoder("utf-8", { fatal: true }).decode(file.buffer); }
  catch { return { candidate, binding, target, healthy: false, currentText: null, currentSha256: file.sha256, manual: null, reason: "summary_unreadable" }; }
  try {
    const manual = extractManual(currentText);
    if (stripManual(currentText) !== stripManual(candidate.content)) fail("managed_summary_changed");
    return { candidate, binding, target, healthy: true, currentText, currentSha256: file.sha256, manual };
  } catch {
    return { candidate, binding, target, healthy: false, currentText, currentSha256: file.sha256, manual: null, reason: "managed_summary_changed" };
  }
}

function readAdoptions(root, { maxMetadataBytes = MAX_METADATA_BYTES, sourceIds, records, readBinary } = {}) {
  const result = { sources: new Map(), candidates: [], pendingIds: new Set(), committedIds: new Set(), complete: true, warnings: [], metadataBytes: 0 };
  if (!Number.isSafeInteger(maxMetadataBytes) || maxMetadataBytes < 1 || maxMetadataBytes > MAX_WRITER_METADATA_BYTES) fail("invalid_limit");
  if (sourceIds !== undefined && ((!Array.isArray(sourceIds) && !(sourceIds instanceof Set))
    || sourceIds.size > 2000 || sourceIds.length > 2000 || [...sourceIds].some((id) => !SOURCE_ID.test(id)))) fail("invalid_source_id");
  // A supplied record view must share its caller's budgeted reader, so its lazy
  // journal reads and the summary reads below use one aggregate IO budget.
  if (records !== undefined && (typeof readBinary !== "function" || !records || !Array.isArray(records.candidates)
    || !Number.isSafeInteger(records.metadataBytes) || records.metadataBytes < 0
    || typeof records.readJournal !== "function")) fail("invalid_markdown_state");
  const selected = sourceIds === undefined ? null : new Set(sourceIds);
  const supplied = records !== undefined;
  let used = 0, summaryBytes = 0;
  const bytesRead = () => supplied ? records.metadataBytes + summaryBytes : used;
  const warn = (code, sourceId) => {
    result.complete = false;
    if (result.warnings.length < 40 && !result.warnings.some((item) => item.code === code && item.sourceId === sourceId)) {
      result.warnings.push({ code, ...(sourceId ? { sourceId } : {}) });
    }
  };
  const readBudgeted = (relative, maximum) => {
    const remaining = maxMetadataBytes - bytesRead();
    if (remaining < 1) fail("metadata_budget_exceeded");
    // Charge attempted reads too: a concurrently changing file must not bypass
    // the aggregate budget by failing its post-read identity check.
    const info = fs.lstatSync(checkedPath(root, relative));
    if (info.size > remaining) fail("metadata_budget_exceeded");
    if (info.size > maximum) fail("file_budget_exceeded");
    if (supplied) summaryBytes += info.size; else used += info.size;
    result.metadataBytes = bytesRead();
    return (readBinary || ((name, limit) => readSafeBinary(root, name, limit)))(relative, Math.min(maximum, remaining));
  };
  try {
    if (!records) records = require("./review-history").readReviewRecords(root, { maxMetadataBytes, readBinary: readBudgeted });
    if (!records.complete) {
      for (const item of records.warnings || []) warn(item.code || "invalid_markdown_adoption", item.sourceId);
      if (!(records.warnings || []).length) warn("invalid_markdown_adoption");
      result.metadataBytes = result.bytesRead = bytesRead();
      return result;
    }
  } catch (error) { warn(error.code || "invalid_markdown_adoption"); result.metadataBytes = result.bytesRead = bytesRead(); return result; }
  const candidates = records.candidates.map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) => candidate?.markdownSource !== undefined && (!selected || selected.has(candidate.markdownSource.sourceId)))
    .filter(({ candidate }) => candidate.status === "ready" || candidate.status === "adopted")
    .sort((a, b) => String(b.candidate.adoptedAt || b.candidate.createdAt).localeCompare(String(a.candidate.adoptedAt || a.candidate.createdAt)) || b.index - a.index)
    .map(({ candidate }) => candidate);
  const blocked = new Set();
  for (const candidate of candidates) {
    const id = candidate.markdownSource?.sourceId;
    try {
      validCandidate(candidate);
      result.candidates.push(candidate);
      // Retain identity metadata for history filtering, but older journals do
      // not establish the latest committed source and can consume a full store
      // snapshot each. Read them only while a source still needs its baseline.
      if (result.sources.has(id) || blocked.has(id)) continue;
      const journal = records.readJournal(candidate.id);
      if (candidate.status === "ready" && !journal) continue;
      validJournal(journal, candidate);
      if (!journal.committed) {
        result.pendingIds.add(candidate.id); warn("markdown_publication_pending", id); continue;
      }
      if (candidate.status !== "adopted" || !TIME.test(candidate.adoptedAt)) fail("invalid_markdown_adoption");
      result.committedIds.add(candidate.id);
      if (!result.sources.has(id)) result.sources.set(id, assessSummary(root, candidate, { readBinary: readBudgeted }));
    } catch (error) {
      // A corrupt latest adoption must not silently make an older revision the
      // current source. A valid pending publication can still expose its prior
      // committed baseline, with incomplete coverage as before.
      blocked.add(id);
      warn(error.code || "invalid_markdown_adoption", SOURCE_ID.test(id) ? id : undefined);
    }
  }
  result.metadataBytes = result.bytesRead = bytesRead();
  return result;
}

module.exports = { REGISTRY, MAX_STATE_BYTES, MAX_METADATA_BYTES, MAX_WRITER_METADATA_BYTES, SOURCE_ID, COLLECTION_ID,
  SUMMARY_START, SUMMARY_END, MANUAL_START, MANUAL_END, DEFAULT_MANUAL,
  readRegistry, validateRegistry, readAdoptions, candidateIdentity,
  buildBody, extractManual, stripManual, extractSummary, assessSummary };
