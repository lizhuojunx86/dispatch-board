#!/bin/sh
# Prints what the mod hooks, calls, reads and writes, as `claude plugin
# validate` reports it. docs/surface.txt keeps that list in the repository,
# so a new engine call or environment read shows up in a diff.
#
#   scripts/surface.sh           compare with docs/surface.txt (exit 1 on a difference)
#   scripts/surface.sh --write   rewrite docs/surface.txt
set -eu
cd "$(dirname "$0")/.."
current=$(claude plugin validate . 2>/dev/null |
  sed -n 's/^  ❯ \(\.\/register\.tsx .*\)$/\1/p' |
  sed -e 's/ (via [^)]*)//g')
if [ -z "$current" ]; then
  echo "surface: claude plugin validate reported nothing" >&2
  exit 2
fi
if [ "${1:-}" = "--write" ]; then
  printf '%s\n' "$current" > docs/surface.txt
  echo "surface: wrote docs/surface.txt"
elif printf '%s\n' "$current" | diff -u docs/surface.txt - ; then
  echo "surface: unchanged"
else
  echo "surface: differs from docs/surface.txt (run scripts/surface.sh --write and commit the change)" >&2
  exit 1
fi
