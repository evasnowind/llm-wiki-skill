#!/usr/bin/env python3
"""Portable, verified archives for the file-based Skill knowledge base (stdlib)."""
import argparse
import contextlib
import decimal
import hashlib
import json
import os
import re
import secrets
import shutil
import socket
import stat
import struct
import sys
import tempfile
import time
import unicodedata
import uuid
import zipfile
import zlib
from pathlib import Path

MANIFEST = "archive-manifest.json"
FORMAT = "llm-wiki-skill"
ROOT_FILES = {".wiki-schema.md", ".wiki-cache.json", "index.md", "log.md", "purpose.md"}
ROOT_DIRS = {"raw", "wiki", "assets", "attachments", ".wiki-review"}
REQUIRED = {".wiki-schema.md", "index.md", "log.md"}
LOCK = ".wiki-review/lock"
GUARD = ".wiki-review/lock-recovery"
IDENTITY = ".wiki-review/identity.json"
STATE = ".wiki-review/state.json"
DEFAULTS = {"max_file_bytes": 256 * 1024 * 1024, "max_total_bytes": 2 * 1024 ** 3,
            "max_archive_bytes": 2 * 1024 ** 3, "max_files": 20000}
MAX_ENTRIES = 50000
MAX_MANIFEST = 16 * 1024 * 1024
MAX_STATE = 16 * 1024 * 1024
MAX_JOURNAL = 128 * 1024 * 1024
HASH = re.compile(r"^[a-f0-9]{64}$")
KB_ID = re.compile(r"^kb-[a-f0-9]{32}$")
CANDIDATE = re.compile(r"^candidate-[a-f0-9]{24}$")
ISSUE = re.compile(r"^issue-[a-f0-9]{24}$")
ISO_TIME = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$")
RESERVED = re.compile(r"^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)", re.I)


class ArchiveError(Exception):
    pass


class ArgumentParser(argparse.ArgumentParser):
    def error(self, _message):
        fail("invalid_arguments")


def fail(code):
    raise ArchiveError(code)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def version_one(value):
    return isinstance(value, dict) and type(value.get("version")) is int and value["version"] == 1


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def identity_hash(value):
    # Node-produced store JSON preserves property order, but Python and JS use
    # different exponent/fixed notation thresholds for JSON numbers.
    def compact(item):
        if item is None:
            return "null"
        if isinstance(item, bool):
            return "true" if item else "false"
        if isinstance(item, str):
            return json.dumps(item, ensure_ascii=False)
        if isinstance(item, int):
            return str(item)
        if isinstance(item, float):
            if item == 0:
                return "0"
            number = repr(item).lower()
            if 1e-6 <= abs(item) < 1e21:
                fixed = format(decimal.Decimal(number), "f")
                return fixed.rstrip("0").rstrip(".") if "." in fixed else fixed
            if "e" in number:
                mantissa, exponent = number.split("e")
                if mantissa.endswith(".0"):
                    mantissa = mantissa[:-2]
                exponent = int(exponent)
                return mantissa + "e" + ("+" if exponent >= 0 else "-") + str(abs(exponent))
            return number[:-2] if number.endswith(".0") else number
        if isinstance(item, list):
            return "[" + ",".join(compact(child) for child in item) + "]"
        if isinstance(item, dict):
            return "{" + ",".join(json.dumps(key, ensure_ascii=False) + ":" + compact(child) for key, child in item.items()) + "}"
        fail("invalid_review_state")
    return digest(compact(value).encode("utf-8"))[:24]


def parse_json(data, code="invalid_metadata"):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                fail(code)
            result[key] = value
        return result
    try:
        return json.loads(data.decode("utf-8"), object_pairs_hook=pairs,
                          parse_constant=lambda _value: fail(code))
    except (ValueError, UnicodeError, RecursionError):
        fail(code)


def relative_path(value):
    if not isinstance(value, str) or not value or len(value) > 2048 or value.startswith("/"):
        fail("unsafe_path")
    if any(ord(char) < 32 or ord(char) == 127 for char in value) or re.search(r'[\\:<>"|?*]', value):
        fail("unsafe_path")
    parts = value.split("/")
    if any(not part or part in (".", "..") or part.endswith((".", " ")) or RESERVED.match(part) for part in parts):
        fail("unsafe_path")
    return value


