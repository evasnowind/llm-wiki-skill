"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const pkg = require("./markdown-package");
const review = require("./skill-review");
const { validateRoot, search } = require("./skill-retrieval");
const { withLock, atomicWrite, json } = require("./skill-state-io");
const {
  REGISTRY, MAX_STATE_BYTES, MAX_WRITER_METADATA_BYTES, SOURCE_ID, COLLECTION_ID,
  readRegistry, validateRegistry, readAdoptions, buildBody, extractManual, stripManual,
} = require("./markdown-state");

const DEFAULT_SCAN_LIMITS = Object.freeze({ maxFiles: 1000, maxEntries: 10000, maxDepth: 24, maxTotalBytes: 128 * 1024 * 1024 });
function fail(code) { const error = new Error(code); error.code = code; throw error; }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function id(prefix) { return `${prefix}-${crypto.randomBytes(12).toString("hex")}`; }
function fingerprint(root) { return pkg.sha256(process.platform === "win32" ? root.toLowerCase() : root); }
function targetFor(sourceId) { return `wiki/sources/${sourceId}.md`; }

function checkedRoots(kbRoot, sourceRoot) {
  const root = validateRoot(kbRoot), source = pkg.validateSourceRoot(sourceRoot);
  const contains = (parent, child) => {
    const relative = path.relative(parent, child);
    return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  };
  if (contains(root, source) || contains(source, root)) fail("overlapping_roots");
  return { root, source };
}

function sourceFile(value) {
  if (typeof value !== "string") fail("invalid_arguments");
  // CLI callers on Windows can supply the native relative separator.
  const native = process.platform === "win32" ? value.replace(/\\/gu, "/") : value;
  if (native.startsWith("/") || /^[a-z]:/iu.test(native)) fail("unsafe_path");
  const relative = path.posix.normalize(native);
  pkg.validateRelativePath(relative);
  if (!/\.md$/iu.test(relative)) fail("not_markdown");
  return relative;
}

function chooseCollection(registry, root, collectionId) {
  if (collectionId !== undefined) {
    if (!COLLECTION_ID.test(collectionId)) fail("invalid_collection");
    const collection = registry.collections.find((item) => item.id === collectionId);
    if (!collection) fail("collection_not_found");
    return collection;
  }
  const matches = registry.collections.filter((item) => item.rootFingerprint === fingerprint(root));
  if (matches.length > 1) fail("collection_ambiguous");
  return matches[0] || null;
}

function assertNoPending(root) {
  return review.assertNoPending(root);
}

function inspect(input) {
  return pkg.inspectPackage(input.sourceRoot, sourceFile(input.file), { limits: input.limits });
}

