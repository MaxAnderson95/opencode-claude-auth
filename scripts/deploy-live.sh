#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
live_root=${OPENCODE_CLAUDE_AUTH_LIVE_DIR:-"$HOME/.config/opencode/plugins/opencode-claude-auth"}
release_root=${OPENCODE_CLAUDE_AUTH_RELEASE_DIR:-"$HOME/.local/share/opencode/plugin-releases/opencode-claude-auth"}
bun_bin=${BUN_BIN:-"$HOME/.bun/bin/bun"}

if [[ "$repo_root" == "$live_root" ]]; then
  printf 'Refusing to build inside the live OpenCode plugin directory: %s\n' "$live_root" >&2
  exit 1
fi

pnpm test
pnpm run lint
pnpm run build

mkdir -p "$release_root" "$live_root"
release_id=$(date -u +%Y%m%dT%H%M%SZ)-$(git -C "$repo_root" rev-parse --short HEAD)
staging=$(mktemp -d "$release_root/.staging.XXXXXX")
next_link="$live_root/.current.$$.next"

cleanup() {
  rm -rf "$staging"
  rm -f "$next_link"
}
trap cleanup EXIT

"$bun_bin" build "$repo_root/src/v2.ts" \
  --target=bun \
  --outfile "$staging/index.js"
test -s "$staging/index.js"

release="$release_root/$release_id"
if [[ -e "$release" ]]; then
  release="$release_root/$release_id-$$"
fi
mv "$staging" "$release"
staging=""

ln -s "$release" "$next_link"
mv -h -f "$next_link" "$live_root/current"

printf 'Activated opencode-claude-auth release: %s\n' "$release"
