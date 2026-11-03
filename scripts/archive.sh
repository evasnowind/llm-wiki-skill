#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/shared-config.sh"
require_python_cmd
exec "$PYTHON_CMD" "$SCRIPT_DIR/archive.py" "$@"