function existsInput(root, relative) {
  try {
    const info = fs.lstatSync(pkg.checkedPath(root, relative));
    if (!info.isFile()) fail("not_regular_file");
    return true;
  } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

function currentFingerprint(source, adoptions) {
  return adoptions.sources.get(source.id)?.binding.contentFingerprint || source.revisions.at(-1)?.contentFingerprint;
}

function capture(kbRoot, input) {
  const { root, source: sourceRoot } = checkedRoots(kbRoot, input.sourceRoot);
  const file = sourceFile(input.file);
  if (input.id !== undefined && !SOURCE_ID.test(input.id)) fail("invalid_source_id");
  return withLock(root, () => {
    assertNoPending(root);
    const registry = readRegistry(root);
    let collection = chooseCollection(registry, sourceRoot, input.collection);
    const plan = pkg.inspectPackage(sourceRoot, file, { limits: input.limits });
    if (!plan.coverage.complete) fail("incomplete_package");
    if (!collection) {
      if (registry.collections.length >= 200) fail("registry_limit");
      collection = { id: id("mdcol"), rootFingerprint: fingerprint(sourceRoot) };
      registry.collections.push(collection);
    }
    const candidates = registry.sources.filter((item) => item.collectionId === collection.id);
    let selected = input.id ? candidates.find((item) => item.id === input.id) : candidates.find((item) => item.inputPath === plan.entry);
    if (input.id && !selected) fail("source_not_found");
    if (selected && selected.inputPath !== plan.entry && existsInput(sourceRoot, selected.inputPath)) fail("source_path_still_exists");
    const pathOwner = candidates.find((item) => item.inputPath === plan.entry && item.id !== selected?.id);
    if (selected && pathOwner) fail("source_path_collision");
    const possibleRenames = selected ? [] : candidates.filter((item) => !existsInput(sourceRoot, item.inputPath)
      && item.revisions.some((binding) => binding.contentFingerprint === plan.contentFingerprint));
    const adoptions = readAdoptions(root, { maxMetadataBytes: MAX_WRITER_METADATA_BYTES,
      sourceIds: selected ? [selected.id] : possibleRenames.map((item) => item.id) });
    if (!adoptions.complete) fail("invalid_markdown_adoption");
    if (!selected) {
      const renamed = possibleRenames.filter((item) => currentFingerprint(item, adoptions) === plan.contentFingerprint);
      if (renamed.length > 1) fail("ambiguous_source_identity");
      if (renamed.length && !uniqueNewPath(sourceRoot, plan, candidates)) fail("ambiguous_source_identity");
      selected = renamed[0];
    }
    if (!selected) {
      if (registry.sources.length >= 2000) fail("registry_limit");
      selected = { id: id("md"), collectionId: collection.id, inputPath: plan.entry, aliases: [], revisions: [] };
      registry.sources.push(selected);
    }
    if (selected.inputPath !== plan.entry) {
      selected.aliases ||= [];
      if (!selected.aliases.includes(selected.inputPath)) selected.aliases.push(selected.inputPath);
      selected.inputPath = plan.entry;
    }
    if (selected.revisions.length >= 1000 && !selected.revisions.some((item) => item.revision === plan.revision)) fail("registry_limit");
    // Reserve enough metadata before publishing a new immutable package.
    if (Buffer.byteLength(json(registry)) > MAX_STATE_BYTES - 16 * 1024) fail("registry_limit");
    const binding = pkg.capturePackage(root, selected.id, plan);
    const existing = selected.revisions.find((item) => item.revision === binding.revision);
    if (existing && JSON.stringify(existing) !== JSON.stringify(binding)) fail("registered_package_changed");
    if (!existing) selected.revisions.push(binding);
    collection.rootFingerprint = fingerprint(sourceRoot);
    validateRegistry(registry);
    const before = fs.existsSync(path.join(root, REGISTRY)) ? pkg.readSafeBinary(root, REGISTRY, MAX_STATE_BYTES).buffer : null;
    const contents = json(registry);
    if (!before || !before.equals(Buffer.from(contents))) atomicWrite(root, REGISTRY, contents);
    const current = adoptions.sources.get(selected.id);
    const reused = Boolean(current?.healthy && current.binding.revision === binding.revision && current.binding.manifestSha256 === binding.manifestSha256);
    return { version: 1, status: reused ? "reused" : "captured", sourceId: selected.id, collectionId: collection.id,
      target: targetFor(selected.id), binding, needsSummary: !reused,
      ...(current && !current.healthy ? { reason: current.reason } : {}) };
  });
}

function scanLimits(input = {}) {
  const result = { ...DEFAULT_SCAN_LIMITS };
  for (const [key, value] of Object.entries(input)) {
    if (!(key in result) || !Number.isSafeInteger(value) || value < 1 || value > result[key]) fail("invalid_limit");
    result[key] = value;
  }
  return result;
}

function inventory(root, limits) {
  const result = { files: [], complete: true, reasons: [], entriesRead: 0 };
  const paths = new Map(); let stopped = false;
  const warn = (code, relative) => {
    result.complete = false;
    if (result.reasons.length < 40) result.reasons.push({ code, ...(relative ? { path: relative } : {}) });
  };
  const walk = (relative, depth) => {
    if (stopped) return;
    if (depth > limits.maxDepth) { warn("scan_depth_limit", relative); return; }
    let directory;
    try {
      if (relative) {
        const info = fs.lstatSync(path.join(root, relative));
        if (info.isSymbolicLink() || !info.isDirectory()) { warn("symlink_refused", relative); return; }
      }
      directory = fs.opendirSync(path.join(root, relative));
      const entries = [];
      try {
        for (let entry; (entry = directory.readSync());) {
          if (++result.entriesRead > limits.maxEntries) { warn("scan_entry_limit"); stopped = true; break; }
          entries.push(entry);
        }
      } finally { directory.closeSync(); }
      entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      for (const entry of entries) {
        if (stopped) break;
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        try { pkg.validateRelativePath(child); } catch { warn("unsafe_path", child); continue; }
        const key = child.normalize("NFC").toLowerCase();
        if (paths.has(key) && paths.get(key) !== child) { warn("portable_path_collision", child); continue; }
        paths.set(key, child);
        if (entry.isSymbolicLink()) { warn("symlink_refused", child); continue; }
        if (entry.isDirectory()) walk(child, depth + 1);
        else if (entry.isFile() && /\.md$/iu.test(entry.name)) {
          if (result.files.length >= limits.maxFiles) { warn("scan_file_limit"); stopped = true; break; }
          result.files.push(child);
        }
      }
    } catch { warn("unreadable_source_directory", relative); }
  };
  walk("", 0);
  return result;
}

function uniqueNewPath(root, selected, sources) {
  // A missing old file can transfer its identity only when the matching new
  // file is unique in both directions. A selected capture alone cannot prove
  // that another new file does not contain the same document.
  const limits = DEFAULT_SCAN_LIMITS, files = inventory(root, limits);
  if (!files.complete) return false;
  const known = new Set(sources.map((source) => source.inputPath));
  let bytes = 0, matches = 0;
  for (const file of files.files) {
    if (known.has(file)) continue;
    try {
      if (bytes >= limits.maxTotalBytes) return false;
      const plan = file === selected.entry ? selected : pkg.inspectPackage(root, file, {
        limits: { maxTotalBytes: Math.min(pkg.DEFAULT_LIMITS.maxTotalBytes, limits.maxTotalBytes - bytes) },
      });
      bytes += plan.coverage.totalBytes;
      if (!plan.coverage.complete || bytes > limits.maxTotalBytes) return false;
      if (plan.contentFingerprint === selected.contentFingerprint && ++matches > 1) return false;
    } catch { return false; }
  }
  return matches === 1;
}

function verifyScannedPackage(root, binding, coverage, limits) {
  // Verification also reads immutable KB files and re-derives their reading
  // copies. Reserve that bounded work before the verifier starts, so many
  // unchanged sources cannot bypass the scan's aggregate byte cap.
  const remaining = limits.maxTotalBytes - coverage.bytesRead;
  if (remaining < 1) fail("scan_byte_limit");
  let file, manifest;
  try {
    file = pkg.readSafeBinary(root, binding.manifestPath, Math.min(pkg.MAX_MANIFEST_BYTES, remaining));
    coverage.bytesRead += file.size;
    if (file.sha256 !== binding.manifestSha256) return { ok: false };
    manifest = pkg.validateManifest(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.buffer)), binding);
  } catch (error) {
    if (error.code === "file_budget_exceeded" && remaining < pkg.MAX_MANIFEST_BYTES) fail("scan_byte_limit");
    return { ok: false };
  }
  const reserved = file.size + manifest.files.reduce((sum, item) => sum + item.size + 1, 0)
    + manifest.files.filter((item) => item.kind !== "reading").reduce((sum, item) => sum + item.size + 1, 0);
  if (coverage.bytesRead + reserved > limits.maxTotalBytes) fail("scan_byte_limit");
  coverage.bytesRead += reserved;
  return pkg.verifyPackage(root, binding);
}

