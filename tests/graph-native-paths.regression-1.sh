#!/bin/bash
# Exercise the MSYS/native filesystem boundary without relying on argv auto-conversion.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMP_ROOT="$(mktemp -d -t llm-wiki-graph-native.XXXXXX)"
trap 'rm -rf "$TEMP_ROOT"' EXIT
REAL_NODE="$(command -v node)"
REAL_JQ="$(command -v jq)"
REAL_CYGPATH="$(command -v cygpath || true)"
TOOL_ROOT="$TEMP_ROOT/tool 中文 & 'quotes"
KB_ROOT="$TEMP_ROOT/知识库 空格 & \$quote'"
BIN="$TEMP_ROOT/bin"
mkdir -p "$TOOL_ROOT" "$BIN"
cp -R "$REPO_ROOT/scripts" "$TOOL_ROOT/scripts"
mkdir -p "$TOOL_ROOT/deps" "$TOOL_ROOT/packages/workbench-contracts/src"
cp -R "$REPO_ROOT/deps/unicode" "$TOOL_ROOT/deps/unicode"
cp "$REPO_ROOT/packages/workbench-contracts/package.json" "$TOOL_ROOT/packages/workbench-contracts/package.json"
cp "$REPO_ROOT/packages/workbench-contracts/src/graph-rename-filename.js" "$TOOL_ROOT/packages/workbench-contracts/src/graph-rename-filename.js"
cp -R "$REPO_ROOT/tests/fixtures/graph-path-identity-wiki" "$KB_ROOT"
# Exceed Windows' argv limit while remaining below the graph content budget.
# The body must survive the stdin merge without truncation or an argv payload.
{
  printf '# Native large payload\n\n'
  for ((line = 0; line < 80; line++)); do printf '%0600d\n' "$line"; done
} > "$KB_ROOT/wiki/sources/native-large.md"
# Only this temporary copy emulates Git Bash's host type; production detection is unchanged.
awk 'NR == 1 { print; print "OSTYPE=msys"; next } { print }' \
  "$REPO_ROOT/scripts/build-graph-data.sh" > "$TOOL_ROOT/scripts/build-graph-data.sh"

cat > "$BIN/cygpath" <<'SH'
#!/bin/bash
set -eu
[ "$#" -eq 3 ] && [ "$1" = "-m" ] && [ "$2" = "--" ] || exit 91
# A native-only marker represents the physical Windows path, with native line endings.
printf 'native:%s\r\n' "$3"
SH

cat > "$BIN/node" <<'SH'
#!/bin/bash
set -euo pipefail
[ "${MSYS2_ARG_CONV_EXCL:-}" = '*' ] && [ "${MSYS_NO_PATHCONV:-}" = 1 ] || exit 92
args=()
for arg in "$@"; do
  case "$arg" in
    native:*)
      value="${arg#native:}"
      if [ -n "${GRAPH_NATIVE_REAL_CYGPATH:-}" ]; then
        value="$("$GRAPH_NATIVE_REAL_CYGPATH" -m -- "$value")"
      fi
      args+=("${value%$'\r'}")
      ;;
    /*) echo 'ERROR: native Node received an unconverted MSYS filesystem argument' >&2; exit 93 ;;
    *) args+=("$arg") ;;
  esac
done
exec "$GRAPH_NATIVE_REAL_NODE" "${args[@]}"
SH

cat > "$BIN/jq" <<'SH'
#!/bin/bash
set -euo pipefail
[ "${MSYS2_ARG_CONV_EXCL:-}" = '*' ] && [ "${MSYS_NO_PATHCONV:-}" = 1 ] || exit 94
for arg in "$@"; do
  [ "${#arg}" -lt 16384 ] || { echo 'ERROR: native jq received JSON in argv' >&2; exit 96; }
  case "$arg" in
    --slurpfile|--rawfile|--argfile|native:*|/*)
      echo 'ERROR: native jq must read JSON through stdin, without filesystem arguments' >&2; exit 95 ;;
  esac
done
"$GRAPH_NATIVE_REAL_JQ" "$@" | awk '{ sub(/\r$/, ""); printf "%s\r\n", $0 }'
SH
chmod +x "$BIN/cygpath" "$BIN/node" "$BIN/jq"

if ! PATH="$BIN:$PATH" GRAPH_NATIVE_REAL_NODE="$REAL_NODE" GRAPH_NATIVE_REAL_JQ="$REAL_JQ" GRAPH_NATIVE_REAL_CYGPATH="$REAL_CYGPATH" \
  LLM_WIKI_TEST_MODE=1 bash "$TOOL_ROOT/scripts/build-graph-data.sh" "$KB_ROOT" \
  > "$TEMP_ROOT/build.out" 2> "$TEMP_ROOT/build.err"; then
  cat "$TEMP_ROOT/build.err" >&2
  echo 'FAIL: explicit MSYS/native graph path conversion' >&2
  exit 1
fi
[ ! -s "$TEMP_ROOT/build.err" ] || {
  cat "$TEMP_ROOT/build.err" >&2
  echo 'FAIL: native scalar line endings caused graph diagnostics' >&2
  exit 1
}
native_test_path() {
  local value="$1"
  if [ -n "$REAL_CYGPATH" ]; then value="$("$REAL_CYGPATH" -m -- "$value")"; fi
  printf '%s\n' "${value%$'\r'}"
}
MSYS2_ARG_CONV_EXCL='*' MSYS_NO_PATHCONV=1 "$REAL_JQ" -e '.meta.total_nodes > 0 and (.nodes | type) == "array" and (.edges | type) == "array"
  and ([.nodes[] | select(.id == "wiki/sources/native-large.md") | .content | length] == [48103])' \
  < "$KB_ROOT/wiki/graph-data.json" > /dev/null
MSYS2_ARG_CONV_EXCL='*' MSYS_NO_PATHCONV=1 "$REAL_NODE" "$(native_test_path "$REPO_ROOT/scripts/wiki-link-cli.js")" warning-embed "$(native_test_path "$KB_ROOT")" \
  "$(native_test_path "$KB_ROOT/wiki/graph-data.json")" "$(native_test_path "$KB_ROOT/wiki/graph-warnings.json")" "$(native_test_path "$TEMP_ROOT/warnings.json")"
MSYS2_ARG_CONV_EXCL='*' MSYS_NO_PATHCONV=1 "$REAL_JQ" -e '.details_status == "available"' < "$TEMP_ROOT/warnings.json" > /dev/null
echo 'PASS: graph native path boundary regression (MSYS Node paths, jq stdin, large JSON and CRLF)'
