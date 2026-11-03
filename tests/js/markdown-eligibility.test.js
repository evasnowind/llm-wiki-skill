"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const pkg = require("../../scripts/lib/markdown-package");
const review = require("../../scripts/lib/skill-review");
const { search, verifyPacket } = require("../../scripts/lib/skill-retrieval");
const { buildBody, MANUAL_START, MANUAL_END } = require("../../scripts/lib/markdown-state");

function fixture(t) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "Markdown eligibility 中文 ")));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const source = path.join(temp, "source"), kb = path.join(temp, "kb");
  fs.mkdirSync(source); fs.mkdirSync(kb);
  fs.writeFileSync(path.join(kb, ".wiki-schema.md"), "# Schema\n");
  fs.writeFileSync(path.join(kb, "index.md"), "# Index\n");
  fs.writeFileSync(path.join(kb, "log.md"), "# Log\n");
  const sourceId = `md-${"a".repeat(24)}`;
  const capture = (value = "first") => {
    fs.writeFileSync(path.join(source, "note.md"), `# Daily\r\nDaily Markdown ${value} evidence.\r\n![图](image.bin)\r\n`);
    fs.writeFileSync(path.join(source, "image.bin"), Buffer.from([0, 255, 1]));
    return pkg.capturePackage(kb, sourceId, pkg.inspectPackage(source, "note.md"));
  };
  const packet = (binding) => search(kb, { query: "note", mode: "raw", paths: [binding.primaryPath] });
  const stage = (binding, body = "Daily summary") => review.stage(kb, {
    title: "Daily", target: `wiki/sources/${sourceId}.md`, body: buildBody(binding, body),
    packet: packet(binding), markdownSource: binding,
  });
  return { temp, source, kb, sourceId, capture, packet, stage };
}

const paths = (packet) => new Set(packet.evidence.map((item) => item.path));

test("pending packages and reading copies stay out of default raw facts; explicit original context is available", (t) => {
  const f = fixture(t), binding = f.capture();
  const current = search(f.kb, { query: "Daily", mode: "raw" });
  assert.equal(current.evidence.length, 0);
  assert.ok(current.coverage.filtered.markdown_pending > 0);
  assert.ok(current.coverage.filtered.markdown_reading > 0);
  const explicit = f.packet(binding);
  assert.deepEqual(paths(explicit), new Set([binding.primaryPath]));
  assert.deepEqual(explicit.scope, { kind: "paths", paths: [binding.primaryPath] });
  assert.equal(verifyPacket(f.kb, explicit).ok, true);
});

test("only the latest committed original is recalled, while exact old quotes remain verifiable", (t) => {
  const f = fixture(t), first = f.capture(), firstPacket = f.packet(first);
  review.adopt(f.kb, f.stage(first).id);
  const second = f.capture("updated"), candidate = f.stage(second);
  assert.deepEqual(paths(search(f.kb, { query: "Daily", mode: "raw" })), new Set([first.primaryPath]));
  review.adopt(f.kb, candidate.id);
  const current = search(f.kb, { query: "Daily", mode: "raw" });
  assert.deepEqual(paths(current), new Set([second.primaryPath]));
  assert.ok(current.coverage.filtered.markdown_historical > 0);
  assert.equal(verifyPacket(f.kb, firstPacket).ok, true);
  assert.deepEqual(paths(f.packet(first)), new Set([first.primaryPath]));
  const wiki = search(f.kb, { query: "Daily", mode: "wiki" });
  assert.ok(wiki.evidence.every((item) => item.path.startsWith("wiki/")));
});

test("every partial publication boundary retains the previous committed raw version", (t) => {
  for (const boundary of [0, 1, 2, 3, 4]) {
    const f = fixture(t), first = f.capture();
    review.adopt(f.kb, f.stage(first).id);
    const next = f.capture("second"), candidate = f.stage(next);
    assert.throws(() => review.adopt(f.kb, candidate.id, { afterWrite(index) {
      if (index === boundary) throw new Error("power loss");
    } }), /power loss/);
    const pending = search(f.kb, { query: "Daily", mode: "raw" });
    assert.deepEqual(paths(pending), new Set([first.primaryPath]), String(boundary));
    assert.equal(pending.coverage.complete, false);
    assert.ok(pending.coverage.reasons.some((item) => item.code === "markdown_publication_pending"));
    if (boundary > 0) {
      const wiki = search(f.kb, { query: "Daily", mode: "wiki" });
      assert.equal(wiki.evidence.length, 0, `new uncommitted source page at boundary ${boundary}`);
    }
    review.recover(f.kb);
    assert.deepEqual(paths(search(f.kb, { query: "Daily", mode: "raw" })), new Set([next.primaryPath]));
  }
});

