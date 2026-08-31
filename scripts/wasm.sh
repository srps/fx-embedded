#!/usr/bin/env bash
# Build/copy fx-term.wasm (the embedded fx agent) into romfs/.
#
# Sources, in order:
#   1. a newer zig-out/bin/fx-term.wasm in the fx checkout
#   2. the copy in romfs, but only when no fx source/build input is newer
#   3. a fresh `zig build -Dwasm-surface=term` (needs zig 0.16+; FX_ZIG can
#      point at the zig binary)
# Set FX_WASM_REUSE=1 only when intentionally testing a pinned artifact.
#
# WSL note: zig's cache does atomic renames that Windows drives (/mnt/c)
# reject (AccessDenied), so the build runs in /tmp against a copied tree and
# only the artifact crosses back.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
FX_DIR="${FX_DIR:-$ROOT/../fx}"
OUT="$ROOT/romfs/fx-term.wasm"

if [ ! -d "$FX_DIR" ]; then
  echo "wasm: fx checkout not found at $FX_DIR (set FX_DIR)" >&2
  exit 1
fi

SRC="$FX_DIR/zig-out/bin/fx-term.wasm"
if [ -f "$SRC" ] && [ "$SRC" -nt "$OUT" ]; then
  cp "$SRC" "$OUT"
  echo "wasm: copied $(ls -lh "$OUT" | awk '{print $5}') from $SRC"
  exit 0
fi
if [ "${FX_WASM_REUSE:-0}" = "1" ] && [ -f "$OUT" ]; then
  echo "wasm: reusing pinned romfs/fx-term.wasm (FX_WASM_REUSE=1)"
  exit 0
fi
if [ -f "$OUT" ] && ! find "$FX_DIR/src" "$FX_DIR/build.zig" "$FX_DIR/build.zig.zon" \
  -type f -newer "$OUT" -print -quit 2>/dev/null | grep -q .; then
  echo "wasm: keeping existing romfs/fx-term.wasm ($(ls -lh "$OUT" | awk '{print $5}'))"
  exit 0
fi

ZIG="${FX_ZIG:-zig}"
if ! command -v "$ZIG" >/dev/null 2>&1 && [ ! -x "${FX_ZIG:-/nonexistent}" ]; then
  echo "wasm: zig not found (set FX_ZIG=/path/to/zig; fx needs 0.16+)" >&2
  exit 1
fi
BUILD_DIR="$(mktemp -d /tmp/fx-wasm-build.XXXXXX)"
trap 'rm -rf "$BUILD_DIR"' EXIT
tar --exclude=.git -cf - -C "$FX_DIR" . | tar xf - -C "$BUILD_DIR"
(cd "$BUILD_DIR" && "$ZIG" build -Dwasm-surface=term >/dev/null)
cp "$BUILD_DIR/zig-out/bin/fx-term.wasm" "$OUT"
echo "wasm: built $(ls -lh "$OUT" | awk '{print $5}') -> romfs/fx-term.wasm"
