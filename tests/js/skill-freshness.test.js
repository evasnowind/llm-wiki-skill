"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const { scanFreshness } = require("../../scripts/lib/skill-freshness");
const { track } = require("../../scripts/freshness-cli");
const runtime = require("../../scripts/lib/markdown-runtime");
const review = require("../../scripts/lib/skill-review");
const { search, verifyPacket } = require("../../scripts/lib/skill-retrieval");
const { DEFAULT_MANUAL } = require("../../scripts/lib/markdown-state");
const { sha256 } = require("../../scripts/lib/markdown-package");

function write(root, relative, value) { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); }
function fixture(t) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "skill freshness 中文 "))), kb = path.join(temp, "kb"), source = path.join(temp, "input");
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  write(kb, ".wiki-schema.md", "# Schema\n"); write(kb, "index.md", "# Index\n"); write(kb, "log.md", "# Log\n");
  write(source, "note.md", "# Markdown\r\n可靠的本地资料。\r\n![图](image.bin)\r\n");
  write(source, "image.bin", Buffer.from([0, 255, 13, 10]));
  function publishSource(body = "# 资料摘要\n可靠资料的摘要。\n") {
    const captured = runtime.capture(kb, { sourceRoot: source, file: "note.md" });
    const candidate = runtime.stage(kb, { id: captured.sourceId, revision: captured.binding.revision, body });
    review.adopt(kb, candidate.id); return { captured, candidate };
  }
  function research(packet, target = "wiki/synthesis/report.md", body = "# 研究报告\n可靠资料支持此报告。\n") {
    const candidate = review.stage(kb, { title: "研究报告", target, body, packet });
    review.adopt(kb, candidate.id); return candidate;
  }
  return { temp, kb, source, publishSource, research };
}
function page(report, relative) { const found = report.pages.find((item) => item.path === relative); assert.ok(found, relative); return found; }
function snapshot(root) {
  function walk(relative = "") { return fs.readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap((entry) => {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    return entry.isDirectory() ? walk(name) : [[name, sha256(fs.readFileSync(path.join(root, name)))]];
  }); }
  return Object.fromEntries(walk());
}

test("source and research baselines are current; captured but unadopted packages do not supersede them", (t) => {
  const f = fixture(t), first = f.publishSource(), report = f.research(first.candidate.packet);
  const before = snapshot(f.kb);
  const initial = scanFreshness(f.kb);
  assert.equal(initial.coverage.complete, true, JSON.stringify(initial.coverage));
  assert.equal(page(initial, first.candidate.target).status, "current");
  assert.equal(page(initial, report.target).status, "current");
  assert.deepEqual(snapshot(f.kb), before);
  write(f.source, "image.bin", Buffer.from([9, 8, 7, 6]));
  const pending = runtime.capture(f.kb, { sourceRoot: f.source, file: "note.md" });
  assert.notEqual(pending.binding.revision, first.captured.binding.revision);
  assert.equal(page(scanFreshness(f.kb), report.target).status, "current");
});

test("attachment-only adoption makes old direct references stale while exact old evidence still verifies", (t) => {
  const f = fixture(t), first = f.publishSource(), report = f.research(first.candidate.packet);
  write(f.source, "image.bin", Buffer.from([3, 4, 5, 6]));
  const second = f.publishSource("# 资料摘要\n附件已更新。\n");
  assert.equal(first.captured.binding.primarySha256, second.captured.binding.primarySha256);
  assert.equal(verifyPacket(f.kb, first.candidate.packet).ok, true);
  const result = scanFreshness(f.kb), stale = page(result, report.target);
  assert.equal(stale.status, "stale");
  const dependency = stale.dependencies.find((item) => item.reason === "source_revision_superseded");
  assert.equal(dependency.usedRevision, first.captured.binding.revision);
  assert.equal(dependency.currentRevision, second.captured.binding.revision);
  assert.equal(page(result, second.candidate.target).status, "current");
});

