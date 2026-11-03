"use strict";

// This module intentionally uses only Node built-ins and the standalone parser:
// installed Skills do not contain the workbench or its dependencies.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { TextDecoder } = require("node:util");
const { parseWikilinks } = require("./wikilink-parser");

const DEFAULT_LIMITS = Object.freeze({
  maxFiles: 1500, maxEntries: 10000, maxDepth: 24, maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024, maxEvidence: 50, maxOutputChars: 64000,
  maxPerFile: 3, maxExcerptLines: 16
});
const MAX_PACKET_BYTES = 2 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const fold = (value) => value.normalize("NFC").toLocaleLowerCase("en-US");
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function validateRelativePath(relative) {
  if (typeof relative !== "string" || !relative || relative.length > 2048
    || /[\\:\x00-\x1f\x7f]/.test(relative) || relative.startsWith("/")
    || relative.split("/").some((part) => !part || part === "." || part === "..")) fail("unsafe_path");
  return relative;
}

function validateRoot(kbRoot) {
  if (typeof kbRoot !== "string" || !kbRoot) fail("invalid_root");
  const root = path.resolve(kbRoot);
  try {
    const stat = fs.lstatSync(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail("invalid_root");
    const real = fs.realpathSync(root);
    safeReadFile(real, ".wiki-schema.md", DEFAULT_LIMITS.maxFileBytes);
    return real;
  } catch (error) {
    if (error.code === "invalid_root") throw error;
    fail("invalid_schema_or_root");
  }
}

function safeReadFile(root, relative, maxBytes = DEFAULT_LIMITS.maxFileBytes) {
  validateRelativePath(relative);
  const current = path.join(root, ...relative.split("/"));
  const checkPath = (openedStat) => {
    let component = root;
    for (const part of relative.split("/")) {
      component = path.join(component, part);
      const stat = fs.lstatSync(component);
      if (stat.isSymbolicLink()) fail("symlink_refused");
    }
    if (fs.realpathSync(current) !== current) fail("unsafe_path");
    if (openedStat) {
      const liveStat = fs.lstatSync(current);
      if (!liveStat.isFile() || liveStat.dev !== openedStat.dev || liveStat.ino !== openedStat.ino) fail("file_changed_during_read");
    }
  };
  checkPath();
  const fd = fs.openSync(current, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) fail("not_regular_file");
    checkPath(stat);
    if (stat.size > maxBytes) fail("file_too_large");
    // A bounded read also handles a file that grows after fstat.
    const buffer = Buffer.alloc(Math.min(stat.size + 1, maxBytes + 1));
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = fs.readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (!count) break;
      bytes += count;
    }
    if (bytes > stat.size || bytes > maxBytes) fail("file_changed_during_read");
    const end = fs.fstatSync(fd);
    if (end.size !== stat.size || end.mtimeMs !== stat.mtimeMs || bytes !== stat.size) fail("file_changed_during_read");
    checkPath(end);
    const data = buffer.subarray(0, bytes);
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data); }
    catch { fail("invalid_utf8"); }
    return { buffer: data, text, sha256: sha256(data) };
  } finally { fs.closeSync(fd); }
}

function checkedLimits(options = {}) {
  const limits = { ...DEFAULT_LIMITS };
  for (const [name, value] of Object.entries(options)) {
    if (!(name in limits) || !Number.isSafeInteger(value) || value < 1 || value > DEFAULT_LIMITS[name]) fail("invalid_limit");
    limits[name] = value;
  }
  if (limits.maxOutputChars < 4096) fail("invalid_limit");
  return limits;
}

function termsForQuery(query, schema) {
  const tokens = query.match(/"[^"]+"|\S+/gu).map((token) => fold(token.replace(/^"|"$/g, "")));
  const original = new Set(tokens);
  const groups = [];
  let inAliases = false;
  for (const line of schema.replace(/^\uFEFF/, "").split(/\r?\n/u)) {
    if (/^#{1,6}\s/u.test(line)) {
      inAliases = /别名词表|alias table/iu.test(line);
      continue;
    }
    if (!inAliases || !line.includes("=") || /^\s*[-*]/u.test(line)) continue;
    const aliases = [...new Set(line.split("=").map((term) => fold(term.trim())).filter(Boolean))];
    if (aliases.length < 2 || aliases.length > 12 || aliases.some((term) => term.length > 200)) continue;
    // Only the original terms trigger a group. An expanded alias cannot trigger
    // a second group, even if both declarations happen to share one term.
    if (aliases.some((term) => original.has(term) || fold(query) === term)) groups.push(aliases);
  }
  const grouped = new Set(groups.flat());
  for (const token of tokens) if (!grouped.has(token)) groups.push([token]);
  return groups;
}

