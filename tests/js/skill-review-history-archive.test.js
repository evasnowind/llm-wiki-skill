"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { test } = require("node:test");
const { spawnSync } = require("node:child_process");
const review = require("../../scripts/lib/skill-review");
const records = require("../../scripts/lib/review-records");
const history = require("../../scripts/lib/review-history");
const markdown = require("../../scripts/lib/markdown-runtime");
const { MANUAL_START } = require("../../scripts/lib/markdown-state");
const { search } = require("../../scripts/lib/skill-retrieval");

const python = ["python3", "python"].find((command) => spawnSync(command, ["-c", "import sys;sys.exit(0 if sys.version_info >= (3,8) else 1)"], { encoding: "utf8" }).status === 0);
assert.ok(python, "Python 3.8+ is required");
const cli = path.resolve(__dirname, "../../scripts/archive.py");
const sha = (data) => crypto.createHash("sha256").update(data).digest("hex");
const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const readJson = (filename) => JSON.parse(fs.readFileSync(filename));

function fixture(t) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "review history archive 中文 ")));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const kb = path.join(temp, "knowledge"), source = path.join(temp, "source");
  fs.mkdirSync(path.join(kb, "raw/notes"), { recursive: true });
  fs.mkdirSync(path.join(kb, "wiki/synthesis"), { recursive: true });
  fs.mkdirSync(source);
  for (const [relative, body] of Object.entries({ ".wiki-schema.md": "# Schema\n", "index.md": "# Index\n", "log.md": "# Log\n", "raw/notes/input.md": "# Markdown\r\n可离线保留原文。\r\n" })) fs.writeFileSync(path.join(kb, relative), body);
  const packet = search(kb, { mode: "raw", query: "Markdown" });
  const stage = (input = {}) => review.stage(kb, { title: "研究", target: "wiki/synthesis/research.md", body: "# 研究\n可离线保存。\n", packet, ...input });
  const run = (...args) => spawnSync(python, ["-B", cli, ...args, "--json"], { encoding: "utf8", timeout: 25_000, env: { ...process.env, PYTHONIOENCODING: "utf-8", HOME: temp, USERPROFILE: temp } });
  const ok = (...args) => {
    const result = run(...args);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };
  const reject = (...args) => {
    const result = run(...args);
    assert.notEqual(result.status, 0, result.stdout);
    assert.ok(!result.stderr.includes(temp));
    return JSON.parse(result.stderr).error;
  };
  return { temp, kb, source, packet, stage, run, ok, reject };
}

