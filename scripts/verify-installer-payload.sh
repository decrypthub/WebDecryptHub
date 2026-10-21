#!/usr/bin/env bash
# List the NSIS installer with 7z and require the payload paths release.yml ships.
set -euo pipefail
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"
NSIS=$(find src-tauri/target/release/bundle/nsis -type f -name '*-setup.exe' | head -1)
test -n "$NSIS"
ls -la "$NSIS"
7z l "$NSIS" > payload.txt
for f in WebDecryptHub.exe jsra-sidecar.exe resources/node/node.exe resources/node/node_modules/npm/bin/npm-cli.js resources/patchright-core/package.json; do
  grep -F "$(echo "$f" | tr '/' '\\')" payload.txt > /dev/null || grep -F "$f" payload.txt > /dev/null || { echo "MISSING in installer: $f" >&2; exit 1; }
done
echo "installer payload OK"
