"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync, spawn } = require("node:child_process");
const { test } = require("node:test");
const { search } = require("../../scripts/lib/skill-retrieval");
const review = require("../../scripts/lib/skill-review");

const cli = path.resolve(__dirname, "../../scripts/archive.py");
const python = ["python3", "python"].find((cmd) => spawnSync(cmd, ["-c", "import sys; sys.exit(0 if sys.version_info >= (3,8) else 1)"], { encoding: "utf8" }).status === 0);
assert.ok(python, "Python 3.8+ is required for archive tests");
const sha = (data) => crypto.createHash("sha256").update(data).digest("hex");

function fixture(t, withReview = false) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "skill archive 中文 ")));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const kb = path.join(temp, "知识 库");
  for (const relative of ["raw/notes", "raw/assets/空 文件夹", "wiki/topics", "wiki/queries", "wiki/synthesis", "assets", "attachments"]) fs.mkdirSync(path.join(kb, relative), { recursive: true });
  for (const [relative, data] of Object.entries({
    ".wiki-schema.md": "# Schema\r\n## 别名词表\r\nMarkdown = MD\r\n",
    "index.md": "# 索引\r\n", "log.md": "# 日志\r\n", "purpose.md": "# 研究方向\nMarkdown 日常使用。\n",
    "raw/notes/样本.md": "# Markdown\r\n原始资料可离线保存。\r\n",
    "wiki/topics/整理.md": "# Markdown\n整理笔记。\n",
    ".wiki-cache.json": JSON.stringify({ version: 1, entries: { stale: { source_page: "/old/machine/page.md" } } }),
    "raw/assets/图片.bin": Buffer.from([0, 1, 2, 13, 10, 255, 128]),
    "assets/图.dat": Buffer.from([7, 8, 9]), "attachments/附件.txt": "保留附件\n",
  })) fs.writeFileSync(path.join(kb, relative), data);
  if (withReview) {
    const packet = search(kb, { query: "Markdown", mode: "raw" });
    const issue = review.add(kb, { type: "unverified", title: "核对", reason: "核对资料", paths: ["raw/notes/样本.md"], packet });
    const adopted = review.stage(kb, { title: "研究", target: "wiki/synthesis/研究.md", body: "# 研究\n可以离线保存。", packet, issueId: issue.id });
    review.adopt(kb, adopted.id);
    review.stage(kb, { title: "待采用", target: "wiki/queries/待采用.md", body: "# 待采用\n候选不改变正式文件。", packet });
  }
  const run = (...args) => spawnSync(python, [cli, ...args, "--json"], { encoding: "utf8", timeout: 20_000, env: { ...process.env, HOME: temp, USERPROFILE: temp, PYTHONIOENCODING: "utf-8" } });
  const ok = (...args) => {
    const result = run(...args);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };
  const reject = (args, expected) => {
    const result = run(...args);
    assert.notEqual(result.status, 0, result.stdout);
    const error = JSON.parse(result.stderr);
    assert.equal(error.ok, false);
    if (expected) assert.equal(error.error, expected);
    assert.ok(!result.stderr.includes(temp), "errors must not disclose absolute private paths");
    return error.error;
  };
  return { temp, kb, run, ok, reject, zip: path.join(temp, "知识归档.zip") };
}

function listFiles(root, relative = "") {
  return fs.readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap((entry) => {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    return entry.isDirectory() ? listFiles(root, name) : [name];
  }).sort();
}