def portable_key(value):
    return unicodedata.normalize("NFC", value).casefold()


def linked(info):
    # Python 3.8 on Windows reports junctions as reparse points rather than
    # POSIX symlinks; both redirect file access outside the lexical tree.
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_file_attributes", 0) & 0x400)


def permitted(value):
    return value in ROOT_FILES or value.split("/", 1)[0] in ROOT_DIRS


def transient(value):
    parts = value.split("/")
    own_temporary = value.startswith(".wiki-review/") and re.search(r"\.json\.tmp-[a-f0-9]{20,24}$", value)
    return value in (LOCK, GUARD) or bool(own_temporary) or any(
        part in {".git", ".obsidian", "node_modules", ".wiki-tmp", "__pycache__", ".DS_Store"} for part in parts)


def absolute_safe(value):
    """Reject symlink ancestors, including an existing final component."""
    target = Path(os.path.abspath(os.fspath(value)))
    current = Path(target.anchor)
    for part in target.parts[1:]:
        current = current / part
        try:
            info = current.lstat()
        except FileNotFoundError:
            continue
        if linked(info):
            fail("symlink_refused")
    return target


def root_path(value):
    root = absolute_safe(value)
    if not root.is_dir():
        fail("invalid_root")
    root = Path(os.path.realpath(root))
    for relative in REQUIRED:
        with safe_open(root, relative) as stream:
            if os.fstat(stream.fileno()).st_size > DEFAULTS["max_file_bytes"]:
                fail("file_budget_exceeded")
    return root


def checked(root, relative):
    relative_path(relative)
    target = root.joinpath(*relative.split("/"))
    current = root
    for part in relative.split("/"):
        current = current / part
        info = current.lstat()
        if linked(info):
            fail("symlink_refused")
    if os.path.realpath(target) != os.fspath(target):
        fail("unsafe_path")
    return target


@contextlib.contextmanager
def safe_open(root, relative):
    target = checked(root, relative)
    descriptor = os.open(target, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0))
    with os.fdopen(descriptor, "rb") as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode):
            fail("not_regular_file")
        current = checked(root, relative).stat()
        if (before.st_dev, before.st_ino) != (current.st_dev, current.st_ino):
            fail("source_changed")
        yield stream
        after = os.fstat(stream.fileno())
        current = checked(root, relative).stat()
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) \
                or (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) != (current.st_dev, current.st_ino, current.st_size, current.st_mtime_ns):
            fail("source_changed")


def read_file(root, relative, maximum):
    with safe_open(root, relative) as stream:
        if os.fstat(stream.fileno()).st_size > maximum:
            fail("metadata_budget_exceeded")
        data = stream.read(maximum + 1)
        if len(data) > maximum:
            fail("metadata_budget_exceeded")
        return data


def sync_directory(directory):
    descriptor = None
    try:
        descriptor = os.open(directory, os.O_RDONLY)
        os.fsync(descriptor)
    except OSError:
        # Directory fsync is unsupported on Windows; file fsync still applies.
        pass
    finally:
        if descriptor is not None:
            os.close(descriptor)


def atomic_identity(root):
    destination = root / IDENTITY
    if destination.exists() or destination.is_symlink():
        value = parse_json(read_file(root, IDENTITY, 4096))
        if not version_one(value) or not KB_ID.fullmatch(str(value.get("id", ""))):
            fail("invalid_identity")
        return value["id"]
    value = {"version": 1, "id": "kb-" + uuid.uuid4().hex}
    temporary = destination.with_name(destination.name + ".tmp-" + secrets.token_hex(12))
    try:
        with open(temporary, "xb") as stream:
            stream.write(encoded(value))
            stream.flush()
            os.fsync(stream.fileno())
        # The shared lock excludes all supported identity writers.
        if destination.exists() or destination.is_symlink():
            fail("source_changed")
        os.rename(temporary, destination)
        sync_directory(destination.parent)
    finally:
        if temporary.exists():
            temporary.unlink()
    return value["id"]


