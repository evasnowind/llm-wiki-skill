"use strict";

// A leaf module: package IO and parsing must not depend on Review/retrieval.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { TextDecoder } = require("node:util");
const { parseWikilinks } = require("./wikilink-parser");
const { loadUnicode17CaseFolder } = require("./unicode-case-folding");

const DEFAULT_LIMITS = Object.freeze({ maxFiles: 256, maxEntries: 10000, maxDepth: 8,
  maxMarkdownBytes: 2 * 1024 * 1024, maxAssetBytes: 32 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024, maxLinks: 5000 });
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const SOURCE_ID = /^md-[a-f0-9]{24}$/u;
const REVISION = /^rev-[a-f0-9]{64}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const FORMAT = "llm-wiki-markdown-package";
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
const isMarkdown = (value) => /\.md$/iu.test(value);
const folded = (value) => loadUnicode17CaseFolder()(value);
function fail(code) { const error = new Error(code); error.code = code; throw error; }

function validateRelativePath(value) {
  if (typeof value !== "string" || !value || value.length > 2048 || /^[\/\\]/u.test(value)
    || /[\\:<>"|?*\x00-\x1f\x7f]/u.test(value)
    || value.split("/").some((part) => !part || part === "." || part === ".."
      || /[. ]$/u.test(part) || /^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part))) fail("unsafe_path");
  return value;
}

function validateSourceRoot(value) {
  if (typeof value !== "string" || !value) fail("invalid_source_root");
  try {
    const absolute = path.resolve(value);
    const info = fs.lstatSync(absolute);
    if (!info.isDirectory() || info.isSymbolicLink()) fail("invalid_source_root");
    return fs.realpathSync(absolute);
  } catch { fail("invalid_source_root"); }
}

function checkedPath(root, relative, { parents = false } = {}) {
  validateRelativePath(relative);
  let cursor = root;
  const parts = relative.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    cursor = path.join(cursor, parts[index]);
    let info;
    try { info = fs.lstatSync(cursor); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (!parents || index === parts.length - 1) return path.join(root, ...parts);
      fs.mkdirSync(cursor); info = fs.lstatSync(cursor);
    }
    if (info.isSymbolicLink()) fail("symlink_refused");
    if (index < parts.length - 1 && !info.isDirectory()) fail("invalid_parent");
    if (fs.realpathSync(cursor) !== cursor) fail("unsafe_path");
  }
  return path.join(root, ...parts);
}

function readSafeBinary(root, relative, maxBytes = DEFAULT_LIMITS.maxAssetBytes) {
  const target = checkedPath(root, relative);
  const descriptor = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const before = fs.fstatSync(descriptor);
    const check = () => {
      checkedPath(root, relative);
      const current = fs.lstatSync(target);
      if (!current.isFile() || current.dev !== before.dev || current.ino !== before.ino) fail("source_changed");
    };
    if (!before.isFile()) fail("not_regular_file");
    check();
    if (before.size > maxBytes) fail("file_budget_exceeded");
    const data = Buffer.alloc(Math.min(before.size + 1, maxBytes + 1));
    let count = 0;
    while (count < data.length) {
      const read = fs.readSync(descriptor, data, count, data.length - count, null);
      if (!read) break;
      count += read;
    }
    const after = fs.fstatSync(descriptor); check();
    if (count !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) fail("source_changed");
    const buffer = data.subarray(0, count);
    return { buffer, sha256: sha256(buffer), size: count };
  } finally { fs.closeSync(descriptor); }
}

function decode(data) { try { return decoder.decode(data); } catch { fail("invalid_utf8"); } }
function readSafeJson(root, relative, maximum = MAX_MANIFEST_BYTES) {
  try { return JSON.parse(decode(readSafeBinary(root, relative, maximum).buffer)); }
  catch (error) { if (error.code) throw error; fail("invalid_manifest"); }
}
function limitsFor(options = {}) {
  const values = { ...DEFAULT_LIMITS };
  for (const [key, value] of Object.entries(options)) {
    if (!(key in values) || !Number.isSafeInteger(value) || value < 1 || value > values[key]) fail("invalid_limit");
    values[key] = value;
  }
  return values;
}

