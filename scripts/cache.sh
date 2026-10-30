#!/bin/bash
# llm-wiki 缓存脚本

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/shared-config.sh"

usage() {
  cat <<'EOF'
用法：
  bash scripts/cache.sh check <file>
  bash scripts/cache.sh update <file> <source_page>
  bash scripts/cache.sh invalidate <file>
EOF
}

require_file() {
  local file_path="$1"

  [ -n "$file_path" ] || {
    usage
    exit 1
  }

  [ -f "$file_path" ] || {
    echo "文件不存在：$file_path" >&2
    exit 1
  }
}

find_wiki_root() {
  local file_path="$1"
  local dir parent

  dir="$(cd "$(dirname "$file_path")" && pwd)"

  while true; do
    if [ -f "$dir/.wiki-cache.json" ] || [ -f "$dir/.wiki-schema.md" ]; then
      printf '%s\n' "$dir"
      return 0
    fi

    parent="$(dirname "$dir")"
    [ "$parent" = "$dir" ] && return 1
    dir="$parent"
  done
}

cache_file_path() {
  printf '%s/.wiki-cache.json\n' "$1"
}

ensure_cache_file() {
  local cache_file="$1"

  if [ ! -f "$cache_file" ]; then
    cat > "$cache_file" <<'EOF'
{
  "version": 1,
  "entries": {}
}
EOF
  fi
}

relative_path() {
  require_python_cmd

  "$PYTHON_CMD" - "$1" "$2" <<'PY'
import os
import sys

sys.stdout.reconfigure(newline="\n")
print(os.path.relpath(os.path.realpath(sys.argv[2]), os.path.realpath(sys.argv[1])).replace(os.sep, "/"))
PY
}

normalized_source_page() {
  local wiki_root="$1"
  local source_page="$2"

  if [ -z "$source_page" ]; then
    printf '%s\n' ""
    return 0
  fi

  require_python_cmd

  "$PYTHON_CMD" - "$wiki_root" "$source_page" <<'PY'
import os
import sys

sys.stdout.reconfigure(newline="\n")
wiki_root = os.path.realpath(sys.argv[1])
source_page = sys.argv[2]

if not os.path.isabs(source_page):
    print(source_page.replace("\\", "/"))
    raise SystemExit(0)

source_page = os.path.realpath(source_page)

try:
    common = os.path.commonpath([wiki_root, source_page])
except ValueError:
    common = ""

if common == wiki_root:
    print(os.path.relpath(source_page, wiki_root).replace(os.sep, "/"))
else:
    print(sys.argv[2].replace(os.sep, "/"))
PY
}

file_hash() {
  require_python_cmd

  "$PYTHON_CMD" - "$1" "$2" <<'PY'
import hashlib
import pathlib
import sys

sys.stdout.reconfigure(newline="\n")
relative_path = sys.argv[1].encode("utf-8")
file_path = pathlib.Path(sys.argv[2])
content = file_path.read_bytes()

digest = hashlib.sha256(relative_path + b"\0" + content).hexdigest()
print(f"sha256:{digest}")
PY
}

