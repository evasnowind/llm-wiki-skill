"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { test } = require("node:test");
const { spawn, spawnSync } = require("node:child_process");
const review = require("../../scripts/lib/skill-review");
const { search, sha256 } = require("../../scripts/lib/skill-retrieval");
const { withLock } = require("../../scripts/lib/skill-state-io");

const cli = path.resolve(__dirname, "../../scripts/review-cli.js");
const modulePath = path.resolve(__dirname, "../../scripts/lib/skill-review.js");
function write(root, relative, value) { const target = path.join(root, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, value); }
function read(root, relative) { return fs.readFileSync(path.join(root, relative), "utf8"); }
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "skill-review-中文 ")));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  write(root, ".wiki-schema.md", "# Schema\n");
  write(root, "index.md", "# 索引\r\n\r\n用户编写的条目。\r\n");
  write(root, "log.md", "# 日志\r\n");
  write(root, "raw/notes/资料.md", "# 缓存\r\n内容哈希用于确认原文版本。\r\n");
  return root;
}
function packet(root) { return search(root, { query: "缓存", mode: "raw" }); }
function issue(root) { return review.add(root, { type: "unverified", title: "核对缓存", reason: "需要更多原文证据", paths: ["raw/notes/资料.md"] }); }
function candidate(root, more = {}) { return review.stage(root, { title: "缓存研究", target: "wiki/synthesis/缓存.md", body: "# 研究\n原文讨论哈希。", packet: packet(root), ...more }); }
function code(expected) { return (error) => error.code === expected; }
function journal(root, id) { return path.join(root, `.wiki-review/journals/${id}.json`); }
function rawHash(root) { return sha256(fs.readFileSync(path.join(root, "raw/notes/资料.md"))); }
function run(root, ...args) { return spawnSync(process.execPath, [cli, args[0], root, ...args.slice(1)], { encoding: "utf8", timeout: 10_000 }); }

test("Review deduplicates by normalized issue and source version; changed/missing sources become new issues", (t) => {
  const root = fixture(t);
  const first = issue(root);
  assert.equal(issue(root).id, first.id);
  review.dismiss(root, first.id);
  assert.equal(issue(root).status, "dismissed");
  write(root, "raw/notes/资料.md", "# 缓存\n原文已改变。\n");
  assert.notEqual(issue(root).id, first.id);
  const input = { type: "missing", title: "缺页", reason: "缺少定义", paths: ["wiki/topics/缺页.md"] };
  const missing = review.add(root, input);
  write(root, input.paths[0], "# 新页\n");
  assert.notEqual(review.add(root, input).id, missing.id);
  assert.equal(review.list(root).issues.length, 3);
});

test("stage keeps formal files untouched and exposes prior/current/new content; publish is derived with exact evidence", (t) => {
  const root = fixture(t);
  const original = rawHash(root);
  write(root, "wiki/synthesis/缓存.md", "# 既有研究\r\n保留旧内容。\r\n");
  const index = read(root, "index.md"); const log = read(root, "log.md");
  const problem = issue(root);
  const staged = candidate(root, { issueId: problem.id });
  assert.equal(read(root, staged.target), staged.targetBefore.content);
  assert.equal(read(root, "index.md"), index); assert.equal(read(root, "log.md"), log);
  assert.equal(review.show(root, staged.id).currentTarget.sha256, staged.targetBefore.sha256);
  assert.equal(review.list(root).issues[0].status, "open");
  assert.equal(review.adopt(root, staged.id).status, "adopted");
  const result = read(root, staged.target);
  assert.match(result, /^---\ntype: research\nderived: true\n/u);
  assert.ok(result.includes(staged.packet.evidence[0].id));
  assert.ok(result.includes(staged.packet.evidence[0].fileSha256));
  assert.ok(result.includes("内容哈希用于确认原文版本。"));
  assert.equal(review.list(root, { status: "resolved" }).issues[0].resolvedBy, staged.id);
  assert.equal(rawHash(root), original);
});

