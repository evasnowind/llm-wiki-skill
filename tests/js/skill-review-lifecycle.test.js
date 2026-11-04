"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const review = require("../../scripts/lib/skill-review");
const { search, sha256 } = require("../../scripts/lib/skill-retrieval");
const { readReviewRecords, HISTORY_INDEX } = require("../../scripts/lib/review-history");

function write(root, relative, value) {
  const target = path.join(root, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, value);
}
function read(root, relative) { return fs.readFileSync(path.join(root, relative), "utf8"); }
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "review lifecycle 中文 ")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, ".wiki-schema.md", "# Schema\n"); write(root, "index.md", "# Index\r\n用户索引。\r\n"); write(root, "log.md", "# Log\n");
  write(root, "raw/notes/资料.md", "# 缓存\r\n资料讨论离线读取与字节哈希。\r\n");
  const packet = search(root, { mode: "raw", query: "缓存" });
  const stage = (more = {}) => review.stage(root, { title: "缓存研究", target: "wiki/synthesis/缓存.md", body: "# 缓存\n离线读取原文。", packet, ...more });
  return { root, packet, stage };
}
const code = (expected) => (error) => error.code === expected;
function formal(root) {
  return Object.fromEntries(["index.md", "log.md", "raw/notes/资料.md", "wiki/synthesis/缓存.md"].map((file) => [file, fs.existsSync(path.join(root, file)) ? read(root, file) : null]));
}

test("cancelling a ready candidate preserves content and formal files; history stays inspectable and cannot publish", (t) => {
  const f = fixture(t), candidate = f.stage(), before = formal(f.root);
  const cancelled = review.cancel(f.root, candidate.id, { reason: "用户选择暂不采用" });
  assert.equal(cancelled.status, "cancelled"); assert.equal(cancelled.body, candidate.body); assert.equal(cancelled.content, candidate.content);
  assert.deepEqual(formal(f.root), before);
  assert.equal(review.cancel(f.root, candidate.id).cancelledAt, cancelled.cancelledAt);
  assert.throws(() => review.adopt(f.root, candidate.id), code("candidate_not_ready"));
  const next = f.stage({ body: "# 缓存\n新的研究候选。" });
  assert.equal(review.loadState(f.root).candidates.length, 1);
  assert.equal(review.show(f.root, candidate.id).cancelReason, "用户选择暂不采用");
  assert.equal(review.list(f.root, { scope: "history", candidateStatus: "cancelled" }).candidates[0].id, candidate.id);
  assert.equal(review.cancel(f.root, candidate.id).status, "cancelled");
  review.adopt(f.root, next.id);
  assert.throws(() => review.cancel(f.root, next.id), code("candidate_not_ready"));
});

test("superseding is explicit, same-target and idempotent; replacement may later be cancelled", (t) => {
  const f = fixture(t), first = f.stage(), next = f.stage({ body: "# 新候选\n更明确的说明。" });
  const other = f.stage({ target: "wiki/topics/其他.md" });
  const before = formal(f.root);
  assert.throws(() => review.supersede(f.root, first.id, other.id), code("replacement_target_mismatch"));
  const old = review.supersede(f.root, first.id, next.id);
  assert.equal(old.status, "superseded"); assert.equal(old.supersededBy, next.id);
  assert.equal(review.supersede(f.root, first.id, next.id).supersededAt, old.supersededAt);
  assert.throws(() => review.supersede(f.root, next.id, first.id), code("candidate_not_ready"));
  assert.throws(() => review.adopt(f.root, first.id), code("candidate_not_ready"));
  review.cancel(f.root, next.id); review.compact(f.root);
  assert.equal(review.show(f.root, first.id).supersededBy, next.id);
  assert.equal(readReviewRecords(f.root).complete, true);
  assert.deepEqual(formal(f.root), before);
});

test("every compaction boundary resumes without changing formal content or losing adoption proofs", (t) => {
  for (let boundary = 0; boundary <= 6; boundary++) {
    const f = fixture(t);
    const issue = review.add(f.root, { type: "unverified", title: "核对", reason: "待核对", paths: ["raw/notes/资料.md"] });
    const candidate = f.stage({ issueId: issue.id }); review.adopt(f.root, candidate.id);
    const before = formal(f.root);
    assert.throws(() => review.compact(f.root, { afterWrite(n) { if (n === boundary) throw new Error("crash"); } }), /crash/u);
    assert.deepEqual(formal(f.root), before);
    const interrupted = readReviewRecords(f.root);
    assert.equal(interrupted.complete, true); assert.equal(interrupted.candidates.length, 1);
    review.compact(f.root); review.compact(f.root);
    const view = readReviewRecords(f.root);
    assert.equal(view.complete, true); assert.equal(view.activeState.candidates.length, 0); assert.equal(view.activeState.issues.length, 0);
    assert.equal(view.readJournal(candidate.id).committed, true);
    assert.equal(review.adopt(f.root, candidate.id).recovered, false);
    assert.deepEqual(review.recover(f.root, candidate.id).recovered, []);
    assert.deepEqual(formal(f.root), before);
    assert.equal(fs.existsSync(path.join(f.root, `.wiki-review/journals/${candidate.id}.json`)), false);
  }
});

