#!/bin/bash
# build-graph-data.sh — build a path-identity graph and its sibling warning sidecar.
#
# Usage:
#   bash scripts/build-graph-data.sh <kb-root> [<kb-internal-dir>/graph-data.json]
#
# A custom output must remain inside the knowledge base, keep the graph-data.json
# basename, and owns graph-warnings.json in the same existing directory.
# Exit codes: 0 = valid graph produced (including data warnings); 1 = tool/input failure.

set -euo pipefail

SCRIPT_DIR="${BASH_SOURCE[0]%/*}"
[ "$SCRIPT_DIR" = "${BASH_SOURCE[0]}" ] && SCRIPT_DIR="."
SCRIPT_DIR="$(cd "$SCRIPT_DIR" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/shared-config.sh"

# Git Bash's physical /tmp and drive mounts are not native Windows paths.
# Convert filesystem arguments explicitly instead of relying on MSYS argv
# heuristics (which can skip quoted/Unicode paths or be disabled by the host).
native_path() {
  local value
  case "$OSTYPE" in
    msys*|cygwin*)
      command -v cygpath >/dev/null 2>&1 || {
        echo "ERROR: cygpath is required with Git Bash/Cygwin on Windows." >&2
        return 1
      }
      value="$(cygpath -m -- "$1")"
      printf '%s\n' "${value%$'\r'}"
      ;;
    *) printf '%s\n' "$1" ;;
  esac
}

native_command() {
  case "$OSTYPE" in
    msys*|cygwin*) MSYS2_ARG_CONV_EXCL='*' MSYS_NO_PATHCONV=1 "$@" ;;
    *) "$@" ;;
  esac
}

usage() {
  cat <<'USAGE'
Usage:
  bash scripts/build-graph-data.sh <kb-root> [<kb-internal-dir>/graph-data.json]

Custom output rules:
  - the destination directory must already exist inside the knowledge base
  - the graph filename must remain graph-data.json
  - graph-warnings.json is committed beside it as the unique paired warning file
USAGE
}

[ "$#" -ge 1 ] && [ "$#" -le 2 ] || {
  usage >&2
  exit 1
}

command -v jq >/dev/null 2>&1 || {
  echo "ERROR: jq is not installed. Install it via:" >&2
  print_install_hint jq
  exit 1
}
command -v node >/dev/null 2>&1 || {
  echo "ERROR: node is not installed. Install it via:" >&2
  print_install_hint node
  exit 1
}

WIKI_ROOT_INPUT="$1"
[ -d "$WIKI_ROOT_INPUT" ] || {
  echo "ERROR: knowledge base does not exist or is not readable: $WIKI_ROOT_INPUT" >&2
  exit 1
}
WIKI_ROOT="$(cd "$WIKI_ROOT_INPUT" && pwd)"
WIKI_DIR="$WIKI_ROOT/wiki"
[ -d "$WIKI_DIR" ] || {
  echo "ERROR: wiki directory does not exist: $WIKI_DIR" >&2
  echo "       Run init-wiki.sh before building the graph." >&2
  exit 1
}

if [ "$#" -eq 2 ]; then
  OUTPUT_INPUT="$2"
  OUTPUT_PARENT="$(dirname "$OUTPUT_INPUT")"
  [ -d "$OUTPUT_PARENT" ] || {
    echo "ERROR: custom graph output directory does not exist: $OUTPUT_PARENT" >&2
    exit 1
  }
  OUTPUT="$(cd "$OUTPUT_PARENT" && pwd)/$(basename "$OUTPUT_INPUT")"
else
  OUTPUT="$WIKI_ROOT/wiki/graph-data.json"
fi

SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
HELPER="$SCRIPT_DIR/graph-analysis.js"
CLI="$SCRIPT_DIR/wiki-link-cli.js"
BUNDLE="$SCRIPT_DIR/lib/graph-warning-bundle.js"
[ -f "$HELPER" ] || {
  echo "ERROR: 找不到图谱分析 helper：$HELPER" >&2
  echo "       Reinstall the skill and retry." >&2
  exit 1
}
[ -f "$CLI" ] || {
  echo "ERROR: shared wikilink resolver is missing: $CLI" >&2
  echo "       Reinstall the skill and retry." >&2
  exit 1
}
[ -f "$BUNDLE" ] || {
  echo "ERROR: graph warning bundle helper is missing: $BUNDLE" >&2
  echo "       Reinstall the skill and retry." >&2
  exit 1
}

