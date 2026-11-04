"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const { copyFixture } = require("./helpers/copy-fixture");
const runtime = require("../../scripts/lib/markdown-runtime");
const state = require("../../scripts/lib/markdown-state");
const review = require("../../scripts/lib/skill-review");
const { withLock } = require("../../scripts/lib/skill-state-io");
const { sha256 } = require("../../scripts/lib/markdown-package");
const { search, verifyPacket } = require("../../scripts/lib/skill-retrieval");

const cli = path.resolve(__dirname, "../../scripts/markdown-cli.js");
const archive = path.resolve(__dirname, "../../scripts/archive.py");
function write(root, name, content) { const target = path.join(root, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content); }
function read(root, name) { return fs.readFileSync(path.join(root, name), "utf8"); }
function code(value) { return (error) => error.code === value; }
function fixture(t) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "markdown updates 中文 ")));
  t.after(() => fs.rmSync(temp, { force: true, recursive: true }));
  const kb = path.join(temp, "knowledge"), source = path.join(temp, "source notes");
  write(kb, ".wiki-schema.md", "# Schema\n"); write(kb, "index.md", "# Index\r\n\n手写索引。\n"); write(kb, "log.md", "# Log\n");
  write(source, "notes/a.md", "---\r\ntags: [Markdown]\r\n---\r\n# Markdown\r\n离线阅读。\r\n![图](../images/a.png)\r\n");
  write(source, "images/a.png", Buffer.from([0, 13, 10, 255]));
  const capture = (more = {}) => runtime.capture(kb, { sourceRoot: source, file: "notes/a.md", ...more });
  const publish = (captured = capture(), body = "# 摘要\n原文支持离线阅读。") => {
    const candidate = runtime.stage(kb, { id: captured.sourceId, revision: captured.binding.revision, body });
    review.adopt(kb, candidate.id); return { captured, candidate };
  };
  return { temp, kb, source, capture, publish };
}
function fileHashes(root, relative = "") {
  return Object.fromEntries(fs.readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap((entry) => {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    return entry.isDirectory() ? Object.entries(fileHashes(root, name)) : [[name, sha256(fs.readFileSync(path.join(root, name)))]];
  }));
}

test("capture is separate from publication; stable source and unchanged healthy results reuse all saved data", (t) => {
  const f = fixture(t), captured = f.capture();
  assert.equal(captured.status, "captured"); assert.match(captured.sourceId, /^md-[a-f0-9]{24}$/u);
  assert.equal(fs.existsSync(path.join(f.kb, captured.target)), false);
  const { candidate } = f.publish(captured);
  assert.equal(candidate.target, captured.target);
  assert.match(read(f.kb, candidate.target), /^---\ntype: source\nderived: true/u);
  const before = fileHashes(f.kb);
  assert.equal(f.capture().status, "reused");
  assert.equal(f.capture({ file: "./notes/a.md" }).sourceId, captured.sourceId);
  assert.deepEqual(fileHashes(f.kb), before);
  const same = runtime.stage(f.kb, { id: captured.sourceId, revision: captured.binding.revision, body: "# 摘要\n原文支持离线阅读。" });
  assert.equal(same.status, "reused"); assert.equal(same.id, candidate.id);
  const scanned = runtime.scan(f.kb, { sourceRoot: f.source });
  assert.equal(scanned.coverage.complete, true); assert.equal(scanned.counts.unchanged, 1);
  assert.deepEqual(fileHashes(f.kb), before, "scan must be read-only");
  assert.ok(!JSON.stringify(state.readRegistry(f.kb)).includes(f.source));
});

