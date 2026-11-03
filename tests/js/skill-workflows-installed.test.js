"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

const repo = path.resolve(__dirname, "../..");

function bashCommand() {
  const choices = process.platform === "win32"
    ? [path.join(process.env.ProgramFiles || "C:/Program Files", "Git/bin/bash.exe"), "bash"]
    : ["bash"];
  return choices.find((cmd) => spawnSync(cmd, ["--version"], { encoding: "utf8" }).status === 0);
}

test("installed Skill retrieves and verifies evidence without development dependencies", { timeout: 60_000 }, (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "skill installed 中文 "));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const home = path.join(temp, "home");
  const kb = path.join(temp, "knowledge");
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(kb, "raw/notes"), { recursive: true });
  fs.mkdirSync(path.join(kb, "wiki/topics"), { recursive: true });
  fs.writeFileSync(path.join(kb, ".wiki-schema.md"), "# Schema\n");
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
  }
});