test("manual notes do not hide healthy source pages; unknown external summary edits remain visible with a warning", (t) => {
  const f = fixture(t), binding = f.capture(), candidate = f.stage(binding);
  review.adopt(f.kb, candidate.id);
  const target = path.join(f.kb, candidate.target);
  let text = fs.readFileSync(target, "utf8");
  const start = text.indexOf(MANUAL_START) + MANUAL_START.length, end = text.indexOf(MANUAL_END);
  text = text.slice(0, start) + "\r\nDaily Cafe\u0301 human notes.\r\n" + text.slice(end);
  fs.writeFileSync(target, text);
  const healthy = search(f.kb, { query: "Daily", mode: "wiki" });
  assert.deepEqual(paths(healthy), new Set([candidate.target]));
  assert.equal(healthy.coverage.complete, true);
  fs.writeFileSync(target, text.replace("Daily summary", "Daily externally edited summary"));
  const edited = search(f.kb, { query: "Daily", mode: "wiki" });
  assert.deepEqual(paths(edited), new Set([candidate.target]));
  assert.ok(edited.coverage.reasons.some((item) => item.code === "markdown_summary_changed"));
});

test("user-edited historical originals and files absent from a manifest are never hidden by directory prefix", (t) => {
  const f = fixture(t), first = f.capture();
  review.adopt(f.kb, f.stage(first).id);
  const next = f.capture("second"); review.adopt(f.kb, f.stage(next).id);
  fs.writeFileSync(path.join(f.kb, first.primaryPath), "# Manual\nManual original edit.\n");
  const extra = `${path.posix.dirname(first.primaryPath)}/extra.md`;
  fs.writeFileSync(path.join(f.kb, extra), "# Manual\nManual unrelated document.\n");
  const result = search(f.kb, { query: "Manual", mode: "raw" });
  assert.deepEqual(paths(result), new Set([first.primaryPath, extra]));
  assert.ok(result.coverage.reasons.some((item) => item.code === "markdown_original_changed"));
  assert.ok(result.coverage.reasons.some((item) => item.code === "markdown_unlisted_file"));
});

test("changed historical manifests cannot re-certify files for silent history filtering", (t) => {
  const f = fixture(t), first = f.capture(); review.adopt(f.kb, f.stage(first).id);
  const next = f.capture("second"); review.adopt(f.kb, f.stage(next).id);
  const filename = path.join(f.kb, first.manifestPath);
  const manifest = JSON.parse(fs.readFileSync(filename, "utf8"));
  manifest.externalReferences.push({ source: "note.md", target: "https://outside.invalid/rehashed" });
  fs.writeFileSync(filename, JSON.stringify(manifest));
  const result = search(f.kb, { query: "Daily", mode: "raw" });
  assert.deepEqual(paths(result), new Set([first.primaryPath, next.primaryPath]));
  assert.ok(result.coverage.reasons.some((item) => item.code === "markdown_manifest_changed"));
});

test("current originals are read before history when the shared content budget is small", (t) => {
  const f = fixture(t), first = f.capture(); review.adopt(f.kb, f.stage(first).id);
  for (let index = 0; index < 4; index += 1) f.capture(`pending ${index} ${"long".repeat(500)}`);
  const size = fs.statSync(path.join(f.kb, first.primaryPath)).size;
  const result = search(f.kb, { query: "Daily", mode: "raw", limits: { maxTotalBytes: size + 1 } });
  assert.deepEqual(paths(result), new Set([first.primaryPath]));
  assert.equal(result.coverage.complete, false);
  assert.ok(result.coverage.bytesRead <= size + 1);
});

