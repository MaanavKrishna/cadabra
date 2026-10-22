#!/usr/bin/env bash
# Save the PNG image currently on the macOS clipboard to the given path.
set -euo pipefail
out="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
osascript -e "set f to open for access POSIX file \"$out\" with write permission" \
  -e 'set eof f to 0' -e 'write (the clipboard as «class PNGf») to f' -e 'close access f'
echo "$out"