cache_check() {
  local file_path="$1"
  local wiki_root cache_file relative_path_value current_hash result

  require_file "$file_path"
  wiki_root="$(find_wiki_root "$file_path")" || {
    echo "未找到知识库根目录：$file_path" >&2
    exit 1
  }
  cache_file="$(cache_file_path "$wiki_root")"

  if [ ! -f "$cache_file" ]; then
    printf 'MISS\n'
    return 0
  fi

  require_python_cmd

  relative_path_value="$(relative_path "$wiki_root" "$file_path")"
  current_hash="$(file_hash "$relative_path_value" "$file_path")"

  result="$(
    "$PYTHON_CMD" - "$cache_file" "$wiki_root" "$relative_path_value" "$current_hash" <<'PY'
import hashlib
import json
import os
import pathlib
import sys

sys.stdout.reconfigure(newline="\n")
cache_file, wiki_root, relative_path, current_hash = sys.argv[1:5]

with open(cache_file, "r", encoding="utf-8") as fh:
    data = json.load(fh)

entry = data.get("entries", {}).get(relative_path)

def save_cache():
    tmp_file = cache_file + ".tmp"
    with open(tmp_file, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    os.replace(tmp_file, cache_file)

# Older native Windows versions used backslashes in both cache keys and hashes.
# Migrate only after verifying the old identity hash and its existing source page.
legacy_key = relative_path.replace("/", "\\")
legacy_entry = data.get("entries", {}).get(legacy_key) if legacy_key != relative_path else None
if not entry and isinstance(legacy_entry, dict):
    legacy_hash = "sha256:" + hashlib.sha256(legacy_key.encode("utf-8") + b"\0" + pathlib.Path(os.path.join(wiki_root, relative_path)).read_bytes()).hexdigest()
    if legacy_entry.get("hash") != legacy_hash:
        print("MISS:hash_changed")
        raise SystemExit(0)
    source_page = legacy_entry.get("source_page")
    if not isinstance(source_page, str) or not source_page:
        print("MISS:no_entry")
        raise SystemExit(0)
    source_page = source_page.replace("\\", "/")
    source_abs = source_page if os.path.isabs(source_page) else os.path.join(wiki_root, source_page)
    if not os.path.isfile(source_abs):
        print("MISS:no_source")
        raise SystemExit(0)
    entries = data.setdefault("entries", {})
    entries[relative_path] = dict(legacy_entry, hash=current_hash, source_page=source_page)
    del entries[legacy_key]
    save_cache()
    print("HIT(repaired)")
    raise SystemExit(0)

# 无 cache entry → 尝试自愈（exact filename stem match + source_path 验证）
if not entry:
    raw_stem = pathlib.Path(relative_path).stem
    sources_dir = os.path.join(wiki_root, "wiki", "sources")
    if os.path.isdir(sources_dir):
        for f in os.listdir(sources_dir):
            if pathlib.Path(f).stem == raw_stem and f.endswith(".md"):
                source_page = "/".join(["wiki", "sources", f])
                source_abs = os.path.join(wiki_root, source_page)
                # 验证 source 页面的 source_path frontmatter 是否指向当前 raw 文件
                source_path_match = False
                try:
                    with open(source_abs, "r", encoding="utf-8") as sf:
                        in_frontmatter = False
                        for line in sf:
                            stripped = line.strip()
                            if stripped == "---":
                                if in_frontmatter:
                                    break  # end of frontmatter
                                in_frontmatter = True
                                continue
                            if in_frontmatter and stripped.startswith("source_path:"):
                                fm_value = stripped.split(":", 1)[1].strip().replace("\\", "/")
                                # 匹配相对路径的末尾部分
                                if relative_path.endswith(fm_value) or fm_value.endswith(relative_path) or fm_value == relative_path:
                                    source_path_match = True
                                break
                except (OSError, UnicodeDecodeError):
                    pass
                if not source_path_match:
                    # stem 匹配但 source_path 不一致 → 不信任，需要验证
                    print("MISS:repaired_needs_verify")
                    raise SystemExit(0)
                # stem + source_path 都匹配 → 安全自愈
                timestamp = __import__("datetime").datetime.now(__import__("datetime").timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
                entries = data.setdefault("entries", {})
                entries[relative_path] = {
                    "hash": current_hash,
                    "ingested_at": timestamp,
                    "source_page": source_page,
                }
                save_cache()
                print("HIT(repaired)")
                raise SystemExit(0)
    print("MISS:no_entry")
    raise SystemExit(0)

if entry.get("hash") != current_hash:
    print("MISS:hash_changed")
    raise SystemExit(0)

source_page = entry.get("source_page")
if not source_page:
    print("MISS:no_entry")
    raise SystemExit(0)

source_path = source_page.replace("\\", "/")
if not os.path.isabs(source_path):
    source_path = os.path.join(wiki_root, source_path)

if not os.path.isfile(source_path):
    print("MISS:no_source")
else:
    print("HIT")
PY
  )"

  printf '%s\n' "$result"
}

cache_update() {
  local file_path="$1"
  local source_page="$2"
  local wiki_root cache_file relative_path_value current_hash normalized_source timestamp

  require_file "$file_path"
  wiki_root="$(find_wiki_root "$file_path")" || {
    echo "未找到知识库根目录：$file_path" >&2
    exit 1
  }
  cache_file="$(cache_file_path "$wiki_root")"
  ensure_cache_file "$cache_file"

  require_python_cmd

  relative_path_value="$(relative_path "$wiki_root" "$file_path")"
  current_hash="$(file_hash "$relative_path_value" "$file_path")"
  normalized_source="$(normalized_source_page "$wiki_root" "$source_page")"
  timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

  "$PYTHON_CMD" - "$cache_file" "$relative_path_value" "$current_hash" "$timestamp" "$normalized_source" <<'PY'
import json
import os
import sys

cache_file, relative_path, file_hash_value, timestamp, source_page = sys.argv[1:6]

with open(cache_file, "r", encoding="utf-8") as fh:
    data = json.load(fh)

entries = data.setdefault("entries", {})
entries[relative_path] = {
    "hash": file_hash_value,
    "ingested_at": timestamp,
    "source_page": source_page,
}

tmp_file = cache_file + ".tmp"
with open(tmp_file, "w", encoding="utf-8") as fh:
    json.dump(data, fh, ensure_ascii=False, indent=2)
    fh.write("\n")
os.replace(tmp_file, cache_file)
PY

  printf 'UPDATED\n'
}

cache_invalidate() {
  local file_path="$1"
  local wiki_root cache_file relative_path_value

  # 不调用 require_file：文件可能已被删除（级联删除场景）
  # 直接通过路径查找缓存条目
  wiki_root="$(find_wiki_root "$file_path")" || {
    echo "未找到知识库根目录：$file_path" >&2
    exit 1
  }
  cache_file="$(cache_file_path "$wiki_root")"

  if [ ! -f "$cache_file" ]; then
    printf 'INVALIDATED\n'
    return 0
  fi

  require_python_cmd

  relative_path_value="$(relative_path "$wiki_root" "$file_path")"

  "$PYTHON_CMD" - "$cache_file" "$relative_path_value" <<'PY'
import json
import os
import sys

cache_file, relative_path = sys.argv[1:3]

with open(cache_file, "r", encoding="utf-8") as fh:
    data = json.load(fh)

entries = data.setdefault("entries", {})
entries.pop(relative_path, None)
entries.pop(relative_path.replace("/", "\\"), None)

tmp_file = cache_file + ".tmp"
with open(tmp_file, "w", encoding="utf-8") as fh:
    json.dump(data, fh, ensure_ascii=False, indent=2)
    fh.write("\n")
os.replace(tmp_file, cache_file)
PY

  printf 'INVALIDATED\n'
}

command_name="${1:-}"

case "$command_name" in
  check)
    [ "$#" -eq 2 ] || { usage; exit 1; }
    cache_check "$2"
    ;;
  update)
    [ "$#" -eq 3 ] || { usage; exit 1; }
    cache_update "$2" "$3"
    ;;
  invalidate)
    [ "$#" -eq 2 ] || { usage; exit 1; }
    cache_invalidate "$2"
    ;;
  *)
    usage
    exit 1
    ;;
esac