@contextlib.contextmanager
def review_lock(root):
    review = root / ".wiki-review"
    if review.exists() or review.is_symlink():
        checked(root, ".wiki-review")
        if not review.is_dir():
            fail("invalid_review_state")
    else:
        review.mkdir()
    if (root / GUARD).exists() or (root / GUARD).is_symlink():
        fail("review_locked")
    owner = {"version": 1, "pid": os.getpid(), "hostname": socket.gethostname(), "token": secrets.token_hex(20)}
    lock = root / LOCK
    try:
        descriptor = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0), 0o600)
    except FileExistsError:
        fail("review_locked")
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(encoded(owner))
            stream.flush()
            os.fsync(stream.fileno())
        if (root / GUARD).exists() or (root / GUARD).is_symlink():
            fail("review_locked")
        yield
    finally:
        current = parse_json(read_file(root, LOCK, 4096))
        if not isinstance(current, dict) or current.get("token") != owner["token"]:
            fail("lock_changed")
        checked(root, LOCK).unlink()
        sync_directory(review)


def inventory(root, limits):
    files, directories, excluded = [], [], []
    seen = set()
    entries_seen = 0

    def walk(relative="", depth=0):
        nonlocal entries_seen
        if depth > 32:
            fail("depth_budget_exceeded")
        with os.scandir(root / relative) as iterator:
            entries = []
            for entry in iterator:
                entries_seen += 1
                if entries_seen > MAX_ENTRIES:
                    fail("entry_budget_exceeded")
                entries.append(entry)
        for entry in sorted(entries, key=lambda item: item.name):
            name = relative + "/" + entry.name if relative else entry.name
            if (not relative and name not in ROOT_FILES and name not in ROOT_DIRS) or transient(name):
                excluded.append(name)
                continue
            relative_path(name)
            key = portable_key(name)
            if key in seen:
                fail("portable_path_collision")
            seen.add(key)
            if linked(entry.stat(follow_symlinks=False)):
                fail("symlink_refused")
            if entry.is_dir(follow_symlinks=False):
                checked(root, name)
                directories.append(name)
                walk(name, depth + 1)
            elif entry.is_file(follow_symlinks=False):
                if len(files) >= limits["max_files"]:
                    fail("file_count_budget_exceeded")
                if entry.stat(follow_symlinks=False).st_size > limits["max_file_bytes"]:
                    fail("file_budget_exceeded")
                files.append(name)
            else:
                fail("not_regular_file")
    walk()
    if not REQUIRED.issubset(files):
        fail("incomplete_knowledge_base")
    return sorted(files), sorted(directories), sorted(excluded)


