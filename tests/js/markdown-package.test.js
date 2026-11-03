"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const { copyFixture } = require("./helpers/copy-fixture");
const modulePath = path.resolve(__dirname, "../../scripts/lib/markdown-package.js");
const { inspectPackage, capturePackage, verifyPackage, readSafeBinary, validateBinding, sha256 } = require(modulePath);
const SOURCE = `md-${"1".repeat(24)}`;

function fixture(t) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "markdown package 中文 ")));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const source = path.join(temp, "source"), kb = path.join(temp, "knowledge");
  fs.mkdirSync(source); fs.mkdirSync(kb); fs.writeFileSync(path.join(kb, ".wiki-schema.md"), "# Schema\n");
  const write = (relative, body) => { fs.mkdirSync(path.dirname(path.join(source, relative)), { recursive: true }); fs.writeFileSync(path.join(source, relative), body); };
  return { temp, source, kb, write };
}

function code(expected) { return (error) => error.code === expected; }

test("raw Markdown, frontmatter, Unicode, BOM, CRLF, code and binary bytes remain exact; reading links resolve", (t) => {
  const f = fixture(t);
  const markdown = "\uFEFF---\r\ntags:\r\n  - 中文\r\naliases: [别名]\r\nexample: '![not-resource](missing-yaml.png)'\r\n---\r\n# 原文\r\n![图片](<../images/图 1.png>)\r\n[另文](../other/关联.md#保留标题)\r\n```md\r\n![example](missing-code.png)\r\n```\r\n`[code](missing-inline.md)`\r\n";
  const binary = Buffer.from([0, 255, 1, 13, 10, 128]);
  f.write("notes/文章.md", markdown); f.write("images/图 1.png", binary);
  f.write("other/关联.md", "# 保留标题\n![图](../images/图%201.png)\n");
  const plan = inspectPackage(f.source, "notes/文章.md");
  assert.equal(plan.coverage.complete, true, JSON.stringify(plan.coverage));
  assert.equal(plan.files.length, 3);
  assert.ok(!JSON.stringify(plan).includes(f.source));
  const binding = capturePackage(f.kb, SOURCE, plan);
  const verified = verifyPackage(f.kb, binding); assert.equal(verified.ok, true, JSON.stringify(verified));
  const base = path.posix.dirname(binding.manifestPath);
  assert.deepEqual(fs.readFileSync(path.join(f.kb, binding.primaryPath)), Buffer.from(markdown));
  assert.deepEqual(fs.readFileSync(path.join(f.kb, base, "files/images/图 1.png")), binary);
  const reading = fs.readFileSync(path.join(f.kb, binding.readingPath), "utf8");
  assert.ok(reading.startsWith(markdown.slice(0, markdown.indexOf("# 原文"))));
  assert.ok(reading.includes("![图片](<../../files/images/%E5%9B%BE%201.png>)"));
  assert.ok(reading.includes("[另文](../other/%E5%85%B3%E8%81%94.md#保留标题)"));
  assert.ok(reading.includes("![example](missing-code.png)"));
  assert.ok(reading.includes("`[code](missing-inline.md)`"));
  assert.deepEqual(fs.readFileSync(path.resolve(path.dirname(path.join(f.kb, binding.readingPath)), "../../files/images/图 1.png")), binary);
  assert.ok(verified.manifest.files.some((item) => item.kind === "reading"));
});

test("inline escaped parentheses, reference images, HTML attributes and same-named assets preserve identities", (t) => {
  const f = fixture(t);
  f.write("note.md", "# Note\n![one][id]\n![two](two/a.png)\n[paren](images/a\\(b\\).png)\n<img alt=\"图\" src=\"images/a%20b.png\">\n[id]: <one/a.png> 'title'\n");
  f.write("one/a.png", Buffer.from([1])); f.write("two/a.png", Buffer.from([2]));
  f.write("images/a(b).png", "paren"); f.write("images/a b.png", "space");
  const plan = inspectPackage(f.source, "note.md"); assert.equal(plan.coverage.complete, true, JSON.stringify(plan.coverage));
  const binding = capturePackage(f.kb, SOURCE, plan);
  const reading = fs.readFileSync(path.join(f.kb, binding.readingPath), "utf8");
  assert.ok(reading.includes("[id]: <../files/one/a.png> 'title'"));
  assert.ok(reading.includes("![two](../files/two/a.png)"));
  assert.ok(reading.includes("[paren](../files/images/a%28b%29.png)"));
  assert.ok(reading.includes('src="../files/images/a%20b.png"'));
  assert.equal(verifyPackage(f.kb, binding).ok, true);
});