function parseDocument(text) {
  const lines = text.split("\n");
  if (lines.length > 100000) fail("document_too_complex");
  const clean = (index) => {
    const line = lines[index].replace(/\r$/u, "");
    return index === 0 ? line.replace(/^\uFEFF/u, "") : line;
  };
  let bodyStart = 0;
  let metadata = "";
  if (clean(0).replace(/^\uFEFF/u, "") === "---") {
    const close = lines.findIndex((_, index) => index > 0 && /^(---|\.\.\.)$/u.test(clean(index)));
    if (close === -1) fail("malformed_frontmatter");
    metadata = lines.slice(1, close).join("\n");
    bodyStart = close + 1;
  }
  const sections = [];
  const heading = [];
  let sectionStart = bodyStart;
  let sectionHeading = [];
  let fence = null;
  for (let index = bodyStart; index < lines.length; index += 1) {
    const line = clean(index);
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (marker) {
      if (!fence) fence = { char: marker[1][0], length: marker[1].length };
      else if (marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      continue;
    }
    if (fence) continue;
    const match = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line);
    if (!match) continue;
    if (index > sectionStart) sections.push({ start: sectionStart, end: index - 1, heading: sectionHeading });
    if (sections.length > 10000) fail("document_too_complex");
    heading.length = match[1].length - 1;
    heading[match[1].length - 1] = match[2];
    sectionStart = index;
    sectionHeading = heading.filter(Boolean);
  }
  if (sectionStart < lines.length) sections.push({ start: sectionStart, end: lines.length - 1, heading: sectionHeading });
  const rankMetadata = metadata.split("\n").filter((line) => /^\s*(title|tags)\s*:/iu.test(line)).join("\n");
  return { lines, bodyStart, sections, metadata: rankMetadata, derived: /^derived\s*:\s*true\s*$/imu.test(metadata) };
}

function matches(value, term) {
  const index = value.indexOf(term);
  if (index < 0) return false;
  if (!/^[a-z0-9_-]+$/u.test(term)) return true;
  let cursor = index;
  while (cursor >= 0) {
    if (!/[a-z0-9_]/u.test(value[cursor - 1] || "") && !/[a-z0-9_]/u.test(value[cursor + term.length] || "")) return true;
    cursor = value.indexOf(term, cursor + 1);
  }
  return false;
}

function groupHits(value, groups) {
  const lower = fold(value);
  return groups.filter((group) => group.some((term) => matches(lower, term))).length;
}

