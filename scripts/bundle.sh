#!/usr/bin/env bash
# Bundle src/main.ts -> romfs/main.js with esbuild.
#
# WSL note: node_modules on /mnt/c is often installed from Windows, so the
# local esbuild is the win32-x64 binary and fails under Linux. Prefer the
# local one when it runs; otherwise fall back to any linux-x64 esbuild in a
# sibling checkout, then to `bunx esbuild`.
set -euo pipefail
cd "$(dirname "$0")/.."
ARGS=(src/main.ts --bundle --format=esm --outfile=romfs/main.js)
if node_modules/.bin/esbuild --version >/dev/null 2>&1; then
  exec node_modules/.bin/esbuild "${ARGS[@]}"
fi
for cand in ../nx.js/node_modules/.pnpm/@esbuild+linux-x64@*/node_modules/@esbuild/linux-x64/bin/esbuild; do
  if [ -x "$cand" ]; then
    echo "bundle: local esbuild is for another platform; using $cand" >&2
    exec "$cand" "${ARGS[@]}"
  fi
done
echo "bundle: no native esbuild found; using bunx esbuild" >&2
exec bunx esbuild "${ARGS[@]}"