test("closed issues required by a ready candidate stay active until that candidate is closed", (t) => {
  const f = fixture(t), issue = review.add(f.root, { type: "missing", title: "待完善", reason: "需要整理", paths: ["raw/notes/资料.md"] });
  const first = f.stage({ issueId: issue.id });
  const ready = f.stage({ issueId: issue.id, target: "wiki/topics/缓存.md" });
  review.adopt(f.root, first.id); review.compact(f.root);
  assert.equal(review.loadState(f.root).issues[0].id, issue.id);
  assert.equal(review.loadState(f.root).candidates[0].id, ready.id);
  review.cancel(f.root, ready.id); review.compact(f.root);
  assert.equal(review.loadState(f.root).issues.length, 0);
  assert.equal(review.show(f.root, issue.id).resolvedBy, first.id);
  assert.equal(readReviewRecords(f.root).complete, true);
});

test("compaction never overwrites changed history metadata or deletes an externally changed hot journal", (t) => {
  for (const changed of ["index", "journal"]) {
    const f = fixture(t), candidate = f.stage(); review.adopt(f.root, candidate.id);
    const before = formal(f.root);
    assert.throws(() => review.compact(f.root, { afterWrite(_n, label) {
      if (changed === "index" && label === `journal:${candidate.id}`) write(f.root, HISTORY_INDEX, "external history index\n");
      if (changed === "journal" && label === "state") write(f.root, `.wiki-review/journals/${candidate.id}.json`, "external journal\n");
    } }), code("history_conflict"));
    assert.deepEqual(formal(f.root), before);
    if (changed === "index") assert.equal(read(f.root, HISTORY_INDEX), "external history index\n");
    else assert.equal(read(f.root, `.wiki-review/journals/${candidate.id}.json`), "external journal\n");
  }
});

test("pending publication blocks cancellation superseding and compaction until recovery", (t) => {
  const f = fixture(t), first = f.stage(), next = f.stage({ body: "# 候选二\n待核对。" });
  assert.throws(() => review.adopt(f.root, first.id, { afterWrite(n) { if (n === 1) throw new Error("crash"); } }), /crash/u);
  for (const mutate of [() => review.cancel(f.root, next.id), () => review.supersede(f.root, next.id, first.id), () => review.compact(f.root)]) assert.throws(mutate, code("recovery_required"));
  review.recover(f.root);
  assert.equal(review.cancel(f.root, next.id).status, "cancelled");
});

test("a compacted adopted predecessor remains a strict basis for same-target publication and recovery", (t) => {
  const f = fixture(t), first = f.stage(); review.adopt(f.root, first.id); review.compact(f.root);
  const next = f.stage({ body: "# 缓存\n第二版研究。" });
  assert.throws(() => review.adopt(f.root, next.id, { afterWrite(n) { if (n === 2) throw new Error("crash"); } }), /crash/u);
  const journal = JSON.parse(read(f.root, `.wiki-review/journals/${next.id}.json`));
  assert.equal(journal.previousCandidate.id, first.id);
  review.recover(f.root); review.compact(f.root);
  assert.equal((read(f.root, "index.md").match(/<!-- review-target:/gu) || []).length, 1);
  assert.equal((read(f.root, "log.md").match(/<!-- review-adopt:/gu) || []).length, 2);
  const current = read(f.root, next.target); review.adopt(f.root, first.id);
  assert.equal(read(f.root, next.target), current);
});

test("more than one hundred cumulative adoptions retain current indexing and readable cold history", { timeout: 120000 }, (t) => {
  const f = fixture(t); let first, last;
  for (let index = 0; index < 105; index++) {
    last = f.stage({ title: `研究 ${index}`, body: `# 缓存\n第 ${index} 版研究。` });
    first ||= last; review.adopt(f.root, last.id);
    assert.ok(review.loadState(f.root).candidates.length <= 1);
  }
  review.compact(f.root);
  const page = review.list(f.root, { scope: "history", limit: 50 });
  assert.equal(page.candidates.length, 50); assert.equal(page.pagination.candidates, 105); assert.equal(page.pagination.nextOffset, 50);
  assert.equal(review.list(f.root, { scope: "history", limit: 50, offset: 100 }).candidates.length, 5);
  assert.equal(review.show(f.root, first.id).status, "adopted");
  assert.equal(review.show(f.root, last.id).status, "adopted");
  assert.equal((read(f.root, "index.md").match(/<!-- review-target:/gu) || []).length, 1);
  assert.equal((read(f.root, "log.md").match(/<!-- review-adopt:/gu) || []).length, 105);
});

