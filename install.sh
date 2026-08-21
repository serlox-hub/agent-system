#!/usr/bin/env bash
# Thin wrapper so the install is discoverable as ./install.sh.
# All the logic lives in install.mjs (JSON merging in bash is a bad idea).
set -euo pipefail
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/install.mjs" "$@"
