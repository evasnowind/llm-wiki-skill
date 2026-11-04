"use strict";

// Read-only leaf. Retrieval and the Review publisher consume this module.
const fs = require("node:fs");
const path = require("node:path");
const { TextDecoder } = require("node:util");
const pkg = require("./markdown-package");
const { readReviewRecords } = require("./review-history");
const { readAdoptions, validateRegistry, assessSummary } = require("./markdown-state");
const { parseWikilinks } = require("./wikilink-parser");
const { extractFrontmatter, parseSourcesFrontmatter } = require("./source-signal-eligibility");

const DEFAULT_LIMITS = Object.freeze({ maxFiles: 1000, maxEntries: 10000, maxDepth: 24,
  maxFileBytes: 2 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024,
  maxMetadataBytes: 64 * 1024 * 1024, maxDependencies: 100, maxHops: 2, maxOutputChars: 64000 });
const PACKAGE_PATH = /^(raw\/markdown\/(md-[a-f0-9]{24})\/(rev-[a-f0-9]{64}))\/(files|reading)\/(.+)$/u;
const STATES = new Set(["current", "stale", "potential", "unknown", "untracked"]);
const fold = (value) => value.normalize("NFC").toLowerCase();
function fail(code) { throw Object.assign(new Error(code), { code }); }
function checkedLimits(input = {}) {
  const limits = { ...DEFAULT_LIMITS };
  for (const [key, value] of Object.entries(input)) {
    if (!(key in limits) || !Number.isSafeInteger(value) || value < 1 || value > limits[key]) fail("invalid_limit");
    limits[key] = value;
  }
  if (limits.maxOutputChars < 4096) fail("invalid_limit");
  return limits;
}
function checkedPage(relative) {
  pkg.validateRelativePath(relative);
  if (!/^(wiki|raw)\/.+\.(md|txt)$/iu.test(relative) || (relative.startsWith("wiki/") && !/\.md$/iu.test(relative))) fail("invalid_path");
  return relative;
}
function decode(buffer) {
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer); }
  catch { fail("invalid_utf8"); }
}