test("query targets preserve query metadata and body-only input rejects nested frontmatter", (t) => {
  const root = fixture(t);
  const result = candidate(root, { target: "wiki/queries/回答.md" });
  assert.match(result.content, /^---\ntype: query\nderived: true\n/u);
  assert.throws(() => candidate(root, { body: "---\ntitle: nested\n---\nbody" }), code("body_frontmatter_not_allowed"));
});

test("a publication cannot overwrite its own cited evidence", (t) => {
  const root = fixture(t);
  write(root, "wiki/topics/缓存.md", "# 缓存\n现有定义。\n");
  const evidence = search(root, { query: "缓存", mode: "wiki" });
  assert.throws(() => candidate(root, { target: "wiki/topics/缓存.md", packet: evidence }), code("target_is_evidence"));
  assert.equal(read(root, "wiki/topics/缓存.md"), "# 缓存\n现有定义。\n");
});

test("sources, target and candidate tampering refuse publication without overwriting formal files", (t) => {
  for (const kind of ["source", "target", "candidate"]) {
    const root = fixture(t); const staged = candidate(root);
    const index = read(root, "index.md"); const log = read(root, "log.md");
    if (kind === "source") write(root, "raw/notes/资料.md", "# 缓存\n外部编辑\n");
    if (kind === "target") write(root, staged.target, "外部编辑\n");
    if (kind === "candidate") {
      const state = JSON.parse(read(root, review.STATE)); state.candidates[0].body = "伪造内容";
      write(root, review.STATE, JSON.stringify(state));
    }
    assert.throws(() => review.adopt(root, staged.id), code(kind === "source" ? "evidence_changed_or_invalid" : kind === "target" ? "target_changed" : "invalid_state"));
    assert.equal(read(root, "index.md"), index); assert.equal(read(root, "log.md"), log);
    if (kind === "target") assert.equal(read(root, staged.target), "外部编辑\n");
    else assert.equal(fs.existsSync(path.join(root, staged.target)), false);
  }
});

test("candidate retries and repeat adoption are idempotent; updating the same target retains one index entry", (t) => {
  const root = fixture(t);
  const first = candidate(root);
  assert.equal(candidate(root).id, first.id);
  review.adopt(root, first.id);
  const log = read(root, "log.md");
  review.adopt(root, first.id);
  assert.equal(read(root, "log.md"), log);
  const second = candidate(root, { title: "更新研究", body: "# 研究\n加入边界说明。" });
  assert.equal(second.targetBefore.content, first.content);
  review.adopt(root, second.id);
  assert.equal((read(root, "index.md").match(/<!-- review-target:/gu) || []).length, 1);
  assert.ok(read(root, "index.md").includes("更新研究"));
  assert.ok(!read(root, "index.md").includes("缓存研究"));
  assert.equal((read(root, "log.md").match(/<!-- review-adopt:/gu) || []).length, 2);
  assert.equal(review.show(root, first.id).content, first.content);
  assert.ok(read(root, "index.md").includes("用户编写的条目。\r\n"));
});

test("modified managed index entry is preserved and blocks adoption", (t) => {
  const root = fixture(t); const first = candidate(root); review.adopt(root, first.id);
  write(root, "index.md", read(root, "index.md").replace("缓存研究", "用户改过的标题"));
  const second = candidate(root, { body: "# 新研究\n仍保留引用。" });
  assert.throws(() => review.adopt(root, second.id), code("index_managed_entry_changed"));
  assert.equal(read(root, second.target), first.content);
  assert.ok(read(root, "index.md").includes("用户改过的标题"));
});