// Preserve character positions for the inline parser, and original byte
// positions for the shared Wiki parser. No excluded text can become a resource.
function visibleBody(text) {
  const intervals = [];
  const lines = text.match(/[^\n]*\n|[^\n]+$/gu) || [];
  let offset = 0, fence = null, frontmatter = false, frontmatterClosed = false;
  let previousBlank = true, indented = false, inList = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index], clean = line.replace(/\r?\n$/u, "");
    let containerText = clean, quoteDepth = 0;
    for (let quote; (quote = /^ {0,3}>[ \t]?/u.exec(containerText));) {
      quoteDepth += 1; containerText = containerText.slice(quote[0].length);
    }
    const list = /^ {0,3}(?:[-+*]|\d+[.)])[ \t]+/u.exec(containerText);
    const indentationLength = (containerText.match(/^ */u) || [""])[0].length;
    if (fence && (quoteDepth < fence.quoteDepth || (fence.listIndent && containerText.trim() && indentationLength < fence.listIndent))) fence = null;
    if (index === 0 && clean.replace(/^\uFEFF/u, "") === "---") frontmatter = true;
    let excluded = false;
    if (frontmatter && !frontmatterClosed) {
      excluded = true;
      if (index > 0 && /^(---|\.\.\.)$/u.test(clean)) frontmatterClosed = true;
    } else {
      const listIndent = list ? list[0].length : (inList && indentationLength ? indentationLength : 0);
      const fenceText = fence?.listIndent ? containerText.slice(fence.listIndent)
        : list ? containerText.slice(list[0].length) : listIndent ? containerText.slice(listIndent) : containerText;
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(fenceText);
      if (fence) {
        excluded = true;
        if (marker && quoteDepth === fence.quoteDepth && marker[1][0] === fence.marker[0] && marker[1].length >= fence.marker.length && !marker[2].trim()) fence = null;
      } else if (marker && !(marker[1][0] === "`" && marker[2].includes("`"))) {
        excluded = true; fence = { marker: marker[1], quoteDepth, listIndent };
      } else {
        if (/^ {0,3}(?:[-+*]|\d+[.)])\s/u.test(clean)) inList = true;
        else if (/^\S/u.test(clean)) inList = false;
        const indentation = /^(?: {4}|\t)/u.test(clean);
        if (!inList && indentation && (indented || previousBlank)) { excluded = true; indented = true; }
        else if (clean.trim()) indented = false;
      }
    }
    if (excluded) intervals.push([offset, offset + line.length]);
    previousBlank = !clean.trim(); offset += line.length;
  }
  if (frontmatter && !frontmatterClosed) fail("unclosed_frontmatter");
  // Replace runs with the same UTF-16 length, including astral characters.
  const chars = text.split("");
  for (const [start, end] of intervals) for (let i = start; i < end; i += 1) if (chars[i] !== "\r" && chars[i] !== "\n") chars[i] = " ";
  let visible = chars.join("");
  const runs = [], byLength = new Map();
  for (let index = 0; index < visible.length;) {
    if (visible[index] !== "`") { index += 1; continue; }
    let length = 1; while (visible[index + length] === "`") length += 1;
    const positions = byLength.get(length) || [];
    runs.push({ start: index, length, ordinal: positions.length }); positions.push(index); byLength.set(length, positions);
    index += length;
  }
  let skipUntil = 0;
  for (const run of runs) {
    if (run.start < skipUntil) continue;
    const closer = byLength.get(run.length)[run.ordinal + 1];
    if (closer === undefined) continue;
    for (let i = run.start; i < closer + run.length; i += 1) if (chars[i] !== "\r" && chars[i] !== "\n") chars[i] = " ";
    skipUntil = closer + run.length;
  }
  visible = chars.join("");
  const maskedBytes = Buffer.from(text, "utf8");
  let byteOffset = 0;
  for (let index = 0; index < text.length;) {
    const length = String.fromCodePoint(text.codePointAt(index)).length;
    const bytes = Buffer.byteLength(text.slice(index, index + length));
    if (visible.slice(index, index + length) !== text.slice(index, index + length)) {
      maskedBytes.fill(32, byteOffset, byteOffset + bytes);
    }
    index += length; byteOffset += bytes;
  }
  return { visible, maskedBytes };
}

function escaped(text, index) {
  let count = 0; for (let i = index - 1; i >= 0 && text[i] === "\\"; i -= 1) count += 1;
  return count % 2 === 1;
}
function destination(text, start, inline) {
  let cursor = start; while (/[ \t\r\n]/u.test(text[cursor] || "") && cursor < text.length) cursor += 1;
  let from = cursor, to;
  if (text[cursor] === "<") {
    from = ++cursor;
    while (cursor < text.length && !(text[cursor] === ">" && !escaped(text, cursor)) && text[cursor] !== "\n") cursor += 1;
    if (text[cursor] !== ">") return null;
    to = cursor++;
  } else {
    let depth = 0;
    while (cursor < text.length) {
      const char = text[cursor];
      if (char === "\\" && cursor + 1 < text.length) { cursor += 2; continue; }
      if (char === "(") depth += 1;
      if (char === ")") { if (!depth) break; depth -= 1; }
      if (/\s/u.test(char) && !depth) break;
      cursor += 1;
    }
    if (depth) return null;
    to = cursor;
  }
  if (!inline) return from < to ? { start: from, end: to } : null;
  while (/[ \t\r\n]/u.test(text[cursor] || "") && cursor < text.length) cursor += 1;
  if (["\"", "'", "("].includes(text[cursor])) {
    const closer = text[cursor] === "(" ? ")" : text[cursor]; cursor += 1;
    while (cursor < text.length && !(text[cursor] === closer && !escaped(text, cursor))) cursor += 1;
    if (text[cursor] !== closer) return null;
    cursor += 1;
    while (/[ \t\r\n]/u.test(text[cursor] || "") && cursor < text.length) cursor += 1;
  }
  return text[cursor] === ")" ? { start: from, end: to, endSyntax: cursor + 1 } : null;
}
const referenceLabel = (value) => value.trim().replace(/\s+/gu, " ").toLowerCase();