def review_candidate(value):
    if not isinstance(value, dict) or not CANDIDATE.fullmatch(str(value.get("id", ""))) or value.get("status") not in ("ready", "adopted"):
        fail("invalid_review_state")
    target = relative_path(value.get("target"))
    if not target.startswith("wiki/") or not target.endswith(".md") or any(part.startswith(".") for part in target.split("/")):
        fail("invalid_review_state")
    if not isinstance(value.get("title"), str) or not 1 <= len(value["title"]) <= 240 or not ISO_TIME.fullmatch(str(value.get("createdAt", ""))):
        fail("invalid_review_state")
    if value.get("issueId") is not None and not ISSUE.fullmatch(str(value["issueId"])):
        fail("invalid_review_state")
    for field, hash_field, maximum in (("body", "bodySha256", 256 * 1024), ("content", "contentSha256", 512 * 1024)):
        if not isinstance(value.get(field), str) or len(value[field].encode("utf-8")) > maximum or digest(value[field].encode("utf-8")) != value.get(hash_field):
            fail("invalid_review_state")
    before = value.get("targetBefore")
    if before is not None and (not isinstance(before, dict) or not isinstance(before.get("content"), str) or len(before["content"].encode("utf-8")) > 512 * 1024 or digest(before["content"].encode("utf-8")) != before.get("sha256")):
        fail("invalid_review_state")
    packet = value.get("packet")
    if not version_one(packet) or packet.get("mode") not in ("raw", "wiki") or not isinstance(packet.get("evidence"), list) or not 1 <= len(packet["evidence"]) <= 50:
        fail("invalid_review_state")
    for evidence in packet["evidence"]:
        if not isinstance(evidence, dict):
            fail("invalid_review_state")
        relative = relative_path(evidence.get("path"))
        if not relative.startswith(packet["mode"] + "/") or relative == target or not HASH.fullmatch(str(evidence.get("fileSha256", ""))):
            fail("invalid_review_state")
        if not isinstance(evidence.get("excerpt"), str) or digest(evidence["excerpt"].encode("utf-8")) != evidence.get("excerptSha256"):
            fail("invalid_review_state")
        if not re.fullmatch(r"ev-[a-f0-9]{24}", str(evidence.get("id", ""))) or type(evidence.get("startLine")) is not int or type(evidence.get("endLine")) is not int or not 1 <= evidence["startLine"] <= evidence["endLine"]:
            fail("invalid_review_state")
        if not isinstance(evidence.get("heading"), list) or any(not isinstance(item, str) for item in evidence["heading"]):
            fail("invalid_review_state")
    identity = {"title": value["title"], "target": target,
                "targetBeforeHash": before["sha256"] if before else None,
                "bodySha256": value["bodySha256"], "packet": packet, "issueId": value.get("issueId")}
    if value["id"] != "candidate-" + identity_hash(identity):
        fail("invalid_review_state")


def review_state(data):
    value = parse_json(data, "invalid_review_state")
    if not version_one(value) or not isinstance(value.get("issues"), list) or not isinstance(value.get("candidates"), list):
        fail("invalid_review_state")
    if len(value["issues"]) > 500 or len(value["candidates"]) > 100:
        fail("invalid_review_state")
    ids = set()
    for issue in value["issues"]:
        if not isinstance(issue, dict) or not ISSUE.fullmatch(str(issue.get("id", ""))) or issue["id"] in ids or issue.get("status") not in ("open", "dismissed", "resolved"):
            fail("invalid_review_state")
        if issue.get("type") not in ("contradiction", "duplicate", "missing", "unverified", "suggestion") or not isinstance(issue.get("title"), str) or not 1 <= len(issue["title"]) <= 240 or not isinstance(issue.get("reason"), str) or not 1 <= len(issue["reason"]) <= 4000:
            fail("invalid_review_state")
        for field, hash_field in (("paths", "sha256"), ("evidence", "fileSha256")):
            if not isinstance(issue.get(field), list) or len(issue[field]) > 50:
                fail("invalid_review_state")
            for item in issue[field]:
                if not isinstance(item, dict):
                    fail("invalid_review_state")
                relative_path(item.get("path"))
                if item.get(hash_field) is not None and not HASH.fullmatch(str(item[hash_field])):
                    fail("invalid_review_state")
        identity = {"type": issue["type"], "title": issue["title"], "reason": issue["reason"],
                    "paths": issue["paths"], "evidence": issue["evidence"]}
        if issue["id"] != "issue-" + identity_hash(identity):
            fail("invalid_review_state")
        ids.add(issue["id"])
    for candidate in value["candidates"]:
        review_candidate(candidate)
        if candidate["id"] in ids or (candidate.get("issueId") and candidate["issueId"] not in ids):
            fail("invalid_review_state")
        ids.add(candidate["id"])
    return value


