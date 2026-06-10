#!/usr/bin/env bash
# Capture a focused adb logcat dump for debugging Kaata crashes.
#
# Usage:
#   scripts/capture-crash.sh             # interactive: prompts you to reproduce
#   scripts/capture-crash.sh --auto      # no prompt — runs the capture for 30s
#
# Output:
#   crash.log in the repo root (gitignored). Paste the path to me OR
#   `tail -n 500 crash.log` if it's still big.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$REPO_ROOT/crash.log"

# Filter to just the tags I actually need:
#   AndroidRuntime:E         — fatal Java exceptions
#   ReactNativeJS:V          — JS console output (our [mesh] / [ble] breadcrumbs)
#   ActivityManager:I        — process lifecycle (FGS auto-restart signals)
#   AndroidRuntime:I         — non-fatal RT info
#   KaataGattServer:I        — our GATT module logs
#   *:F *:S                  — suppress everything else (F=fatal native, S=silent default)
FILTER=(AndroidRuntime:E AndroidRuntime:I ReactNativeJS:V ActivityManager:I KaataGattServer:I '*:F' '*:S')

if ! command -v adb >/dev/null 2>&1; then
  echo "adb not found in PATH. Install android-tools-platform-tools or add ANDROID_HOME/platform-tools to PATH." >&2
  exit 1
fi

DEVICES=$(adb devices | awk 'NR>1 && $2=="device" {print $1}' | wc -l)
if [ "$DEVICES" -eq 0 ]; then
  echo "No Android device connected. Plug in via USB + enable USB debugging." >&2
  exit 1
fi

echo "Clearing logcat buffer…"
adb logcat -c

if [ "${1:-}" = "--auto" ]; then
  echo "Capturing for 30s — open the app on your phone NOW."
  timeout 30 adb logcat -v time "${FILTER[@]}" > "$OUT" || true
else
  echo ""
  echo "─────────────────────────────────────────────────"
  echo " 1. Open the app on your phone."
  echo " 2. Wait for it to crash (the 'Send feedback' dialog)."
  echo " 3. Come back here and press ENTER."
  echo "─────────────────────────────────────────────────"
  echo ""
  read -r -p "Press ENTER after the crash happens > " _
  adb logcat -d -v time "${FILTER[@]}" > "$OUT"
fi

SIZE=$(wc -l < "$OUT")
echo ""
echo "Captured $SIZE lines → $OUT"
echo ""
echo "If it's small enough, paste the whole file. Otherwise:"
echo "  tail -n 500 $OUT | xclip -selection clipboard   # X11"
echo "  tail -n 500 $OUT | wl-copy                       # Wayland"
echo "  tail -n 500 $OUT                                 # just print it"
