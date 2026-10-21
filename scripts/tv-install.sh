#!/usr/bin/env bash
# Usage: scripts/tv-install.sh <fire-tv-ip>
set -euo pipefail
IP="${1:?usage: tv-install.sh <ip>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17}"
export PATH="$JAVA_HOME/bin:$PATH"

npm --prefix "$ROOT" run build --workspace @cadabra/tv
WWW="$ROOT/apps/android/app/src/main/assets/www"
rm -rf "$WWW" && mkdir -p "$WWW"
cp -R "$ROOT/apps/tv/dist/." "$WWW/"

(cd "$ROOT/apps/android" && ./gradlew --no-daemon assembleDebug)

adb connect "$IP:5555"
adb -s "$IP:5555" install -r "$ROOT/apps/android/app/build/outputs/apk/debug/app-debug.apk"
adb -s "$IP:5555" shell am start -n com.maanavkrishna.cadabra/.MainActivity