test("Wiki links and embeds use unique root lookup, qualified reading paths and unchanged fragments", (t) => {
  const f = fixture(t);
  f.write("note.md", "---\naliases: ['[[missing]]']\n---\n# Note\n[[Other#标题|别名]]\n![[assets/image.png|300]]\n[[#当前标题]]\n``[[missing]]``\n");
  f.write("pages/Other.md", "# 标题\n[[note]]\n"); f.write("assets/image.png", Buffer.from([1, 2, 3]));
  const plan = inspectPackage(f.source, "note.md"); assert.equal(plan.coverage.complete, true, JSON.stringify(plan.coverage));
  const binding = capturePackage(f.kb, SOURCE, plan), base = path.posix.dirname(binding.manifestPath);
  const reading = fs.readFileSync(path.join(f.kb, binding.readingPath), "utf8");
  assert.ok(reading.includes(`[[${base}/reading/pages/Other.md#标题|别名]]`));
  assert.ok(reading.includes(`![[${base}/files/assets/image.png|300]]`));
  assert.ok(reading.includes("[[#当前标题]]")); assert.ok(reading.includes("``[[missing]]``"));
  assert.equal(plan.files.length, 3);
});

test("remote links remain external, are never fetched, and same-page anchors need no dependency", (t) => {
  const f = fixture(t);
  f.write("note.md", "# Note\n![remote](https://example.invalid/image.png)\n[mail](mailto:hello@example.invalid)\n[section](#标题)\n");
  const plan = inspectPackage(f.source, "note.md");
  assert.equal(plan.coverage.complete, true); assert.equal(plan.files.length, 1); assert.equal(plan.externalReferences.length, 2);
  const binding = capturePackage(f.kb, SOURCE, plan);
  assert.deepEqual(fs.readFileSync(path.join(f.kb, binding.readingPath)), fs.readFileSync(path.join(f.source, "note.md")));
});

test("missing, malformed, ambiguous and unsupported local resources refuse complete capture", (t) => {
  for (const [name, text, expected] of [
    ["missing", "![x](missing.png)", "missing_resource"],
    ["malformed", "![x](<unterminated)", "unsupported_link_syntax"],
    ["encoding", "![x](bad%XY.png)", "invalid_link_encoding"],
    ["html", '<img srcset="a.png 1x,b.png 2x">', "unsupported_html_resource"],
    ["ambiguous", "[[Same]]", "ambiguous_resource"],
  ]) {
    const f = fixture(t); f.write("note.md", text); f.write("a/Same.md", "A"); f.write("b/Same.md", "B");
    const plan = inspectPackage(f.source, "note.md");
    assert.equal(plan.coverage.complete, false, name); assert.ok(plan.coverage.reasons.some((reason) => reason.code === expected), JSON.stringify(plan));
    assert.throws(() => capturePackage(f.kb, SOURCE, plan), code("incomplete_package"));
    assert.equal(fs.existsSync(path.join(f.kb, "raw/markdown", SOURCE)), false);
  }
});

test("root escapes, encoded escapes, drives and symlink resources cannot become package contents", (t) => {
  const f = fixture(t); fs.writeFileSync(path.join(f.temp, "outside.png"), "outside");
  for (const target of ["../outside.png", "%2e%2e/outside.png", "/outside.png", "C:/outside.png", "file:///outside.png", "//server/share.png", "..\\outside.png"]) {
    f.write("note.md", `![x](${target})\n`);
    const plan = inspectPackage(f.source, "note.md"); assert.equal(plan.coverage.complete, false, target);
    assert.throws(() => capturePackage(f.kb, SOURCE, plan), code("incomplete_package"));
  }
  try { fs.symlinkSync(path.join(f.temp, "outside.png"), path.join(f.source, "link.png")); }
  catch (error) { if (["EPERM", "EACCES"].includes(error.code)) return; throw error; }
  f.write("note.md", "![x](link.png)");
  assert.ok(inspectPackage(f.source, "note.md").coverage.reasons.some((reason) => reason.code === "symlink_refused"));
});

