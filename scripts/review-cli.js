#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const { TextDecoder } = require("node:util");
const review = require("./lib/skill-review");
const { MAX_PACKET_BYTES } = require("./lib/skill-retrieval");

const usage = `Review / research (local only)
  add <kb> --type contradiction|duplicate|missing|unverified|suggestion --title TEXT --reason TEXT [--path REL ...] [--packet JSON]
  list <kb> [--status open|dismissed|resolved|all] [--candidate-status ready|adopted|cancelled|superseded|all] [--scope active|history|all] [--limit N] [--offset N]
  show <kb> --id ID
  dismiss <kb> --id ISSUE_ID
  stage <kb> --title TEXT --target wiki/...md --body MARKDOWN --packet JSON [--issue ISSUE_ID]
  adopt <kb> --id CANDIDATE_ID
  recover <kb> [--id CANDIDATE_ID]
  cancel <kb> --id CANDIDATE_ID [--reason TEXT]
  supersede <kb> --id CANDIDATE_ID --replacement CANDIDATE_ID
  compact <kb>
All commands accept --json. stage does not publish; adopt explicitly publishes.
`;

function invalid() { throw new Error("invalid_arguments"); }

function readInput(filename, maximum, asJson = false) {
  const fd = fs.openSync(filename, "r");
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maximum) throw new Error("input_too_large");
    const buffer = Buffer.alloc(stat.size + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = fs.readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (!count) break;
      bytes += count;
    }
    if (bytes !== stat.size || fs.fstatSync(fd).mtimeMs !== stat.mtimeMs) throw new Error("input_changed");
    const result = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytes));
    return asJson ? JSON.parse(result) : result;
  } finally { fs.closeSync(fd); }
}

function main(argv) {
  if (argv.length === 1 && argv[0] === "--help") { process.stdout.write(usage); return; }
  const [command, kb, ...args] = argv;
  const flags = { add: ["--type", "--title", "--reason", "--path", "--packet"], list: ["--status", "--candidate-status", "--scope", "--limit", "--offset"], show: ["--id"],
    dismiss: ["--id"], stage: ["--title", "--target", "--body", "--packet", "--issue"], adopt: ["--id"], recover: ["--id"],
    cancel: ["--id", "--reason"], supersede: ["--id", "--replacement"], compact: [] };
  if (!kb || !Object.hasOwn(flags, command)) invalid();
  const options = { paths: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") { if (options.json) invalid(); options.json = true; continue; }
    if (!flags[command].includes(arg) || !args[index + 1] || args[index + 1].startsWith("--") || (arg !== "--path" && options[arg] !== undefined)) invalid();
    const value = args[++index];
    if (arg === "--path") options.paths.push(value); else options[arg] = value;
  }
  const required = { add: ["--type", "--title", "--reason"], show: ["--id"], dismiss: ["--id"], stage: ["--title", "--target", "--body", "--packet"], adopt: ["--id"],
    cancel: ["--id"], supersede: ["--id", "--replacement"] };
  if ((required[command] || []).some((arg) => !options[arg])) invalid();
  let result;
  switch (command) {
    case "add": result = review.add(kb, { type: options["--type"], title: options["--title"], reason: options["--reason"], paths: options.paths,
      packet: options["--packet"] ? readInput(options["--packet"], MAX_PACKET_BYTES, true) : undefined }); break;
    case "list": {
      for (const key of ["--limit", "--offset"]) if (options[key] !== undefined && !/^\d+$/u.test(options[key])) invalid();
      result = review.list(kb, { status: options["--status"], scope: options["--scope"], candidateStatus: options["--candidate-status"],
        limit: options["--limit"] === undefined ? undefined : Number(options["--limit"]), offset: options["--offset"] === undefined ? undefined : Number(options["--offset"]) }); break;
    }
    case "show": result = review.show(kb, options["--id"]); break;
    case "dismiss": result = review.dismiss(kb, options["--id"]); break;
    case "stage": result = review.stage(kb, { title: options["--title"], target: options["--target"], body: readInput(options["--body"], review.MAX_BODY),
      packet: readInput(options["--packet"], MAX_PACKET_BYTES, true), issueId: options["--issue"] }); break;
    case "adopt": result = review.adopt(kb, options["--id"]); break;
    case "recover": result = review.recover(kb, options["--id"]); break;
    case "cancel": result = review.cancel(kb, options["--id"], { reason: options["--reason"] }); break;
    case "supersede": result = review.supersede(kb, options["--id"], options["--replacement"]); break;
    case "compact": result = review.compact(kb); break;
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    const allowed = new Set(["invalid_arguments", "input_too_large", "input_changed", "invalid_root", "invalid_schema_or_root", "unsafe_path", "symlink_refused",
      "invalid_parent", "state_too_large", "invalid_state", "review_locked", "lock_changed", "invalid_target", "invalid_path", "evidence_required",
      "evidence_changed_or_invalid", "review_limit", "not_found", "issue_already_resolved", "body_too_large", "body_frontmatter_not_allowed", "issue_not_open", "invalid_journal",
      "recovery_required", "publication_conflict", "target_changed", "target_path_collision", "index_managed_entry_changed", "target_is_evidence", "issue_changed",
      "candidate_not_ready", "replacement_target_mismatch", "invalid_review_history", "history_conflict", "review_history_limit", "metadata_budget_exceeded"]);
    const code = error.code || error.message;
    process.stderr.write(`${JSON.stringify({ ok: false, error: allowed.has(code) ? code : "review_failed" })}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main };