def validate_review(root, files):
    state = review_state(read_file(root, STATE, MAX_STATE)) if STATE in files else None
    committed = {}
    for relative in files:
        if not relative.startswith(".wiki-review/journals/"):
            continue
        value = parse_json(read_file(root, relative, MAX_JOURNAL), "invalid_review_journal")
        if not version_one(value) or value.get("committed") is not True:
            fail("incomplete_publication")
        candidate_id = value.get("candidateId", "")
        if not CANDIDATE.fullmatch(str(candidate_id)) or relative != ".wiki-review/journals/" + candidate_id + ".json":
            fail("invalid_review_journal")
        writes = value.get("writes")
        target = relative_path(value.get("target"))
        if not target.startswith("wiki/") or not target.endswith(".md") or not isinstance(writes, list) or len(writes) != 4:
            fail("invalid_review_journal")
        for item, expected in zip(writes, (target, "index.md", "log.md", STATE)):
            if not isinstance(item, dict) or item.get("path") != expected or not isinstance(item.get("content"), str) or digest(item["content"].encode("utf-8")) != item.get("afterSha256"):
                fail("invalid_review_journal")
            before = item.get("beforeContent")
            if (before is None and item.get("beforeSha256") is not None) or (before is not None and (not isinstance(before, str) or digest(before.encode("utf-8")) != item.get("beforeSha256"))):
                fail("invalid_review_journal")
        candidate = value.get("candidate")
        review_candidate(candidate)
        if candidate["id"] != candidate_id or candidate["target"] != target or candidate["content"] != writes[0]["content"] or candidate["status"] != "ready":
            fail("invalid_review_journal")
        if not isinstance(writes[3]["beforeContent"], str):
            fail("invalid_review_journal")
        before_state = review_state(writes[3]["beforeContent"].encode("utf-8"))
        after_state = review_state(writes[3]["content"].encode("utf-8"))
        if candidate not in before_state["candidates"] or not state:
            fail("invalid_review_journal")
        after = next((item for item in after_state["candidates"] if item["id"] == candidate_id), None)
        if not after or after["status"] != "adopted" or after["contentSha256"] != candidate["contentSha256"]:
            fail("invalid_review_journal")
        if candidate.get("issueId") and not any(item["id"] == candidate["issueId"] and item["status"] == "resolved" and item.get("resolvedBy") == candidate_id for item in after_state["issues"]):
            fail("invalid_review_journal")
        current = next((item for item in state["candidates"] if item["id"] == candidate_id), None)
        if not current or current["status"] != "adopted" or current.get("adoptedAt") != value.get("createdAt"):
            fail("invalid_review_journal")
        original = dict(current)
        original.pop("adoptedAt", None)
        original["status"] = "ready"
        if original != candidate:
            fail("invalid_review_journal")
        committed[candidate_id] = value
    if state:
        for candidate in state["candidates"]:
            if candidate["status"] == "adopted" and candidate["id"] not in committed:
                fail("invalid_review_journal")
        for issue in state["issues"]:
            if issue["status"] != "resolved":
                continue
            candidate = next((item for item in state["candidates"] if item["id"] == issue.get("resolvedBy")), None)
            if not candidate or candidate["status"] != "adopted" or candidate.get("issueId") != issue["id"] or issue.get("resolvedAt") != candidate.get("adoptedAt"):
                fail("invalid_review_state")


def stream_hash(stream, maximum, destination=None):
    hasher, count = hashlib.sha256(), 0
    while True:
        chunk = stream.read(min(1024 * 1024, maximum - count + 1))
        if not chunk:
            break
        count += len(chunk)
        if count > maximum:
            fail("file_budget_exceeded")
        hasher.update(chunk)
        if destination is not None:
            destination.write(chunk)
    return count, hasher.hexdigest()