test("case and Unicode collisions are explicit, never guessed", (t) => {
  const f = fixture(t);
  f.write("note.md", "![x](assets/FOO.png)\n"); f.write("assets/Foo.png", "one"); f.write("assets/foo.png", "two");
  // Case-insensitive file systems cannot represent this collision.
  if (fs.readdirSync(path.join(f.source, "assets")).length > 1) {
    const plan = inspectPackage(f.source, "note.md");
    assert.ok(plan.coverage.reasons.some((reason) => reason.code === "portable_path_collision"));
  }
  f.write("note.md", "[x](../escape.md)\n");
  assert.equal(inspectPackage(f.source, "note.md").coverage.complete, false);
});

test("entry rename keeps content fingerprint while changing revision; attachment-only change changes fingerprint", (t) => {
  const f = fixture(t); f.write("one.md", "![x](a.png)\n"); f.write("a.png", "first");
  const before = inspectPackage(f.source, "one.md");
  fs.renameSync(path.join(f.source, "one.md"), path.join(f.source, "two.md"));
  const renamed = inspectPackage(f.source, "two.md");
  assert.equal(renamed.contentFingerprint, before.contentFingerprint); assert.notEqual(renamed.revision, before.revision);
  f.write("a.png", "second");
  const changed = inspectPackage(f.source, "two.md");
  assert.notEqual(changed.contentFingerprint, renamed.contentFingerprint); assert.notEqual(changed.revision, renamed.revision);
});

test("file, bytes, directory and dependency budgets report incomplete packages", (t) => {
  const f = fixture(t); f.write("note.md", "[child](child.md)\n![x](a.png)\n"); f.write("child.md", "[next](last.md)\n"); f.write("last.md", "last\n"); f.write("a.png", "asset");
  for (const limits of [{ maxFiles: 1 }, { maxTotalBytes: 5 }, { maxEntries: 1 }, { maxDepth: 1 }, { maxLinks: 1 }, { maxAssetBytes: 1 }]) {
    const plan = inspectPackage(f.source, "note.md", { limits });
    assert.equal(plan.coverage.complete, false, JSON.stringify(limits));
  }
  assert.throws(() => inspectPackage(f.source, "note.md", { limits: { maxFiles: 257 } }), code("invalid_limit"));
});

test("invalid UTF-8, unclosed frontmatter and pathological link shape cannot claim completeness", (t) => {
  const f = fixture(t);
  for (const contents of [Buffer.from([0xff]), "---\ntags: [x]\n", "[".repeat(25000)]) {
    f.write("note.md", contents); assert.equal(inspectPackage(f.source, "note.md").coverage.complete, false);
  }
});

test("capture is idempotent and rejects stale plans, tampered originals, reading copies and unknown extra files", (t) => {
  const f = fixture(t); f.write("note.md", "# Note\n![x](a.png)\n"); f.write("a.png", Buffer.from([1, 2]));
  const plan = inspectPackage(f.source, "note.md"), binding = capturePackage(f.kb, SOURCE, plan);
  assert.deepEqual(capturePackage(f.kb, SOURCE, plan), binding);
  f.write("unrelated.md", "# Unrelated\n");
  assert.deepEqual(capturePackage(f.kb, SOURCE, inspectPackage(f.source, "note.md")), binding);
  f.write("a.png", "changed");
  assert.throws(() => capturePackage(f.kb, SOURCE, plan), code("source_changed"));
  const original = fs.readFileSync(path.join(f.kb, binding.primaryPath));
  fs.writeFileSync(path.join(f.kb, binding.primaryPath), "changed"); assert.equal(verifyPackage(f.kb, binding).ok, false);
  fs.writeFileSync(path.join(f.kb, binding.primaryPath), original);
  const view = fs.readFileSync(path.join(f.kb, binding.readingPath));
  fs.writeFileSync(path.join(f.kb, binding.readingPath), "changed"); assert.equal(verifyPackage(f.kb, binding).ok, false);
  fs.writeFileSync(path.join(f.kb, binding.readingPath), view);
  fs.mkdirSync(path.join(f.kb, path.posix.dirname(binding.manifestPath), "unknown-empty"));
  assert.equal(verifyPackage(f.kb, binding).ok, false);
});

