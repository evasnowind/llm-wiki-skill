#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const runtime = require("./lib/markdown-runtime");

const usage = `Markdown sources (local only)
  inspect --source-root ROOT --file REL.md
  capture <kb> --source-root ROOT --file REL.md [--collection ID] [--id SOURCE_ID]
  scan <kb> --source-root ROOT [--collection ID]
  stage <kb> --id SOURCE_ID --revision REVISION --body MARKDOWN [--title TEXT]
All commands accept --json. Capture does not publish; adopt with review-cli.js.
`;

function invalid() { const error = new Error("invalid_arguments"); error.code = "invalid_arguments"; throw error; }

function readBody(filename) {
  const fd = fs.openSync(filename, "r");
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > 250 * 1024) throw new Error("body_too_large");
    const buffer = Buffer.alloc(before.size + 1); let length = 0;
    while (length < buffer.length) {
      const read = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (!read) break; length += read;
    }
    const after = fs.fstatSync(fd);
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error("input_changed");
    try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length)); }
    catch { throw new Error("invalid_utf8"); }
  } finally { fs.closeSync(fd); }
}

function main(argv) {
  if (argv.length === 1 && argv[0] === "--help") { process.stdout.write(usage); return; }
  const command = argv[0];
  const flags = { inspect: ["--source-root", "--file"], capture: ["--source-root", "--file", "--collection", "--id"],
    scan: ["--source-root", "--collection"], stage: ["--id", "--revision", "--body", "--title"] };
  if (!Object.hasOwn(flags, command)) invalid();
  const kb = command === "inspect" ? null : argv[1];
  if (command !== "inspect" && (!kb || kb.startsWith("--"))) invalid();
  const args = argv.slice(command === "inspect" ? 1 : 2), options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") { if (options.json) invalid(); options.json = true; continue; }
    if (!flags[command].includes(arg) || options[arg] !== undefined || !args[index + 1] || args[index + 1].startsWith("--")) invalid();
    options[arg] = args[++index];
  }
  const required = { inspect: ["--source-root", "--file"], capture: ["--source-root", "--file"], scan: ["--source-root"], stage: ["--id", "--revision", "--body"] };
  if (required[command].some((flag) => !options[flag])) invalid();
  const input = { sourceRoot: options["--source-root"], file: options["--file"], collection: options["--collection"], id: options["--id"],
    revision: options["--revision"], title: options["--title"] };
  if (command === "stage") input.body = readBody(options["--body"]);
  const result = command === "inspect" ? runtime.inspect(input) : runtime[command](kb, input);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    const allowed = new Set(["invalid_arguments", "invalid_root", "invalid_schema_or_root", "invalid_source_root", "unsafe_path", "not_markdown",
      "invalid_limit", "overlapping_roots", "invalid_collection", "collection_not_found", "collection_ambiguous", "invalid_source_id", "source_not_found",
      "source_revision_not_found", "source_path_still_exists", "source_path_collision", "ambiguous_source_identity", "incomplete_package",
      "invalid_markdown_state", "invalid_markdown_adoption", "metadata_budget_exceeded", "registry_limit", "registered_package_changed",
      "invalid_binding", "invalid_manifest", "existing_package_changed", "package_verification_failed", "source_changed", "invalid_parent",
      "symlink_refused", "file_budget_exceeded", "invalid_utf8", "invalid_journal", "recovery_required", "review_locked", "lock_changed",
      "managed_summary_changed", "invalid_summary_body", "markdown_package_changed", "source_evidence_unavailable", "target_changed",
      "invalid_markdown_source", "invalid_markdown_evidence", "body_too_large", "body_frontmatter_not_allowed", "input_changed", "review_limit",
      "state_too_large", "evidence_required", "evidence_changed_or_invalid", "invalid_state", "target_path_collision", "invalid_target"]);
    const code = error.code || error.message;
    process.stderr.write(`${JSON.stringify({ ok: false, error: allowed.has(code) ? code : "markdown_failed" })}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main };