function scan(kbRoot, input) {
  const { root, source: sourceRoot } = checkedRoots(kbRoot, input.sourceRoot);
  const registry = readRegistry(root), collection = chooseCollection(registry, sourceRoot, input.collection);
  const limits = scanLimits(input.limits), files = inventory(sourceRoot, limits);
  const adoptions = readAdoptions(root);
  const coverage = { complete: files.complete && adoptions.complete, entriesRead: files.entriesRead, bytesRead: 0,
    reasons: [...files.reasons, ...adoptions.warnings].slice(0, 40) };
  const sources = collection ? registry.sources.filter((item) => item.collectionId === collection.id) : [];
  const byPath = new Map(sources.map((item) => [item.inputPath, item]));
  const plans = new Map(), entries = [];
  for (const file of files.files) {
    try {
      if (coverage.bytesRead >= limits.maxTotalBytes) fail("scan_byte_limit");
      const plan = pkg.inspectPackage(sourceRoot, file, { limits: { maxTotalBytes: Math.min(pkg.DEFAULT_LIMITS.maxTotalBytes, limits.maxTotalBytes - coverage.bytesRead) } });
      coverage.bytesRead += plan.coverage.totalBytes;
      if (!plan.coverage.complete) fail("incomplete_package");
      plans.set(file, { revision: plan.revision, contentFingerprint: plan.contentFingerprint });
    } catch (error) {
      coverage.complete = false;
      if (coverage.reasons.length < 40) coverage.reasons.push({ code: error.code || "source_unreadable", path: file });
      entries.push({ status: "unknown", path: file, ...(byPath.has(file) ? { sourceId: byPath.get(file).id } : {}), reason: error.code || "source_unreadable" });
    }
  }
  const present = new Set(files.files), missing = sources.filter((item) => !present.has(item.inputPath));
  const newPaths = [...plans.keys()].filter((file) => !byPath.has(file));
  const matched = new Set();
  for (const [file, plan] of plans) {
    const source = byPath.get(file);
    if (source) {
      const current = adoptions.sources.get(source.id);
      let status, reason;
      if (!current || !current.healthy) { status = "needs-repair"; reason = current?.reason || "summary_not_adopted"; }
      else if (current.binding.revision === plan.revision && current.binding.contentFingerprint === plan.contentFingerprint) {
        try {
          const verified = verifyScannedPackage(root, current.binding, coverage, limits);
          status = verified.ok ? "unchanged" : "needs-repair"; reason = verified.ok ? undefined : "package_changed";
        } catch (error) {
          coverage.complete = false; status = "unknown"; reason = error.code || "scan_byte_limit";
          if (coverage.reasons.length < 40) coverage.reasons.push({ code: reason, path: file });
        }
      } else status = "modified";
      entries.push({ status, path: file, sourceId: source.id, revision: plan.revision, ...(reason ? { reason } : {}) });
      continue;
    }
    const old = coverage.complete ? missing.filter((item) => currentFingerprint(item, adoptions) === plan.contentFingerprint) : [];
    const competing = newPaths.filter((other) => plans.get(other).contentFingerprint === plan.contentFingerprint);
    if (old.length === 1 && competing.length === 1) {
      matched.add(old[0].id);
      entries.push({ status: "renamed", path: file, sourceId: old[0].id, previousPath: old[0].inputPath, revision: plan.revision });
    } else entries.push({ status: "new", path: file, revision: plan.revision,
      ...(old.length ? { reason: "ambiguous_rename", choices: old.map((item) => item.id) } : {}) });
  }
  if (!coverage.complete) for (const entry of entries) if (entry.status === "renamed") {
    entry.status = "unknown"; entry.reason = "scan_incomplete";
    delete entry.sourceId; delete entry.previousPath;
  }
  for (const source of missing) if (!coverage.complete || !matched.has(source.id)) entries.push({ status: coverage.complete ? "deleted" : "unknown",
    path: source.inputPath, sourceId: source.id, ...(coverage.complete ? {} : { reason: "scan_incomplete" }) });
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : a.status.localeCompare(b.status));
  const counts = {};
  for (const entry of entries) counts[entry.status] = (counts[entry.status] || 0) + 1;
  return { version: 1, collectionId: collection?.id || null,
    requiresRebind: Boolean(collection && collection.rootFingerprint !== fingerprint(sourceRoot)), coverage, counts, entries };
}

