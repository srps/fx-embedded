#!/usr/bin/env bash
# Track fx upstream: fetch origin/main, rebase our switch-patches branch,
# rebuild fx-term.wasm, run the host suite. One command instead of a
# 291-commit surprise.
#
#   bash scripts/fx-update.sh            # update + rebuild + test
#   bash scripts/fx-update.sh --check    # just report how far behind we are
set -euo pipefail
cd "$(dirname "$0")/.."
FX_DIR="${FX_DIR:-../fx}"

git -C "$FX_DIR" fetch -q --tags origin
behind=$(git -C "$FX_DIR" rev-list --count switch-patches..origin/main)
tag=$(git -C "$FX_DIR" tag --sort=-creatordate | head -1)
echo "fx-update: switch-patches is $behind commit(s) behind origin/main (latest tag: $tag)"
[ "${1:-}" = "--check" ] && exit 0
if [ "$behind" = 0 ]; then echo "fx-update: nothing to do"; exit 0; fi

if [ -n "$(git -C "$FX_DIR" status --porcelain)" ]; then
  echo "fx-update: fx working tree is dirty — commit or stash first" >&2
  exit 1
fi
git -C "$FX_DIR" checkout -q switch-patches
git -C "$FX_DIR" rebase -q origin/main || {
  echo "fx-update: rebase conflict — resolve in $FX_DIR, then re-run" >&2
  exit 1
}
echo "fx-update: rebased onto $(git -C "$FX_DIR" log --oneline -1 origin/main)"

bash scripts/wasm.sh
sha256sum romfs/fx-term.wasm

echo "fx-update: running host suite…"
bun run term:stream >/dev/null && echo "  PASS term:stream" || { echo "  FAIL term:stream"; exit 1; }
bun run term:workspace >/dev/null && echo "  PASS term:workspace" || { echo "  FAIL term:workspace"; exit 1; }
bun run term:exit >/dev/null && echo "  PASS term:exit" || { echo "  FAIL term:exit"; exit 1; }
bun run term:input >/dev/null && echo "  PASS term:input" || { echo "  FAIL term:input"; exit 1; }
bun run term:model >/dev/null && echo "  PASS term:model" || { echo "  FAIL term:model"; exit 1; }
echo "fx-update: OK — rebuild NRO with: bun run build && bun run nro:fat"
