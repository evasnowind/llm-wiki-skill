#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const { search, verifyPacket, MAX_PACKET_BYTES } = require("./lib/skill-retrieval");

function main(argv) {
  const [command, kbRoot, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--json") { if (options.json) throw new Error("invalid_arguments"); options.json = true; continue; }
    if (!["--mode", "--query", "--packet"].includes(arg) || options[arg] !== undefined || !rest[index + 1] || rest[index + 1].startsWith("--")) throw new Error("invalid_arguments");
    options[arg] = rest[++index];
  }
  if (!kbRoot || !["search", "verify"].includes(command)) throw new Error("invalid_arguments");
  let result;
  if (command === "search") {
    if (options["--packet"] || !options["--query"]) throw new Error("invalid_arguments");
    result = search(kbRoot, { mode: options["--mode"], query: options["--query"] });
  } else {
    if (!options["--packet"] || options["--mode"] || options["--query"]) throw new Error("invalid_arguments");
    const fd = fs.openSync(options["--packet"], "r");
    let packet;
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_PACKET_BYTES) throw new Error("invalid_packet");
      const buffer = Buffer.alloc(stat.size + 1);
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
      if (bytes > stat.size) throw new Error("invalid_packet");
      try { packet = JSON.parse(buffer.subarray(0, bytes).toString("utf8")); }
      catch { throw new Error("invalid_packet"); }
    } finally { fs.closeSync(fd); }
    result = verifyPacket(kbRoot, packet);
  }
  // Compact JSON keeps the module's output-character budget valid on the CLI.
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.ok === false) process.exitCode = 1;
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    const allowed = new Set(["invalid_arguments", "invalid_packet", "invalid_root", "invalid_schema_or_root", "invalid_mode", "invalid_query", "invalid_limit"]);
    process.stderr.write(`${JSON.stringify({ ok: false, error: allowed.has(error.code || error.message) ? (error.code || error.message) : "query_failed" })}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main };