function zipEntries(filename) {
  const script = "import sys,zipfile,json,base64;z=zipfile.ZipFile(sys.argv[1]);print(json.dumps([{'name':i.filename,'data':base64.b64encode(z.read(i)).decode(),'mode':i.external_attr} for i in z.infolist()]))";
  const result = spawnSync(python, ["-c", script, filename], { encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function writeZip(filename, entries) {
  const script = "import sys,zipfile,json,base64\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n for e in json.loads(sys.stdin.buffer.read().decode('utf-8')):\n  i=zipfile.ZipInfo(e['name']);i.filename=e['name'];i.orig_filename=e['name'];i.external_attr=e.get('mode',0);z.writestr(i,base64.b64decode(e['data']))\n";
  const result = spawnSync(python, ["-c", script, filename], { input: JSON.stringify(entries), encoding: "utf8", timeout: 10_000, env: { ...process.env, PYTHONIOENCODING: "ascii:surrogateescape" } });
  assert.equal(result.status, 0, result.stderr);
}

function entryJson(entries, name) {
  return JSON.parse(Buffer.from(entries.find((entry) => entry.name === name).data, "base64"));
}

function replaceFile(entries, name, data) {
  const entry = entries.find((item) => item.name === name);
  if (entry) entry.data = data.toString("base64");
  else entries.push({ name, data: data.toString("base64") });
  const manifestEntry = entries.find((item) => item.name === "archive-manifest.json");
  const manifest = entryJson(entries, manifestEntry.name);
  const record = manifest.files.find((item) => item.path === name);
  if (record) Object.assign(record, { size: data.length, sha256: sha(data) });
  else manifest.files.push({ path: name, size: data.length, sha256: sha(data) });
  manifestEntry.data = json(manifest).toString("base64");
}

function replaceCold(entries, descriptor, value, journal = false) {
  const data = json(value), target = journal ? descriptor.journal : descriptor;
  replaceFile(entries, target.path, data);
  const index = entryJson(entries, history.HISTORY_INDEX);
  const record = index.entries.find((item) => item.id === descriptor.id);
  Object.assign(journal ? record.journal : record, { size: data.length, sha256: sha(data) });
  replaceFile(entries, history.HISTORY_INDEX, json(index));
}

test("released v1 hot archives retain original IDs and legacy journals across restore and later cold-backed updates", (t) => {
  const f = fixture(t), first = f.stage();
  review.adopt(f.kb, first.id);
  const journalPath = path.join(f.kb, `.wiki-review/journals/${first.id}.json`);
  const journal = readJson(journalPath);
  const before = JSON.parse(journal.writes[3].beforeContent);
  delete journal.indexFormat;
  journal.writes[1].content = records.updatedIndex({ content: journal.writes[1].beforeContent }, before, journal.candidate, "markdown-v1");
  journal.writes[1].afterSha256 = sha(journal.writes[1].content);
  records.validateJournal(journal);
  fs.writeFileSync(journalPath, json(journal));
  fs.writeFileSync(path.join(f.kb, "index.md"), journal.writes[1].content);
  const originalJournal = fs.readFileSync(journalPath), zip = path.join(f.temp, "legacy.zip"), restored = path.join(f.temp, "legacy-restored");
  f.ok("export", f.kb, "--output", zip); f.ok("verify", zip); f.ok("restore", zip, "--target", restored);
  assert.deepEqual(fs.readFileSync(path.join(restored, `.wiki-review/journals/${first.id}.json`)), originalJournal);
  assert.equal(review.show(restored, first.id).id, first.id);
  const second = review.stage(restored, { title: "研究", target: first.target, body: "更新研究结果。\n", packet: f.packet });
  review.adopt(restored, second.id);
  const next = readJson(path.join(restored, `.wiki-review/journals/${second.id}.json`));
  assert.equal(next.previousCandidate.id, first.id);
  assert.equal((fs.readFileSync(path.join(restored, "index.md"), "utf8").match(/review-target:/g) || []).length, 1);
  const updated = path.join(f.temp, "updated.zip"); f.ok("export", restored, "--output", updated); f.ok("verify", updated);
  const entries = zipEntries(updated), journalName = `.wiki-review/journals/${second.id}.json`;
  const forged = entryJson(entries, journalName);
  forged.previousCandidate.adoptedAt = "2000-01-01T00:00:00.000Z";
  replaceFile(entries, journalName, json(forged));
  const invalid = path.join(f.temp, "previous-mismatch.zip"); writeZip(invalid, entries);
  assert.equal(f.reject("verify", invalid), "invalid_review_journal");
});

test("real cancel, supersede, adopted history and closed issues round-trip without changing unadopted formal files", (t) => {
  const f = fixture(t), issue = review.add(f.kb, { type: "unverified", title: "待确认", reason: "核对原文", paths: ["raw/notes/input.md"], packet: f.packet });
  const originalIndex = fs.readFileSync(path.join(f.kb, "index.md")), originalLog = fs.readFileSync(path.join(f.kb, "log.md"));
  const cancelled = f.stage({ target: "wiki/synthesis/cancelled.md", issueId: issue.id });
  review.cancel(f.kb, cancelled.id, { reason: "保留草稿但取消采用" });
  const old = f.stage({ body: "较早草稿" }), replacement = f.stage({ body: "更新草稿" });
  review.supersede(f.kb, old.id, replacement.id);
  review.dismiss(f.kb, issue.id);
  review.compact(f.kb);
  assert.deepEqual(fs.readFileSync(path.join(f.kb, "index.md")), originalIndex);
  assert.deepEqual(fs.readFileSync(path.join(f.kb, "log.md")), originalLog);
  assert.equal(fs.existsSync(path.join(f.kb, cancelled.target)), false);
  const adopted = f.stage({ target: "wiki/synthesis/adopted.md", body: "采用此篇。" }); review.adopt(f.kb, adopted.id); review.compact(f.kb);
  const zip = path.join(f.temp, "history.zip"), restored = path.join(f.temp, "history-restored");
  f.ok("export", f.kb, "--output", zip); f.ok("verify", zip); f.ok("restore", zip, "--target", restored);
  assert.equal(review.show(restored, cancelled.id).status, "cancelled");
  assert.equal(review.show(restored, old.id).supersededBy, replacement.id);
  assert.equal(review.show(restored, replacement.id).status, "ready");
  assert.equal(review.show(restored, issue.id).status, "dismissed");
  assert.equal(review.show(restored, adopted.id).status, "adopted");
  assert.throws(() => review.adopt(restored, cancelled.id));
  assert.throws(() => review.adopt(restored, old.id));
  const view = history.readReviewRecords(restored); assert.equal(view.complete, true);
  assert.equal(view.readJournal(adopted.id).committed, true);
  assert.deepEqual(review.recover(restored).recovered, []);
});

test("indexed compact overlap is safe; conflicting parsed record order is refused; pre-index copies require retry", (t) => {
  for (const label of ["index", "state"]) {
    const f = fixture(t), adopted = f.stage(); review.adopt(f.kb, adopted.id);
    assert.throws(() => review.compact(f.kb, { afterWrite(_index, boundary) { if (boundary === label) throw new Error("power loss"); } }), /power loss/);
    const zip = path.join(f.temp, `${label}.zip`); f.ok("export", f.kb, "--output", zip); f.ok("verify", zip);
    review.compact(f.kb);
    assert.equal(history.readReviewRecords(f.kb).complete, true);
  }
  const f = fixture(t), adopted = f.stage(); review.adopt(f.kb, adopted.id);
  assert.throws(() => review.compact(f.kb, { afterWrite(_index, boundary) { if (boundary === `record:${adopted.id}`) throw new Error("power loss"); } }), /power loss/);
  assert.equal(f.reject("export", f.kb, "--output", path.join(f.temp, "orphan.zip")), "invalid_review_history");
  review.compact(f.kb);
  const index = readJson(path.join(f.kb, history.HISTORY_INDEX));
  const record = readJson(path.join(f.kb, index.entries.find((item) => item.id === adopted.id).path));
  const reordered = { status: record.status, ...record };
  fs.writeFileSync(path.join(f.kb, ".wiki-review/state.json"), json({ version: 1, issues: [], candidates: [reordered] }));
  assert.equal(f.reject("export", f.kb, "--output", path.join(f.temp, "conflict.zip")), "history_conflict");
});

test("history associations and exact journal writes remain checked after all archive hashes are recomputed", (t) => {
  const f = fixture(t), adopted = f.stage(); review.adopt(f.kb, adopted.id); review.compact(f.kb);
  const old = f.stage({ target: "wiki/synthesis/other.md", body: "旧草稿" }), replacement = f.stage({ target: old.target, body: "新草稿" });
  review.supersede(f.kb, old.id, replacement.id); review.compact(f.kb);
  const zip = path.join(f.temp, "valid.zip"); f.ok("export", f.kb, "--output", zip);
  const original = zipEntries(zip), index = entryJson(original, history.HISTORY_INDEX);
  const adoptedDescriptor = index.entries.find((item) => item.id === adopted.id), supersededDescriptor = index.entries.find((item) => item.id === old.id);
  const cases = [
    (entries) => { const value = entryJson(entries, supersededDescriptor.path); value.supersededBy = `candidate-${"a".repeat(24)}`; replaceCold(entries, supersededDescriptor, value); },
    (entries) => { const value = entryJson(entries, adoptedDescriptor.path); value.body += "tampered"; value.bodySha256 = sha(value.body); replaceCold(entries, adoptedDescriptor, value); },
    (entries) => { const value = entryJson(entries, adoptedDescriptor.journal.path); value.writes[1].content = "erase index\n"; value.writes[1].afterSha256 = sha(value.writes[1].content); replaceCold(entries, adoptedDescriptor, value, true); },
    (entries) => { const value = entryJson(entries, adoptedDescriptor.journal.path); value.committed = false; replaceCold(entries, adoptedDescriptor, value, true); },
    (entries) => { replaceFile(entries, `${history.HISTORY}/candidates/candidate-${"b".repeat(24)}.json`, json(entryJson(entries, adoptedDescriptor.path))); },
    (entries) => { const value = entryJson(entries, history.HISTORY_INDEX); value.entries.push({ ...value.entries[0] }); replaceFile(entries, history.HISTORY_INDEX, json(value)); },
    (entries) => { const value = entryJson(entries, history.HISTORY_INDEX); value.entries[0].size = 4 * 1024 * 1024 + 1; replaceFile(entries, history.HISTORY_INDEX, json(value)); },
    (entries) => { const value = entryJson(entries, history.HISTORY_INDEX); value.entries[0].path = "../escape.json"; replaceFile(entries, history.HISTORY_INDEX, json(value)); },
    (entries) => { const state = entryJson(entries, ".wiki-review/state.json"); const value = state.candidates.find((item) => item.id === replacement.id); value.status = "superseded"; value.supersededAt = new Date().toISOString(); value.supersededBy = old.id; replaceFile(entries, ".wiki-review/state.json", json(state)); },
  ];
  for (const [number, mutate] of cases.entries()) {
    const entries = structuredClone(original); mutate(entries);
    const bad = path.join(f.temp, `bad-${number}.zip`); writeZip(bad, entries);
    f.reject("verify", bad);
    const target = path.join(f.temp, `bad-restore-${number}`); f.reject("restore", bad, "--target", target);
    assert.equal(fs.existsSync(target), false);
  }
});

test("ordinary historical citations may be stale without preventing faithful history backup", (t) => {
  const f = fixture(t), adopted = f.stage(); review.adopt(f.kb, adopted.id); review.compact(f.kb);
  const current = "# Markdown\r\n更新后的普通原文。\r\n";
  fs.writeFileSync(path.join(f.kb, "raw/notes/input.md"), current);
  const zip = path.join(f.temp, "stale-history.zip"), restored = path.join(f.temp, "stale-restored");
  f.ok("export", f.kb, "--output", zip); f.ok("verify", zip); f.ok("restore", zip, "--target", restored);
  assert.equal(fs.readFileSync(path.join(restored, "raw/notes/input.md"), "utf8"), current);
  assert.equal(review.show(restored, adopted.id).evidenceVerification.ok, false);
  assert.equal(history.readReviewRecords(restored).readJournal(adopted.id).committed, true);
});

test("cold records can exceed active limits while index, record and actual metadata budgets remain enforced", (t) => {
  const f = fixture(t), template = f.stage(), entries = [];
  for (let number = 0; number < 101; number++) {
    const candidate = { ...template, title: `候选 ${number}`, body: `草稿 ${number}`, status: "cancelled", cancelledAt: new Date().toISOString() };
    candidate.bodySha256 = sha(candidate.body); candidate.id = records.candidateIdentity(candidate);
    candidate.content = records.renderCandidate(candidate); candidate.contentSha256 = sha(candidate.content); records.validateCandidate(candidate);
    const data = json(candidate), relative = `${history.HISTORY}/candidates/${candidate.id}.json`;
    fs.mkdirSync(path.dirname(path.join(f.kb, relative)), { recursive: true }); fs.writeFileSync(path.join(f.kb, relative), data);
    entries.push({ kind: "candidate", id: candidate.id, path: relative, size: data.length, sha256: sha(data) });
  }
  for (let number = 0; number < 501; number++) {
    const issue = { type: "suggestion", title: `问题 ${number}`, reason: "待后续研究", paths: [], evidence: [], status: "dismissed", createdAt: new Date().toISOString() };
    issue.id = records.issueIdentity(issue); records.validateIssue(issue);
    const data = json(issue), relative = `${history.HISTORY}/issues/${issue.id}.json`;
    fs.mkdirSync(path.dirname(path.join(f.kb, relative)), { recursive: true }); fs.writeFileSync(path.join(f.kb, relative), data);
    entries.push({ kind: "issue", id: issue.id, path: relative, size: data.length, sha256: sha(data) });
  }
  fs.writeFileSync(path.join(f.kb, history.HISTORY_INDEX), json({ version: 1, entries }));
  fs.writeFileSync(path.join(f.kb, ".wiki-review/state.json"), json({ version: 1, issues: [], candidates: [] }));
  assert.equal(history.readReviewRecords(f.kb).complete, true);
  const zip = path.join(f.temp, "many.zip"); f.ok("export", f.kb, "--output", zip); f.ok("verify", zip);
  assert.equal(f.reject("export", f.kb, "--output", path.join(f.temp, "budget.zip"), "--max-total-bytes", "128"), "metadata_budget_exceeded");
});

test("restored cold Markdown adoption continues source updates, explicit relocation and manual-note preservation", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.source, "note.md"), "# Markdown\r\n第一版。\r\n![图](image.bin)\r\n");
  fs.writeFileSync(path.join(f.source, "image.bin"), Buffer.from([0, 255, 13, 10]));
  const captured = markdown.capture(f.kb, { sourceRoot: f.source, file: "note.md" });
  const first = markdown.stage(f.kb, { id: captured.sourceId, revision: captured.binding.revision, body: "第一版摘要。" }); review.adopt(f.kb, first.id);
  let page = fs.readFileSync(path.join(f.kb, first.target), "utf8");
  assert.ok(page.includes(MANUAL_START));
  page = page.replace(MANUAL_START, `${MANUAL_START}\n手动补充必须保留。\n`);
  fs.writeFileSync(path.join(f.kb, first.target), page);
  review.compact(f.kb);
  const zip = path.join(f.temp, "markdown.zip"), restored = path.join(f.temp, "markdown-restored");
  f.ok("export", f.kb, "--output", zip); f.ok("restore", zip, "--target", restored);
  const moved = path.join(f.temp, "relocated-source"); fs.renameSync(f.source, moved);
  const unchanged = markdown.scan(restored, { sourceRoot: moved, collection: captured.collectionId });
  assert.equal(unchanged.requiresRebind, true); assert.equal(unchanged.entries.find((item) => item.sourceId === captured.sourceId).status, "unchanged");
  fs.writeFileSync(path.join(moved, "note.md"), "# Markdown\r\n第二版。\r\n![图](image.bin)\r\n");
  assert.equal(markdown.scan(restored, { sourceRoot: moved, collection: captured.collectionId }).entries.find((item) => item.sourceId === captured.sourceId).status, "modified");
  const next = markdown.capture(restored, { sourceRoot: moved, collection: captured.collectionId, id: captured.sourceId, file: "note.md" });
  assert.equal(next.sourceId, captured.sourceId);
  const second = markdown.stage(restored, { id: next.sourceId, revision: next.binding.revision, body: "第二版摘要。" }); review.adopt(restored, second.id);
  assert.equal(second.target, first.target);
  assert.ok(fs.readFileSync(path.join(restored, first.target), "utf8").includes("手动补充必须保留。"));
  assert.equal((fs.readFileSync(path.join(restored, "index.md"), "utf8").match(/review-target:/g) || []).length, 1);
  review.compact(restored);
  const latest = path.join(f.temp, "latest.zip"); f.ok("export", restored, "--output", latest); f.ok("verify", latest);
});

