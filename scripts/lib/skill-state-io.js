"use strict";

// Narrow IO for the Skill Review store; no dependency on the client runtime.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { validateRelativePath, safeReadFile, sha256 } = require("./skill-retrieval");

const STORE = ".wiki-review";
const LOCK = `${STORE}/lock`;
const MAX_STATE_BYTES = 16 * 1024 * 1024;
// A journal contains both serialized store versions, which are JSON strings
// escaped once more inside the journal. Keep this separate from store limits.
const MAX_JOURNAL_BYTES = 128 * 1024 * 1024;

function fail(code) { const error = new Error(code); error.code = code; throw error; }

function checkedPath(root, relative, createParents = false) {
  validateRelativePath(relative);
  let current = root;
  const parts = relative.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (index === parts.length - 1) break;
      if (!createParents) return path.join(root, ...parts);
      fs.mkdirSync(current);
      stat = fs.lstatSync(current);
    }
    if (stat.isSymbolicLink()) fail("symlink_refused");
    if (index < parts.length - 1 && !stat.isDirectory()) fail("invalid_parent");
    if (fs.realpathSync(current) !== current) fail("unsafe_path");
  }
  return path.join(root, ...parts);
}

function readOptional(root, relative, maxBytes = MAX_STATE_BYTES) {
  checkedPath(root, relative);
  try { return safeReadFile(root, relative, maxBytes); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function syncDirectory(directory) {
  // Windows cannot open directories for fsync. File fsync + rename still apply.
  let fd;
  try { fd = fs.openSync(directory, "r"); fs.fsyncSync(fd); }
  catch (error) { if (!["EINVAL", "EPERM", "EISDIR", "EBADF", "ENOTSUP", "EACCES"].includes(error.code)) throw error; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function atomicWrite(root, relative, value, maxBytes = MAX_STATE_BYTES) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  if (buffer.length > maxBytes) fail("state_too_large");
  const target = checkedPath(root, relative, true);
  const temporary = `${relative}.tmp-${crypto.randomBytes(10).toString("hex")}`;
  const tempPath = checkedPath(root, temporary);
  let fd;
  try {
    fd = fs.openSync(tempPath, "wx", 0o600);
    fs.writeFileSync(fd, buffer);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    checkedPath(root, relative);
    checkedPath(root, temporary);
    fs.renameSync(tempPath, target);
    syncDirectory(path.dirname(target));
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(tempPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

function readJson(root, relative, maxBytes = MAX_STATE_BYTES) {
  const file = readOptional(root, relative, maxBytes);
  if (!file) return null;
  try { return JSON.parse(file.text); } catch { fail("invalid_state"); }
}

function json(value) { return `${JSON.stringify(value, null, 2)}\n`; }

function lockOwner() {
  return { version: 1, pid: process.pid, hostname: os.hostname(), token: crypto.randomBytes(20).toString("hex") };
}

function createLock(root, relative, owner) {
  const target = checkedPath(root, relative, true);
  let fd;
  try { fd = fs.openSync(target, "wx", 0o600); }
  catch (error) { if (error.code === "EEXIST") fail("review_locked"); throw error; }
  try { fs.writeFileSync(fd, json(owner)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  syncDirectory(path.dirname(target));
}

function releaseLock(root, relative, owner) {
  const current = readJson(root, relative, 4096);
  if (!current || current.token !== owner.token) fail("lock_changed");
  fs.unlinkSync(checkedPath(root, relative));
  syncDirectory(path.join(root, STORE));
}

function reclaimDeadLock(root) {
  // Serialize stale-lock reclamation so two recovery commands cannot remove a
  // newly acquired live lock. A recovery-guard crash is explicit, never guessed.
  const guard = `${STORE}/lock-recovery`;
  const owner = lockOwner();
  createLock(root, guard, owner);
  try {
    const old = readJson(root, LOCK, 4096);
    if (!old) return;
    if (old.version !== 1 || old.hostname !== os.hostname() || !Number.isSafeInteger(old.pid) || old.pid <= 0 || typeof old.token !== "string") fail("review_locked");
    try { process.kill(old.pid, 0); fail("review_locked"); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
    const again = readJson(root, LOCK, 4096);
    if (!again || again.token !== old.token) fail("lock_changed");
    fs.unlinkSync(checkedPath(root, LOCK));
    syncDirectory(path.join(root, STORE));
  } finally { releaseLock(root, guard, owner); }
}

function withLock(root, callback, { recover = false } = {}) {
  if (recover && readOptional(root, LOCK, 4096)) reclaimDeadLock(root);
  const owner = lockOwner();
  createLock(root, LOCK, owner);
  try { return callback(); }
  finally { releaseLock(root, LOCK, owner); }
}

module.exports = { STORE, LOCK, MAX_STATE_BYTES, MAX_JOURNAL_BYTES, fail, checkedPath, readOptional, readJson, atomicWrite, syncDirectory, json, withLock, sha256 };
