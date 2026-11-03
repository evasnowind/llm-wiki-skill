"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { spawnSync } = require("node:child_process");
const { search, verifyPacket, sha256, safeReadFile, validateRoot } = require("../../scripts/lib/skill-retrieval");

function fixture(t, contents = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-query-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, ".wiki-schema.md", "# Schema\n## 别名词表（Alias Table）\n```\nLLM = 大语言模型 = 大模型\n大模型 = 不应传递\n```\n## 其他\n");
  for (const [relative, value] of Object.entries(contents)) write(root, relative, value);
  return root;
}
function write(root, relative, value) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, value);
}
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function run(root, ...args) {
  return spawnSync(process.execPath, [path.resolve(__dirname, "../../scripts/query-cli.js"), ...args.slice(0, 1), root, ...args.slice(1)], { encoding: "utf8" });
}

test("Chinese aliases expand only original groups; same-group dense repetition does not multiply rank", (t) => {
  const root = fixture(t, {
    "wiki/topics/a.md": "# 资料\n大语言模型是主题。\n",
    "wiki/topics/b.md": "# 资料\n不应传递是另一个主题。\n",
    "wiki/topics/c.md": "# 资料\nLLM 大语言模型 大模型 LLM LLM\n"
  });
  const packet = search(root, { query: "LLM" });
  assert.deepEqual(packet.evidence.map((item) => item.path), ["wiki/topics/a.md", "wiki/topics/c.md"]);
  assert.equal(packet.evidence[0].score, packet.evidence[1].score);
  assert.equal(verifyPacket(root, packet).ok, true);
});

test("raw and wiki are separate before ranking and one-hop; derived raw is excluded", (t) => {
  const root = fixture(t, {
    "wiki/topics/wiki.md": "# Wiki\n证据 [[raw/notes/secret]]\n",
    "raw/notes/secret.md": "# 原文\n证据 [[wiki/topics/wiki]]\n",
    "raw/notes/secondary.md": "---\nderived: true\n---\n证据\n",
    "raw/notes/unrelated.txt": "原文没有关键词。\n"
  });
  const wiki = search(root, { query: "证据" });
  const raw = search(root, { query: "证据", mode: "raw" });
  assert.deepEqual(wiki.evidence.map((item) => item.path), ["wiki/topics/wiki.md"]);
  assert.deepEqual(raw.evidence.map((item) => item.path), ["raw/notes/secret.md"]);
  assert.ok(raw.coverage.reasons.some((item) => item.code === "derived_raw_excluded"));
});

test("multiple sections keep heading paths, fenced fake headings and CRLF exact excerpts", (t) => {
  const body = "---\r\ntitle: 检索\r\n---\r\n# 总览\r\n## 第一节\r\n检索第一处\r\n```md\r\n# 伪标题\r\n检索代码\r\n```\r\n## 第二节\r\n检索第二处\r\n";
  const root = fixture(t, { "wiki/topic.md": body });
  const packet = search(root, { query: "检索" });
  assert.equal(packet.evidence.length, 2);
  assert.deepEqual(packet.evidence.map((item) => item.heading), [["总览", "第一节"], ["总览", "第二节"]]);
  assert.ok(packet.evidence[0].excerpt.includes("# 伪标题\r"));
  assert.equal(packet.evidence[0].fileSha256, sha256(Buffer.from(body)));
  assert.equal(verifyPacket(root, packet).ok, true);
});

test("frontmatter improves rank but cannot supply factual excerpts", (t) => {
  const root = fixture(t, { "wiki/a.md": "---\ntitle: 主题\ntags: [关键词]\nsecret: 关键词\n---\n# 公开正文\n资料正文。\n" });
  const packet = search(root, { query: "关键词" });
  assert.equal(packet.evidence.length, 1);
  assert.ok(packet.evidence[0].reasons.includes("metadata"));
  assert.ok(!packet.evidence[0].excerpt.includes("secret"));
  assert.equal(packet.evidence[0].startLine, 6);
  const forged = copy(packet);
  forged.evidence[0].startLine = 2;
  forged.evidence[0].endLine = 2;
  forged.evidence[0].excerpt = "title: 主题";
  forged.evidence[0].excerptSha256 = sha256(forged.evidence[0].excerpt);
  assert.equal(verifyPacket(root, forged).errors[0].code, "invalid_location");
});

test("unique one-hop links add context but ambiguity and recursive links do not", (t) => {
  const root = fixture(t, {
    "wiki/source.md": "# 起点\n关键词 [[unique]] [[duplicate]] [[wiki/exact]]\n",
    "wiki/unique.md": "# 连接正文\n无搜索词 [[third]]\n",
    "wiki/exact.md": "# 精确正文\n无搜索词\n",
    "wiki/a/duplicate.md": "无搜索词\n",
    "wiki/b/duplicate.md": "无搜索词\n",
    "wiki/third.md": "无搜索词\n"
  });
  const packet = search(root, { query: "关键词" });
  assert.deepEqual(new Set(packet.evidence.map((item) => item.path)), new Set(["wiki/source.md", "wiki/unique.md", "wiki/exact.md"]));
});