function scan(root, mode, limits, coverage) {
  const files = [];
  let stopped = false;
  const warn = (code, relative) => {
    coverage.complete = false;
    if (coverage.reasons.length < Math.min(40, Math.floor(limits.maxOutputChars / 512)) && !coverage.reasons.some((reason) => reason.code === code && reason.path === relative)) {
      coverage.reasons.push({ code, ...(relative ? { path: relative.slice(0, 160) } : {}) });
    }
  };
  const walk = (relative, depth) => {
    if (stopped) return;
    if (depth > limits.maxDepth) { warn("depth_limit", relative); return; }
    let directory;
    try {
      const stat = fs.lstatSync(path.join(root, relative));
      if (stat.isSymbolicLink()) { warn("symlink_refused", relative); return; }
      if (!stat.isDirectory()) { warn("not_directory", relative); return; }
      directory = fs.opendirSync(path.join(root, relative));
      const entries = [];
      try {
        for (let item; (item = directory.readSync());) {
          coverage.entriesScanned += 1;
          if (coverage.entriesScanned > limits.maxEntries) { warn("entry_limit"); stopped = true; break; }
          entries.push(item);
        }
      } finally { directory.closeSync(); }
      entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      for (const item of entries) {
        if (stopped) break;
        if (item.name.startsWith(".") || item.name === "node_modules") continue;
        const child = `${relative}/${item.name}`;
        try { validateRelativePath(child); } catch { warn("unsafe_path"); continue; }
        if (item.isSymbolicLink()) { warn("symlink_refused", child); continue; }
        if (item.isDirectory()) walk(child, depth + 1);
        else if (item.isFile() && (mode === "wiki" ? /\.md$/iu : /\.(md|txt)$/iu).test(item.name)) {
          if (coverage.filesScanned >= limits.maxFiles) { warn("file_limit"); stopped = true; break; }
          coverage.filesScanned += 1;
          try {
            const remaining = limits.maxTotalBytes - coverage.bytesRead;
            if (remaining <= 0) { warn("total_byte_limit"); stopped = true; break; }
            const size = fs.lstatSync(path.join(root, child)).size;
            if (size > limits.maxFileBytes || size > remaining) { warn("file_or_byte_limit", child); continue; }
            // Count attempted reads too: invalid UTF-8 must not bypass the budget.
            coverage.bytesRead += size;
            const file = safeReadFile(root, child, Math.min(limits.maxFileBytes, remaining));
            const document = parseDocument(file.text);
            if (mode === "raw" && document.derived) { warn("derived_raw_excluded", child); continue; }
            files.push({ path: child, ...file, document });
          } catch (error) { warn(error.code === "file_too_large" ? "file_or_byte_limit" : (error.code || "unreadable_file"), child); }
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") warn("unreadable_directory", relative);
    }
  };
  walk(mode, 0);
  return { files, warn };
}

function search(kbRoot, options = {}) {
  const root = validateRoot(kbRoot);
  const mode = options.mode || "wiki";
  const query = options.query;
  if (mode !== "wiki" && mode !== "raw") fail("invalid_mode");
  if (typeof query !== "string" || !query.trim() || query.length > 1024) fail("invalid_query");
  const limits = checkedLimits(options.limits);
  const schema = safeReadFile(root, ".wiki-schema.md", limits.maxFileBytes);
  const groups = termsForQuery(query.trim(), schema.text);
  const coverage = { complete: true, filesScanned: 0, entriesScanned: 0, bytesRead: 0, reasons: [] };
  const { files, warn } = scan(root, mode, limits, coverage);
  const packet = { version: 1, mode, query, coverage, evidence: [] };
  for (const file of files) {
    const body = file.document.lines.slice(file.document.bodyStart).join("\n");
    const filename = path.posix.basename(file.path).replace(/\.(md|txt)$/iu, "");
    const titleHits = groupHits(filename, groups);
    const metadataHits = groupHits(file.document.metadata, groups);
    const bodyHits = groupHits(body, groups);
    file.score = titleHits * 12 + metadataHits * 8 + bodyHits * 4;
    file.reasons = [titleHits && "filename", metadataHits && "metadata", bodyHits && "body"].filter(Boolean);
  }
  // One-hop is evaluated from the initial direct hits, never recursively. The
  // target set is exactly the selected corpus, so raw mode cannot borrow wiki.
  const targets = new Map();
  for (const file of files) {
    const key = fold(path.posix.basename(file.path).replace(/\.(md|txt)$/iu, ""));
    targets.set(key, [...(targets.get(key) || []), file]);
  }
  const byPath = new Map(files.map((file) => [file.path, file]));
  for (const file of files.filter((item) => item.score > 0)) {
    for (const link of parseWikilinks(file.buffer, file.path).occurrences) {
      if (link.line <= file.document.bodyStart || link.pending || link.link_kind === "attachment_wikilink" || !link.page_target) continue;
      let destination;
      if (link.page_target.includes("/") || /\.(md|txt)$/iu.test(link.page_target)) {
        destination = byPath.get(/\.(md|txt)$/iu.test(link.page_target) ? link.page_target : `${link.page_target}.md`);
      } else {
        const candidates = targets.get(fold(link.page_target)) || [];
        if (candidates.length === 1) destination = candidates[0];
      }
      if (destination && destination !== file && !destination.reasons.includes("one_hop")) {
        destination.score += 2;
        destination.reasons.push("one_hop");
      }
    }
  }
  const candidates = [];
  for (const file of files.filter((item) => item.score > 0)) {
    const sections = file.document.sections.map((section) => {
      const value = file.document.lines.slice(section.start, section.end + 1).join("\n");
      return { ...section, score: groupHits(value, groups) * 4 + groupHits(section.heading.join(" "), groups) * 6 };
    }).filter((section) => file.document.lines.slice(section.start, section.end + 1).some((line) => line.trim()));
    sections.sort((a, b) => b.score - a.score || a.start - b.start);
    const selected = sections.filter((section) => section.score > 0);
    const choices = (selected.length ? selected : sections.slice(0, 1)).slice(0, limits.maxPerFile);
    if (selected.length > limits.maxPerFile) warn("per_file_evidence_limit", file.path);
    for (const section of choices) {
      let start = section.start;
      const hit = file.document.lines.findIndex((line, index) => index >= section.start && index <= section.end && groupHits(line, groups));
      if (hit >= 0) start = Math.max(section.start, hit - 3);
      const end = Math.min(section.end, start + limits.maxExcerptLines - 1);
      const excerpt = file.document.lines.slice(start, end + 1).join("\n");
      const excerptSha256 = sha256(excerpt);
      candidates.push({
        id: `ev-${sha256(`${file.path}\0${file.sha256}\0${start + 1}\0${end + 1}\0${excerptSha256}`).slice(0, 24)}`,
        path: file.path, heading: section.heading, startLine: start + 1, endLine: end + 1,
        excerpt, fileSha256: file.sha256, excerptSha256,
        score: file.score + section.score, reasons: file.reasons
      });
    }
  }
  candidates.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : a.startLine - b.startLine));
  for (const evidence of candidates) {
    if (packet.evidence.length >= limits.maxEvidence) { warn("evidence_limit"); break; }
    packet.evidence.push(evidence);
    if (JSON.stringify(packet).length + 512 > limits.maxOutputChars) {
      packet.evidence.pop();
      warn("output_limit");
      break;
    }
  }
  return packet;
}