test("known reading copies cannot be promoted into raw evidence even with an explicit path or a forged packet", (t) => {
  const f = fixture(t), binding = f.capture();
  const explicit = search(f.kb, { query: "Daily", mode: "raw", paths: [binding.readingPath] });
  assert.equal(explicit.evidence.length, 0);
  assert.equal(explicit.coverage.complete, false);
  const text = fs.readFileSync(path.join(f.kb, binding.readingPath), "utf8");
  const fileSha256 = pkg.sha256(Buffer.from(text)), excerptSha256 = pkg.sha256(text);
  const endLine = text.split("\n").length;
  const evidence = { path: binding.readingPath, heading: ["Daily"], startLine: 1, endLine,
    excerpt: text, fileSha256, excerptSha256 };
  evidence.id = `ev-${pkg.sha256(`${evidence.path}\0${fileSha256}\0${1}\0${endLine}\0${excerptSha256}`).slice(0, 24)}`;
  assert.equal(verifyPacket(f.kb, { version: 1, mode: "raw", evidence: [evidence] }).errors[0].code, "derived_raw_excluded");
  fs.appendFileSync(path.join(f.kb, binding.readingPath), "\nDaily changed generated view.\n");
  const changed = search(f.kb, { query: "Daily", mode: "raw" });
  assert.equal(changed.evidence.length, 0);
  assert.ok(changed.coverage.reasons.some((item) => item.code === "markdown_reading_copy_changed"));
});

test("corrupt registry, adoption state and bounded metadata reads are reported instead of pretending the library is empty", (t) => {
  const f = fixture(t), binding = f.capture(); review.adopt(f.kb, f.stage(binding).id);
  fs.writeFileSync(path.join(f.kb, ".wiki-review/markdown-sources.json"), "{}");
  const registry = search(f.kb, { query: "Daily", mode: "raw" });
  assert.equal(registry.coverage.complete, false);
  assert.ok(registry.coverage.reasons.some((item) => item.code === "markdown_registry_unavailable"));
  fs.unlinkSync(path.join(f.kb, ".wiki-review/markdown-sources.json"));
  const tiny = search(f.kb, { query: "Daily", mode: "raw", limits: { maxMetadataBytes: 1 } });
  assert.equal(tiny.coverage.complete, false);
  assert.ok(tiny.coverage.reasons.length);
  fs.writeFileSync(path.join(f.kb, ".wiki-review/state.json"), "{");
  const broken = search(f.kb, { query: "Daily", mode: "raw" });
  assert.equal(broken.coverage.complete, false);
  assert.ok(broken.coverage.reasons.some((item) => /adoption|state/.test(item.code)));
  fs.writeFileSync(path.join(f.kb, binding.manifestPath), "{");
  assert.equal(verifyPacket(f.kb, f.packet(binding)).ok, false);
});

test("explicit paths do not walk unrelated files and keep corpus, traversal and count limits", (t) => {
  const f = fixture(t), binding = f.capture();
  fs.writeFileSync(path.join(f.kb, "raw/unrelated.md"), Buffer.from([255, 254]));
  const packet = f.packet(binding);
  assert.equal(packet.coverage.complete, true);
  assert.equal(packet.coverage.entriesScanned, 0);
  assert.equal(packet.coverage.filesScanned, 1);
  assert.equal(packet.coverage.bytesRead, fs.statSync(path.join(f.kb, binding.primaryPath)).size);
  assert.throws(() => search(f.kb, { mode: "raw", query: "Daily", paths: ["wiki/a.md"] }), { code: "wrong_corpus" });
  assert.throws(() => search(f.kb, { mode: "raw", query: "Daily", paths: ["raw/../outside.md"] }), { code: "unsafe_path" });
  assert.throws(() => search(f.kb, { query: "Daily", paths: [] }), { code: "invalid_paths" });
  assert.throws(() => search(f.kb, { query: "Daily", paths: Array(51).fill("wiki/a.md") }), { code: "invalid_paths" });
  assert.throws(() => search(f.kb, { mode: "raw", query: "Daily", paths: Array.from({ length: 8 }, (_, index) => `raw/${"x".repeat(130)}${index}.md`), limits: { maxOutputChars: 4096 } }), { code: "invalid_paths" });
});