test("adopted Unicode target is listed by the actual lint runner using a canonical wikilink", (t) => {
  const root = fixture(t);
  const staged = candidate(root, { target: "wiki/synthesis/Markdown-对比.md", title: "Markdown [[别名]] | 标题 \\ `代码`" });
  review.adopt(root, staged.id);
  const bashOptions = process.platform === "win32"
    ? [path.join(process.env.ProgramFiles || "C:/Program Files", "Git/bin/bash.exe"), "bash"] : ["bash"];
  const bash = bashOptions.find((command) => spawnSync(command, ["--version"], { encoding: "utf8" }).status === 0);
  assert.ok(bash, "Bash or Git Bash is required for the actual lint integration");
  const result = spawnSync(bash, [path.resolve(__dirname, "../../scripts/lint-runner.sh").replace(/\\/g, "/"), root.replace(/\\/g, "/"), "--json"], { encoding: "utf8", timeout: 20_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.ok(report.derived.index_resolved_target_paths.includes(staged.target));
  assert.ok(!report.derived.index_unlisted_paths.includes(staged.target));
  const indexed = report.warning_report.occurrences.filter((item) => item.source_path === "index.md");
  assert.equal(indexed.length, 1);
  assert.equal(indexed[0].resolution.target_path, staged.target);
});

test("legacy Markdown journal remains recoverable and its exact managed pair migrates on the next adoption", (t) => {
  const root = fixture(t); const first = candidate(root);
  assert.throws(() => review.adopt(root, first.id, { afterWrite: () => { throw new Error("crash"); } }), /crash/u);
  const file = journal(root, first.id);
  const legacy = JSON.parse(fs.readFileSync(file, "utf8"));
  delete legacy.indexFormat;
  const encoded = first.target.split("/").map(encodeURIComponent).join("/");
  const oldPair = `<!-- review-target:${sha256(first.target).slice(0, 24)} -->\n- [${first.title}](${encoded}) — research / 研究 <!-- review-adopt:${first.id} -->`;
  const before = legacy.writes[1].beforeContent;
  legacy.writes[1].content = `${before}${before && !before.endsWith("\n") ? "\n" : ""}\n${oldPair}\n`;
  legacy.writes[1].afterSha256 = sha256(legacy.writes[1].content);
  fs.writeFileSync(file, JSON.stringify(legacy));
  assert.equal(review.recover(root).recovered.length, 1);
  assert.ok(read(root, "index.md").includes(oldPair));
  const second = candidate(root, { title: "更新研究", body: "# 新版\n补充原文边界。" });
  review.adopt(root, second.id);
  const index = read(root, "index.md");
  assert.ok(index.includes(`[[${second.target}|更新研究]]`));
  assert.ok(!index.includes(oldPair));
  assert.equal((index.match(/<!-- review-target:/gu) || []).length, 1);
  assert.ok(index.includes("用户编写的条目。\r\n"));
  assert.equal(review.recover(root).recovered.length, 0);
});

test("every publication boundary recovers the fixed write-set exactly once and resolves only on complete state write", (t) => {
  for (let boundary = 0; boundary <= 4; boundary += 1) {
    const root = fixture(t); const problem = issue(root); const staged = candidate(root, { issueId: problem.id });
    assert.throws(() => review.adopt(root, staged.id, { afterWrite: (count) => { if (count === boundary) throw new Error("simulated_crash"); } }), /simulated_crash/u);
    const record = JSON.parse(fs.readFileSync(journal(root, staged.id), "utf8"));
    assert.equal(record.committed, false);
    assert.equal(record.writes.length, 4);
    assert.equal(review.list(root, { status: "all" }).issues[0].status, boundary === 4 ? "resolved" : "open");
    assert.throws(() => issue(root), code("recovery_required"));
    review.recover(root);
    review.recover(root);
    assert.equal(read(root, staged.target), staged.content);
    assert.equal((read(root, "log.md").match(/<!-- review-adopt:/gu) || []).length, 1);
    assert.equal(review.list(root, { status: "resolved" }).issues.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(journal(root, staged.id), "utf8")).committed, true);
  }
});

test("recovery preflights all paths, refuses external edits and preserves the pending journal", (t) => {
  const root = fixture(t); const staged = candidate(root);
  assert.throws(() => review.adopt(root, staged.id, { afterWrite: (count) => { if (count === 1) throw new Error("crash"); } }), /crash/u);
  write(root, "log.md", "用户新日志\n");
  const index = read(root, "index.md");
  assert.throws(() => review.recover(root), code("publication_conflict"));
  assert.equal(read(root, "index.md"), index);
  assert.equal(read(root, "log.md"), "用户新日志\n");
  assert.equal(JSON.parse(fs.readFileSync(journal(root, staged.id), "utf8")).committed, false);
});

test("recovery rechecks evidence before any remaining publication write and never resolves stale evidence", (t) => {
  for (const boundary of [0, 1, 3]) {
    const root = fixture(t); const problem = issue(root); const staged = candidate(root, { issueId: problem.id });
    assert.throws(() => review.adopt(root, staged.id, { afterWrite: (count) => { if (count === boundary) throw new Error("crash"); } }), /crash/u);
    write(root, "raw/notes/资料.md", "# 缓存\n证据已在中断后改变。\n");
    const before = ["index.md", "log.md", review.STATE].map((relative) => read(root, relative));
    assert.throws(() => review.recover(root), code("evidence_changed_or_invalid"));
    assert.deepEqual(["index.md", "log.md", review.STATE].map((relative) => read(root, relative)), before);
    assert.equal(review.list(root, { status: "all" }).issues[0].status, "open");
    assert.equal(JSON.parse(fs.readFileSync(journal(root, staged.id), "utf8")).committed, false);
  }
});

test("linked issue paths/evidence are rechecked at stage, adopt and recovery even when candidate cites another source", (t) => {
  for (const checkpoint of ["stage", "adopt", "recover"]) {
    for (const binding of ["path", "evidence", "missing"]) {
      const root = fixture(t);
      write(root, "raw/notes/另一个.md", "# 独立\n候选使用独立证据。\n");
      const independent = search(root, { query: "独立", mode: "raw" });
      const problem = review.add(root, { type: "unverified", title: "独立版本绑定", reason: "问题不能被无关来源的候选掩盖",
        paths: binding === "evidence" ? [] : [binding === "missing" ? "wiki/topics/待建.md" : "raw/notes/资料.md"],
        packet: binding === "evidence" ? packet(root) : undefined });
      let staged;
      if (checkpoint !== "stage") staged = candidate(root, { packet: independent, issueId: problem.id });
      if (checkpoint === "recover") assert.throws(() => review.adopt(root, staged.id, { afterWrite: () => { throw new Error("crash"); } }), /crash/u);
      if (binding === "missing") write(root, "wiki/topics/待建.md", "# 外部创建\n");
      else write(root, "raw/notes/资料.md", "# 缓存\n问题关联资料已更新。\n");
      const beforeIndex = read(root, "index.md");
      const action = checkpoint === "stage" ? () => candidate(root, { packet: independent, issueId: problem.id })
        : checkpoint === "adopt" ? () => review.adopt(root, staged.id) : () => review.recover(root);
      assert.throws(action, code("issue_changed"));
      assert.equal(read(root, "index.md"), beforeIndex);
      assert.equal(review.list(root).issues[0].status, "open");
      if (staged) assert.equal(fs.existsSync(path.join(root, staged.target)), false);
    }
  }
});

test("issue paths changed by the exact journal write-set remain recoverable at every boundary", (t) => {
  for (const boundary of [1, 2, 3, 4]) {
    const root = fixture(t);
    const problem = review.add(root, { type: "missing", title: "研究页待建", reason: "同时更新根索引日志",
      paths: ["wiki/synthesis/缓存.md", "index.md", "log.md"] });
    const staged = candidate(root, { issueId: problem.id });
    assert.throws(() => review.adopt(root, staged.id, { afterWrite: (count) => { if (count === boundary) throw new Error("crash"); } }), /crash/u);
    assert.equal(review.recover(root).recovered.length, 1);
    assert.equal(review.list(root, { status: "resolved" }).issues[0].resolvedBy, staged.id);
    assert.equal((read(root, "log.md").match(/<!-- review-adopt:/gu) || []).length, 1);
  }
});

test("untrusted journals cannot change paths or recompute hashes to erase index data", (t) => {
  for (const kind of ["path", "content", "state"]) {
    const root = fixture(t); const staged = candidate(root);
    assert.throws(() => review.adopt(root, staged.id, { afterWrite: () => { throw new Error("crash"); } }), /crash/u);
    const record = JSON.parse(fs.readFileSync(journal(root, staged.id), "utf8"));
    if (kind === "path") record.writes[0].path = "raw/notes/资料.md";
    if (kind === "content") { record.writes[1].content = `<!-- review-adopt:${staged.id} -->\nerased\n`; record.writes[1].afterSha256 = sha256(record.writes[1].content); }
    if (kind === "state") { const state = JSON.parse(record.writes[3].content); state.candidates = []; record.writes[3].content = JSON.stringify(state); record.writes[3].afterSha256 = sha256(record.writes[3].content); }
    fs.writeFileSync(journal(root, staged.id), JSON.stringify(record));
    const before = read(root, "index.md");
    assert.throws(() => review.recover(root), code("invalid_journal"));
    assert.equal(read(root, "index.md"), before);
    assert.equal(fs.existsSync(path.join(root, staged.target)), false);
  }
});

test("actual child-process exit leaves a recoverable same-host lock and partial publication", (t) => {
  const root = fixture(t); const staged = candidate(root);
  const child = spawnSync(process.execPath, ["-e", `const r=require(${JSON.stringify(modulePath)});r.adopt(process.argv[1],process.argv[2],{afterWrite(n){if(n===2)process.exit(91)}});`, root, staged.id], { encoding: "utf8" });
  assert.equal(child.status, 91, child.stderr);
  assert.ok(fs.existsSync(path.join(root, ".wiki-review/lock")));
  assert.equal(review.recover(root).recovered.length, 1);
  assert.equal(fs.existsSync(path.join(root, ".wiki-review/lock")), false);
  assert.equal(read(root, staged.target), staged.content);
});

test("accepted multi-candidate store can persist and recover a journal larger than the store limit", { timeout: 60_000 }, (t) => {
  const root = fixture(t);
  let first;
  const body = "x".repeat(240_000);
  for (let index = 0; index < 18; index += 1) {
    const staged = candidate(root, { title: `候选 ${index}`, body: `# 研究 ${index}\n${body}` });
    first ||= staged;
  }
  assert.ok(fs.statSync(path.join(root, review.STATE)).size > 8 * 1024 * 1024);
  assert.throws(() => review.adopt(root, first.id, { afterWrite: () => { throw new Error("crash"); } }), /crash/u);
  assert.ok(fs.statSync(journal(root, first.id)).size > 16 * 1024 * 1024);
  assert.equal(review.recover(root).recovered.length, 1);
  assert.equal(review.show(root, first.id).status, "adopted");
  assert.equal(read(root, first.target), first.content);
});

test("live/foreign owner and recovery guard are never automatically removed", (t) => {
  const root = fixture(t);
  for (const owner of [{ version: 1, pid: process.pid, hostname: os.hostname(), token: "live" }, { version: 1, pid: 9999999, hostname: "other-host", token: "foreign" }]) {
    write(root, ".wiki-review/lock", JSON.stringify(owner));
    assert.throws(() => review.recover(root), code("review_locked"));
    assert.equal(JSON.parse(read(root, ".wiki-review/lock")).token, owner.token);
    fs.unlinkSync(path.join(root, ".wiki-review/lock"));
  }
  write(root, ".wiki-review/lock", JSON.stringify({ version: 1, pid: 9999999, hostname: os.hostname(), token: "old" }));
  write(root, ".wiki-review/lock-recovery", JSON.stringify({ version: 1, pid: 9999999, hostname: os.hostname(), token: "guard" }));
  assert.throws(() => review.recover(root), code("review_locked"));
  assert.equal(JSON.parse(read(root, ".wiki-review/lock-recovery")).token, "guard");
});

test("cross-process owner excludes a second publisher and simultaneous attempts never duplicate the log", { timeout: 15_000 }, async (t) => {
  const root = fixture(t); const staged = candidate(root);
  const ioPath = path.resolve(__dirname, "../../scripts/lib/skill-state-io.js");
  const held = spawn(process.execPath, ["-e", `const fs=require('node:fs');require(${JSON.stringify(ioPath)}).withLock(process.argv[1],()=>{process.stdout.write('locked');fs.readFileSync(0)});`, root], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (held.exitCode === null) held.kill(); });
  await new Promise((resolve, reject) => { held.stdout.once("data", resolve); held.once("error", reject); held.once("exit", (status) => { if (status) reject(new Error(`holder exited ${status}`)); }); });
  const refused = run(root, "adopt", "--id", staged.id, "--json");
  assert.equal(refused.status, 1); assert.equal(JSON.parse(refused.stderr).error, "review_locked");
  await new Promise((resolve) => { held.once("exit", resolve); held.stdin.end(); });
  const attempt = () => new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, "adopt", root, "--id", staged.id, "--json"], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = ""; child.stderr.on("data", (chunk) => { stderr += chunk; }); child.on("exit", (status) => resolve({ status, stderr }));
  });
  const results = await Promise.all([attempt(), attempt()]);
  assert.ok(results.some((item) => item.status === 0));
  for (const result of results) if (result.status !== 0) assert.equal(JSON.parse(result.stderr).error, "review_locked");
  assert.equal((read(root, "log.md").match(/<!-- review-adopt:/gu) || []).length, 1);
});