test("active ready capacity remains bounded while terminal records can release that capacity", { timeout: 120000 }, (t) => {
  const f = fixture(t), staged = [];
  for (let index = 0; index < 100; index++) staged.push(f.stage({ body: `# 缓存\n候选 ${index}。` }));
  assert.throws(() => f.stage({ body: "# 缓存\n候选101。" }), code("review_limit"));
  review.cancel(f.root, staged[0].id);
  assert.equal(f.stage({ body: "# 缓存\n释放后新候选。" }).status, "ready");
  assert.equal(review.loadState(f.root).candidates.length, 100);
  assert.equal(review.show(f.root, staged[0].id).status, "cancelled");
});

test("history tampering and bounded metadata fail closed instead of exposing an older partial timeline", (t) => {
  const f = fixture(t), candidate = f.stage(); review.cancel(f.root, candidate.id); review.compact(f.root);
  const limited = readReviewRecords(f.root, { maxMetadataBytes: 16 });
  assert.equal(limited.complete, false); assert.deepEqual(limited.candidates, []);
  assert.equal(limited.warnings[0].code, "metadata_budget_exceeded");
  const index = JSON.parse(read(f.root, HISTORY_INDEX)), descriptor = index.entries[0];
  const record = JSON.parse(read(f.root, descriptor.path)); record.body = "tampered";
  const data = JSON.stringify(record); write(f.root, descriptor.path, data); descriptor.size = Buffer.byteLength(data); descriptor.sha256 = sha256(data);
  write(f.root, HISTORY_INDEX, JSON.stringify(index));
  assert.equal(readReviewRecords(f.root).complete, false);
  assert.throws(() => review.show(f.root, candidate.id));
});

test("track preconditions are checked under Review lock and are not incorporated into issue identity", (t) => {
  const f = fixture(t), file = "raw/notes/资料.md", original = sha256(read(f.root, file));
  const input = { type: "unverified", title: "检查更新", reason: "来源变化", paths: [file], expectedPaths: [{ path: file, sha256: original }] };
  const issue = review.add(f.root, input);
  assert.equal(review.add(f.root, { ...input, expectedPaths: undefined }).id, issue.id);
  write(f.root, file, "# 缓存\n再次变化。\n");
  assert.throws(() => review.add(f.root, input), code("issue_changed"));
  assert.equal(review.list(f.root).issues.length, 1);
  assert.throws(() => review.add(f.root, { ...input, expectedPaths: new Array(251).fill({ path: file, sha256: original }) }), code("invalid_arguments"));
});

test("live search freshness diagnostics do not change fixed candidate identity or mutate the input packet", (t) => {
  const f = fixture(t), originalPacket = search(f.root, { mode: "raw", query: "缓存" });
  const first = f.stage({ packet: originalPacket });
  const nextPacket = search(f.root, { mode: "raw", query: "缓存" });
  assert.deepEqual(nextPacket.evidence, originalPacket.evidence);
  assert.notDeepEqual(nextPacket.freshness, originalPacket.freshness, "live metadata changed after the candidate was staged");
  const saved = JSON.stringify(nextPacket);
  assert.equal(f.stage({ packet: nextPacket }).id, first.id);
  assert.equal(JSON.stringify(nextPacket), saved);
  assert.equal(first.packet.freshness, undefined);
});

test("actual CLI cancels supersedes compacts and paginates without a client runtime", (t) => {
  const f = fixture(t), first = f.stage(), next = f.stage({ body: "# 缓存\n较新候选。" });
  const cli = path.resolve(__dirname, "../../scripts/review-cli.js");
  const run = (...args) => {
    const result = spawnSync(process.execPath, [cli, args[0], f.root, ...args.slice(1), "--json"], { encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, result.stderr || result.stdout); return JSON.parse(result.stdout);
  };
  assert.equal(run("supersede", "--id", first.id, "--replacement", next.id).status, "superseded");
  assert.equal(run("cancel", "--id", next.id, "--reason", "保留草稿").status, "cancelled");
  assert.equal(run("compact").archivedCandidates, 2);
  assert.equal(run("list", "--scope", "history", "--candidate-status", "cancelled", "--limit", "1", "--offset", "0").candidates[0].id, next.id);
  assert.equal(run("show", "--id", first.id).supersededBy, next.id);
});
