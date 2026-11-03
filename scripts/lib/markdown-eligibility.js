"use strict";

// Classification only: do not import Review, retrieval or state-io here.
const fs = require("node:fs");
const path = require("node:path");
const { TextDecoder } = require("node:util");
const { readSafeBinary, validateManifest, MAX_MANIFEST_BYTES } = require("./markdown-package");

const PACKAGE_FILE = /^(raw\/markdown\/(md-[a-f0-9]{24})\/(rev-[a-f0-9]{64}))\/(.+)$/u;
const SUMMARY_FILE = /^wiki\/sources\/(md-[a-f0-9]{24})\.md$/u;
const MAX_METADATA_BYTES = 64 * 1024 * 1024;

function hasMarkdownMetadata(root) {
  return fs.existsSync(path.join(root, "raw/markdown"))
    || fs.existsSync(path.join(root, ".wiki-review/markdown-sources.json"));
}

function createMarkdownEligibility(root, { explicit = false, maxMetadataBytes = MAX_METADATA_BYTES, warn = () => {} } = {}) {
  const manifests = new Map();
  const unavailableManifests = new Set();
  const filtered = {};
  let metadataBytes = 0;
  let adoptions;
  const expectedBindings = new Map();
  const noted = new Set();
  const warning = (code, relative) => {
    const key = `${code}\0${relative || ""}`;
    if (noted.has(key)) return;
    noted.add(key); warn(code, relative);
  };
  const count = (reason) => { filtered[reason] = (filtered[reason] || 0) + 1; return false; };
  const expectBinding = (binding) => {
    const existing = expectedBindings.get(binding.manifestPath);
    if (existing && existing !== binding.manifestSha256) {
      expectedBindings.set(binding.manifestPath, false);
      warning("markdown_binding_conflict", binding.manifestPath);
    } else if (existing !== false) expectedBindings.set(binding.manifestPath, binding.manifestSha256);
  };

  function metadata(relative, maximum) {
    const remaining = maxMetadataBytes - metadataBytes;
    if (remaining < 1) throw Object.assign(new Error(), { code: "markdown_metadata_budget" });
    const size = fs.lstatSync(path.join(root, ...relative.split("/"))).size;
    if (size > maximum || size > remaining) throw Object.assign(new Error(), { code: "markdown_metadata_budget" });
    metadataBytes += size;
    const file = readSafeBinary(root, relative, Math.min(maximum, remaining));
    return { file, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.buffer)) };
  }

  function currentAdoptions() {
    if (adoptions) return adoptions;
    if (metadataBytes >= maxMetadataBytes) {
      warning("markdown_metadata_budget");
      return (adoptions = { sources: new Map(), candidates: [], complete: false });
    }
    try {
      // Load adoption metadata only when managed Markdown paths need it.
      const { readAdoptions, validateRegistry } = require("./markdown-state");
      try {
        const registry = validateRegistry(metadata(".wiki-review/markdown-sources.json", 16 * 1024 * 1024).value);
        for (const source of registry.sources) for (const binding of source.revisions) expectBinding(binding);
      }
      catch (error) {
        if (error.code !== "ENOENT") warning(error.code === "markdown_metadata_budget" ? error.code : "markdown_registry_unavailable");
      }
      if (metadataBytes >= maxMetadataBytes) throw new Error("markdown_metadata_budget");
      adoptions = readAdoptions(root, { maxMetadataBytes: maxMetadataBytes - metadataBytes });
      metadataBytes += adoptions.metadataBytes || adoptions.bytesRead || 0;
      if (!(adoptions.sources instanceof Map)) throw new Error("invalid_markdown_state");
      for (const candidate of adoptions.candidates || []) expectBinding(candidate.markdownSource);
      for (const item of adoptions.warnings || []) warning(item.code || "markdown_state_unavailable",
        item.path || (item.sourceId ? `wiki/sources/${item.sourceId}.md` : undefined));
      if (!adoptions.complete && !(adoptions.warnings || []).length) warning("markdown_state_unavailable");
    } catch {
      warning("markdown_state_unavailable");
      adoptions = { sources: new Map(), candidates: [], complete: false };
    }
    return adoptions;
  }

  function packageRecord(relative) {
    const match = PACKAGE_FILE.exec(relative);
    if (!match) return null;
    const [ , base, sourceId, revision, inside ] = match;
    if (!manifests.has(base)) {
      let result = null;
      try {
        const manifestPath = `${base}/manifest.json`;
        const { file, value: manifest } = metadata(manifestPath, MAX_MANIFEST_BYTES);
        const primary = manifest.files?.find((item) => item?.path === `files/${manifest.entry}`);
        const binding = { version: 1, sourceId, revision, manifestPath, manifestSha256: file.sha256,
          primaryPath: `${base}/files/${manifest.entry}`, primarySha256: primary?.sha256 };
        validateManifest(manifest, binding);
        result = { manifest, binding, records: new Map(manifest.files.map((item) => [item.path, item])) };
      } catch (error) {
        warning(error.code === "markdown_metadata_budget" ? error.code : "markdown_manifest_unavailable", `${base}/manifest.json`);
        try {
          fs.lstatSync(path.join(root, ...`${base}/manifest.json`.split("/")));
          unavailableManifests.add(base);
        } catch (probeError) { if (probeError.code !== "ENOENT") unavailableManifests.add(base); }
      }
      manifests.set(base, result);
    }
    const packaged = manifests.get(base);
    return packaged ? { ...packaged, record: packaged.records.get(inside), base } : null;
  }

  function classify(relative, fileSha256, { verification = false } = {}) {
    const packaged = packageRecord(relative);
    const layout = PACKAGE_FILE.exec(relative);
    if (!packaged && verification && layout && unavailableManifests.has(layout[1])) {
      throw Object.assign(new Error("markdown_manifest_unavailable"), { code: "markdown_manifest_unavailable" });
    }
    if (packaged) {
      const { record, binding } = packaged;
      if (!record) { warning("markdown_unlisted_file", relative); return true; }
      if (record.kind === "reading") {
        if (fileSha256 !== record.sha256) warning("markdown_reading_copy_changed", relative);
        if (verification) return false;
        return count("markdown_reading");
      }
      if (record.sha256 !== fileSha256) {
        warning("markdown_original_changed", relative);
        return true;
      }
      if (explicit || verification) return true;
      const result = currentAdoptions();
      if (expectedBindings.has(binding.manifestPath)
        && expectedBindings.get(binding.manifestPath) !== binding.manifestSha256) {
        warning("markdown_manifest_changed", relative);
        return true;
      }
      const current = result.sources.get(binding.sourceId);
      if (!current) {
        if (!result.complete) warning("markdown_adoption_unknown", relative);
        return count("markdown_pending");
      }
      if (current.binding.manifestPath === binding.manifestPath) {
        if (current.binding.manifestSha256 !== binding.manifestSha256) {
          warning("markdown_manifest_changed", relative);
          return true;
        }
        if (!current.healthy) warning("markdown_summary_changed", current.target);
        return true;
      }
      return count("markdown_historical");
    }
    const summary = SUMMARY_FILE.exec(relative);
    if (summary && !explicit && !verification) {
      const result = currentAdoptions();
      const current = result.sources.get(summary[1]);
      if (current?.healthy) return true;
      const pending = (result.candidates || []).find((candidate) => candidate.target === relative
        && candidate.contentSha256 === fileSha256 && candidate.id !== current?.candidate?.id
        && (result.pendingIds?.has?.(candidate.id)
          || (candidate.status === "ready" && !result.committedIds?.has?.(candidate.id))));
      if (pending) { warning("markdown_publication_pending", relative); return count("markdown_pending_summary"); }
      if (current) warning("markdown_summary_changed", relative);
    }
    return true;
  }

  return {
    classify,
    priority(relative) {
      if (explicit) return 0;
      const match = PACKAGE_FILE.exec(relative);
      if (!match) return 1;
      const current = currentAdoptions().sources.get(match[2]);
      if (current?.binding.revision === match[3] && match[4].startsWith("files/")) return 0;
      return match[4].startsWith("reading/") ? 3 : 2;
    },
    snapshot() { return { metadataBytes, filtered: { ...filtered } }; },
  };
}

module.exports = { MAX_METADATA_BYTES, hasMarkdownMetadata, createMarkdownEligibility };
