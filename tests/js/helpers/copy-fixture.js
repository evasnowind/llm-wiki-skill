"use strict";

const fs = require("node:fs");
const path = require("node:path");

// The pinned Node 22 Windows cpSync fast path can lose or abort on non-ASCII
// paths (nodejs/node#61950). Keep Unicode fixtures and use libuv file copies.
function copyFixture(source, target) {
  const info = fs.lstatSync(source);
  if (info.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const name of fs.readdirSync(source)) copyFixture(path.join(source, name), path.join(target, name));
  } else if (info.isFile()) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  } else throw new Error("Fixture copies require regular files and directories");
}

module.exports = { copyFixture };