def export_archive(kb_root, output, limits):
    root = root_path(kb_root)
    output = absolute_safe(output)
    try:
        inside = os.path.commonpath([root, output]) == os.fspath(root)
    except ValueError:  # Different Windows drives cannot be nested.
        inside = False
    if inside:
        fail("output_inside_knowledge_base")
    if output.exists():
        fail("output_exists")
    if not output.parent.is_dir():
        fail("invalid_output_parent")
    temporary = None
    with review_lock(root):
        knowledge_id = atomic_identity(root)
        files, directories, excluded = inventory(root, limits)
        validate_review(root, files)
        descriptor, temporary_name = tempfile.mkstemp(prefix=".wiki-archive-", suffix=".zip", dir=output.parent)
        os.close(descriptor)
        temporary = Path(temporary_name)
        try:
            entries, total = [], 0
            with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
                for relative in directories:
                    archive.writestr(relative + "/", b"")
                for relative in files:
                    with safe_open(root, relative) as source, archive.open(relative, "w", force_zip64=True) as destination:
                        size, sha = stream_hash(source, limits["max_file_bytes"], destination)
                    total += size
                    if total > limits["max_total_bytes"]:
                        fail("total_budget_exceeded")
                    entries.append({"path": relative, "size": size, "sha256": sha})
                manifest = {"format": FORMAT, "version": 1, "knowledgeBaseId": knowledge_id,
                            "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "directories": directories,
                            "files": entries, "excluded": excluded}
                validate_manifest(manifest, limits)
                data = encoded(manifest)
                if len(data) > MAX_MANIFEST:
                    fail("manifest_budget_exceeded")
                archive.writestr(MANIFEST, data)
            if temporary.stat().st_size > limits["max_archive_bytes"]:
                fail("archive_budget_exceeded")
            # Recheck all names and bytes while the shared publication lock is
            # still held; ordinary editors do not participate in that lock.
            if inventory(root, limits) != (files, directories, excluded):
                fail("source_changed")
            for entry in entries:
                with safe_open(root, entry["path"]) as stream:
                    size, sha = stream_hash(stream, limits["max_file_bytes"])
                if size != entry["size"] or sha != entry["sha256"]:
                    fail("source_changed")
            # Windows FlushFileBuffers requires write access to the handle.
            # Reopen the completed ZIP without truncation before syncing it.
            with open(temporary, "r+b") as stream:
                os.fsync(stream.fileno())
            # Hard-link publication is atomic and cannot overwrite an existing
            # archive, unlike rename on POSIX. Both paths are on the same disk.
            absolute_safe(output)
            try:
                os.link(temporary, output)
            except FileExistsError:
                fail("output_exists")
            sync_directory(output.parent)
            return summary(manifest, total)
        finally:
            if temporary is not None and temporary.exists():
                temporary.unlink()


def zip_preflight(archive_path, limits):
    path = absolute_safe(archive_path)
    if not path.is_file():
        fail("invalid_archive")
    size = path.stat().st_size
    if size > limits["max_archive_bytes"]:
        fail("archive_budget_exceeded")
    # Bound central-directory construction before ZipFile creates ZipInfo
    # objects. Our bounded writer never needs ZIP64 directory-count records.
    with open(path, "rb") as stream:
        stream.seek(max(0, size - 65557))
        tail = stream.read(65557)
    offset = tail.rfind(b"PK\x05\x06")
    if offset < 0 or len(tail) - offset < 22:
        fail("invalid_archive")
    _signature, disk, cd_disk, disk_entries, entries, cd_size, cd_offset, comment_size = struct.unpack("<4s4H2IH", tail[offset:offset + 22])
    if disk or cd_disk or entries != disk_entries or entries > MAX_ENTRIES or cd_size > 64 * 1024 * 1024 or offset + 22 + comment_size != len(tail):
        fail("invalid_archive")
    if cd_offset + cd_size != size - len(tail) + offset:
        fail("invalid_archive")
    # Counts in EOCD are attacker-controlled; count the actual bounded records
    # too, before ZipFile allocates its complete list.
    with open(path, "rb") as stream:
        stream.seek(cd_offset)
        consumed, actual_entries = 0, 0
        while consumed < cd_size:
            header = stream.read(46)
            if len(header) != 46 or header[:4] != b"PK\x01\x02":
                fail("invalid_archive")
            name_length, extra_length, comment_length = struct.unpack("<3H", header[28:34])
            consumed += 46 + name_length + extra_length + comment_length
            actual_entries += 1
            if consumed > cd_size or actual_entries > MAX_ENTRIES:
                fail("entry_budget_exceeded")
            name = stream.read(name_length)
            if len(name) != name_length or b"\x00" in name:
                fail("unsafe_path")
            stream.seek(extra_length + comment_length, os.SEEK_CUR)
        if actual_entries != entries:
            fail("invalid_archive")
    return path