test("body and binary-only changes produce selected revision candidates while keeping summary path and history", (t) => {
  const f = fixture(t), first = f.publish();
  const oldPacket = first.candidate.packet;
  write(f.source, "images/a.png", Buffer.from([8, 7, 6, 5]));
  assert.equal(runtime.scan(f.kb, { sourceRoot: f.source }).counts.modified, 1);
  const imageUpdate = f.capture();
  assert.equal(imageUpdate.sourceId, first.captured.sourceId);
  assert.notEqual(imageUpdate.binding.revision, first.captured.binding.revision);
  assert.equal(read(f.kb, first.candidate.target), first.candidate.content);
  const second = f.publish(imageUpdate, "# 摘要\n图片版本已更新，支持离线阅读。");
  assert.equal(second.candidate.target, first.candidate.target);
  write(f.source, "notes/a.md", read(f.source, "notes/a.md").replace("离线阅读。", "离线阅读与协作。"));
  assert.equal(runtime.scan(f.kb, { sourceRoot: f.source }).counts.modified, 1);
  const third = f.publish(f.capture(), "# 摘要\n原文新增协作说明。");
  assert.equal(third.candidate.target, first.candidate.target);
  assert.equal(state.readRegistry(f.kb).sources[0].revisions.length, 3);
  assert.equal(verifyPacket(f.kb, oldPacket).ok, true, "explicit old evidence remains verifiable");
  const current = state.readAdoptions(f.kb).sources.get(first.captured.sourceId);
  assert.equal(current.binding.revision, third.captured.binding.revision);
});

test("unique rename retains source identity; deleted source stays archived and is never removed", (t) => {
  const f = fixture(t), first = f.publish();
  fs.renameSync(path.join(f.source, "notes/a.md"), path.join(f.source, "notes/改名.md"));
  const scanned = runtime.scan(f.kb, { sourceRoot: f.source });
  assert.equal(scanned.counts.renamed, 1); assert.equal(scanned.entries[0].sourceId, first.captured.sourceId);
  const next = f.capture({ file: "notes/改名.md" });
  assert.equal(next.sourceId, first.captured.sourceId);
  const adopted = f.publish(next);
  assert.equal(adopted.candidate.target, first.candidate.target);
  fs.unlinkSync(path.join(f.source, "notes/改名.md"));
  const before = fileHashes(f.kb);
  const missing = runtime.scan(f.kb, { sourceRoot: f.source });
  assert.equal(missing.counts.deleted, 1);
  assert.deepEqual(fileHashes(f.kb), before);
  assert.ok(fs.existsSync(path.join(f.kb, first.captured.binding.primaryPath)));
  assert.ok(fs.existsSync(path.join(f.kb, next.binding.primaryPath)));
});

test("duplicate-content rename is not guessed and explicit source selection resolves it", (t) => {
  const f = fixture(t), a = f.publish();
  write(f.source, "notes/b.md", read(f.source, "notes/a.md"));
  const b = f.publish(f.capture({ file: "notes/b.md" }));
  assert.notEqual(a.captured.sourceId, b.captured.sourceId);
  fs.unlinkSync(path.join(f.source, "notes/a.md")); fs.renameSync(path.join(f.source, "notes/b.md"), path.join(f.source, "notes/c.md"));
  const scanned = runtime.scan(f.kb, { sourceRoot: f.source });
  const found = scanned.entries.find((item) => item.path === "notes/c.md");
  assert.equal(found.status, "new"); assert.equal(found.reason, "ambiguous_rename"); assert.equal(found.choices.length, 2);
  assert.throws(() => f.capture({ file: "notes/c.md" }), code("ambiguous_source_identity"));
  assert.equal(f.capture({ file: "notes/c.md", id: a.captured.sourceId }).sourceId, a.captured.sourceId);
});