MAX_CONTENT_BYTES=$((2 * 1024 * 1024))
MAX_CONTENT_LINES=500
MAX_INSIGHT_NODES=250
MAX_INSIGHT_EDGES=1000

TMPDIR="$(mktemp -d -t llm-wiki-graph.XXXXXX)"
trap 'rm -rf "$TMPDIR"' EXIT
SCAN_DIR="$TMPDIR/scan"
mkdir -p "$SCAN_DIR"
NATIVE_TMPDIR="$(native_path "$TMPDIR")"
NATIVE_SCAN_DIR="$(native_path "$SCAN_DIR")"
NATIVE_WIKI_ROOT="$(native_path "$WIKI_ROOT")"
NATIVE_CLI="$(native_path "$CLI")"
NATIVE_HELPER="$(native_path "$HELPER")"
NATIVE_OUTPUT="$(native_path "$OUTPUT")"

GRAPH_FLAGS=""
if [ "${LLM_WIKI_TEST_MODE:-0}" = "1" ]; then
  BUILD_DATE="2026-01-01T00:00:00Z"
  GRAPH_FLAGS="--test-mode"
else
  BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
fi

if [ -n "$GRAPH_FLAGS" ]; then
  native_command node "$NATIVE_CLI" graph "$NATIVE_WIKI_ROOT" "$NATIVE_SCAN_DIR" "$GRAPH_FLAGS" > "$TMPDIR/scan.out"
else
  native_command node "$NATIVE_CLI" graph "$NATIVE_WIKI_ROOT" "$NATIVE_SCAN_DIR" > "$TMPDIR/scan.out"
fi

for SCAN_FILE in nodes.json edges.json warning-groups.json candidate-sets.json scan-metrics.json; do
  [ -f "$SCAN_DIR/$SCAN_FILE" ] || {
    echo "ERROR: graph scan did not produce $SCAN_FILE" >&2
    exit 1
  }
done

WIKI_TITLE=""
if [ -f "$WIKI_ROOT/purpose.md" ]; then
  WIKI_TITLE="$(awk '/^# / { sub(/^# +/, ""); print; exit }' "$WIKI_ROOT/purpose.md")"
fi
[ -n "$WIKI_TITLE" ] || WIKI_TITLE="$(basename "$WIKI_ROOT")"
WIKI_TITLE="${WIKI_TITLE%$'\r'}"

# Let Bash open JSON files: native Windows jq may not open Unicode paths
# consistently through its file/--slurpfile entry points. stdin also keeps large
# graph payloads out of argv and its Windows command-line length limit.
TOTAL_SIZE="$(native_command jq -r '.graph_source_bytes // 0' < "$SCAN_DIR/scan-metrics.json")"
TOTAL_SIZE="${TOTAL_SIZE%$'\r'}"
DEGRADE=0
if [ "$TOTAL_SIZE" -gt "$MAX_CONTENT_BYTES" ]; then
  DEGRADE=1
fi

ANALYSIS_JSON="$TMPDIR/analysis.json"
if ! native_command node "$NATIVE_HELPER" \
  "$NATIVE_SCAN_DIR/nodes.json" \
  "$NATIVE_SCAN_DIR/edges.json" \
  "$NATIVE_TMPDIR/analysis.json" \
  "$DEGRADE" \
  "$MAX_CONTENT_LINES" \
  "$MAX_INSIGHT_NODES" \
  "$MAX_INSIGHT_EDGES"; then
  echo "ERROR: graph analysis helper failed: $HELPER" >&2
  exit 1
fi

native_command jq -e '
  (.nodes | type) == "array" and
  (.edges | type) == "array" and
  (.insights | type) == "object" and
  (.learning | type) == "object"
' < "$ANALYSIS_JSON" > /dev/null 2>&1 || {
  echo "ERROR: graph analysis helper returned invalid JSON: $ANALYSIS_JSON" >&2
  exit 1
}