def validate_manifest(value, limits):
    if not version_one(value) or value.get("format") != FORMAT or not KB_ID.fullmatch(str(value.get("knowledgeBaseId", ""))):
        fail("invalid_manifest")
    files, directories = value.get("files"), value.get("directories")
    if not isinstance(files, list) or not isinstance(directories, list) or len(files) > limits["max_files"] or len(files) + len(directories) + 1 > MAX_ENTRIES:
        fail("invalid_manifest")
    names, total = {}, 0
    for relative in directories:
        relative_path(relative)
        if not permitted(relative) or transient(relative) or relative.split("/", 1)[0] not in ROOT_DIRS:
            fail("invalid_manifest_path")
        key = portable_key(relative)
        if key in names:
            fail("portable_path_collision")
        names[key] = (relative, True)
    exact_files = set()
    for entry in files:
        if not isinstance(entry, dict):
            fail("invalid_manifest")
        relative = relative_path(entry.get("path"))
        size = entry.get("size")
        if not permitted(relative) or transient(relative) or relative in ROOT_DIRS:
            fail("invalid_manifest_path")
        if type(size) is not int or size < 0 or size > limits["max_file_bytes"] or not HASH.fullmatch(str(entry.get("sha256", ""))):
            fail("invalid_manifest")
        key = portable_key(relative)
        if key in names:
            fail("portable_path_collision")
        names[key] = (relative, False)
        exact_files.add(relative)
        total += size
    if total > limits["max_total_bytes"]:
        fail("total_budget_exceeded")
    if not REQUIRED.union({IDENTITY}).issubset(exact_files):
        fail("incomplete_knowledge_base")
    for relative, _is_directory in names.values():
        parts = relative.split("/")
        for length in range(1, len(parts)):
            parent = "/".join(parts[:length])
            if names.get(portable_key(parent)) != (parent, True):
                fail("invalid_manifest_hierarchy")
    if not isinstance(value.get("excluded"), list) or any(not isinstance(item, str) or len(item) > 2048 for item in value["excluded"]):
        fail("invalid_manifest")
    return total


def verified_extract(archive_path, staging, limits):
    archive_path = zip_preflight(archive_path, limits)
    with zipfile.ZipFile(archive_path, "r") as archive:
        infos = archive.infolist()
        if len(infos) > MAX_ENTRIES:
            fail("entry_budget_exceeded")
        by_name, keys = {}, set()
        for info in infos:
            if info.filename in by_name:
                fail("duplicate_zip_entry")
            key = portable_key(info.filename.rstrip("/"))
            if key in keys:
                fail("portable_path_collision")
            keys.add(key)
            by_name[info.filename] = info
            mode = (info.external_attr >> 16) & 0xffff
            if stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR)) or info.flag_bits & 1:
                fail("unsupported_zip_entry")
            if info.filename != MANIFEST:
                relative_path(info.filename[:-1] if info.is_dir() else info.filename)
            if info.file_size > limits["max_file_bytes"] and info.filename != MANIFEST:
                fail("file_budget_exceeded")
        manifest_info = by_name.get(MANIFEST)
        if not manifest_info or manifest_info.file_size > MAX_MANIFEST or manifest_info.is_dir():
            fail("invalid_manifest")
        with archive.open(manifest_info) as stream:
            manifest_bytes = stream.read(MAX_MANIFEST + 1)
        if len(manifest_bytes) > MAX_MANIFEST:
            fail("manifest_budget_exceeded")
        manifest = parse_json(manifest_bytes, "invalid_manifest")
        total = validate_manifest(manifest, limits)
        expected = {MANIFEST} | {entry["path"] for entry in manifest["files"]} | {relative + "/" for relative in manifest["directories"]}
        if set(by_name) != expected:
            fail("archive_entries_mismatch")
        for relative in sorted(manifest["directories"], key=lambda item: (item.count("/"), item)):
            staging.joinpath(*relative.split("/")).mkdir()
        for entry in manifest["files"]:
            info = by_name[entry["path"]]
            if info.is_dir() or info.file_size != entry["size"]:
                fail("archive_entries_mismatch")
            destination = staging.joinpath(*entry["path"].split("/"))
            with archive.open(info) as source, open(destination, "xb") as output:
                size, sha = stream_hash(source, entry["size"], output)
                output.flush()
                os.fsync(output.fileno())
            if size != entry["size"] or sha != entry["sha256"]:
                fail("content_hash_mismatch")
        identity = parse_json(read_file(staging, IDENTITY, 4096), "invalid_identity")
        if not version_one(identity) or identity.get("id") != manifest["knowledgeBaseId"]:
            fail("invalid_identity")
        validate_review(staging, [entry["path"] for entry in manifest["files"]])
        return manifest, total