test("one missing source and two new identical files cannot transfer identity or manual notes implicitly", (t) => {
  const f = fixture(t), first = f.publish();
  const content = read(f.source, "notes/a.md"), manual = "\n保留在原始身份下的人工笔记。\n";
  write(f.kb, first.candidate.target, first.candidate.content.replace(state.DEFAULT_MANUAL, manual));
  fs.unlinkSync(path.join(f.source, "notes/a.md"));
  write(f.source, "notes/b.md", content); write(f.source, "notes/c.md", content);
  const scanned = runtime.scan(f.kb, { sourceRoot: f.source });
  assert.equal(scanned.counts.renamed || 0, 0);
  assert.equal(scanned.entries.filter((entry) => entry.reason === "ambiguous_rename").length, 2);
  const before = fileHashes(f.kb);
  assert.throws(() => f.capture({ file: "notes/b.md" }), code("ambiguous_source_identity"));
  assert.deepEqual(fileHashes(f.kb), before);
  assert.equal(state.readRegistry(f.kb).sources[0].inputPath, "notes/a.md");
  assert.equal(state.extractManual(read(f.kb, first.candidate.target)), manual);
  const selected = f.capture({ file: "notes/b.md", id: first.captured.sourceId });
  assert.equal(selected.sourceId, first.captured.sourceId);
  assert.equal(f.publish(selected).candidate.target, first.candidate.target);
  assert.equal(state.extractManual(read(f.kb, first.candidate.target)), manual);
});

test("incomplete inventory or source inspection never reports old sources as deleted", (t) => {
  const f = fixture(t); f.publish();
  fs.unlinkSync(path.join(f.source, "notes/a.md"));
  write(f.source, "notes/b.md", "# B\n"); write(f.source, "notes/c.md", "# C\n");
  const scanned = runtime.scan(f.kb, { sourceRoot: f.source, limits: { maxFiles: 1 } });
  assert.equal(scanned.coverage.complete, false); assert.equal(scanned.counts.deleted || 0, 0);
  assert.ok(scanned.entries.some((item) => item.sourceId && item.status === "unknown"));
});

test("scan byte limits include integrity verification of unchanged immutable packages", (t) => {
  const f = fixture(t); f.publish();
  const sourceBytes = runtime.inspect({ sourceRoot: f.source, file: "notes/a.md" }).coverage.totalBytes;
  const before = fileHashes(f.kb);
  const scanned = runtime.scan(f.kb, { sourceRoot: f.source, limits: { maxTotalBytes: sourceBytes } });
  assert.equal(scanned.coverage.complete, false);
  assert.equal(scanned.entries[0].status, "unknown");
  assert.equal(scanned.entries[0].reason, "scan_byte_limit");
  assert.deepEqual(fileHashes(f.kb), before);
});

test("manual notes preserve exact CRLF and decomposed Unicode across updates", (t) => {
  const f = fixture(t), first = f.publish();
  const manual = "\r\n## 人工补充\r\ne\u0301 与中文；不规范化。\r\n";
  const edited = first.candidate.content.replace(state.MANUAL_START + state.DEFAULT_MANUAL + state.MANUAL_END,
    state.MANUAL_START + manual + state.MANUAL_END);
  write(f.kb, first.candidate.target, edited);
  assert.equal(state.readAdoptions(f.kb).sources.get(first.captured.sourceId).healthy, true);
  write(f.source, "notes/a.md", read(f.source, "notes/a.md") + "\r\n新增观点。\r\n");
  const next = f.publish(f.capture(), "# 新摘要\n新增观点已整理。");
  assert.equal(state.extractManual(read(f.kb, next.candidate.target)), manual);
  assert.ok(read(f.kb, next.candidate.target).includes("e\u0301"));
});

test("literal source text that mentions control markers does not become a second editable region", (t) => {
  const f = fixture(t);
  write(f.source, "notes/a.md", `# Markdown\nExample: ${state.MANUAL_START}\n`);
  const first = f.publish();
  assert.ok(first.candidate.content.includes(`  Example: ${state.MANUAL_START}`));
  assert.equal(state.readAdoptions(f.kb).sources.get(first.captured.sourceId).healthy, true);
  assert.equal(f.capture().status, "reused");
});