test("targets reject raw, traversal, Windows reserved names and portable collisions", (t) => {
  const root = fixture(t);
  for (const target of ["raw/new.md", "../wiki/new.md", "wiki/../new.md", "wiki/CON.md", "wiki/bad?.md", "wiki/bad /new.md", "wiki/.hidden/new.md", "wiki/a#b.md", "wiki/a[b].md"]) {
    assert.throws(() => candidate(root, { target }));
  }
  write(root, "wiki/synthesis/Foo.md", "旧页\n");
  assert.throws(() => candidate(root, { target: "wiki/synthesis/foo.md" }), code("target_path_collision"));
  assert.equal(fs.existsSync(path.join(root, "raw/new.md")), false);
});

test("symlink state and target ancestors are refused", (t) => {
  const root = fixture(t); const outside = fs.mkdtempSync(path.join(os.tmpdir(), "skill-review-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  try { fs.symlinkSync(outside, path.join(root, ".wiki-review"), process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (process.platform === "win32" && error.code === "EPERM") { t.skip("symlink privilege unavailable"); return; } throw error; }
  assert.throws(() => issue(root), code("symlink_refused"));
  fs.unlinkSync(path.join(root, ".wiki-review"));
  fs.mkdirSync(path.join(root, "wiki"), { recursive: true });
  fs.symlinkSync(outside, path.join(root, "wiki/synthesis"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => candidate(root), code("symlink_refused"));
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("CLI validates arguments/input safely and supports add/stage/show/adopt without model dependencies", (t) => {
  const root = fixture(t);
  write(root, "packet.json", JSON.stringify(packet(root))); write(root, "body.md", "# 研究\n哈希核验。\n");
  const added = run(root, "add", "--type", "suggestion", "--title", "研究", "--reason", "需要综合", "--path", "raw/notes/资料.md", "--json");
  assert.equal(added.status, 0, added.stderr);
  const problem = JSON.parse(added.stdout);
  const staged = run(root, "stage", "--title", "研究", "--target", "wiki/synthesis/CLI.md", "--body", path.join(root, "body.md"), "--packet", path.join(root, "packet.json"), "--issue", problem.id, "--json");
  assert.equal(staged.status, 0, staged.stderr);
  const result = JSON.parse(staged.stdout);
  assert.equal(run(root, "show", "--id", result.id).status, 0);
  assert.equal(run(root, "adopt", "--id", result.id).status, 0);
  for (const args of [["adopt", "--id", result.id, "--unknown"], ["list", "--status", "bogus"], ["stage", "--title", "缺参数"]]) {
    const refused = run(root, ...args); assert.equal(refused.status, 1); assert.ok(!refused.stderr.includes(root));
  }
  assert.throws(() => withLock(root, () => review.add(root, { type: "suggestion", title: "x", reason: "x" })), code("review_locked"));
});