function htmlResources(visible) {
  const tags = [];
  const pattern = /<(img|a)(?=[\s/>])/giu;
  for (let match; (match = pattern.exec(visible));) {
    const start = match.index, tag = match[1].toLowerCase(), attributes = [];
    let cursor = start + match[0].length, valid = true, ended = false;
    const limit = Math.min(visible.length, start + 4096);
    while (cursor < limit) {
      while (/\s/u.test(visible[cursor] || "") && cursor < limit) cursor += 1;
      if (visible[cursor] === ">" || visible.slice(cursor, cursor + 2) === "/>") {
        cursor += visible[cursor] === ">" ? 1 : 2; ended = true; break;
      }
      const from = cursor;
      while (cursor < limit && !/[\s"'<>/=]/u.test(visible[cursor])) cursor += 1;
      if (cursor === from) { valid = false; break; }
      const name = visible.slice(from, cursor).toLowerCase();
      while (/\s/u.test(visible[cursor] || "") && cursor < limit) cursor += 1;
      if (visible[cursor] !== "=") { attributes.push({ name, value: null }); continue; }
      cursor += 1;
      while (/\s/u.test(visible[cursor] || "") && cursor < limit) cursor += 1;
      let valueStart, valueEnd;
      if (visible[cursor] === "\"" || visible[cursor] === "'") {
        const quote = visible[cursor++]; valueStart = cursor;
        while (cursor < limit && visible[cursor] !== quote) cursor += 1;
        if (visible[cursor] !== quote) { valid = false; break; }
        valueEnd = cursor++;
      } else {
        valueStart = cursor;
        while (cursor < limit && !/[\s>]/u.test(visible[cursor])) cursor += 1;
        valueEnd = cursor;
      }
      attributes.push({ name, value: visible.slice(valueStart, valueEnd), start: valueStart, end: valueEnd });
    }
    tags.push({ start, end: cursor, tag, attributes, valid: valid && ended });
    pattern.lastIndex = Math.max(cursor, match.index + match[0].length);
  }
  return tags;
}

function parseReferences(text, source, maxLinks = DEFAULT_LIMITS.maxLinks) {
  const { visible, maskedBytes } = visibleBody(text);
  let delimiters = 0;
  for (const character of visible) if ((character === "[" || character === "<") && ++delimiters > maxLinks * 4) fail("link_budget_exceeded");
  const references = [], reasons = [];
  const wiki = parseWikilinks(maskedBytes, source).occurrences;
  const ignore = [];
  const positions = new Set(wiki.flatMap((item) => [item.start_byte, item.end_byte]));
  const characterPositions = new Map();
  let bytes = 0;
  for (let index = 0; index <= text.length;) {
    if (positions.has(bytes)) characterPositions.set(bytes, index);
    if (index === text.length) break;
    const length = String.fromCodePoint(text.codePointAt(index)).length;
    bytes += Buffer.byteLength(text.slice(index, index + length)); index += length;
  }
  for (const occurrence of wiki) {
    const start = characterPositions.get(occurrence.start_byte);
    const end = characterPositions.get(occurrence.end_byte);
    ignore.push([start, end]);
    if (occurrence.pending || occurrence.link_kind === "same_page_anchor") continue;
    const targetStart = start + occurrence.target_start_in_raw;
    references.push({ source, kind: "wiki", raw: text.slice(targetStart, start + occurrence.target_end_in_raw),
      start: targetStart, end: start + occurrence.target_end_in_raw, fragment: occurrence.anchor ? `#${occurrence.anchor}` : "", wiki: true });
  }
  const definitions = new Map();
  const definitionRanges = [];
  const definitionPattern = /^ {0,3}\[([^\]\n]+)\]:[ \t]*/gmu;
  for (const match of visible.matchAll(definitionPattern)) {
    if (match[1].startsWith("^")) continue;
    const value = destination(visible, match.index + match[0].length, false);
    const lineEnd = visible.indexOf("\n", match.index);
    definitionRanges.push([match.index, lineEnd < 0 ? visible.length : lineEnd]);
    if (value && !definitions.has(referenceLabel(match[1]))) definitions.set(referenceLabel(match[1]), value);
  }
  const html = htmlResources(visible);
  const ignoredRanges = [...ignore, ...definitionRanges, ...html.map((item) => [item.start, item.end])].sort((a, b) => a[0] - b[0]);
  let ignoredCursor = 0;
  const hidden = (index) => {
    while (ignoredCursor < ignoredRanges.length && ignoredRanges[ignoredCursor][1] <= index) ignoredCursor += 1;
    return ignoredCursor < ignoredRanges.length && index >= ignoredRanges[ignoredCursor][0];
  };
  const pairs = new Map(), stack = [];
  for (let index = 0; index < visible.length; index += 1) {
    if (visible[index] !== "[" && visible[index] !== "]") continue;
    if (escaped(visible, index)) continue;
    if (visible[index] === "[") stack.push(index);
    else if (visible[index] === "]" && stack.length) pairs.set(stack.pop(), index);
  }
  const usedDefinitions = new Set();
  const scanInline = (from, until, depth = 0) => {
    if (depth > 32) { reasons.push({ code: "link_nesting_exceeded", source }); return; }
    for (let index = from; index < until; index += 1) {
    if (visible[index] !== "[" || escaped(visible, index) || hidden(index)) continue;
    const close = pairs.get(index);
    if (close === undefined || close >= until) continue;
    const kind = index > 0 && visible[index - 1] === "!" && !escaped(visible, index - 1) ? "markdown-image" : "markdown-link";
    scanInline(index + 1, close, depth + 1);
    if (visible[close + 1] === "(") {
      const value = destination(visible, close + 2, true);
      if (!value) { reasons.push({ code: "unsupported_link_syntax", source }); continue; }
      references.push({ source, kind, raw: text.slice(value.start, value.end), start: value.start, end: value.end, fragment: "", wiki: false });
      index = value.endSyntax - 1; continue;
    }
    let label = visible.slice(index + 1, close), end = close;
    if (visible[close + 1] === "[") {
      const second = pairs.get(close + 1);
      if (second === undefined) continue;
      label = visible.slice(close + 2, second) || label; end = second;
    }
    const key = referenceLabel(label), value = definitions.get(key);
    if (value && !usedDefinitions.has(key)) {
      usedDefinitions.add(key);
      references.push({ source, kind, raw: text.slice(value.start, value.end), start: value.start, end: value.end, fragment: "", wiki: false });
    }
    index = end;
    }
  };
  scanInline(0, visible.length);
  // Attribute names and value spans are quote-aware, not suffix/substring matches.
  for (const tag of html) {
    const selected = tag.attributes.filter((attr) => attr.name === (tag.tag === "img" ? "src" : "href"));
    if (tag.valid && tag.tag === "a" && selected.length === 0) continue;
    if (!tag.valid || selected.length !== 1 || selected[0].value === null || tag.attributes.some((attr) => attr.name === "srcset")) {
      reasons.push({ code: "unsupported_html_resource", source }); continue;
    }
    const attr = selected[0];
    references.push({ source, kind: "html", raw: text.slice(attr.start, attr.end), start: attr.start, end: attr.end, fragment: "", wiki: false });
  }
  return { references, reasons };
}

function decodeTarget(value) {
  const unescaped = value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/gu, "$1")
    .replace(/&amp;/giu, "&").replace(/&quot;/giu, "\"").replace(/&#39;|&apos;/giu, "'");
  try { return decodeURIComponent(unescaped); } catch { fail("invalid_link_encoding"); }
}
function normalizedRelative(base, target) {
  if (/^[\/\\]/u.test(target) || /[\\:\x00-\x1f\x7f]/u.test(target)) fail("outside_source_root");
  const relative = path.posix.normalize(path.posix.join(base, target));
  if (relative === ".." || relative.startsWith("../")) fail("outside_source_root");
  return validateRelativePath(relative);
}

function inspectPackage(sourceRoot, entryRelative, options = {}) {
  const root = validateSourceRoot(sourceRoot), limits = limitsFor(options.limits);
  validateRelativePath(entryRelative);
  if (!isMarkdown(entryRelative)) fail("markdown_required");
  const files = new Map(), buffers = new Map(), links = [], externalReferences = [], reasons = [];
  const directories = new Map(); let entriesRead = 0, totalBytes = 0, indexed = null;
  const warning = (code, source, raw) => { if (reasons.length < 100) reasons.push({ code, ...(source ? { source } : {}), ...(raw ? { raw: raw.slice(0, 500) } : {}) }); };
  const directory = (relative) => {
    if (directories.has(relative)) return directories.get(relative);
    const target = relative ? checkedPath(root, relative) : root;
    const items = []; const handle = fs.opendirSync(target);
    try {
      for (let item; (item = handle.readSync());) {
        if (++entriesRead > limits.maxEntries) fail("entry_budget_exceeded");
        items.push(item);
      }
    } finally { handle.closeSync(); }
    items.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    directories.set(relative, items); return items;
  };
  const canonical = (relative) => {
    let parent = "";
    for (const component of relative.split("/")) {
      const matches = directory(parent).filter((item) => folded(item.name) === folded(component));
      if (matches.length > 1) fail("portable_path_collision");
      if (!matches.length) fail("missing_resource");
      if (matches[0].isSymbolicLink()) fail("symlink_refused");
      parent = parent ? `${parent}/${matches[0].name}` : matches[0].name;
      validateRelativePath(parent);
    }
    checkedPath(root, parent); return parent;
  };
  const indexFiles = () => {
    if (indexed) return indexed;
    indexed = [];
    const walk = (relative, depth) => {
      if (depth > 24) fail("directory_depth_exceeded");
      for (const item of directory(relative)) {
        if (item.name.startsWith(".") || item.name === "node_modules") continue;
        const child = relative ? `${relative}/${item.name}` : item.name;
        if (item.isDirectory()) walk(child, depth + 1);
        else if (item.isFile() || item.isSymbolicLink()) indexed.push(child);
      }
    };
    walk("", 0); return indexed;
  };
  const resolveReference = (reference) => {
    const raw = reference.raw.trim();
    if (!raw || raw.startsWith("#")) return { ...reference, status: "anchor", target: null };
    if (/^[a-z][a-z0-9+.-]*:/iu.test(raw)) {
      if (/^[a-z]:/iu.test(raw) || /^file:/iu.test(raw)) fail("outside_source_root");
      externalReferences.push({ source: reference.source, target: raw });
      return { ...reference, status: "external", target: null };
    }
    const boundary = reference.wiki ? -1 : raw.search(/[?#]/u);
    const suffix = boundary < 0 ? reference.fragment : raw.slice(boundary);
    const resource = boundary < 0 ? raw : raw.slice(0, boundary);
    const decoded = decodeTarget(resource);
    if (!decoded) return { ...reference, status: "anchor", target: null };
    let candidate;
    if (reference.wiki && !decoded.includes("/")) {
      const key = folded(decoded), withoutExtension = !path.posix.extname(decoded);
      const matches = indexFiles().filter((item) => {
        const basename = path.posix.basename(item);
        return folded(basename) === key || (withoutExtension && isMarkdown(item) && folded(basename.replace(/\.md$/iu, "")) === key);
      });
      if (matches.length > 1) fail("ambiguous_resource");
      if (!matches.length) fail("missing_resource");
      candidate = matches[0];
    } else candidate = normalizedRelative(reference.wiki && !/^\.\.?\//u.test(decoded) ? "" : path.posix.dirname(reference.source), decoded);
    const target = canonical(candidate);
    if (reference.wiki && /[\[\]#|]/u.test(target)) fail("unsupported_wiki_target");
    return { ...reference, status: "resolved", target, fragment: suffix || "" };
  };
  let entry, entryUnavailable = false;
  try { entry = canonical(entryRelative); }
  catch (error) {
    if (error.code !== "entry_budget_exceeded") fail(error.code || "unreadable_source");
    entry = entryRelative; entryUnavailable = true; warning(error.code, entry);
  }
  const visit = (relative, depth) => {
    if (files.has(relative)) return;
    if (depth > limits.maxDepth) { warning("dependency_depth_exceeded", relative); return; }
    if (files.size >= limits.maxFiles) { warning("file_count_budget_exceeded", relative); return; }
    try {
      const kind = isMarkdown(relative) ? "markdown" : "asset";
      const file = readSafeBinary(root, relative, Math.min(kind === "markdown" ? limits.maxMarkdownBytes : limits.maxAssetBytes, limits.maxTotalBytes - totalBytes));
      totalBytes += file.size;
      if (totalBytes > limits.maxTotalBytes) fail("total_budget_exceeded");
      files.set(relative, { path: relative, kind, size: file.size, sha256: file.sha256 }); buffers.set(relative, file.buffer);
      if (kind !== "markdown") return;
      const parsed = parseReferences(decode(file.buffer), relative, limits.maxLinks);
      for (const reason of parsed.reasons) warning(reason.code, relative);
      for (const reference of parsed.references) {
        if (links.length >= limits.maxLinks) { warning("link_budget_exceeded", relative); break; }
        try {
          const resolved = resolveReference(reference); links.push(resolved);
          if (resolved.status === "resolved") visit(resolved.target, depth + 1);
        } catch (error) {
          links.push({ ...reference, target: null, status: "unresolved", error: error.code || "unreadable_resource" });
          warning(error.code || "unreadable_resource", relative, reference.raw);
        }
      }
    } catch (error) { warning(error.code || "unreadable_resource", relative); }
  };
  if (!entryUnavailable) visit(entry, 0);
  const records = [...files.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const revision = `rev-${sha256(JSON.stringify({ version: 1, entry, files: records }))}`;
  const contentFingerprint = sha256(JSON.stringify({ primarySha256: files.get(entry)?.sha256 || null,
    dependencies: records.filter((item) => item.path !== entry).map((item) => ({ path: path.posix.relative(path.posix.dirname(entry), item.path), sha256: item.sha256 })) }));
  const result = { version: 1, entry, revision, contentFingerprint, files: records, links, externalReferences,
    coverage: { complete: reasons.length === 0, files: records.length, entries: entriesRead, totalBytes, reasons } };
  Object.defineProperties(result, { sourceRoot: { value: root }, limits: { value: limits }, buffers: { value: buffers } });
  return result;
}

function bindingFor(manifest, relative, manifestSha256) {
  const primary = manifest.files.find((item) => item.path === `files/${manifest.entry}`);
  return { version: 1, sourceId: manifest.sourceId, revision: manifest.revision,
    manifestPath: `${relative}/manifest.json`, manifestSha256,
    primaryPath: `${relative}/files/${manifest.entry}`, primarySha256: primary.sha256,
    readingPath: `${relative}/reading/${manifest.entry}`, contentFingerprint: manifest.contentFingerprint };
}
function validateBinding(binding) {
  if (!binding || binding.version !== 1 || !SOURCE_ID.test(binding.sourceId) || !REVISION.test(binding.revision)
    || !HASH.test(binding.manifestSha256) || !HASH.test(binding.primarySha256)) fail("invalid_binding");
  const base = `raw/markdown/${binding.sourceId}/${binding.revision}`;
  if (binding.manifestPath !== `${base}/manifest.json` || typeof binding.primaryPath !== "string" || !binding.primaryPath.startsWith(`${base}/files/`)) fail("invalid_binding");
  validateRelativePath(binding.primaryPath);
  if (binding.readingPath !== undefined && binding.readingPath !== `${base}/reading/${binding.primaryPath.slice(`${base}/files/`.length)}`) fail("invalid_binding");
  if (binding.contentFingerprint !== undefined && !HASH.test(binding.contentFingerprint)) fail("invalid_binding");
  return binding;
}
function renderReading(plan, sourceId, relative) {
  let text = decode(plan.buffers.get(relative));
  const base = `raw/markdown/${sourceId}/${plan.revision}`;
  const edits = new Map();
  for (const link of plan.links.filter((item) => item.source === relative && item.status === "resolved")) {
    const target = `${base}/${isMarkdown(link.target) ? "reading" : "files"}/${link.target}`;
    const replacement = link.wiki ? target : path.posix.relative(path.posix.dirname(`${base}/reading/${relative}`), target).split("/")
      .map((part) => encodeURIComponent(part).replace(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)).join("/");
    edits.set(`${link.start}:${link.end}`, { start: link.start, end: link.end, value: replacement + (link.wiki ? "" : link.fragment) });
  }
  for (const edit of [...edits.values()].sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.value + text.slice(edit.end);
  return Buffer.from(text, "utf8");
}
function syncDirectory(directory) {
  let fd; try { fd = fs.openSync(directory, "r"); fs.fsyncSync(fd); }
  catch (error) { if (!["EINVAL", "EPERM", "EISDIR", "EBADF", "ENOTSUP", "EACCES"].includes(error.code)) throw error; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function safeWrite(root, relative, data) {
  const target = checkedPath(root, relative, { parents: true });
  const fd = fs.openSync(target, "wx", 0o600);
  try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  checkedPath(root, relative); syncDirectory(path.dirname(target));
}

function capturePackage(kbRoot, sourceId, input) {
  const root = validateSourceRoot(kbRoot);
  readSafeBinary(root, ".wiki-schema.md", DEFAULT_LIMITS.maxMarkdownBytes);
  if (!SOURCE_ID.test(sourceId)) fail("invalid_source_id");
  const plan = input?.sourceRoot && input?.entry
    ? inspectPackage(input.sourceRoot, input.entry, { limits: input.limits })
    : inspectPackage(input?.sourceRoot, input?.entryRelative, { limits: input?.limits });
  if (input?.entry && input?.revision && JSON.stringify(plan) !== JSON.stringify(input)) fail("source_changed");
  if (!plan.coverage.complete) fail("incomplete_package");
  const common = path.relative(root, plan.sourceRoot);
  const reverse = path.relative(plan.sourceRoot, root);
  if (!common || (!common.startsWith(`..${path.sep}`) && common !== ".." && !path.isAbsolute(common))
    || (!reverse.startsWith(`..${path.sep}`) && reverse !== ".." && !path.isAbsolute(reverse))) fail("overlapping_roots");
  const relative = `raw/markdown/${sourceId}/${plan.revision}`;
  const contents = new Map(); const records = [];
  for (const file of plan.files) {
    contents.set(`files/${file.path}`, plan.buffers.get(file.path));
    records.push({ ...file, path: `files/${file.path}`, sourcePath: file.path });
    if (file.kind === "markdown") {
      const buffer = renderReading(plan, sourceId, file.path);
      contents.set(`reading/${file.path}`, buffer);
      records.push({ path: `reading/${file.path}`, sourcePath: file.path, kind: "reading", size: buffer.length, sha256: sha256(buffer) });
    }
  }
  records.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const manifest = { format: FORMAT, version: 1, sourceId, revision: plan.revision, entry: plan.entry,
    contentFingerprint: plan.contentFingerprint, files: records, links: plan.links, externalReferences: plan.externalReferences,
    coverage: { complete: true, files: plan.files.length, totalBytes: plan.coverage.totalBytes, reasons: [] } };
  const manifestBuffer = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  if (manifestBuffer.length > MAX_MANIFEST_BYTES) fail("manifest_budget_exceeded");
  const binding = bindingFor(manifest, relative, sha256(manifestBuffer));
  const final = checkedPath(root, relative, { parents: true });
  if (fs.existsSync(final)) {
    const verification = verifyPackage(root, binding);
    if (!verification.ok) fail("existing_package_changed");
    return binding;
  }
  const stagingRelative = `.wiki-tmp/markdown-${crypto.randomBytes(12).toString("hex")}`;
  const staging = checkedPath(root, stagingRelative, { parents: true }); fs.mkdirSync(staging);
  try {
    for (const [name, data] of contents) safeWrite(staging, name, data);
    safeWrite(staging, "manifest.json", manifestBuffer);
    const reread = inspectPackage(plan.sourceRoot, plan.entry, { limits: plan.limits });
    if (!reread.coverage.complete || JSON.stringify(reread) !== JSON.stringify(plan)) fail("source_changed");
    checkedPath(root, relative);
    fs.renameSync(staging, final); syncDirectory(path.dirname(final));
    const verified = verifyPackage(root, binding);
    if (!verified.ok) fail("package_verification_failed");
    return binding;
  } finally { if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true }); }
}

function validateManifest(manifest, binding) {
  validateBinding(binding);
  if (!manifest || manifest.format !== FORMAT || manifest.version !== 1 || manifest.sourceId !== binding.sourceId
    || manifest.revision !== binding.revision || !isMarkdown(manifest.entry) || !HASH.test(manifest.contentFingerprint)
    || !manifest.coverage || manifest.coverage.complete !== true || !Array.isArray(manifest.files)
    || manifest.files.length < 2 || manifest.files.length > DEFAULT_LIMITS.maxFiles * 2 || !Array.isArray(manifest.links)
    || manifest.links.length > DEFAULT_LIMITS.maxLinks) fail("invalid_manifest");
  validateRelativePath(manifest.entry);
  const originals = [], seen = new Set(), prefixes = new Map(); let total = 0;
  for (const item of manifest.files) {
    if (!item || !["markdown", "asset", "reading"].includes(item.kind) || !Number.isSafeInteger(item.size)
      || item.size < 0 || item.size > DEFAULT_LIMITS.maxAssetBytes * 2 || !HASH.test(item.sha256)) fail("invalid_manifest");
    validateRelativePath(item.path); validateRelativePath(item.sourcePath);
    const prefix = item.kind === "reading" ? "reading" : "files";
    if (item.path !== `${prefix}/${item.sourcePath}` || (item.kind !== "asset" && !isMarkdown(item.sourcePath))) fail("invalid_manifest");
    const key = folded(item.path);
    if (seen.has(key)) fail("portable_path_collision"); seen.add(key);
    const components = item.path.split("/");
    for (let length = 1; length <= components.length; length += 1) {
      const prefix = components.slice(0, length).join("/"), prefixKey = folded(prefix);
      if (prefixes.has(prefixKey) && prefixes.get(prefixKey) !== prefix) fail("portable_path_collision");
      prefixes.set(prefixKey, prefix);
    }
    total += item.size;
    if (total > DEFAULT_LIMITS.maxTotalBytes * 2 + MAX_MANIFEST_BYTES) fail("total_budget_exceeded");
    if (item.kind !== "reading") originals.push({ path: item.sourcePath, kind: item.kind, size: item.size, sha256: item.sha256 });
  }
  originals.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (manifest.revision !== `rev-${sha256(JSON.stringify({ version: 1, entry: manifest.entry, files: originals }))}`) fail("invalid_revision");
  const primary = originals.find((item) => item.path === manifest.entry && item.kind === "markdown");
  if (!primary || binding.primaryPath !== `${path.posix.dirname(binding.manifestPath)}/files/${manifest.entry}` || binding.primarySha256 !== primary.sha256
    || !manifest.files.some((item) => item.path === `reading/${manifest.entry}` && item.kind === "reading")) fail("invalid_binding");
  for (const original of originals.filter((item) => item.kind === "markdown")) if (!manifest.files.some((item) => item.path === `reading/${original.path}` && item.kind === "reading")) fail("invalid_manifest");
  const fingerprint = sha256(JSON.stringify({ primarySha256: primary.sha256,
    dependencies: originals.filter((item) => item.path !== manifest.entry).map((item) => ({ path: path.posix.relative(path.posix.dirname(manifest.entry), item.path), sha256: item.sha256 })) }));
  if (manifest.contentFingerprint !== fingerprint || (binding.contentFingerprint !== undefined && binding.contentFingerprint !== fingerprint)) fail("invalid_manifest");
  return manifest;
}

function verifyPackage(kbRoot, binding) {
  try {
    validateBinding(binding);
    const root = validateSourceRoot(kbRoot);
    const manifestFile = readSafeBinary(root, binding.manifestPath, MAX_MANIFEST_BYTES);
    if (manifestFile.sha256 !== binding.manifestSha256) fail("manifest_changed");
    const manifest = validateManifest(JSON.parse(decode(manifestFile.buffer)), binding);
    const base = path.posix.dirname(binding.manifestPath), expected = new Set(["manifest.json", ...manifest.files.map((item) => item.path)]);
    let entries = 0;
    const walk = (relative = "", depth = 0) => {
      if (depth > 32) fail("directory_depth_exceeded");
      const directory = checkedPath(root, relative ? `${base}/${relative}` : base);
      const handle = fs.opendirSync(directory);
      try { for (let item; (item = handle.readSync());) {
          if (++entries > DEFAULT_LIMITS.maxEntries) fail("entry_budget_exceeded");
          const child = relative ? `${relative}/${item.name}` : item.name;
          if (item.isSymbolicLink()) fail("symlink_refused");
          if (item.isDirectory()) {
            if (![...expected].some((name) => name.startsWith(`${child}/`))) fail("unexpected_package_file");
            walk(child, depth + 1);
          } else if (!item.isFile() || !expected.has(child)) fail("unexpected_package_file");
        }
      } finally { handle.closeSync(); }
    };
    walk();
    for (const item of manifest.files) {
      const file = readSafeBinary(root, `${base}/${item.path}`, Math.min(DEFAULT_LIMITS.maxAssetBytes * 2, item.size + 1));
      if (file.size !== item.size || file.sha256 !== item.sha256) fail("package_file_changed");
    }
    // Re-derive the closure and reading copies from verified originals. Hashes
    // in a rehashed manifest alone must not certify forged rewritten content.
    const snapshot = inspectPackage(checkedPath(root, `${base}/files`), manifest.entry);
    const originals = manifest.files.filter((item) => item.kind !== "reading").map((item) => ({ path: item.sourcePath, kind: item.kind, size: item.size, sha256: item.sha256 }))
      .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    if (!snapshot.coverage.complete || snapshot.revision !== manifest.revision || snapshot.contentFingerprint !== manifest.contentFingerprint
      || JSON.stringify(snapshot.files) !== JSON.stringify(originals) || JSON.stringify(snapshot.links) !== JSON.stringify(manifest.links)
      || JSON.stringify(snapshot.externalReferences) !== JSON.stringify(manifest.externalReferences)) fail("invalid_package_derivation");
    for (const item of manifest.files.filter((entry) => entry.kind === "reading")) {
      if (sha256(renderReading(snapshot, binding.sourceId, item.sourcePath)) !== item.sha256) fail("invalid_reading_copy");
    }
    return { ok: true, version: 1, manifest, binding };
  } catch (error) { return { ok: false, version: 1, errors: [{ code: error.code || "invalid_manifest" }] }; }
}

module.exports = { DEFAULT_LIMITS, MAX_MANIFEST_BYTES, FORMAT, SOURCE_ID, REVISION, HASH,
  sha256, validateRelativePath, validateSourceRoot, checkedPath, readSafeBinary, readSafeJson,
  inspectPackage, capturePackage, verifyPackage, validateBinding, validateManifest, parseReferences };