test("unknown edits outside manual region and edits during staging preparation are never overwritten", (t) => {
  const f = fixture(t), first = f.publish();
  write(f.source, "notes/a.md", read(f.source, "notes/a.md") + "\n修改。\n");
  const captured = f.capture();
  const outside = first.candidate.content.replace("原文支持离线阅读。", "用户手写了不同结论。");
  write(f.kb, first.candidate.target, outside);
  assert.throws(() => runtime.stage(f.kb, { id: captured.sourceId, revision: captured.binding.revision, body: "新摘要" }), code("managed_summary_changed"));
  assert.equal(read(f.kb, first.candidate.target), outside);
  write(f.kb, first.candidate.target, first.candidate.content);
  const original = review.stage;
  review.stage = (root, input) => {
    write(root, first.candidate.target, first.candidate.content.replace(state.DEFAULT_MANUAL, "\n最后一刻的新笔记。\n"));
    return original(root, input);
  };
  try {
    assert.throws(() => runtime.stage(f.kb, { id: captured.sourceId, revision: captured.binding.revision, body: "新摘要" }), code("target_changed"));
  } finally { review.stage = original; }
  assert.ok(read(f.kb, first.candidate.target).includes("最后一刻的新笔记。"));
});

test("missing summary is needs-repair and can be rebuilt without creating a new raw revision", (t) => {
  const f = fixture(t), first = f.publish();
  fs.unlinkSync(path.join(f.kb, first.candidate.target));
  assert.equal(runtime.scan(f.kb, { sourceRoot: f.source }).counts["needs-repair"], 1);
  const captured = f.capture(); assert.equal(captured.status, "captured");
  assert.equal(captured.binding.revision, first.captured.binding.revision);
  const repaired = f.publish(captured);
  assert.equal(repaired.candidate.target, first.candidate.target);
  assert.equal(state.readRegistry(f.kb).sources[0].revisions.length, 1);
});

test("pending publication excludes mutation and read-only adoption falls back to last committed version", (t) => {
  const f = fixture(t), first = f.publish();
  write(f.source, "notes/a.md", read(f.source, "notes/a.md") + "\n新版本。\n");
  const captured = f.capture();
  const staged = runtime.stage(f.kb, { id: captured.sourceId, revision: captured.binding.revision, body: "新版本摘要" });
  assert.throws(() => review.adopt(f.kb, staged.id, { afterWrite: (step) => { if (step === 1) throw new Error("interrupt"); } }), /interrupt/u);
  const adoptions = state.readAdoptions(f.kb);
  assert.equal(adoptions.complete, false); assert.ok(adoptions.pendingIds.has(staged.id));
  assert.equal(adoptions.sources.get(first.captured.sourceId).binding.revision, first.captured.binding.revision);
  assert.throws(() => f.capture(), code("recovery_required"));
  review.recover(f.kb);
  assert.equal(state.readAdoptions(f.kb).sources.get(first.captured.sourceId).binding.revision, captured.binding.revision);
});

test("rehashing an altered journal write cannot certify committed or pending source adoption", (t) => {
  const f = fixture(t), first = f.publish();
  const relative = `.wiki-review/journals/${first.candidate.id}.json`;
  const journal = JSON.parse(read(f.kb, relative));
  journal.writes[1].content += "\nUnexpected rewritten index.\n";
  journal.writes[1].afterSha256 = sha256(journal.writes[1].content);
  for (const committed of [true, false]) {
    journal.committed = committed;
    write(f.kb, relative, JSON.stringify(journal));
    assert.throws(() => review.validateJournal(journal), code("invalid_journal"));
    const adoption = state.readAdoptions(f.kb);
    assert.equal(adoption.complete, false);
    assert.equal(adoption.sources.has(first.captured.sourceId), false);
    assert.equal(adoption.pendingIds.has(first.candidate.id), false);
  }
});