test("stale bytes and forged excerpt, line, heading, id or corpus fail verification", (t) => {
  const root = fixture(t, { "raw/a.md": "# 原文\n可靠资料\n" });
  const packet = search(root, { query: "可靠", mode: "raw" });
  for (const mutate of [
    (item) => { item.excerpt = "编造资料"; item.excerptSha256 = sha256(item.excerpt); },
    (item) => { item.startLine = 200; item.endLine = 201; },
    (item) => { item.heading = ["假标题"]; },
    (item) => { item.id = "ev-fake"; },
    (item) => { item.path = "wiki/a.md"; }
  ]) {
    const forged = copy(packet);
    mutate(forged.evidence[0]);
    assert.equal(verifyPacket(root, forged).ok, false);
  }
  write(root, "raw/a.md", "# 原文\n可靠资料\n外部编辑\n");
  assert.equal(verifyPacket(root, packet).errors[0].code, "source_changed");
});

test("verification rejects noncanonical paths and duplicate evidence", (t) => {
  const root = fixture(t, { "wiki/a.md": "# 内容\n关键词\n" });
  const packet = search(root, { query: "关键词" });
  for (const relative of ["../outside.md", "/absolute.md", "C:/secret.md", "wiki/../a.md", "wiki\\a.md", "wiki//a.md", "wiki/a.md\0"]) {
    const forged = copy(packet);
    forged.evidence[0].path = relative;
    assert.equal(verifyPacket(root, forged).errors[0].code, "unsafe_path");
  }
  packet.evidence.push(copy(packet.evidence[0]));
  assert.equal(verifyPacket(root, packet).errors[0].code, "invalid_evidence_id");
});

test("file, entry, depth, output and evidence budgets report incomplete coverage", (t) => {
  const root = fixture(t, {
    "wiki/a.md": "# 一\n关键词\n# 二\n关键词\n# 三\n关键词\n",
    "wiki/b.md": "关键词\n",
    "wiki/sub/deep/c.md": "关键词\n"
  });
  for (const limits of [{ maxFiles: 1 }, { maxEntries: 1 }, { maxDepth: 1 }, { maxEvidence: 1 }, { maxPerFile: 1 }, { maxFileBytes: 8 }, { maxTotalBytes: 8 }]) {
    // A small maxFileBytes also bounds the required schema: use a tiny valid schema.
    write(root, ".wiki-schema.md", "# KB\n");
    const packet = search(root, { query: "关键词", limits });
    assert.equal(packet.coverage.complete, false, JSON.stringify(limits));
    assert.ok(packet.coverage.reasons.length > 0);
  }
  write(root, "wiki/a.md", "# 一\n关键词" + "文".repeat(6000));
  const output = search(root, { query: "关键词", limits: { maxOutputChars: 4096 } });
  assert.equal(output.coverage.complete, false);
  assert.ok(output.coverage.reasons.some((item) => item.code === "output_limit"));
  assert.ok(JSON.stringify(output).length <= 4096);
});

test("invalid UTF-8 counts toward the total read budget and cannot become evidence", (t) => {
  const root = fixture(t, { "wiki/a.md": Buffer.from([0xff, 0xfe, 0xfd]), "wiki/b.md": "关键词" });
  const packet = search(root, { query: "关键词", limits: { maxTotalBytes: 3 } });
  assert.equal(packet.coverage.bytesRead, 3);
  assert.equal(packet.evidence.length, 0);
  assert.ok(packet.coverage.reasons.some((item) => item.code === "invalid_utf8"));
  assert.equal(packet.coverage.complete, false);
});

test("symlink files and directories are not read, including required schema", (t) => {
  const root = fixture(t, { "outside/a.md": "关键词" });
  fs.mkdirSync(path.join(root, "wiki"));
  try {
    fs.symlinkSync(path.join(root, "outside/a.md"), path.join(root, "wiki/link.md"));
    fs.symlinkSync(path.join(root, "outside"), path.join(root, "wiki/linked-dir"), "junction");
  } catch (error) {
    if (["EPERM", "EACCES"].includes(error.code)) return t.skip("symlink privilege unavailable");
    throw error;
  }
  const packet = search(root, { query: "关键词" });
  assert.equal(packet.evidence.length, 0);
  assert.equal(packet.coverage.complete, false);
  assert.throws(() => safeReadFile(root, "wiki/link.md"), { code: "symlink_refused" });
  fs.unlinkSync(path.join(root, ".wiki-schema.md"));
  fs.symlinkSync(path.join(root, "outside/a.md"), path.join(root, ".wiki-schema.md"));
  assert.throws(() => validateRoot(root), { code: "invalid_schema_or_root" });
});