function readZip(filename) {
  const result = spawnSync(python, ["-c", "import sys,zipfile,json,base64; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps([{'name':i.filename,'data':base64.b64encode(z.read(i)).decode(),'mode':i.external_attr} for i in z.infolist()]))", filename], { encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function writeZip(filename, entries) {
  const script = "import sys,zipfile,json,base64\nwith zipfile.ZipFile(sys.argv[1],'w',compression=zipfile.ZIP_DEFLATED) as z:\n for e in json.load(sys.stdin):\n  i=zipfile.ZipInfo(e['name']); i.external_attr=e.get('mode',0); z.writestr(i,base64.b64decode(e['data']))\n";
  const result = spawnSync(python, ["-c", script, filename], { input: JSON.stringify(entries), encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
}

function manifestOf(entries) {
  return JSON.parse(Buffer.from(entries.find((entry) => entry.name === "archive-manifest.json").data, "base64").toString("utf8"));
}

function replaceManifest(entries, manifest) {
  entries.find((entry) => entry.name === "archive-manifest.json").data = Buffer.from(JSON.stringify(manifest)).toString("base64");
}

test("archive round-trip preserves Markdown, binary assets, empty directories and real Review state; cache safely resets", (t) => {
  const f = fixture(t, true);
  fs.writeFileSync(path.join(f.kb, ".env"), "PRIVATE=not-knowledge\n");
  fs.mkdirSync(path.join(f.kb, "workbench"));
  fs.writeFileSync(path.join(f.kb, "workbench/config.json"), "private");
  const exported = f.ok("export", f.kb, "--output", f.zip);
  assert.match(exported.knowledgeBaseId, /^kb-[a-f0-9]{32}$/);
  assert.deepEqual(exported.excluded, [".env", ".wiki-review/lock", "workbench"]);
  assert.equal(fs.existsSync(path.join(f.kb, ".wiki-review/lock")), false);
  const expected = listFiles(f.kb).filter((relative) => !relative.startsWith("workbench/") && relative !== ".env");
  const verified = f.ok("verify", f.zip);
  assert.equal(verified.knowledgeBaseId, exported.knowledgeBaseId);
  const target = path.join(f.temp, "恢复 目录");
  const restored = f.ok("restore", f.zip, "--target", target);
  assert.equal(restored.cacheInvalidated, true);
  assert.deepEqual(listFiles(target), expected);
  for (const relative of expected.filter((relative) => relative !== ".wiki-cache.json")) assert.deepEqual(fs.readFileSync(path.join(target, relative)), fs.readFileSync(path.join(f.kb, relative)), relative);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(target, ".wiki-cache.json"))), { version: 1, entries: {} });
  assert.ok(fs.statSync(path.join(target, "raw/assets/空 文件夹")).isDirectory());
  assert.equal(review.list(target, { status: "all" }).candidates.length, 2);
  assert.equal(review.show(target, review.list(target).candidates.find((item) => item.status === "ready").id).evidenceVerification.ok, true);
  assert.deepEqual(review.recover(target).recovered, []);
  const second = path.join(f.temp, "second.zip");
  assert.equal(f.ok("export", target, "--output", second).knowledgeBaseId, exported.knowledgeBaseId);
  assert.equal(fs.existsSync(path.join(f.temp, ".llm-wiki-path")), false);
});

test("initialized empty directories survive restore and an empty target is accepted", (t) => {
  const f = fixture(t);
  fs.rmSync(path.join(f.kb, "raw/notes/样本.md"));
  fs.rmSync(path.join(f.kb, "wiki/topics/整理.md"));
  f.ok("export", f.kb, "--output", f.zip);
  const target = path.join(f.temp, "empty"); fs.mkdirSync(target);
  f.ok("restore", f.zip, "--target", target);
  assert.ok(fs.statSync(path.join(target, "raw/notes")).isDirectory());
  assert.ok(fs.statSync(path.join(target, "wiki/queries")).isDirectory());
  assert.deepEqual(search(target, { query: "missing", mode: "raw" }).evidence, []);
});

test("export refuses live locks, recovery guards and incomplete/malformed publication without leaving output", (t) => {
  const f = fixture(t, true);
  for (const relative of [".wiki-review/lock", ".wiki-review/lock-recovery"]) {
    fs.writeFileSync(path.join(f.kb, relative), "{}");
    f.reject(["export", f.kb, "--output", f.zip], "review_locked");
    assert.equal(fs.existsSync(f.zip), false);
    fs.unlinkSync(path.join(f.kb, relative));
  }
  const journal = path.join(f.kb, listFiles(f.kb).find((relative) => relative.startsWith(".wiki-review/journals/")));
  const original = fs.readFileSync(journal);
  const value = JSON.parse(original); value.committed = false;
  fs.writeFileSync(journal, JSON.stringify(value));
  f.reject(["export", f.kb, "--output", f.zip], "incomplete_publication");
  fs.writeFileSync(journal, "{");
  f.reject(["export", f.kb, "--output", f.zip], "invalid_review_journal");
  assert.equal(fs.existsSync(path.join(f.kb, ".wiki-review/lock")), false);
  fs.writeFileSync(journal, original);
  fs.writeFileSync(path.join(f.kb, ".wiki-review/state.json"), "{}");
  f.reject(["export", f.kb, "--output", f.zip], "invalid_review_state");
});

test("archives omit own transient files but keep ready candidates and reject unknown output replacement", (t) => {
  const f = fixture(t, true);
  fs.writeFileSync(path.join(f.kb, `.wiki-review/state.json.tmp-${"a".repeat(20)}`), "incomplete temp");
  fs.writeFileSync(path.join(f.kb, "raw/notes/research.tmp-draft.md"), "legitimate raw data");
  f.ok("export", f.kb, "--output", f.zip);
  assert.ok(!readZip(f.zip).some((entry) => entry.name.startsWith(".wiki-review/") && entry.name.includes(".tmp-")));
  assert.ok(readZip(f.zip).some((entry) => entry.name === "raw/notes/research.tmp-draft.md"));
  const before = fs.readFileSync(f.zip);
  f.reject(["export", f.kb, "--output", f.zip], "output_exists");
  assert.deepEqual(fs.readFileSync(f.zip), before);
  f.reject(["export", f.kb, "--output", path.join(f.kb, "backup.zip")], "output_inside_knowledge_base");
});

test("content corruption, extra/missing entries, duplicate entries and identity mismatch fail verification and restore cleanly", (t) => {
  const f = fixture(t);
  f.ok("export", f.kb, "--output", f.zip);
  const original = readZip(f.zip);
  const mutations = [
    (entries) => { entries.find((item) => item.name === "raw/notes/样本.md").data = Buffer.from("changed").toString("base64"); },
    (entries) => { entries.push({ name: "raw/extra.md", data: Buffer.from("extra").toString("base64") }); },
    (entries) => { entries.splice(entries.findIndex((item) => item.name === "index.md"), 1); },
    (entries) => { entries.push(entries.find((item) => item.name === "index.md")); },
    (entries) => { const m = manifestOf(entries); m.knowledgeBaseId = `kb-${"a".repeat(32)}`; replaceManifest(entries, m); },
    (entries) => { entries.splice(entries.findIndex((item) => item.name === "archive-manifest.json"), 1); },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const entries = structuredClone(original); mutate(entries);
    const bad = path.join(f.temp, `bad-${index}.zip`); writeZip(bad, entries);
    f.reject(["verify", bad]);
    const target = path.join(f.temp, `restore-${index}`);
    f.reject(["restore", bad, "--target", target]);
    assert.equal(fs.existsSync(target), false);
    assert.ok(!fs.readdirSync(f.temp).some((name) => name.startsWith(".wiki-restore-")));
  }
});

test("unsafe ZIP names, symlinks and portable directory/file collisions are refused", (t) => {
  const f = fixture(t);
  f.ok("export", f.kb, "--output", f.zip);
  const original = readZip(f.zip);
  for (const [index, name] of ["../escape.md", "/absolute.md", "C:/escape.md", "//server/share.md", "raw\\escape.md", "raw/CON.md", "raw/COM¹.md", "raw/CONOUT$.md", "raw/trailing .", "raw/x/../escape.md"].entries()) {
    const entries = structuredClone(original);
    entries.push({ name, data: Buffer.from("escape").toString("base64") });
    const bad = path.join(f.temp, `unsafe-${index}.zip`); writeZip(bad, entries);
    f.reject(["verify", bad], "unsafe_path");
  }
  const symlink = structuredClone(original);
  symlink.find((entry) => entry.name === "raw/notes/样本.md").mode = 0o120777 * 65536;
  const symlinkZip = path.join(f.temp, "symlink.zip"); writeZip(symlinkZip, symlink);
  f.reject(["verify", symlinkZip], "unsupported_zip_entry");
  for (const [index, additions] of [["raw/Foo/", "raw/foo/"], ["raw/café/", "raw/café/"], ["raw/notes/样本.md/"]].entries()) {
    const entries = structuredClone(original);
    for (const name of additions) entries.push({ name, data: "" });
    const bad = path.join(f.temp, `collision-${index}.zip`); writeZip(bad, entries);
    f.reject(["verify", bad], "portable_path_collision");
  }
  assert.equal(fs.existsSync(path.join(f.temp, "escape.md")), false);
});

test("restoring refuses nonempty targets and filesystem symlink ancestors while preserving unknown files", (t) => {
  const f = fixture(t);
  f.ok("export", f.kb, "--output", f.zip);
  const nonempty = path.join(f.temp, "nonempty"); fs.mkdirSync(nonempty);
  fs.writeFileSync(path.join(nonempty, "keep.txt"), "unchanged");
  f.reject(["restore", f.zip, "--target", nonempty], "target_not_empty");
  assert.equal(fs.readFileSync(path.join(nonempty, "keep.txt"), "utf8"), "unchanged");
  const outside = path.join(f.temp, "outside"); fs.mkdirSync(outside);
  const link = path.join(f.temp, "linked");
  try { fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (["EPERM", "EACCES"].includes(error.code)) return; throw error; }
  f.reject(["restore", f.zip, "--target", path.join(link, "target")], "symlink_refused");
  f.reject(["export", f.kb, "--output", path.join(link, "backup.zip")], "symlink_refused");
  const rawLink = path.join(f.kb, "raw/linked"); fs.symlinkSync(outside, rawLink, process.platform === "win32" ? "junction" : "dir");
  f.reject(["export", f.kb, "--output", path.join(f.temp, "linked-source.zip")], "symlink_refused");
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("file/count/total/archive budgets reject rather than silently dropping data", (t) => {
  const f = fixture(t);
  f.reject(["export", f.kb, "--output", f.zip, "--max-file-bytes", "16"], "file_budget_exceeded");
  f.reject(["export", f.kb, "--output", f.zip, "--max-files", "2"], "file_count_budget_exceeded");
  f.reject(["export", f.kb, "--output", f.zip, "--max-total-bytes", "64"], "total_budget_exceeded");
  f.ok("export", f.kb, "--output", f.zip);
  f.reject(["verify", f.zip, "--max-archive-bytes", "32"], "archive_budget_exceeded");
  f.reject(["verify", f.zip, "--max-total-bytes", "64"], "total_budget_exceeded");
  f.reject(["verify", f.zip, "--max-files", "2"], "invalid_manifest");
  f.reject(["verify", f.zip, "--max-total-bytes", "2147483649"], "invalid_limit");
  assert.ok(!fs.readdirSync(f.temp).some((name) => name.startsWith(".wiki-archive-")));
});

test("even a self-consistently hashed archive cannot restore pending Review publication", (t) => {
  const f = fixture(t, true);
  f.ok("export", f.kb, "--output", f.zip);
  const entries = readZip(f.zip);
  const journal = entries.find((entry) => entry.name.startsWith(".wiki-review/journals/") && !entry.name.endsWith("/"));
  const value = JSON.parse(Buffer.from(journal.data, "base64")); value.committed = false;
  const changed = Buffer.from(JSON.stringify(value)); journal.data = changed.toString("base64");
  const manifest = manifestOf(entries); const record = manifest.files.find((entry) => entry.path === journal.name);
  record.size = changed.length; record.sha256 = sha(changed); replaceManifest(entries, manifest);
  const bad = path.join(f.temp, "pending.zip"); writeZip(bad, entries);
  f.reject(["verify", bad], "incomplete_publication");
  f.reject(["restore", bad, "--target", path.join(f.temp, "pending-restore")], "incomplete_publication");
});

test("export and Review share a real cross-process lock", async (t) => {
  const f = fixture(t);
  const io = path.resolve(__dirname, "../../scripts/lib/skill-state-io.js");
  const holder = spawn(process.execPath, ["-e", "const io=require(process.argv[1]);io.withLock(process.argv[2],()=>{process.stdout.write('locked\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30000)});", io, f.kb], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => holder.kill());
  await new Promise((resolve, reject) => {
    holder.stdout.once("data", resolve); holder.once("error", reject); holder.once("exit", (code) => reject(new Error(`holder exited ${code}`)));
  });
  f.reject(["export", f.kb, "--output", f.zip], "review_locked");
  holder.kill();
  await new Promise((resolve) => holder.once("exit", resolve));
  review.recover(f.kb);
  f.ok("export", f.kb, "--output", f.zip);
});

test("export refuses external edits during its final snapshot check and removes temporary output", (t) => {
  const f = fixture(t);
  const script = `import importlib.util,sys,pathlib
s=importlib.util.spec_from_file_location('wiki_archive',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
original=m.inventory; calls=0
def inventory(root,limits):
 global calls
 calls+=1
 if calls==2: (root/'raw/notes/样本.md').write_bytes(b'changed after packing')
 return original(root,limits)
m.inventory=inventory
try: m.export_archive(sys.argv[2],sys.argv[3],m.DEFAULTS)
except m.ArchiveError as e: print(str(e));sys.exit(3)
`;
  const result = spawnSync(python, ["-B", "-c", script, cli, f.kb, f.zip], { encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 3, result.stderr || result.stdout);
  assert.equal(result.stdout.trim(), "source_changed");
  assert.equal(fs.existsSync(f.zip), false);
  assert.equal(fs.existsSync(path.join(f.kb, ".wiki-review/lock")), false);
  assert.ok(!fs.readdirSync(f.temp).some((name) => name.startsWith(".wiki-archive-")));
});

test("restore rechecks target after validation and preserves a concurrently added unknown file", (t) => {
  const f = fixture(t);
  f.ok("export", f.kb, "--output", f.zip);
  const target = path.join(f.temp, "concurrent"); fs.mkdirSync(target);
  const script = `import importlib.util,sys,pathlib
s=importlib.util.spec_from_file_location('wiki_archive',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
original=m.verified_extract
def extract(source,staging,limits):
 result=original(source,staging,limits)
 (pathlib.Path(sys.argv[3])/'keep.txt').write_bytes(b'concurrent edit')
 return result
m.verified_extract=extract
try: m.restore_archive(sys.argv[2],sys.argv[3],m.DEFAULTS)
except m.ArchiveError as e: print(str(e));sys.exit(3)
`;
  const result = spawnSync(python, ["-B", "-c", script, cli, f.zip, target], { encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 3, result.stderr || result.stdout);
  assert.equal(result.stdout.trim(), "target_not_empty");
  assert.equal(fs.readFileSync(path.join(target, "keep.txt"), "utf8"), "concurrent edit");
  assert.deepEqual(fs.readdirSync(target), ["keep.txt"]);
  assert.ok(!fs.readdirSync(f.temp).some((name) => name.startsWith(".wiki-restore-")));
});

test("Bash wrapper uses the shared Python locator with Unicode and space arguments", (t) => {
  const f = fixture(t);
  const bash = process.platform === "win32" ? path.join(process.env.ProgramFiles || "C:/Program Files", "Git/bin/bash.exe") : "bash";
  const wrapper = path.resolve(__dirname, "../../scripts/archive.sh").replace(/\\/g, "/");
  const result = spawnSync(bash, [wrapper, "export", f.kb.replace(/\\/g, "/"), "--output", f.zip.replace(/\\/g, "/"), "--json"], {
    encoding: "utf8", timeout: 10_000, env: { ...process.env, PYTHON_CMD: python, PYTHONIOENCODING: "utf-8" },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).ok, true);
  f.ok("verify", f.zip);
});

test("malformed Review metadata is rejected even when archive hashes are recomputed", (t) => {
  const f = fixture(t, true);
  f.ok("export", f.kb, "--output", f.zip);
  const original = readZip(f.zip);
  for (const [index, mutate] of [
    (value) => { value.version = true; },
    (value) => { value.candidates[0].packet.evidence[0].startLine = -1; },
    (value) => { delete value.issues[0].paths; },
    (value) => { value.candidates[0].target = "raw/notes/overwrite.md"; },
    (value) => { value.candidates.find((item) => item.status === "ready").id = `candidate-${"b".repeat(24)}`; },
    (value) => { value.issues[0].reason = "changed without a matching issue identity"; },
  ].entries()) {
    const entries = structuredClone(original);
    const state = entries.find((entry) => entry.name === ".wiki-review/state.json");
    const value = JSON.parse(Buffer.from(state.data, "base64")); mutate(value);
    const data = Buffer.from(JSON.stringify(value)); state.data = data.toString("base64");
    const manifest = manifestOf(entries); const record = manifest.files.find((item) => item.path === state.name);
    record.size = data.length; record.sha256 = sha(data); replaceManifest(entries, manifest);
    const bad = path.join(f.temp, `bad-review-${index}.zip`); writeZip(bad, entries);
    f.reject(["verify", bad], "invalid_review_state");
  }
});

test("forged central-directory counts and very small invalid ZIPs fail safely", (t) => {
  const f = fixture(t);
  f.ok("export", f.kb, "--output", f.zip);
  const buffer = fs.readFileSync(f.zip);
  const marker = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  buffer.writeUInt16LE(1, marker + 8); buffer.writeUInt16LE(1, marker + 10);
  const forged = path.join(f.temp, "forged-directory.zip"); fs.writeFileSync(forged, buffer);
  f.reject(["verify", forged], "invalid_archive");
  const nul = fs.readFileSync(f.zip);
  const centralOffset = nul.readUInt32LE(marker + 16);
  nul[centralOffset + 46] = 0;
  const nulName = path.join(f.temp, "nul-name.zip"); fs.writeFileSync(nulName, nul);
  f.reject(["verify", nulName], "unsafe_path");
  const tiny = path.join(f.temp, "tiny.zip"); fs.writeFileSync(tiny, "PK");
  f.reject(["verify", tiny], "invalid_archive");
});

test("Review state and committed history must agree in export and even rehashed restore input", (t) => {
  const f = fixture(t, true);
  f.ok("export", f.kb, "--output", f.zip);
  const original = readZip(f.zip);
  const originalState = fs.readFileSync(path.join(f.kb, ".wiki-review/state.json"));
  const cases = [
    (state) => { state.candidates.find((item) => item.status === "adopted").status = "ready"; },
    (state) => { state.candidates = state.candidates.filter((item) => item.status !== "adopted"); },
    (state) => { state.issues[0].resolvedBy = `candidate-${"a".repeat(24)}`; },
  ];
  for (const [index, mutate] of cases.entries()) {
    const state = JSON.parse(originalState); mutate(state);
    const data = Buffer.from(JSON.stringify(state));
    fs.writeFileSync(path.join(f.kb, ".wiki-review/state.json"), data);
    f.reject(["export", f.kb, "--output", path.join(f.temp, `broken-${index}.zip`)]);
    fs.writeFileSync(path.join(f.kb, ".wiki-review/state.json"), originalState);
    const entries = structuredClone(original);
    entries.find((item) => item.name === ".wiki-review/state.json").data = data.toString("base64");
    const manifest = manifestOf(entries); const record = manifest.files.find((item) => item.path === ".wiki-review/state.json");
    record.size = data.length; record.sha256 = sha(data); replaceManifest(entries, manifest);
    const bad = path.join(f.temp, `broken-input-${index}.zip`); writeZip(bad, entries);
    f.reject(["verify", bad]);
    const target = path.join(f.temp, `broken-restore-${index}`);
    f.reject(["restore", bad, "--target", target]);
    assert.equal(fs.existsSync(target), false);
  }
  const entries = structuredClone(original);
  const journalIndex = entries.findIndex((item) => item.name.startsWith(".wiki-review/journals/") && !item.name.endsWith("/"));
  const journalName = entries[journalIndex].name; entries.splice(journalIndex, 1);
  const manifest = manifestOf(entries); manifest.files = manifest.files.filter((item) => item.path !== journalName); replaceManifest(entries, manifest);
  const missing = path.join(f.temp, "missing-history.zip"); writeZip(missing, entries);
  f.reject(["verify", missing], "invalid_review_journal");
  const noStateEntries = structuredClone(original).filter((item) => item.name !== ".wiki-review/state.json");
  const noStateManifest = manifestOf(noStateEntries); noStateManifest.files = noStateManifest.files.filter((item) => item.path !== ".wiki-review/state.json"); replaceManifest(noStateEntries, noStateManifest);
  const noState = path.join(f.temp, "missing-state.zip"); writeZip(noState, noStateEntries);
  f.reject(["verify", noState], "invalid_review_journal");
});

test("malformed CLI arguments fail with structured safe errors", (t) => {
  const f = fixture(t);
  f.reject(["unknown", f.kb], "invalid_arguments");
  f.reject(["export", f.kb], "invalid_arguments");
  f.reject(["restore", f.zip, "--target"], "invalid_arguments");
  f.reject(["verify", f.zip, "--max-files", "bad"], "invalid_arguments");
  f.reject(["verify", f.zip, "--unknown", f.kb], "invalid_arguments");
});

test("archive identity checks preserve valid Node evidence packets with fractional ranking metadata", (t) => {
  const f = fixture(t);
  const packet = search(f.kb, { query: "Markdown", mode: "raw" });
  packet.rankWeight = 1e-7;
  packet.evidence[0].score = 0.000001;
  packet.customWeights = [1.25, 1e21, 1e20, -0, 0.000001234];
  const candidate = review.stage(f.kb, { title: "浮点排序", target: "wiki/synthesis/浮点.md", body: "保留有效的自定义排序元数据。", packet });
  review.adopt(f.kb, candidate.id);
  f.ok("export", f.kb, "--output", f.zip);
  const target = path.join(f.temp, "fractional");
  f.ok("restore", f.zip, "--target", target);
  assert.equal(review.show(target, candidate.id).status, "adopted");
  assert.deepEqual(review.recover(target).recovered, []);
});
