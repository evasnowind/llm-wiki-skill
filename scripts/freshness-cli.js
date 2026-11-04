#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { scanFreshness, checkedPage } = require("./lib/skill-freshness");

const usage = `Knowledge freshness (local only)
  scan <kb> [--path wiki/...md|raw/...md ...]
  track <kb> --path wiki/...md [--path wiki/...md ...]
All commands accept --json. scan is read-only; track explicitly adds Review issues.
`;
function invalid() { throw Object.assign(new Error("invalid_arguments"), { code: "invalid_arguments" }); }

function track(kbRoot, paths, { scan = scanFreshness } = {}) {
  if (!Array.isArray(paths) || !paths.length || paths.length > 50) invalid();
  paths.forEach((relative) => { checkedPage(relative); if (!relative.startsWith("wiki/")) invalid(); });
  const report = scan(kbRoot, { paths }), review = require("./lib/skill-review");
  const issues = [], skipped = [];
  for (const page of report.pages) {
    if (!["stale", "potential"].includes(page.status)) { skipped.push({ path: page.path, status: page.status }); continue; }
    const expectedPaths = [...page.expectedPaths].map(([name, sha256]) => ({ path: name, sha256 })).sort((a, b) => a.path.localeCompare(b.path));
    const preferred = [page.path, ...page.dependencies.map((item) => item.currentSource).filter(Boolean), ...expectedPaths.map((item) => item.path)];
    const issuePaths = [...new Set(preferred)];
    if (issuePaths.length > 50) {
      report.coverage.complete = false;
      report.coverage.reasons.push({ code: "tracking_path_limit", path: page.path });
      skipped.push({ path: page.path, status: page.status, reason: "tracking_path_limit" }); continue;
    }
    const reasons = [...new Set([page.reason, ...page.dependencies.map((item) => item.reason), ...page.impacts.map((item) => item.reason)].filter(Boolean))];
    const reason = `Freshness ${page.fingerprint}: ${page.status}. ${reasons.join(", ")}`.slice(0, 4000);
    const issue = review.add(kbRoot, { type: "unverified", title: `资料更新待复核：${path.posix.basename(page.path)}`.slice(0, 240),
      reason, paths: issuePaths, expectedPaths });
    issues.push({ path: page.path, issue });
  }
  for (const relative of paths) if (!report.pages.some((item) => item.path === relative)) skipped.push({ path: relative, status: "unknown", reason: "freshness_output_limit" });
  return { version: 1, scope: report.scope, coverage: report.coverage, issues, skipped };
}

function main(argv) {
  if (argv.length === 1 && argv[0] === "--help") { process.stdout.write(usage); return; }
  const [command, kb, ...rest] = argv;
  if (!["scan", "track"].includes(command) || !kb || kb.startsWith("--")) invalid();
  const paths = []; let json = false;
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === "--json") { if (json) invalid(); json = true; continue; }
    if (rest[index] !== "--path" || !rest[index + 1] || rest[index + 1].startsWith("--")) invalid();
    paths.push(rest[++index]);
  }
  const result = command === "track" ? track(kb, paths) : scanFreshness(kb, paths.length ? { paths } : {});
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    const allowed = new Set(["invalid_arguments", "invalid_path", "invalid_paths", "invalid_limit", "invalid_source_root", "invalid_schema_or_root", "unsafe_path",
      "symlink_refused", "invalid_parent", "invalid_utf8", "metadata_budget_exceeded", "freshness_byte_limit", "freshness_file_limit",
      "review_locked", "recovery_required", "issue_changed", "invalid_state", "review_limit", "invalid_review_history", "history_conflict"]);
    const code = error.code || error.message;
    process.stderr.write(`${JSON.stringify({ ok: false, error: allowed.has(code) ? code : "freshness_failed" })}\n`);
    process.exitCode = 1;
  }
}
module.exports = { main, track };