test("cold-only Markdown bindings still protect every original asset without a registry", (t) => {
  const f = fixture(t), packages = require("../../scripts/lib/markdown-package");
  fs.writeFileSync(path.join(f.source, "note.md"), "# Markdown\n资料。\n![图](asset.bin)\n");
  fs.writeFileSync(path.join(f.source, "asset.bin"), Buffer.from([0, 1, 255]));
  const binding = packages.capturePackage(f.kb, `md-${"4".repeat(24)}`, packages.inspectPackage(f.source, "note.md"));
  const packet = search(f.kb, { mode: "raw", query: "note", paths: [binding.primaryPath] });
  const candidate = f.stage({ target: `wiki/sources/${binding.sourceId}.md`, body: "摘要。", markdownSource: binding, packet });
  review.adopt(f.kb, candidate.id); review.compact(f.kb);
  assert.equal(fs.existsSync(path.join(f.kb, ".wiki-review/markdown-sources.json")), false);
  const zip = path.join(f.temp, "cold-source.zip"); f.ok("export", f.kb, "--output", zip); f.ok("verify", zip);
  fs.writeFileSync(path.join(f.kb, path.posix.dirname(binding.manifestPath), "files/asset.bin"), Buffer.from([9, 9, 9]));
  assert.equal(f.reject("export", f.kb, "--output", path.join(f.temp, "corrupt-asset.zip")), "invalid_markdown_package");
});

