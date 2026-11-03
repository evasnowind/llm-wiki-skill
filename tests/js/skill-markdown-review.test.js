"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { spawnSync } = require("node:child_process");
const packages = require("../../scripts/lib/markdown-package");
const review = require("../../scripts/lib/skill-review");
const { search } = require("../../scripts/lib/skill-retrieval");

function fixture(t) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "markdown publication 中文 ")));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const source = path.join(temp, "input"), kb = path.join(temp, "kb");
  fs.mkdirSync(source); fs.mkdirSync(kb);
  fs.writeFileSync(path.join(kb, ".wiki-schema.md"), "# Schema\n");
  fs.writeFileSync(path.join(kb, "index.md"), "# Index\n");
  fs.writeFileSync(path.join(kb, "log.md"), "# Log\n");
  fs.writeFileSync(path.join(source, "note.md"), "# Markdown\r\n原文可离线阅读。\r\n![图片](image.bin)\r\n");
  fs.writeFileSync(path.join(source, "image.bin"), Buffer.from([0, 255, 1]));
  const binding = packages.capturePackage(kb, `md-${"3".repeat(24)}`, packages.inspectPackage(source, "note.md"));
  const packet = search(kb, { mode: "raw", query: "note", paths: [binding.primaryPath] });
  assert.ok(packet.evidence.length, "explicit originals must remain available before adoption");
  const target = `wiki/sources/${binding.sourceId}.md`;
  const stage = (extra = {}) => review.stage(kb, { title: "Markdown", target, body: "摘要\n", packet, markdownSource: binding, ...extra });
  return { temp, source, kb, binding, packet, target, stage };
}

test("bound Markdown source publication preserves body bytes and emits source metadata", (t) => {
  const f = fixture(t);
  const body = "摘要\r\nCafe\u0301\r\n\t人工补充与尾部空格  \r\n";
  const candidate = f.stage({ body, expectedTargetSha256: null });
  assert.equal(candidate.body, body);
  assert.ok(candidate.content.includes(body));
  assert.match(candidate.content, /type: source\n/);
  assert.match(candidate.content, /source_id: local_document/);
  assert.ok(candidate.content.includes(f.binding.primaryPath));
  assert.ok(f.packet.evidence.some((item) => item.excerpt.includes("![图片](image.bin)")));
  assert.ok(candidate.content.includes("  ```text\n"));
  assert.ok(candidate.content.includes("  ![图片](image.bin)\n"));
  assert.ok(!candidate.content.includes("> ![图片](image.bin)"), "excerpt links cannot resolve relative to the summary directory");
  review.adopt(f.kb, candidate.id);
  assert.ok(fs.readFileSync(path.join(f.kb, f.target), "utf8").includes(body));
  assert.equal(review.show(f.kb, candidate.id).status, "adopted");
});

test("binary source changes prevent staging, adoption and every recovery boundary", (t) => {
  for (const boundary of [null, 0, 1, 2, 3, 4]) {
    const f = fixture(t), candidate = f.stage();
    if (boundary !== null) assert.throws(() => review.adopt(f.kb, candidate.id, { afterWrite(index) {
      if (index === boundary) throw new Error("power loss");
    } }), /power loss/);
    const image = path.join(f.kb, path.posix.dirname(f.binding.manifestPath), "files/image.bin");
    fs.writeFileSync(image, Buffer.from([9, 9, 9]));
    const before = fs.existsSync(path.join(f.kb, f.target)) ? fs.readFileSync(path.join(f.kb, f.target)) : null;
    assert.throws(() => boundary === null ? review.adopt(f.kb, candidate.id) : review.recover(f.kb), { code: "markdown_package_changed" });
    if (before) assert.deepEqual(fs.readFileSync(path.join(f.kb, f.target)), before);
    else assert.equal(fs.existsSync(path.join(f.kb, f.target)), false);
    assert.throws(() => f.stage(), (error) => ["markdown_package_changed", "recovery_required"].includes(error.code));
  }
});

test("source candidates bind their only source package and pre-stage target version", (t) => {
  const f = fixture(t);
  assert.throws(() => f.stage({ target: "wiki/topics/other.md" }), { code: "invalid_markdown_source" });
  const mixed = structuredClone(f.packet);
  mixed.mode = "wiki";
  assert.throws(() => f.stage({ packet: mixed }));
  fs.mkdirSync(path.dirname(path.join(f.kb, f.target)), { recursive: true });
  fs.writeFileSync(path.join(f.kb, f.target), "edited while preparing summary\n");
  assert.throws(() => f.stage({ expectedTargetSha256: null }), { code: "target_changed" });
  assert.equal(fs.readFileSync(path.join(f.kb, f.target), "utf8"), "edited while preparing summary\n");
});

test("archive round-trip retains bound Markdown records and rejects damaged package resources", (t) => {
  const f = fixture(t), candidate = f.stage();
  review.adopt(f.kb, candidate.id);
  const python = ["python3", "python"].find((cmd) => spawnSync(cmd, ["-c", "import sys;sys.exit(0 if sys.version_info >= (3,8) else 1)"], { encoding: "utf8" }).status === 0);
  assert.ok(python);
  const run = (...args) => spawnSync(python, [path.resolve(__dirname, "../../scripts/archive.py"), ...args, "--json"], {
    encoding: "utf8", timeout: 20_000, env: { ...process.env, PYTHONIOENCODING: "utf-8", HOME: f.temp, USERPROFILE: f.temp },
  });
  const zip = path.join(f.temp, "snapshot.zip"), restored = path.join(f.temp, "restored");
  for (const args of [["export", f.kb, "--output", zip], ["verify", zip], ["restore", zip, "--target", restored]]) {
    const result = run(...args);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
  assert.equal(review.show(restored, candidate.id).status, "adopted");
  assert.equal(packages.verifyPackage(restored, f.binding).ok, true);
  assert.deepEqual(fs.readFileSync(path.join(restored, f.binding.primaryPath)), fs.readFileSync(path.join(f.kb, f.binding.primaryPath)));
  const image = path.join(f.kb, path.posix.dirname(f.binding.manifestPath), "files/image.bin");
  fs.writeFileSync(image, Buffer.from([7, 7, 7]));
  const failed = run("export", f.kb, "--output", path.join(f.temp, "damaged.zip"));
  assert.notEqual(failed.status, 0);
  assert.equal(JSON.parse(failed.stderr).error, "invalid_markdown_package");
});
