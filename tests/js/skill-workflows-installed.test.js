"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const { copyFixture } = require("./helpers/copy-fixture");

const repo = path.resolve(__dirname, "../..");

function bashCommand() {
  const choices = process.platform === "win32"
    ? [path.join(process.env.ProgramFiles || "C:/Program Files", "Git/bin/bash.exe"), "bash"]
    : ["bash"];
  return choices.find((cmd) => spawnSync(cmd, ["--version"], { encoding: "utf8" }).status === 0);
}

test("installed Skill freshness, lifecycle, Markdown updates and archive work without development dependencies", { timeout: 90_000 }, (t) => {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "skill installed 中文 ")));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const home = path.join(temp, "home");
  const kb = path.join(temp, "knowledge");
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(kb, "raw/notes"), { recursive: true });
  fs.mkdirSync(path.join(kb, "wiki/topics"), { recursive: true });
  fs.writeFileSync(path.join(kb, ".wiki-schema.md"), "# Schema\n");
  fs.writeFileSync(path.join(kb, "index.md"), "# Index\n");
  fs.writeFileSync(path.join(kb, "log.md"), "# Log\n");
  fs.writeFileSync(path.join(kb, "raw/notes/样本.md"), "# Markdown\r\n原文支持离线阅读。\r\n");
  fs.writeFileSync(path.join(kb, "wiki/topics/摘要.md"), "# Markdown\n这是衍生摘要。\n");
  const bash = bashCommand();
  assert.ok(bash, "Git Bash or Bash is required to exercise the real installer");
  const env = { ...process.env, HOME: home, USERPROFILE: home, PYTHONIOENCODING: "utf-8" };
  for (const platform of ["codex", "claude"]) {
    const installed = path.join(temp, `${platform} skills`, "llm-wiki");
    const result = spawnSync(bash, [path.join(repo, "install.sh").replace(/\\/g, "/"), "--platform", platform, "--target-dir", installed.replace(/\\/g, "/")], {
      cwd: temp, env, encoding: "utf8", timeout: 25_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    for (const name of ["node_modules", "workbench", "packages/graph-engine"]) {
      assert.equal(fs.existsSync(path.join(installed, name)), false, name);
    }
    assert.ok(fs.existsSync(path.join(installed, "scripts/skill-workflows/query.md")));
    const cli = path.join(installed, "scripts/query-cli.js");
    const searched = spawnSync(process.execPath, [cli, "search", kb, "--mode", "raw", "--query", "Markdown", "--json"], {
      cwd: temp, env, encoding: "utf8", timeout: 10_000,
    });
    assert.equal(searched.status, 0, searched.stderr || searched.stdout);
    const packet = JSON.parse(searched.stdout);
    assert.ok(packet.evidence.length > 0);
    assert.ok(packet.evidence.every((entry) => entry.path.startsWith("raw/")));
    const packetPath = path.join(temp, `${platform}-packet.json`);
    fs.writeFileSync(packetPath, JSON.stringify(packet));
    const verified = spawnSync(process.execPath, [cli, "verify", kb, "--packet", packetPath, "--json"], {
      cwd: temp, env, encoding: "utf8", timeout: 10_000,
    });
    assert.equal(verified.status, 0, verified.stderr || verified.stdout);
    assert.equal(JSON.parse(verified.stdout).ok, true);

    const reviewCli = path.join(installed, "scripts/review-cli.js");
    const reviewAt = (root, ...args) => {
      const result = spawnSync(process.execPath, [reviewCli, args[0], root, ...args.slice(1), "--json"], {
        cwd: temp, env, encoding: "utf8", timeout: 10_000,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return JSON.parse(result.stdout);
    };
    const review = (...args) => reviewAt(kb, ...args);
    const issue = review("add", "--type", "unverified", "--title", `${platform} 原文核对`, "--reason", "核对离线阅读能力", "--path", "raw/notes/样本.md", "--packet", packetPath);
    const body = path.join(temp, `${platform}-research.md`);
    fs.writeFileSync(body, `# 原文核对\n原文支持离线阅读。证据：${packet.evidence[0].id}\n`);
    const target = `wiki/synthesis/${platform}-研究.md`;
    const candidate = review("stage", "--title", "原文核对", "--target", target, "--body", body, "--packet", packetPath, "--issue", issue.id);
    assert.equal(fs.existsSync(path.join(kb, target)), false);
    assert.equal(review("show", "--id", candidate.id).status, "ready");
    assert.equal(review("adopt", "--id", candidate.id).status, "adopted");
    assert.equal(review("show", "--id", issue.id).status, "resolved");
    assert.equal(fs.readFileSync(path.join(kb, "raw/notes/样本.md"), "utf8"), "# Markdown\r\n原文支持离线阅读。\r\n");
    assert.ok(fs.readFileSync(path.join(kb, target), "utf8").includes("derived: true"));
    assert.equal(review("recover").recovered.length, 0);

    // Exercise the installed commands, including their dynamically loaded leaves.
    const source = path.join(temp, `${platform} source 中文`);
    fs.mkdirSync(path.join(source, "images"), { recursive: true });
    const original = Buffer.from("---\r\ntags: [Markdown]\r\n---\r\n# Markdown资料\r\n离线资料。\r\n![图](images/a.png)\r\n");
    fs.writeFileSync(path.join(source, "笔记.md"), original);
    fs.writeFileSync(path.join(source, "images/a.png"), Buffer.from([0, 255, 13, 10]));
    assert.ok(fs.existsSync(path.join(installed, "scripts/skill-workflows/markdown.md")));
    const markdownCli = path.join(installed, "scripts/markdown-cli.js");
    const markdown = (root, ...args) => {
      const result = spawnSync(process.execPath, [markdownCli, args[0], root, ...args.slice(1), "--json"], {
        cwd: temp, env, encoding: "utf8", timeout: 10_000,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return JSON.parse(result.stdout);
    };
    const captured = markdown(kb, "capture", "--source-root", source, "--file", "笔记.md");
    assert.deepEqual(fs.readFileSync(path.join(kb, captured.binding.primaryPath)), original);
    const sourceBody = path.join(temp, `${platform}-source-body.md`);
    fs.writeFileSync(sourceBody, "# 资料摘要\n原文说明离线资料。\n");
    const sourceCandidate = markdown(kb, "stage", "--id", captured.sourceId, "--revision", captured.binding.revision, "--body", sourceBody);
    assert.equal(review("adopt", "--id", sourceCandidate.id).status, "adopted");
    assert.equal(markdown(kb, "capture", "--source-root", source, "--file", "笔记.md").status, "reused");
    const manual = "\r\n人工笔记 e\u0301；原样保存。\r\n";
    const sourceTarget = path.join(kb, captured.target);
    const manualDefault = "\n## 我的补充 / My notes\n\n";
    const initialText = fs.readFileSync(sourceTarget, "utf8");
    assert.ok(initialText.includes(manualDefault));
    fs.writeFileSync(sourceTarget, initialText.replace(manualDefault, manual));
    const installedRetrieval = require(path.join(installed, "scripts/lib/skill-retrieval.js"));
    const managedPacket = installedRetrieval.search(kb, { mode: "raw", query: "Markdown", paths: [captured.binding.primaryPath] });
    assert.ok(managedPacket.evidence.length);
    const managedPacketPath = path.join(temp, `${platform}-managed-packet.json`);
    fs.writeFileSync(managedPacketPath, JSON.stringify(managedPacket));
    const reportBody = path.join(temp, `${platform}-report.md`);
    fs.writeFileSync(reportBody, "# 资料报告\n原文记录了离线资料的阅读方式。\n");
    const reportTarget = `wiki/synthesis/${platform}-资料报告.md`;
    const reportCandidate = review("stage", "--title", "资料报告", "--target", reportTarget, "--body", reportBody, "--packet", managedPacketPath);
    review("adopt", "--id", reportCandidate.id);
    const freshness = (root, command, ...args) => {
      const result = spawnSync(process.execPath, [path.join(installed, "scripts/freshness-cli.js"), command, root, ...args, "--json"], {
        cwd: temp, env, encoding: "utf8", timeout: 10_000,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return JSON.parse(result.stdout);
    };
    const pageStatus = (root) => freshness(root, "scan", "--path", reportTarget).pages.find((entry) => entry.path === reportTarget).status;
    assert.equal(pageStatus(kb), "current");
    fs.writeFileSync(path.join(source, "images/a.png"), Buffer.from([8, 7, 6, 5]));
    assert.equal(markdown(kb, "scan", "--source-root", source).counts.modified, 1);
    const changed = markdown(kb, "capture", "--source-root", source, "--file", "笔记.md");
    assert.equal(changed.sourceId, captured.sourceId);
    assert.notEqual(changed.binding.revision, captured.binding.revision);
    fs.writeFileSync(sourceBody, "# 资料摘要\n附件已更新，原文仍为离线资料。\n");
    const update = markdown(kb, "stage", "--id", changed.sourceId, "--revision", changed.binding.revision, "--body", sourceBody);
    assert.equal(review("adopt", "--id", update.id).status, "adopted");
    assert.equal(update.target, captured.target);
    assert.ok(fs.readFileSync(sourceTarget, "utf8").includes(manual));
    assert.deepEqual(fs.readFileSync(path.join(kb, captured.binding.primaryPath)), original);
    assert.equal(pageStatus(kb), "stale", "attachment-only updates invalidate the report's old source revision");
    assert.equal(installedRetrieval.verifyPacket(kb, managedPacket).ok, true, "old bytes remain verifiable independently of freshness");
    const tracked = freshness(kb, "track", "--path", reportTarget);
    const trackedAgain = freshness(kb, "track", "--path", reportTarget);
    assert.equal(tracked.issues.length, 1);
    assert.equal(trackedAgain.issues[0].issue.id, tracked.issues[0].issue.id);
    const draftTarget = `wiki/synthesis/${platform}-未采用.md`;
    const draftA = review("stage", "--title", "待核对", "--target", draftTarget, "--body", reportBody, "--packet", managedPacketPath);
    fs.writeFileSync(reportBody, "# 修订草稿\n需要进一步核对资料。\n");
    const draftB = review("stage", "--title", "待核对", "--target", draftTarget, "--body", reportBody, "--packet", managedPacketPath);
    const beforeMaintenance = ["index.md", "log.md", reportTarget, captured.target].map((name) => fs.readFileSync(path.join(kb, name)));
    assert.equal(review("supersede", "--id", draftA.id, "--replacement", draftB.id).status, "superseded");
    assert.equal(review("cancel", "--id", draftB.id, "--reason", "暂不采用").status, "cancelled");
    review("compact");
    assert.equal(fs.existsSync(path.join(kb, draftTarget)), false);
    assert.equal(review("show", "--id", draftA.id).status, "superseded");
    assert.equal(review("show", "--id", draftB.id).status, "cancelled");
    assert.ok(review("list", "--scope", "history", "--candidate-status", "cancelled").candidates.some((entry) => entry.id === draftB.id));
    assert.deepEqual(["index.md", "log.md", reportTarget, captured.target].map((name) => fs.readFileSync(path.join(kb, name))), beforeMaintenance);

    const python = ["python3", "python"].find((cmd) => spawnSync(cmd, ["-c", "import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)"], { encoding: "utf8" }).status === 0);
    assert.ok(python, "Python 3.8+ is required for archive integration");
    const archiveCli = path.join(installed, "scripts/archive.py");
    const archive = (...args) => {
      const result = spawnSync(python, [archiveCli, ...args, "--json"], {
        cwd: temp, env, encoding: "utf8", timeout: 10_000,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return JSON.parse(result.stdout);
    };
    const zipped = path.join(temp, `${platform}-archive.zip`);
    const exported = archive("export", kb, "--output", zipped);
    assert.equal(archive("verify", zipped).knowledgeBaseId, exported.knowledgeBaseId);
    const restored = path.join(temp, `${platform}-restored`);
    assert.equal(archive("restore", zipped, "--target", restored).cacheInvalidated, true);
    assert.deepEqual(fs.readFileSync(path.join(restored, "raw/notes/样本.md")), fs.readFileSync(path.join(kb, "raw/notes/样本.md")));
    assert.deepEqual(fs.readFileSync(path.join(restored, target)), fs.readFileSync(path.join(kb, target)));
    assert.equal(reviewAt(restored, "show", "--id", issue.id).status, "resolved");
    assert.equal(reviewAt(restored, "show", "--id", draftA.id).status, "superseded");
    assert.equal(pageStatus(restored), "stale");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(restored, ".wiki-cache.json"), "utf8")), { version: 1, entries: {} });
    const relocated = path.join(temp, `${platform}-relocated-source`);
    copyFixture(source, relocated);
    fs.appendFileSync(path.join(relocated, "笔记.md"), "迁移后追加说明。\r\n");
    const resumed = markdown(restored, "capture", "--source-root", relocated, "--file", "笔记.md", "--collection", captured.collectionId);
    assert.equal(resumed.sourceId, captured.sourceId);
    fs.writeFileSync(sourceBody, "# 资料摘要\n迁移后追加说明，附件仍可阅读。\n");
    const resumedCandidate = markdown(restored, "stage", "--id", resumed.sourceId, "--revision", resumed.binding.revision, "--body", sourceBody);
    const adopted = spawnSync(process.execPath, [reviewCli, "adopt", restored, "--id", resumedCandidate.id, "--json"], { cwd: temp, env, encoding: "utf8", timeout: 10_000 });
    assert.equal(adopted.status, 0, adopted.stderr || adopted.stdout);
    assert.ok(fs.readFileSync(path.join(restored, captured.target), "utf8").includes(manual));
  }
});