if [ "${LLM_WIKI_TEST_MODE:-0}" = "1" ]; then
  native_command jq '.nodes | sort_by(.id)' < "$ANALYSIS_JSON" > "$TMPDIR/nodes.sorted.json"
  native_command jq '.edges | sort_by(.from, .to, .relation_type, .type)
      | to_entries
      | map(.value + {id: ("e" + ((.key + 1) | tostring))})' \
    < "$ANALYSIS_JSON" > "$TMPDIR/edges.sorted.json"
else
  native_command jq '.nodes' < "$ANALYSIS_JSON" > "$TMPDIR/nodes.sorted.json"
  native_command jq '.edges' < "$ANALYSIS_JSON" > "$TMPDIR/edges.sorted.json"
fi

INITIAL_VIEW="$TMPDIR/initial-view.json"
cat "$TMPDIR/nodes.sorted.json" "$TMPDIR/edges.sorted.json" | native_command jq -s '
  .[0] as $node_rows
  | .[1] as $edges
  | (reduce $edges[] as $edge ({};
      .[$edge.from] = (.[$edge.from] // 0) + 1
      | .[$edge.to] = (.[$edge.to] // 0) + 1
    )) as $degree
  | ($node_rows | group_by(.community // "_")) as $groups
  | ([ $groups[] | max_by(($degree[.id] // 0)) | .id ]) as $representatives
  | ($node_rows
      | sort_by(-($degree[.id] // 0), .id)
      | map(.id)
      | map(select(. as $id | $representatives | index($id) | not))) as $rest
  | ($representatives + $rest)[0:30]
' > "$INITIAL_VIEW"

NODE_COUNT="$(native_command jq 'length' < "$TMPDIR/nodes.sorted.json")"
EDGE_COUNT="$(native_command jq 'length' < "$TMPDIR/edges.sorted.json")"
INSIGHTS_DEGRADED="$(native_command jq '.insights.meta.degraded == true' < "$ANALYSIS_JSON")"
NODE_COUNT="${NODE_COUNT%$'\r'}"
EDGE_COUNT="${EDGE_COUNT%$'\r'}"
INSIGHTS_DEGRADED="${INSIGHTS_DEGRADED%$'\r'}"

GRAPH_INPUT="$TMPDIR/graph-data.json"
cat "$INITIAL_VIEW" "$TMPDIR/nodes.sorted.json" "$TMPDIR/edges.sorted.json" "$ANALYSIS_JSON" | native_command jq -s \
  --arg build_date "$BUILD_DATE" \
  --arg wiki_title "$WIKI_TITLE" \
  --argjson total_nodes "$NODE_COUNT" \
  --argjson total_edges "$EDGE_COUNT" \
  --argjson degraded "$DEGRADE" \
  --argjson insights_degraded "$INSIGHTS_DEGRADED" \
  '.[0] as $initial_view | .[1] as $nodes | .[2] as $edges | .[3] as $analysis | {
    meta: {
      build_date: $build_date,
      wiki_title: $wiki_title,
      total_nodes: $total_nodes,
      total_edges: $total_edges,
      initial_view: $initial_view,
      degraded: ($degraded == 1),
      insights_degraded: $insights_degraded
    },
    nodes: $nodes,
    edges: $edges,
    insights: $analysis.insights,
    learning: $analysis.learning
  }' > "$GRAPH_INPUT"

if ! native_command node "$NATIVE_CLI" commit-pair \
  "$NATIVE_WIKI_ROOT" \
  "$NATIVE_TMPDIR/graph-data.json" \
  "$NATIVE_SCAN_DIR/warning-groups.json" \
  "$NATIVE_SCAN_DIR/candidate-sets.json" \
  "$NATIVE_OUTPUT" > "$TMPDIR/commit.out"; then
  echo "ERROR: graph artifact pair commit failed for $OUTPUT" >&2
  exit 1
fi

echo "Graph data generated: $OUTPUT"
echo "  Nodes: $NODE_COUNT"
echo "  Edges: $EDGE_COUNT"
echo "  Warning sidecar: $(dirname "$OUTPUT")/graph-warnings.json"
[ "$DEGRADE" = "1" ] && echo "  Warning: content embedding degraded above 2 MiB"
[ "$INSIGHTS_DEGRADED" = "true" ] && echo "  Warning: insights degraded for graph size"
exit 0