test("unchanged report bytes propagate only potential impact through two links and cycles terminate", (t) => {
  const f = fixture(t), first = f.publishSource(), report = f.research(first.candidate.packet);
  const packet = search(f.kb, { query: "报告", mode: "wiki", paths: [report.target] });
  const downstream = f.research(packet, "wiki/synthesis/downstream.md");
  write(f.kb, "wiki/topics/handwritten.md", `# 手写\n[[${downstream.target}]]\n`);
  write(f.kb, "wiki/topics/cycle-a.md", "# A\n[[wiki/topics/cycle-b.md]]\n");
  write(f.kb, "wiki/topics/cycle-b.md", "# B\n[[wiki/topics/cycle-a.md]]\n");
  write(f.source, "note.md", "# Markdown\n新版本资料。\n![图](image.bin)\n"); f.publishSource();
  const result = scanFreshness(f.kb);
  assert.equal(page(result, report.target).status, "stale");
  const indirect = page(result, downstream.target);
  assert.equal(indirect.status, "potential");
  assert.ok(indirect.impacts.some((item) => item.via[0] === report.target));
  assert.equal(page(result, "wiki/topics/handwritten.md").status, "potential");
  assert.equal(page(result, "wiki/topics/cycle-a.md").status, "untracked");
});

test("handwritten source declarations are potential and ambiguous bare links never guess targets", (t) => {
  const f = fixture(t), first = f.publishSource();
  write(f.kb, "wiki/topics/manual.md", `---\nsources:\n  - ${JSON.stringify(first.captured.binding.primaryPath)}\n---\n# 手写\n`);
  write(f.kb, "wiki/topics/ambiguous.md", "# 索引\n[[duplicate]]\n");
  write(f.kb, "wiki/a/duplicate.md", "# A\n"); write(f.kb, "wiki/b/duplicate.md", "# B\n");
  const result = scanFreshness(f.kb);
  assert.equal(page(result, "wiki/topics/manual.md").status, "potential");
  const ambiguous = page(result, "wiki/topics/ambiguous.md");
  assert.equal(ambiguous.status, "unknown");
  assert.equal(ambiguous.dependencies[0].reason, "ambiguous_reference");
  assert.ok(!ambiguous.dependencies[0].path);
});

test("external page edits lose adopted provenance while the explicit manual source region remains valid", (t) => {
  const f = fixture(t), first = f.publishSource(), report = f.research(first.candidate.packet);
  const notes = "\r\n私人补充 cafe\u0301\r\n";
  write(f.kb, first.candidate.target, first.candidate.content.replace(DEFAULT_MANUAL, notes));
  assert.equal(page(scanFreshness(f.kb), first.candidate.target).status, "current");
  fs.appendFileSync(path.join(f.kb, report.target), "用户在正式报告之外追加了内容。\n");
  const changed = page(scanFreshness(f.kb), report.target);
  assert.equal(changed.status, "unknown"); assert.equal(changed.reason, "page_changed_outside_review");
});

test("missing and changed cited bytes require review rather than a current claim", (t) => {
  const f = fixture(t);
  write(f.kb, "raw/notes/plain.md", "# 原文\n可靠资料。\n");
  const report = f.research(search(f.kb, { mode: "raw", query: "可靠", paths: ["raw/notes/plain.md"] }));
  write(f.kb, "raw/notes/plain.md", "# 原文\n已经变化。\n");
  assert.equal(page(scanFreshness(f.kb), report.target).status, "stale");
  fs.unlinkSync(path.join(f.kb, "raw/notes/plain.md"));
  assert.equal(page(scanFreshness(f.kb), report.target).status, "unknown");
});

test("corrupt registries, journals and package assets never certify current sources", (t) => {
  for (const damage of ["registry", "journal", "asset"]) {
    const f = fixture(t), first = f.publishSource(), report = f.research(first.candidate.packet);
    if (damage === "registry") write(f.kb, ".wiki-review/markdown-sources.json", "{broken");
    if (damage === "journal") write(f.kb, `.wiki-review/journals/${first.candidate.id}.json`, "{broken");
    if (damage === "asset") write(f.kb, first.captured.binding.primaryPath.replace("/note.md", "/image.bin"), Buffer.from([9, 9, 9, 9]));
    const result = scanFreshness(f.kb);
    assert.equal(result.coverage.complete, false, damage);
    assert.notEqual(page(result, report.target).status, "current", damage);
  }
});

