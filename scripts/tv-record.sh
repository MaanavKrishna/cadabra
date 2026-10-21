#!/usr/bin/env bash
# Usage: scripts/tv-record.sh [ip] [out.mp4]   (10 s screenrecord of the Fire TV)
set -euo pipefail
IP="${1:-192.168.68.109}"
OUT="${2:-video/tv-$(date +%Y%m%d-%H%M%S).mp4}"
mkdir -p "$(dirname "$OUT")"
adb connect "$IP:5555" >/dev/null
adb -s "$IP:5555" shell screenrecord --time-limit 10 /sdcard/c.mp4
adb -s "$IP:5555" pull /sdcard/c.mp4 "$OUT"
adb -s "$IP:5555" shell rm /sdcard/c.mp4
echo "$OUT"