test("a damaged latest adoption never makes an older cold revision current", (t) => {
  const f = fixture(t), first = f.publish();
  write(f.source, "notes/a.md", read(f.source, "notes/a.md") + "\n更新的资料版本。\n");
  const second = f.publish(f.capture(), "# 新摘要\n资料版本已更新。");
  review.compact(f.kb);
  const current = state.readAdoptions(f.kb);
  assert.equal(current.complete, true);
  assert.equal(current.sources.get(first.captured.sourceId).candidate.id, second.candidate.id);
  write(f.kb, `.wiki-review/history/journals/${second.candidate.id}.json`, "{ damaged latest journal");
  const broken = state.readAdoptions(f.kb);
  assert.equal(broken.complete, false);
  assert.equal(broken.sources.has(first.captured.sourceId), false);
});

test("source adoption and a shared record reader charge history, journal and summary to one budget", (t) => {
  const f = fixture(t), first = f.publish();
  review.compact(f.kb);
  const history = require("../../scripts/lib/review-history");
  let used = 0;
  const readBinary = (relative, maximum) => {
    const file = require("../../scripts/lib/markdown-package").readSafeBinary(f.kb, relative, maximum);
    used += file.size; return file;
  };
  const records = history.readReviewRecords(f.kb, { readBinary });
  const adoptions = state.readAdoptions(f.kb, { records, readBinary });
  assert.equal(adoptions.complete, true);
  assert.equal(adoptions.sources.get(first.captured.sourceId).candidate.id, first.candidate.id);
  assert.equal(adoptions.metadataBytes, used);
  assert.equal(records.readJournal(first.candidate.id).committed, true);
  assert.equal(adoptions.metadataBytes, used, "a cached proof does not consume another IO budget");
});

test("registry, roots, concurrent locks and input-body errors fail safely", (t) => {
  const f = fixture(t);
  assert.throws(() => runtime.capture(f.kb, { sourceRoot: f.kb, file: "index.md" }), code("overlapping_roots"));
  assert.throws(() => f.capture({ file: "../other.md" }), code("unsafe_path"));
  assert.throws(() => f.capture({ file: "images/a.png" }), code("not_markdown"));
  withLock(f.kb, () => assert.throws(() => f.capture(), code("review_locked")));
  const captured = f.capture();
  assert.throws(() => runtime.stage(f.kb, { id: captured.sourceId, revision: captured.binding.revision, body: "---\nx: y\n---\nbody" }), code("invalid_summary_body"));
  write(f.kb, state.REGISTRY, "{}");
  assert.throws(() => runtime.scan(f.kb, { sourceRoot: f.source }), code("invalid_markdown_state"));
});

test("metadata budget includes journals and current summary; legacy low-level source candidates remain adopted", (t) => {
  const f = fixture(t), first = f.publish();
  const valid = state.readAdoptions(f.kb);
  assert.equal(valid.complete, true); assert.ok(valid.metadataBytes > Buffer.byteLength(read(f.kb, ".wiki-review/state.json")));
  const bounded = state.readAdoptions(f.kb, { maxMetadataBytes: 64 });
  assert.equal(bounded.complete, false); assert.equal(bounded.sources.size, 0);
  assert.ok(bounded.warnings.some((item) => item.code === "metadata_budget_exceeded"));
  const other = f.capture({ file: "notes/a.md" });
  const direct = review.stage(f.kb, { title: "直接来源摘要", target: first.candidate.target, body: "普通正文没有 Runtime 标记。",
    packet: search(f.kb, { mode: "raw", query: "a", paths: [other.binding.primaryPath] }), markdownSource: other.binding });
  review.adopt(f.kb, direct.id);
  const record = state.readAdoptions(f.kb).sources.get(first.captured.sourceId);
  assert.equal(record.candidate.id, direct.id); assert.equal(record.healthy, false);
});