test("pending publication and bounded metadata, file and package IO cannot appear fully current", (t) => {
  const f = fixture(t), first = f.publishSource();
  write(f.source, "note.md", "# Markdown\n发生变化。\n![图](image.bin)\n");
  const capture = runtime.capture(f.kb, { sourceRoot: f.source, file: "note.md" });
  const candidate = runtime.stage(f.kb, { id: capture.sourceId, revision: capture.binding.revision, body: "新摘要" });
  assert.throws(() => review.adopt(f.kb, candidate.id, { afterWrite: (step) => { if (step === 1) throw new Error("interrupt"); } }), /interrupt/);
  const pending = scanFreshness(f.kb);
  assert.equal(pending.coverage.complete, false);
  assert.equal(page(pending, first.candidate.target).status, "unknown");
  review.recover(f.kb);
  write(f.kb, "wiki/topics/extra.md", "# 额外页\n");
  for (const limits of [{ maxMetadataBytes: 1 }, { maxTotalBytes: 8 }, { maxFiles: 1 }]) {
    const limited = scanFreshness(f.kb, { limits });
    assert.equal(limited.coverage.complete, false, JSON.stringify(limits));
    assert.ok(limited.pages.every((item) => item.status !== "current"));
  }
});

test("explicit tracking is idempotent by versions and refuses scan-to-write edits", (t) => {
  const f = fixture(t), first = f.publishSource(), report = f.research(first.candidate.packet);
  write(f.source, "image.bin", Buffer.from([7, 7, 7, 7])); f.publishSource();
  const before = [report.target, "index.md", "log.md"].map((name) => fs.readFileSync(path.join(f.kb, name)));
  const tracked = track(f.kb, [report.target]);
  assert.equal(tracked.issues.length, 1);
  assert.equal(track(f.kb, [report.target]).issues[0].issue.id, tracked.issues[0].issue.id);
  assert.deepEqual([report.target, "index.md", "log.md"].map((name) => fs.readFileSync(path.join(f.kb, name))), before);
  write(f.source, "image.bin", Buffer.from([6, 6, 6, 6])); f.publishSource();
  assert.notEqual(track(f.kb, [report.target]).issues[0].issue.id, tracked.issues[0].issue.id);
  assert.throws(() => track(f.kb, [report.target], { scan(root, options) {
    const result = scanFreshness(root, options);
    fs.appendFileSync(path.join(root, report.target), "concurrent edit\n"); return result;
  } }), { code: "issue_changed" });
});

test("history compaction preserves freshness and tracking baselines", (t) => {
  const f = fixture(t), first = f.publishSource(), report = f.research(first.candidate.packet);
  write(f.source, "image.bin", Buffer.from([1, 2, 3, 4])); f.publishSource();
  const before = scanFreshness(f.kb, { paths: [report.target] });
  review.compact(f.kb);
  const after = scanFreshness(f.kb, { paths: [report.target] });
  assert.equal(page(after, report.target).status, "stale");
  assert.equal(page(before, report.target).fingerprint, page(after, report.target).fingerprint);
  assert.equal(after.coverage.complete, true, JSON.stringify(after.coverage));
});

test("retrieval reports freshness separately, keeps old verification and stays within its output budget", (t) => {
  const f = fixture(t), first = f.publishSource(), report = f.research(first.candidate.packet);
  write(f.source, "image.bin", Buffer.from([8, 1, 8, 1])); f.publishSource();
  const before = snapshot(f.kb);
  const packet = search(f.kb, { mode: "wiki", query: "报告", paths: [report.target] });
  assert.equal(packet.evidence[0].path, report.target);
  assert.equal(packet.freshness.pages[0].status, "stale");
  assert.equal(verifyPacket(f.kb, packet).ok, true);
  assert.equal(verifyPacket(f.kb, first.candidate.packet).ok, true);
  const old = search(f.kb, { mode: "raw", query: "可靠", paths: [first.captured.binding.primaryPath] });
  assert.equal(old.freshness.pages[0].status, "stale");
  assert.equal(verifyPacket(f.kb, old).ok, true);
  const small = search(f.kb, { mode: "wiki", query: "报告", paths: [report.target], limits: { maxOutputChars: 4096 } });
  assert.ok(JSON.stringify(small).length <= 4096);
  assert.deepEqual(snapshot(f.kb), before);
});