function scanFreshness(kbRoot, options = {}) {
  const root = pkg.validateSourceRoot(kbRoot), limits = checkedLimits(options.limits);
  const coverage = { complete: true, filesRead: 0, entriesRead: 0, bytesRead: 0, metadataBytes: 0, maxHops: limits.maxHops, reasons: [] };
  const warn = (code, relative) => {
    coverage.complete = false;
    const reported = relative?.slice(0, 160);
    if (coverage.reasons.length < Math.min(40, Math.floor(limits.maxOutputChars / 512))
      && !coverage.reasons.some((item) => item.code === code && item.path === reported)) {
      coverage.reasons.push({ code, ...(reported ? { path: reported } : {}) });
    }
  };
  const cache = new Map(), metadata = new Map(), nodes = new Map(), packages = new Map();
  if (options.files !== undefined && (!Array.isArray(options.files) || options.files.length > 50)) fail("invalid_paths");
  for (const file of options.files || []) if (file && typeof file.path === "string" && Buffer.isBuffer(file.buffer)) {
    checkedPage(file.path);
    if (file.buffer.length <= limits.maxFileBytes && pkg.sha256(file.buffer) === file.sha256) cache.set(file.path, { ...file, size: file.buffer.length });
  }
  function readBinary(relative, maximum) {
    if (metadata.has(relative)) return metadata.get(relative);
    if (cache.has(relative)) return cache.get(relative);
    const remaining = limits.maxMetadataBytes - coverage.metadataBytes;
    if (remaining < 1) fail("metadata_budget_exceeded");
    const info = fs.lstatSync(pkg.checkedPath(root, relative));
    if (info.size > maximum || info.size > remaining) fail("metadata_budget_exceeded");
    coverage.metadataBytes += info.size;
    const file = pkg.readSafeBinary(root, relative, Math.min(maximum, remaining));
    metadata.set(relative, file); return file;
  }
  function readFile(relative) {
    checkedPage(relative);
    if (metadata.has(relative)) cache.set(relative, metadata.get(relative));
    if (cache.has(relative)) {
      const file = cache.get(relative); if (file.text === undefined) file.text = decode(file.buffer);
      return file;
    }
    if (coverage.filesRead >= limits.maxFiles) fail("freshness_file_limit");
    const remaining = limits.maxTotalBytes - coverage.bytesRead;
    if (remaining < 1) fail("freshness_byte_limit");
    const info = fs.lstatSync(pkg.checkedPath(root, relative));
    if (info.size > limits.maxFileBytes || info.size > remaining) fail("freshness_byte_limit");
    coverage.filesRead += 1; coverage.bytesRead += info.size;
    const file = pkg.readSafeBinary(root, relative, Math.min(limits.maxFileBytes, remaining));
    file.text = decode(file.buffer);
    cache.set(relative, file); return file;
  }
  // Root validation is independent of publication metadata.
  try { decode(readBinary(".wiki-schema.md", limits.maxFileBytes).buffer); }
  catch (error) {
    if (error.code !== "metadata_budget_exceeded") fail("invalid_schema_or_root");
    warn(error.code, ".wiki-schema.md");
  }
  const records = readReviewRecords(root, { readBinary, maxMetadataBytes: limits.maxMetadataBytes });
  const sources = { sources: new Map(), complete: records.complete, warnings: [] }, loadedSources = new Set();
  function sourceAdoption(id) {
    if (!loadedSources.has(id)) {
      loadedSources.add(id);
      const result = readAdoptions(root, { records, readBinary, maxMetadataBytes: limits.maxMetadataBytes, sourceIds: [id] });
      if (result.sources.has(id)) sources.sources.set(id, result.sources.get(id));
      sources.complete &&= result.complete;
      sources.warnings.push(...result.warnings);
      for (const item of result.warnings) warn(item.code, item.path);
    }
    return sources.sources.get(id);
  }
  let registry;
  try {
    const file = readBinary(".wiki-review/markdown-sources.json", 16 * 1024 * 1024);
    registry = validateRegistry(JSON.parse(decode(file.buffer)));
  } catch (error) { if (error.code !== "ENOENT") warn(error.code || "invalid_markdown_state"); registry = { sources: [] }; }
  for (const item of [...records.warnings, ...sources.warnings]) warn(item.code, item.path);
  if (!records.complete || !sources.complete) warn("freshness_metadata_incomplete");
  const registered = new Map();
  for (const source of registry.sources) for (const binding of source.revisions) registered.set(`${source.id}/${binding.revision}`, binding);
  const adopted = new Map();
  const ready = new Map();
  for (const candidate of records.candidates) if (candidate.status === "ready") ready.set(candidate.target, [...(ready.get(candidate.target) || []), candidate]);
  for (const [index, candidate] of records.candidates.entries()) if (candidate.status === "adopted") {
    const previous = adopted.get(candidate.target);
    if (!previous || String(candidate.adoptedAt).localeCompare(String(previous.candidate.adoptedAt)) >= 0) adopted.set(candidate.target, { candidate, index });
  }
  const journals = new Map();
  function committed(candidate) {
    if (journals.has(candidate.id)) return journals.get(candidate.id);
    try {
      const journal = records.readJournal(candidate.id);
      const valid = journal?.committed === true;
      if (!valid) warn("freshness_publication_pending", candidate.target);
      journals.set(candidate.id, valid); return valid;
    } catch (error) { warn(error.code || "invalid_journal", candidate.target); journals.set(candidate.id, false); return false; }
  }
  function verify(binding) {
    if (packages.has(binding.manifestPath)) return packages.get(binding.manifestPath);
    let value;
    try {
      const file = readBinary(binding.manifestPath, pkg.MAX_MANIFEST_BYTES);
      if (file.sha256 !== binding.manifestSha256) fail("markdown_manifest_changed");
      const manifest = pkg.validateManifest(JSON.parse(decode(file.buffer)), binding);
      // verifyPackage re-reads the manifest, all records, then originals while
      // deriving links. Reserve that work before invoking its closed verifier.
      const reserved = file.size + manifest.files.reduce((sum, item) => sum + item.size + 1, 0)
        + manifest.files.filter((item) => item.kind !== "reading").reduce((sum, item) => sum + item.size + 1, 0);
      if (coverage.bytesRead + reserved > limits.maxTotalBytes) fail("freshness_byte_limit");
      coverage.bytesRead += reserved;
      const checked = pkg.verifyPackage(root, binding);
      if (!checked.ok) fail(checked.errors[0]?.code || "markdown_package_changed");
      value = { ok: true, manifest };
    } catch (error) { warn(error.code || "markdown_package_changed", binding.manifestPath); value = { ok: false, reason: error.code || "markdown_package_changed" }; }
    packages.set(binding.manifestPath, value); return value;
  }
  function managed(relative, actualSha256) {
    const match = PACKAGE_PATH.exec(relative);
    if (!match) return { status: "untracked" };
    const [, base, sourceId, usedRevision, kind, sourcePath] = match;
    const binding = registered.get(`${sourceId}/${usedRevision}`), current = sourceAdoption(sourceId);
    const detail = { sourceId, usedRevision, ...(current ? { currentRevision: current.binding.revision, currentSource: current.target } : {}) };
    if (kind === "reading") return { ...detail, status: "unknown", reason: "derived_reading_copy" };
    if (!binding || binding.manifestPath !== `${base}/manifest.json`) return { ...detail, status: "unknown", reason: "markdown_binding_unknown" };
    const old = verify(binding);
    if (!old.ok) return { ...detail, status: "unknown", reason: old.reason };
    const item = old.manifest.files.find((entry) => entry.path === `files/${sourcePath}` && entry.kind !== "reading");
    if (!item || item.sha256 !== actualSha256) return { ...detail, status: "unknown", reason: "markdown_original_changed" };
    if (!current || !records.complete || !sources.complete) return { ...detail, status: "unknown", reason: "current_adoption_unknown" };
    if (!verify(current.binding).ok) return { ...detail, status: "unknown", reason: "current_package_changed" };
    if (current.binding.revision !== usedRevision) return { ...detail, status: "stale", reason: "source_revision_superseded" };
    if (!current.healthy) return { ...detail, status: "unknown", reason: "source_summary_changed" };
    return { ...detail, status: "current", reason: "current_adopted_source" };
  }
  let inventory;
  function wikiFiles() {
    if (inventory) return inventory;
    inventory = [];
    function walk(relative, depth) {
      if (depth > limits.maxDepth) { warn("freshness_depth_limit", relative); return; }
      let directory;
      try {
        const target = pkg.checkedPath(root, relative);
        const info = fs.lstatSync(target);
        if (info.isSymbolicLink() || !info.isDirectory()) fail("symlink_refused");
        directory = fs.opendirSync(target);
        try {
          for (let item; (item = directory.readSync());) {
            if (++coverage.entriesRead > limits.maxEntries) { warn("freshness_entry_limit"); return; }
            if (item.name.startsWith(".") || item.name === "node_modules") continue;
            const child = `${relative}/${item.name}`;
            try { pkg.validateRelativePath(child); } catch { warn("unsafe_path", child); continue; }
            if (item.isSymbolicLink()) { warn("symlink_refused", child); continue; }
            if (item.isDirectory()) walk(child, depth + 1);
            else if (item.isFile() && /\.md$/iu.test(item.name)) {
              if (inventory.length >= limits.maxFiles) { warn("freshness_file_limit"); return; }
              inventory.push(child);
            }
          }
        } finally { directory.closeSync(); }
      } catch (error) { if (error.code !== "ENOENT") warn(error.code || "unreadable_directory", relative); }
    }
    walk("wiki", 0); inventory.sort(); return inventory;
  }
  function resolveHint(source, token) {
    let value = String(token).trim().replace(/^\[\[|\]\]$/gu, "").split("|")[0].split("#")[0];
    if (!value || /^[a-z][a-z0-9+.-]*:/iu.test(value)) return null;
    try { value = decodeURIComponent(value); } catch { return { reason: "invalid_reference" }; }
    if (value.includes("/") || /\.(md|txt)$/iu.test(value)) {
      const relative = /^(wiki|raw)\//u.test(value) ? value : path.posix.normalize(path.posix.join(path.posix.dirname(source), value));
      const complete = /\.(md|txt)$/iu.test(relative) ? relative : `${relative}.md`;
      try { checkedPage(complete); return { path: complete }; } catch { return { reason: "unsafe_reference" }; }
    }
    const matches = wikiFiles().filter((item) => fold(path.posix.basename(item, path.posix.extname(item))) === fold(value));
    return matches.length === 1 ? { path: matches[0] } : { reason: matches.length > 1 ? "ambiguous_reference" : "missing_reference" };
  }
  function hints(relative, file) {
    const text = decode(file.buffer), { frontmatter, body } = extractFrontmatter(text.replace(/^\uFEFF/u, ""));
    const parsed = parseSourcesFrontmatter(frontmatter);
    const tokens = [...parsed.sources];
    if (parsed.hasField && !parsed.parsed) warn("invalid_sources", relative);
    for (const link of parseWikilinks(Buffer.from(body), relative).occurrences) {
      if (!link.pending && link.link_kind !== "attachment_wikilink" && link.page_target) tokens.push(link.page_target);
    }
    return [...new Set(tokens)].map((token) => resolveHint(relative, token)).filter(Boolean);
  }
  function build(relative, depth = 0) {
    if (nodes.has(relative)) return nodes.get(relative);
    const page = { path: relative, fileSha256: null, status: "untracked", dependencies: [], impacts: [] };
    const guards = new Map();
    Object.defineProperty(page, "expectedPaths", { value: guards });
    nodes.set(relative, page);
    let file;
    try { file = readFile(relative); page.fileSha256 = file.sha256; guards.set(relative, file.sha256); }
    catch (error) { page.status = "unknown"; page.reason = error.code === "ENOENT" ? "file_missing" : error.code || "file_unreadable"; warn(page.reason, relative); return page; }
    if (relative.startsWith("raw/")) {
      Object.assign(page, managed(relative, file.sha256));
      if (page.currentSource) {
        try { guards.set(page.currentSource, readFile(page.currentSource).sha256); } catch { page.status = "unknown"; }
      }
      return page;
    }
    for (const candidate of ready.get(relative) || []) {
      try {
        const journal = records.readJournal(candidate.id);
        if (journal && !journal.committed) { warn("freshness_publication_pending", relative); page.status = "unknown"; page.reason = "freshness_publication_pending"; return page; }
      } catch (error) { warn(error.code || "invalid_journal", relative); page.status = "unknown"; page.reason = "adoption_unverified"; return page; }
    }
    const candidate = adopted.get(relative)?.candidate;
    let provenance = false;
    if (candidate) {
      page.candidateId = candidate.id;
      if (!committed(candidate)) { page.status = "unknown"; page.reason = "adoption_unverified"; return page; }
      if (candidate.markdownSource) {
        const assessed = assessSummary(root, candidate, { readBinary: (name) => readFile(name) });
        provenance = assessed.healthy;
      } else provenance = file.sha256 === candidate.contentSha256;
      if (!provenance) { page.status = "unknown"; page.reason = "page_changed_outside_review"; return page; }
    }
    const dependencies = provenance ? candidate.packet.evidence.map((item) => ({ path: item.path, expectedSha256: item.fileSha256, direct: true }))
      : hints(relative, file).map((item) => ({ ...item, direct: false }));
    const unique = [...new Map(dependencies.map((item) => [`${item.path || ""}\0${item.expectedSha256 || ""}\0${item.reason || ""}`, item])).values()];
    if (unique.length > limits.maxDependencies) { warn("freshness_dependency_limit", relative); page.status = "unknown"; page.reason = "freshness_dependency_limit"; }
    for (const dependency of unique.slice(0, limits.maxDependencies)) {
      const detail = { ...dependency, status: "untracked" };
      delete detail.direct;
      page.dependencies.push(detail);
      if (!dependency.path) { detail.status = "unknown"; continue; }
      try {
        const source = readFile(dependency.path);
        detail.actualSha256 = source.sha256; guards.set(dependency.path, source.sha256);
        if (dependency.expectedSha256 && dependency.expectedSha256 !== source.sha256) {
          detail.status = "stale"; detail.reason = "referenced_bytes_changed";
        } else if (dependency.path.startsWith("raw/")) Object.assign(detail, managed(dependency.path, source.sha256));
        else if (options.paths === undefined || depth < limits.maxHops) {
          const linked = options.paths === undefined ? null : build(dependency.path, depth + 1);
          detail.status = linked?.status === "unknown" ? "unknown" : dependency.direct ? "current" : "untracked";
          detail.reason = dependency.direct ? "referenced_page_bytes_match" : "declared_reference";
        } else { detail.status = "unknown"; detail.reason = "freshness_hop_limit"; warn(detail.reason, relative); }
        if (detail.currentSource) guards.set(detail.currentSource, readFile(detail.currentSource).sha256);
        if (!dependency.direct && ["current", "stale"].includes(detail.status)) {
          detail.status = "potential"; detail.reason = "unverified_source_declaration";
        }
      } catch (error) {
        detail.status = "unknown"; detail.reason = error.code === "ENOENT" ? "referenced_file_missing" : error.code || "referenced_file_unreadable";
        if (error.code === "ENOENT") guards.set(dependency.path, null);
        warn(detail.reason, dependency.path);
      }
    }
    if (page.status !== "unknown") {
      const statuses = new Set(page.dependencies.map((item) => item.status));
      page.status = statuses.has("stale") ? "stale" : statuses.has("unknown") ? "unknown"
        : statuses.has("potential") ? "potential" : provenance && page.dependencies.length ? "current" : "untracked";
    }
    return page;
  }
  let selected;
  if (options.paths !== undefined) {
    if (!Array.isArray(options.paths) || options.paths.length < 1 || options.paths.length > 50) fail("invalid_paths");
    selected = [...new Set(options.paths.map(checkedPage))].sort();
  } else selected = wikiFiles();
  for (const relative of selected) build(relative);
  // Fixed rounds keep propagation bounded and stop cycles. Byte changes are
  // direct; unchanged pages depending on stale pages receive potential impact.
  for (let hop = 0; hop < limits.maxHops; hop += 1) {
    const changes = [];
    for (const page of nodes.values()) {
      if (["stale", "unknown"].includes(page.status)) continue;
      for (const dependency of page.dependencies) {
        const linked = nodes.get(dependency.path);
        if (!linked || !["stale", "potential", "unknown"].includes(linked.status) || dependency.reason === "referenced_bytes_changed") continue;
        const prior = linked.impacts.find((item) => item.kind === "potential");
        const via = [dependency.path, ...(prior?.via || [])];
        if (via.length > limits.maxHops || via.includes(page.path)) continue;
        changes.push({ page, unknown: linked.status === "unknown", impact: { kind: "potential", via,
          reason: linked.status === "unknown" ? "dependent_page_unverified" : "dependent_page_needs_review" } });
      }
    }
    for (const { page, impact, unknown } of changes) {
      page.status = unknown || page.status === "unknown" ? "unknown" : "potential";
      if (!page.impacts.some((item) => JSON.stringify(item) === JSON.stringify(impact))) page.impacts.push(impact);
    }
  }
  for (let hop = 0; hop < limits.maxHops; hop += 1) for (const page of nodes.values()) {
    const guards = page.expectedPaths;
    for (const dependency of page.dependencies) {
      const linked = nodes.get(dependency.path);
      if (linked) for (const [name, hash] of linked.expectedPaths) {
        guards.set(name, hash); if (guards.size > 250) break;
      }
      if (guards.size > 250) break;
    }
  }
  for (const page of nodes.values()) {
    if ((!records.complete || !sources.complete || !coverage.complete) && page.status === "current") { page.status = "unknown"; page.reason = "freshness_coverage_incomplete"; }
    if (page.status === "stale") page.impacts.unshift({ kind: "direct", via: [], reason: "recorded_basis_changed" });
    const guards = page.expectedPaths;
    if (guards.size > 250) { page.status = "unknown"; page.reason = "freshness_guard_limit"; warn(page.reason, page.path); }
    page.fingerprint = pkg.sha256(JSON.stringify({ path: page.path, fileSha256: page.fileSha256, status: page.status,
      reason: page.reason || null, dependencies: page.dependencies, impacts: page.impacts }));
  }
  for (const item of [...records.warnings, ...sources.warnings]) warn(item.code, item.path);
  const pages = selected.map((relative) => nodes.get(relative));
  const counts = Object.fromEntries([...STATES].map((status) => [status, pages.filter((item) => item.status === status).length]));
  const report = { version: 1, scope: "adopted-kb", coverage, counts, pages };
  while (JSON.stringify(report).length > limits.maxOutputChars && pages.length) { pages.pop(); warn("freshness_output_limit"); }
  return report;
}

module.exports = { DEFAULT_LIMITS, STATES, checkedPage, scanFreshness };