function verifyPacket(kbRoot, packet) {
  const root = validateRoot(kbRoot);
  const errors = [];
  const invalid = () => ({ ok: false, version: 1, checked: 0, errors: [{ code: "invalid_packet" }] });
  if (!packet || typeof packet !== "object" || packet.version !== 1 || !["wiki", "raw"].includes(packet.mode)
    || !Array.isArray(packet.evidence) || packet.evidence.length > DEFAULT_LIMITS.maxEvidence
    || Buffer.byteLength(JSON.stringify(packet)) > MAX_PACKET_BYTES) return invalid();
  const seen = new Set();
  let checked = 0;
  for (const evidence of packet.evidence) {
    let relative;
    try {
      if (!evidence || typeof evidence !== "object") fail("invalid_evidence");
      relative = validateRelativePath(evidence.path);
      if (!relative.startsWith(`${packet.mode}/`) || !(packet.mode === "wiki" ? /\.md$/iu : /\.(md|txt)$/iu).test(relative)) fail("wrong_corpus");
      if (!Number.isSafeInteger(evidence.startLine) || !Number.isSafeInteger(evidence.endLine)
        || evidence.startLine < 1 || evidence.endLine < evidence.startLine
        || typeof evidence.excerpt !== "string" || !HASH.test(evidence.fileSha256)
        || !HASH.test(evidence.excerptSha256) || !Array.isArray(evidence.heading)
        || evidence.heading.some((item) => typeof item !== "string")) fail("invalid_evidence");
      const file = safeReadFile(root, relative);
      if (file.sha256 !== evidence.fileSha256) fail("source_changed");
      const document = parseDocument(file.text);
      if (packet.mode === "raw" && document.derived) fail("derived_raw_excluded");
      const section = document.sections.find((item) => evidence.startLine - 1 >= item.start && evidence.endLine - 1 <= item.end);
      if (!section || JSON.stringify(section.heading) !== JSON.stringify(evidence.heading)) fail("invalid_location");
      const excerpt = document.lines.slice(evidence.startLine - 1, evidence.endLine).join("\n");
      if (excerpt !== evidence.excerpt || sha256(excerpt) !== evidence.excerptSha256) fail("excerpt_mismatch");
      const id = `ev-${sha256(`${relative}\0${file.sha256}\0${evidence.startLine}\0${evidence.endLine}\0${evidence.excerptSha256}`).slice(0, 24)}`;
      if (evidence.id !== id || seen.has(id)) fail("invalid_evidence_id");
      seen.add(id);
      checked += 1;
    } catch (error) {
      errors.push({ code: error.code || "unreadable_file", ...(relative ? { path: relative } : {}), ...(typeof evidence?.id === "string" ? { evidenceId: evidence.id } : {}) });
    }
  }
  return { ok: errors.length === 0, version: 1, checked, errors };
}

module.exports = { DEFAULT_LIMITS, MAX_PACKET_BYTES, sha256, validateRelativePath, validateRoot, safeReadFile, search, verifyPacket };