test("tracking refuses to silently truncate more than fifty persistent dependency bindings", (t) => {
  const f = fixture(t);
  for (let index = 0; index < 50; index += 1) write(f.kb, `raw/notes/${index}.md`, "# 原文\n可靠资料。\n");
  const report = f.research(search(f.kb, { mode: "raw", query: "可靠" }));
  write(f.kb, "raw/notes/0.md", "# 变化\n");
  const result = track(f.kb, [report.target]);
  assert.equal(result.issues.length, 0);
  assert.equal(result.skipped[0].reason, "tracking_path_limit");
  assert.equal(result.coverage.complete, false);
  assert.equal(review.loadState(f.kb).issues.length, 0);
});

test("damaged cold records and a modified latest adoption cannot downgrade to an older current version", (t) => {
  const f = fixture(t), first = f.publishSource(), report = f.research(first.candidate.packet);
  write(f.source, "image.bin", Buffer.from([4, 3, 2, 1])); const latest = f.publishSource();
  review.compact(f.kb);
  const index = JSON.parse(fs.readFileSync(path.join(f.kb, ".wiki-review/history/index.json"), "utf8"));
  const descriptor = index.entries.find((item) => item.id === latest.candidate.id);
  assert.ok(descriptor?.journal);
  write(f.kb, descriptor.journal.path, "{broken");
  const result = scanFreshness(f.kb, { paths: [report.target] });
  assert.equal(result.coverage.complete, false);
  assert.equal(page(result, report.target).status, "unknown");
});

test("selected paths stay scoped; unsafe paths, symlinks, bad encodings and output limits are explicit", (t) => {
  const f = fixture(t);
  write(f.kb, "wiki/topics/plain.md", "# 原文\n可靠资料。\n");
  write(f.kb, "wiki/topics/bad.md", Buffer.from([0xff]));
  const scoped = scanFreshness(f.kb, { paths: ["wiki/topics/plain.md"] });
  assert.equal(scoped.coverage.filesRead, 1); assert.equal(scoped.coverage.entriesRead, 0);
  assert.equal(scoped.coverage.complete, true);
  assert.equal(page(scanFreshness(f.kb), "wiki/topics/bad.md").status, "unknown");
  for (const relative of ["../outside.md", "wiki/../x.md", "C:/secret.md", "wiki\\x.md", "wiki/x.md\0"]) assert.throws(() => scanFreshness(f.kb, { paths: [relative] }));
  fs.symlinkSync(f.source, path.join(f.kb, "wiki/linked"), process.platform === "win32" ? "junction" : "dir");
  assert.equal(scanFreshness(f.kb).coverage.complete, false);
  for (let index = 0; index < 50; index += 1) write(f.kb, `wiki/topics/long-${index}.md`, `# ${"名".repeat(100)}\n`);
  const limited = scanFreshness(f.kb, { limits: { maxOutputChars: 4096 } });
  assert.ok(JSON.stringify(limited).length <= 4096); assert.equal(limited.coverage.complete, false);
});

test("actual CLI emits portable JSON, stays read-only on scan and validates unsupported flags", (t) => {
  const f = fixture(t); f.publishSource();
  const cli = path.resolve(__dirname, "../../scripts/freshness-cli.js");
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 20_000,
    env: { ...process.env, HOME: f.temp, USERPROFILE: f.temp } });
  const before = snapshot(f.kb), result = run("scan", f.kb, "--json");
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).coverage.complete, true);
  assert.ok(!result.stdout.includes(f.temp)); assert.deepEqual(snapshot(f.kb), before);
  for (const args of [["scan", f.kb, "--wat"], ["track", f.kb, "--json"], ["track", f.kb, "--path", "raw/a.md"]]) {
    const failed = run(...args); assert.notEqual(failed.status, 0); assert.equal(JSON.parse(failed.stderr).error, "invalid_arguments");
  }
});
