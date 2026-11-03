"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const files = ["skill-retrieval", "skill-review", "skill-archive", "skill-workflows-installed"]
  .map((name) => path.join(__dirname, "js", `${name}.test.js`));
const result = spawnSync(process.execPath, ["--test", ...files], {
  cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 8 * 60 * 1000,
});
process.stdout.write(result.stdout || "");
process.stderr.write(result.stderr || "");
if (result.status !== 0 && process.env.GITHUB_ACTIONS === "true") {
  // Keep failure details visible in job annotations when raw logs need login.
  // All inputs are synthetic fixtures; omit runner-specific absolute roots.
  let details = `${result.stdout || ""}\n${result.stderr || ""}\n${result.error?.code || ""}`;
  for (const directory of [root, process.env.RUNNER_TEMP, process.env.USERPROFILE, process.env.HOME].filter(Boolean)) {
    details = details.split(directory).join("<runner>");
    details = details.split(directory.replace(/\\/g, "/")).join("<runner>");
  }
  const annotate = (title, value) => {
    const escaped = value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
    process.stdout.write(`::error title=${title}::${escaped}\n`);
  };
  const failures = details.split("\n").filter((line) => /^(not ok |✖ )/.test(line));
  annotate("Skill workflow tests failed", failures.join("\n").slice(0, 3000));
  // GitHub truncates each annotation to 4096 characters. Keep bounded chunks.
  const tail = details.slice(-24000);
  for (let offset = 0; offset < tail.length; offset += 3000) {
    annotate(`Skill test details ${offset / 3000 + 1}`, tail.slice(offset, offset + 3000));
  }
}
process.exitCode = result.status === 0 ? 0 : 1;