def summary(manifest, total):
    return {"ok": True, "version": 1, "knowledgeBaseId": manifest["knowledgeBaseId"],
            "files": len(manifest["files"]), "totalBytes": total, "excluded": manifest["excluded"]}


def verify_archive(archive_path, limits):
    with tempfile.TemporaryDirectory(prefix="wiki-verify-") as directory:
        manifest, total = verified_extract(archive_path, Path(os.path.realpath(directory)), limits)
        return summary(manifest, total)


def restore_archive(archive_path, target, limits):
    target = absolute_safe(target)
    if not target.parent.is_dir():
        fail("invalid_target_parent")
    existed = target.exists()
    if existed and (not target.is_dir() or any(target.iterdir())):
        fail("target_not_empty")
    staging = Path(tempfile.mkdtemp(prefix=".wiki-restore-", dir=target.parent))
    staging = Path(os.path.realpath(staging))
    published = False
    try:
        manifest, total = verified_extract(archive_path, staging, limits)
        # Cache is disposable derived data. Never carry machine-specific or
        # stale page references into an otherwise byte-exact restore.
        with open(staging / ".wiki-cache.json", "wb") as stream:
            stream.write(encoded({"version": 1, "entries": {}}))
            stream.flush()
            os.fsync(stream.fileno())
        absolute_safe(target)
        if target.exists():
            if not target.is_dir() or any(target.iterdir()):
                fail("target_not_empty")
            target.rmdir()  # Fails if another writer makes it nonempty.
        os.rename(staging, target)
        published = True
        sync_directory(target.parent)
        result = summary(manifest, total)
        result["cacheInvalidated"] = True
        return result
    finally:
        if not published:
            shutil.rmtree(staging, ignore_errors=True)
            if existed and not target.exists():
                target.mkdir(exist_ok=True)


def arguments(argv):
    parser = ArgumentParser(description="Export, verify or restore a Skill knowledge base ZIP.")
    subparsers = parser.add_subparsers(dest="command", required=True)
    for command in ("export", "verify", "restore"):
        sub = subparsers.add_parser(command)
        sub.add_argument("source")
        sub.add_argument("--json", action="store_true")
        if command == "export":
            sub.add_argument("--output", required=True)
        if command == "restore":
            sub.add_argument("--target", required=True)
        for name, maximum in DEFAULTS.items():
            sub.add_argument("--" + name.replace("_", "-"), type=int, default=maximum)
    return parser.parse_args(argv)


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", newline="\n")
    try:
        args = arguments(argv)
        limits = {name: getattr(args, name) for name in DEFAULTS}
        if any(type(value) is not int or value < 1 or value > DEFAULTS[name] for name, value in limits.items()):
            fail("invalid_limit")
        if args.command == "export":
            result = export_archive(args.source, args.output, limits)
        elif args.command == "verify":
            result = verify_archive(args.source, limits)
        else:
            result = restore_archive(args.source, args.target, limits)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except ArchiveError as error:
        print(json.dumps({"ok": False, "error": str(error)}), file=sys.stderr)
    except (OSError, ValueError, KeyError, TypeError, zipfile.BadZipFile, zipfile.LargeZipFile,
            RuntimeError, RecursionError, zlib.error, EOFError, OverflowError):
        # OS exceptions may include absolute private paths; expose a stable code.
        print(json.dumps({"ok": False, "error": "archive_failed"}), file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