test("selected-source metadata reads fit one current journal without rereading adopted history", (t) => {
  const f = fixture(t), first = f.publish();
  write(f.source, "notes/a.md", read(f.source, "notes/a.md") + "\n第二版。\n");
  const second = f.publish(f.capture(), "第二版摘要。");
  write(f.source, "notes/b.md", "# Other source\n其他资料。\n");
  f.publish(f.capture({ file: "notes/b.md" }), "其他资料摘要。");
  const records = require("../../scripts/lib/review-history").readReviewRecords(f.kb);
  const journal = records.index.entries.find((entry) => entry.id === second.candidate.id).journal.path;
  const budget = records.metadataBytes + [journal, second.candidate.target]
    .reduce((sum, relative) => sum + fs.statSync(path.join(f.kb, relative)).size, 0);
  const selected = state.readAdoptions(f.kb, { sourceIds: [first.captured.sourceId], maxMetadataBytes: budget });
  assert.equal(selected.complete, true);
  assert.equal(selected.metadataBytes, budget);
  assert.equal(selected.sources.get(first.captured.sourceId).candidate.id, second.candidate.id);
  assert.equal(selected.candidates.length, 2, "old identity metadata remains available without old journal IO");
  assert.equal(state.readAdoptions(f.kb, { maxMetadataBytes: budget }).complete, false);
  assert.equal(f.capture().status, "reused");
});

test("actual CLI supports source lifecycle and never prints absolute authorized roots", (t) => {
  const f = fixture(t);
  const run = (...args) => spawnSync(process.execPath, [cli, ...args, "--json"], { encoding: "utf8", timeout: 10_000 });
  let result = run("inspect", "--source-root", f.source, "--file", "notes/a.md");
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).coverage.complete, true);
  assert.ok(!result.stdout.includes(f.source));
  result = run("capture", f.kb, "--source-root", f.source, "--file", "notes/a.md");
  assert.equal(result.status, 0, result.stderr); const captured = JSON.parse(result.stdout);
  const body = path.join(f.temp, "摘要.md"); fs.writeFileSync(body, "# 新摘要\n离线阅读。\n");
  result = run("stage", f.kb, "--id", captured.sourceId, "--revision", captured.binding.revision, "--body", body);
  assert.equal(result.status, 0, result.stderr); const candidate = JSON.parse(result.stdout);
  review.adopt(f.kb, candidate.id);
  result = run("scan", f.kb, "--source-root", f.source);
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).counts.unchanged, 1);
  for (const args of [["capture", f.kb, "--source-root", f.source], ["scan", f.kb, "--source-root", f.source, "--unexpected", f.source]]) {
    result = run(...args); assert.notEqual(result.status, 0); assert.equal(JSON.parse(result.stderr).error, "invalid_arguments");
    assert.ok(!result.stderr.includes(f.source));
  }
});

test("archive restore retains source identity and explicitly rebinds a relocated source root", { timeout: 30_000 }, (t) => {
  const f = fixture(t), first = f.publish();
  const python = ["python3", "python"].find((cmd) => spawnSync(cmd, ["-c", "import sys; sys.exit(0 if sys.version_info >= (3,8) else 1)"], { encoding: "utf8" }).status === 0);
  assert.ok(python);
  const zip = path.join(f.temp, "archive.zip"), restored = path.join(f.temp, "restored"), relocated = path.join(f.temp, "new root");
  for (const args of [["export", f.kb, "--output", zip], ["restore", zip, "--target", restored]]) {
    const result = spawnSync(python, [archive, ...args, "--json"], { encoding: "utf8", timeout: 15_000, env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
  copyFixture(f.source, relocated);
  const scan = runtime.scan(restored, { sourceRoot: relocated, collection: first.captured.collectionId });
  assert.equal(scan.requiresRebind, true); assert.equal(scan.counts.unchanged, 1);
  const rebound = runtime.capture(restored, { sourceRoot: relocated, file: "notes/a.md", collection: first.captured.collectionId });
  assert.equal(rebound.sourceId, first.captured.sourceId); assert.equal(rebound.status, "reused");
  assert.equal(runtime.scan(restored, { sourceRoot: relocated }).counts.unchanged, 1);
  assert.ok(!read(restored, state.REGISTRY).includes(relocated));
});