test("missing corpus is an empty search; malformed schema/root/mode/query/limits fail safely", (t) => {
  const root = fixture(t);
  assert.deepEqual(search(root, { query: "未知" }).evidence, []);
  assert.throws(() => search(root, { mode: "all", query: "x" }), { code: "invalid_mode" });
  assert.throws(() => search(root, { query: " " }), { code: "invalid_query" });
  assert.throws(() => search(root, { query: "x", limits: { maxFiles: Infinity } }), { code: "invalid_limit" });
  assert.equal(verifyPacket(root, { version: 9 }).ok, false);
  fs.unlinkSync(path.join(root, ".wiki-schema.md"));
  assert.throws(() => search(root, { query: "x" }), { code: "invalid_schema_or_root" });
});

test("malformed frontmatter and pathological document shapes report partial coverage", (t) => {
  const root = fixture(t, {
    "wiki/malformed.md": "---\ntitle: 关键词\n正文没有闭合分隔符\n",
    "wiki/too-many.md": "# 关键词\n".repeat(10002)
  });
  const packet = search(root, { query: "关键词" });
  assert.equal(packet.coverage.complete, false);
  assert.equal(packet.evidence.length, 0);
  assert.deepEqual(new Set(packet.coverage.reasons.map((item) => item.code)), new Set(["malformed_frontmatter", "document_too_complex"]));
});

test("parent path swapped to a symlink during open is refused before reading", (t) => {
  const root = fixture(t, { "wiki/a.md": "本库资料", "other/a.md": "不应读取的资料" });
  // Probe privileges before replacing the directory, including on Windows CI.
  try { fs.symlinkSync(path.join(root, "other"), path.join(root, "probe"), "junction"); }
  catch (error) {
    if (["EPERM", "EACCES"].includes(error.code)) return t.skip("symlink privilege unavailable");
    throw error;
  }
  fs.unlinkSync(path.join(root, "probe"));
  const canonicalRoot = fs.realpathSync(root);
  const original = fs.openSync;
  let replaced = false;
  fs.openSync = function (filename, ...rest) {
    if (!replaced && filename === path.join(canonicalRoot, "wiki/a.md")) {
      replaced = true;
      fs.renameSync(path.join(root, "wiki"), path.join(root, "old-wiki"));
      fs.symlinkSync(path.join(root, "other"), path.join(root, "wiki"), "junction");
    }
    return original.call(this, filename, ...rest);
  };
  try { assert.throws(() => safeReadFile(fs.realpathSync(root), "wiki/a.md"), { code: "symlink_refused" }); }
  finally { fs.openSync = original; }
});

test("CLI searches/verifies JSON with no KB writes, rejects unknown arguments and malformed packets", (t) => {
  const root = fixture(t, { "raw/中文 空格.MD": "# 资料\n日常 Markdown\n" });
  const result = run(root, "search", "--mode", "raw", "--query", "Markdown", "--json");
  assert.equal(result.status, 0, result.stderr);
  const packet = JSON.parse(result.stdout);
  assert.equal(packet.evidence[0].path, "raw/中文 空格.MD");
  const packetFile = path.join(root, "packet.json");
  fs.writeFileSync(packetFile, result.stdout);
  assert.equal(run(root, "verify", "--packet", packetFile, "--json").status, 0);
  assert.notEqual(run(root, "search", "--query", "x", "--bogus").status, 0);
  fs.writeFileSync(packetFile, "{");
  assert.notEqual(run(root, "verify", "--packet", packetFile).status, 0);
  assert.deepEqual(fs.readdirSync(root).sort(), [".wiki-schema.md", "packet.json", "raw"]);
});

test("copied runtime operates without packages, workbench or node_modules", (t) => {
  const root = fixture(t, { "wiki/a.md": "# 日常\n独立运行资料\n" });
  const install = fs.mkdtempSync(path.join(os.tmpdir(), "skill-query-install-"));
  t.after(() => fs.rmSync(install, { recursive: true, force: true }));
  const installedScripts = path.join(install, "scripts");
  fs.mkdirSync(installedScripts);
  fs.copyFileSync(path.resolve(__dirname, "../../scripts/query-cli.js"), path.join(installedScripts, "query-cli.js"));
  fs.cpSync(path.resolve(__dirname, "../../scripts/lib"), path.join(installedScripts, "lib"), { recursive: true });
  fs.cpSync(path.resolve(__dirname, "../../deps"), path.join(install, "deps"), { recursive: true });
  const result = spawnSync(process.execPath, [path.join(installedScripts, "query-cli.js"), "search", root, "--query", "独立运行", "--json"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).evidence.length, 1);
});

test("CLI serialized output stays inside its declared character budget", (t) => {
  const files = {};
  for (let index = 0; index < 30; index += 1) files[`wiki/${index}.md`] = `# 关键词\n${"关键词\\引号\"".repeat(500)}`;
  const root = fixture(t, files);
  const result = run(root, "search", "--query", "关键词", "--json");
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.length <= 64000);
  assert.ok(JSON.parse(result.stdout).coverage.reasons.some((item) => item.code === "output_limit"));
});