test("manifest and binding forgery cannot escape package or discard file verification", (t) => {
  const f = fixture(t); f.write("note.md", "# Note\n");
  const binding = capturePackage(f.kb, SOURCE, inspectPackage(f.source, "note.md"));
  assert.throws(() => validateBinding({ ...binding, primaryPath: "../outside.md" }), code("invalid_binding"));
  assert.equal(verifyPackage(f.kb, { ...binding, readingPath: "raw/unrelated.md" }).ok, false);
  const location = path.join(f.kb, binding.manifestPath), saved = fs.readFileSync(location);
  const manifest = JSON.parse(saved); manifest.files[0].path = "files/../../escape.md";
  const data = Buffer.from(JSON.stringify(manifest)); fs.writeFileSync(location, data);
  assert.equal(verifyPackage(f.kb, { ...binding, manifestSha256: sha256(data) }).ok, false);
});

test("source mutation during copy is detected and staging is cleaned", (t) => {
  const f = fixture(t); f.write("note.md", "# Before\n");
  const script = `const fs=require('node:fs');const m=require(process.argv[1]);const root=process.argv[2],kb=process.argv[3];const p=m.inspectPackage(root,'note.md');const write=fs.writeFileSync;let changed=false;fs.writeFileSync=function(fd,...args){const result=write.call(this,fd,...args);if(typeof fd==='number'&&!changed){changed=true;write(require('node:path').join(root,'note.md'),'# After\\n');}return result;};try{m.capturePackage(kb,process.argv[4],p);process.exitCode=2;}catch(e){console.log(e.code);}`;
  const result = spawnSync(process.execPath, ["-e", script, modulePath, f.source, f.kb, SOURCE], { encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /source_changed/u);
  assert.deepEqual(fs.readdirSync(path.join(f.kb, ".wiki-tmp")), []);
  const sourceDir = path.join(f.kb, "raw/markdown", SOURCE);
  assert.deepEqual(fs.readdirSync(sourceDir), []);
});

test("binary safe reader refuses parent symlink swaps before reading", (t) => {
  const f = fixture(t); f.write("assets/a.bin", Buffer.from([1]));
  fs.mkdirSync(path.join(f.temp, "outside")); fs.writeFileSync(path.join(f.temp, "outside/a.bin"), Buffer.from([9]));
  try { fs.symlinkSync(path.join(f.temp, "outside"), path.join(f.source, "probe-link"), process.platform === "win32" ? "junction" : "dir"); fs.unlinkSync(path.join(f.source, "probe-link")); }
  catch (error) { if (["EPERM", "EACCES"].includes(error.code)) return; throw error; }
  const open = fs.openSync; let swapped = false;
  fs.openSync = function (filename, ...args) {
    if (filename === path.join(f.source, "assets/a.bin") && !swapped) {
      swapped = true; fs.renameSync(path.join(f.source, "assets"), path.join(f.source, "saved"));
      fs.symlinkSync(path.join(f.temp, "outside"), path.join(f.source, "assets"), process.platform === "win32" ? "junction" : "dir");
    }
    return open.call(this, filename, ...args);
  };
  try { assert.throws(() => readSafeBinary(f.source, "assets/a.bin"), code("symlink_refused")); }
  finally { fs.openSync = open; }
});

test("detached runtime needs no workbench, package workspace or npm modules", (t) => {
  const f = fixture(t); f.write("note.md", "# Note\n![x](a.png)\n"); f.write("a.png", Buffer.from([1, 255]));
  const copy = path.join(f.temp, "installed"); fs.mkdirSync(path.join(copy, "scripts/lib"), { recursive: true });
  const root = path.resolve(__dirname, "../..");
  for (const name of ["markdown-package.js", "wikilink-parser.js", "unicode-case-folding.js", "unicode-normalization.js"]) fs.copyFileSync(path.join(root, "scripts/lib", name), path.join(copy, "scripts/lib", name));
  copyFixture(path.join(root, "deps/unicode"), path.join(copy, "deps/unicode"));
  for (const name of fs.readdirSync(path.join(root, "deps/unicode"))) {
    assert.deepEqual(fs.readFileSync(path.join(copy, "deps/unicode", name)), fs.readFileSync(path.join(root, "deps/unicode", name)), `copied Unicode data: ${name}`);
  }
  const script = "const m=require(process.argv[1]);const p=m.inspectPackage(process.argv[2],'note.md');const b=m.capturePackage(process.argv[3],process.argv[4],p);console.log(JSON.stringify(m.verifyPackage(process.argv[3],b).ok));";
  const result = spawnSync(process.execPath, ["-e", script, path.join(copy, "scripts/lib/markdown-package.js"), f.source, f.kb, SOURCE], { cwd: f.temp, encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), "true");
});

test("HTML resource attributes use exact names and quoted value spans, not suffixes or text inside alt", (t) => {
  const f = fixture(t);
  f.write("note.md", '<img src="s">\n<img data-src="placeholder.png" alt=\'src="decoy.png" [fake](missing.md) <a href="missing">\' src="real.png">\n<a id="anchor"></a>\n');
  f.write("s", "short"); f.write("real.png", "real");
  const plan = inspectPackage(f.source, "note.md"); assert.equal(plan.coverage.complete, true, JSON.stringify(plan.coverage));
  assert.deepEqual(plan.files.map((item) => item.path), ["note.md", "real.png", "s"]);
  const binding = capturePackage(f.kb, SOURCE, plan);
  const reading = fs.readFileSync(path.join(f.kb, binding.readingPath), "utf8");
  assert.ok(reading.includes('<img src="../files/s">'));
  assert.ok(reading.includes('src="../files/real.png"'));
  assert.ok(reading.includes('data-src="placeholder.png"'));
  assert.ok(reading.includes('<a id="anchor"></a>'));
});

test("blockquote and list fences exclude examples while actual resources outside containers are collected", (t) => {
  const f = fixture(t);
  f.write("note.md", '> ~~~md\n> ![quoted](missing.png)\n> ~~~\n\n- ~~~md\n  ![listed](missing-list.png)\n  ~~~\n\n> ~~~md\n> ![unclosed](missing-quote.png)\n![actual](real.png)\n');
  f.write("real.png", "real");
  const plan = inspectPackage(f.source, "note.md"); assert.equal(plan.coverage.complete, true, JSON.stringify(plan.coverage));
  assert.deepEqual(plan.files.map((item) => item.path), ["note.md", "real.png"]);
});

test("relative Wiki paths follow the source directory and delimiters that cannot be qualified are explicit", (t) => {
  const f = fixture(t); f.write("notes/a.md", "[[../other/B.md#标题]]\n"); f.write("other/B.md", "# 标题\n");
  const plan = inspectPackage(f.source, "notes/a.md"); assert.equal(plan.coverage.complete, true, JSON.stringify(plan.coverage));
  const binding = capturePackage(f.kb, SOURCE, plan);
  assert.ok(fs.readFileSync(path.join(f.kb, binding.readingPath), "utf8").includes(`/reading/other/B.md#标题]]`));
  f.write("notes/a.md", "[[B]]\n"); fs.renameSync(path.join(f.source, "other"), path.join(f.source, "other#name"));
  assert.ok(inspectPackage(f.source, "notes/a.md").coverage.reasons.some((item) => item.code === "unsupported_wiki_target"));
});

test("a rehashed manifest cannot certify forged reading content or a fabricated link map", (t) => {
  const f = fixture(t); f.write("note.md", "![x](a.png)\n"); f.write("a.png", "image");
  const binding = capturePackage(f.kb, SOURCE, inspectPackage(f.source, "note.md"));
  const manifestPath = path.join(f.kb, binding.manifestPath), original = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const reading = path.join(f.kb, binding.readingPath), data = Buffer.from("![x](../../../../outside.png)\n");
  fs.writeFileSync(reading, data);
  const forged = structuredClone(original), record = forged.files.find((item) => item.kind === "reading"); record.size = data.length; record.sha256 = sha256(data);
  const encoded = Buffer.from(JSON.stringify(forged)); fs.writeFileSync(manifestPath, encoded);
  const result = verifyPackage(f.kb, { ...binding, manifestSha256: sha256(encoded) });
  assert.equal(result.ok, false); assert.equal(result.errors[0].code, "invalid_reading_copy");
});

test("linked images inside link labels are captured and long backslash text stays bounded", (t) => {
  const f = fixture(t); f.write("note.md", "[![thumb](a.png)](other.md)\n"); f.write("a.png", "image"); f.write("other.md", "# Other\n");
  assert.equal(inspectPackage(f.source, "note.md").files.length, 3);
  f.write("note.md", "\\".repeat(100000));
  const child = spawnSync(process.execPath, ["-e", "const m=require(process.argv[1]);const p=m.inspectPackage(process.argv[2],'note.md');console.log(p.coverage.complete,p.files[0].size);", modulePath, f.source], { encoding: "utf8", timeout: 4000 });
  assert.equal(child.status, 0, child.stderr || child.error?.message); assert.equal(child.stdout.trim(), "true 100000");
});