test("Node-formatted cold candidates retain Unicode and CRLF semantics and reject rehashed rendering changes", (t) => {
  const f = fixture(t), files = ["raw/notes/😀.md", "raw/notes/\uE000.md"];
  for (const relative of files) fs.writeFileSync(path.join(f.kb, relative), "# Markdown\r\n原文含代码 ``` 与 Unicode。\r\n\uFEFF");
  const packet = search(f.kb, { mode: "raw", query: "Markdown", paths: files });
  const candidate = f.stage({ title: "Unicode 💡 研究", body: "# 研究\r\n保留正文。\r\n", packet });
  review.cancel(f.kb, candidate.id); review.compact(f.kb);
  const zip = path.join(f.temp, "render.zip"); f.ok("export", f.kb, "--output", zip); f.ok("verify", zip);
  const entries = zipEntries(zip), descriptor = entryJson(entries, history.HISTORY_INDEX).entries.find((item) => item.id === candidate.id);
  const changed = entryJson(entries, descriptor.path); changed.content += "forged rendering\n"; changed.contentSha256 = sha(changed.content);
  replaceCold(entries, descriptor, changed);
  const bad = path.join(f.temp, "render-forged.zip"); writeZip(bad, entries);
  f.reject("verify", bad);
});

test("cancel reasons use Node control-character, UTF-16 length and whitespace validation in source and rehashed archives", (t) => {
  for (const reason of ["正常中文理由 🙂\n保留换行与\t制表", "🙂".repeat(2000)]) {
    const f = fixture(t), candidate = f.stage(); review.cancel(f.kb, candidate.id, { reason }); review.compact(f.kb);
    const zip = path.join(f.temp, "valid-reason.zip"), restored = path.join(f.temp, "valid-reason-restored");
    f.ok("export", f.kb, "--output", zip); f.ok("verify", zip); f.ok("restore", zip, "--target", restored);
    assert.equal(review.show(restored, candidate.id).cancelReason, reason);
  }
  const f = fixture(t), candidate = f.stage(); review.cancel(f.kb, candidate.id, { reason: "原有理由" }); review.compact(f.kb);
  const zip = path.join(f.temp, "original-reason.zip"); f.ok("export", f.kb, "--output", zip);
  const original = zipEntries(zip), originalIndex = entryJson(original, history.HISTORY_INDEX);
  const descriptor = originalIndex.entries.find((item) => item.id === candidate.id);
  for (const [number, reason] of ["bad\x01reason", "🙂".repeat(2001), "\uFEFF"].entries()) {
    const entries = structuredClone(original), changed = entryJson(entries, descriptor.path); changed.cancelReason = reason;
    replaceCold(entries, descriptor, changed);
    const index = entryJson(entries, history.HISTORY_INDEX);
    fs.writeFileSync(path.join(f.kb, descriptor.path), json(changed));
    fs.writeFileSync(path.join(f.kb, history.HISTORY_INDEX), json(index));
    assert.equal(history.readReviewRecords(f.kb).complete, false, "Node rejects the malformed reason");
    assert.equal(f.reject("export", f.kb, "--output", path.join(f.temp, `bad-reason-export-${number}.zip`)), "invalid_review_state");
    const bad = path.join(f.temp, `bad-reason-${number}.zip`); writeZip(bad, entries);
    assert.equal(f.reject("verify", bad), "invalid_review_state");
    const restored = path.join(f.temp, `bad-reason-restored-${number}`);
    assert.equal(f.reject("restore", bad, "--target", restored), "invalid_review_state");
    assert.equal(fs.existsSync(restored), false);
  }
});