function stage(kbRoot, input) {
  const root = validateRoot(kbRoot);
  if (!SOURCE_ID.test(input.id) || typeof input.revision !== "string") fail("invalid_arguments");
  const registry = readRegistry(root), source = registry.sources.find((item) => item.id === input.id);
  const binding = source?.revisions.find((item) => item.revision === input.revision);
  if (!binding) fail("source_revision_not_found");
  const verified = pkg.verifyPackage(root, binding);
  if (!verified.ok) fail("markdown_package_changed");
  assertNoPending(root);
  const adoptions = readAdoptions(root, { sourceIds: [source.id], maxMetadataBytes: MAX_WRITER_METADATA_BYTES });
  if (!adoptions.complete) fail("invalid_markdown_adoption");
  const current = adoptions.sources.get(source.id), target = targetFor(source.id);
  if (current && !current.healthy && current.reason !== "summary_missing") fail("managed_summary_changed");
  let expectedTargetSha256 = current?.currentSha256 || null;
  if (!current) {
    try { pkg.readSafeBinary(root, target, 512 * 1024); fail("managed_summary_changed"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const manual = current?.healthy ? current.manual : current ? extractManual(current.candidate.content) : undefined;
  const body = buildBody(binding, input.body, manual);
  const title = input.title || current?.candidate.title || path.posix.basename(source.inputPath).replace(/\.md$/iu, "");
  if (current?.healthy && current.binding.revision === binding.revision && current.binding.manifestSha256 === binding.manifestSha256
    && current.candidate.title === title && stripManual(body) === stripManual(current.candidate.body)) {
    return { version: 1, status: "reused", id: current.candidate.id, sourceId: source.id, target };
  }
  const query = path.posix.basename(binding.primaryPath).replace(/\.md$/iu, "").slice(0, 1024) || "Markdown";
  const packet = search(root, { mode: "raw", query, paths: [binding.primaryPath] });
  if (!packet.evidence.length || !packet.evidence.some((item) => item.path === binding.primaryPath)) fail("source_evidence_unavailable");
  return review.stage(root, { title, target, body, packet, markdownSource: binding, expectedTargetSha256 });
}

module.exports = { DEFAULT_SCAN_LIMITS, inspect, capture, scan, stage, fingerprint, assertNoPending };
