#!/bin/bash
# Starts the menu server and opens it as an app window (no tabs or address bar).
#
# Usage: ./start-ui.sh                windowed (can be minimized/moved)
#        ./start-ui.sh --fullscreen   fullscreen
# Override the browser with UI_BROWSER=/path/to/browser ./start-ui.sh

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT=3000
URL="http://localhost:$PORT"
FULLSCREEN=0
[ "$1" = "--fullscreen" ] && FULLSCREEN=1

# Start the server unless one is already listening
SERVER_PID=""
if ! curl -fs "$URL/api/games" >/dev/null 2>&1; then
    (cd "$ROOT/ui" && exec node server.js) &
    SERVER_PID=$!
    trap '[ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null' EXIT
    for _ in $(seq 1 50); do
        curl -fs "$URL/api/games" >/dev/null 2>&1 && break
        sleep 0.1
    done
fi

# A dedicated profile makes the browser start its own process instead of
# handing the URL to an already-running browser (which would ignore the flags).
PROFILE_DIR="$ROOT/profiles/ui-browser"
mkdir -p "$PROFILE_DIR"

BROWSER_BIN="${UI_BROWSER:-}"
if [ -z "$BROWSER_BIN" ]; then
    for b in google-chrome chromium chromium-browser firefox; do
        command -v "$b" >/dev/null 2>&1 && { BROWSER_BIN="$b"; break; }
    done
fi
if [ -z "$BROWSER_BIN" ]; then
    echo "No supported browser found. Install chromium or firefox, or open $URL yourself." >&2
    [ -n "$SERVER_PID" ] && wait "$SERVER_PID"
    exit 1
fi

case "$(basename "$BROWSER_BIN")" in
    firefox*)
        FLAGS=(--no-remote --profile "$PROFILE_DIR/firefox")
        mkdir -p "$PROFILE_DIR/firefox"
        # Firefox has no app mode: --kiosk is fullscreen-only, so windowed is a normal window
        if [ "$FULLSCREEN" = 1 ]; then FLAGS+=(--kiosk "$URL"); else FLAGS+=(--new-window "$URL"); fi ;;
    *)
        FLAGS=(--user-data-dir="$PROFILE_DIR/chromium" --app="$URL" --no-first-run --disable-features=Translate)
        [ "$FULLSCREEN" = 1 ] && FLAGS+=(--start-fullscreen) ;;
esac

# Runs until the window is closed, then the trap stops the server
"$BROWSER_BIN" "${FLAGS[@]}"
