#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
nxjs_dir="${NXJS_DIR:-$project_dir/../nx.js}"
builder="$nxjs_dir/packages/nro/dist/main.js"
runtime="$nxjs_dir/nxjs.nro"

if [[ ! -f "$builder" || ! -f "$runtime" ]]; then
  echo "nro:fat: local nx.js builder/runtime missing under $nxjs_dir" >&2
  echo "nro:fat: build ../nx.js/nxjs.nro first or set NXJS_DIR" >&2
  exit 1
fi

# `bun run nro` has just produced the ordinary slim artifact. Preserve it,
# then invoke the local nx.js packager in source mode; --fat makes it use the
# freshly built local nxjs.nro rather than the published package's runtime.
cp "$project_dir/fx-embedded.nro" "$project_dir/fx-embedded-slim.nro"
(
  cd "$project_dir"
  bun "$builder" --fat
)
mv "$project_dir/fx-embedded.nro" "$project_dir/fx-embedded-fat.nro"
mv "$project_dir/fx-embedded-slim.nro" "$project_dir/fx-embedded.nro"

echo "nro:fat: built fx-embedded-fat.nro with local $runtime"
