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

# A dedicated profile makes the browser start its own process instead of
# handing the URL to an already-running browser (which would ignore the flags).
# Kept outside the repo so it is always writable by you. Snap browsers (the Ubuntu
# default) cannot read hidden folders like ~/.local, so they get a folder under
# ~/snap/<name>/common instead.
SNAP_NAME="$(basename "$BROWSER_BIN")"; SNAP_NAME="${SNAP_NAME%-browser}"
if command -v snap >/dev/null 2>&1 && snap list "$SNAP_NAME" >/dev/null 2>&1; then
    PROFILE_DIR="$HOME/snap/$SNAP_NAME/common/all-in-one-emulator"
else
    PROFILE_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/all-in-one-emulator/ui-browser"
fi
if ! mkdir -p "$PROFILE_DIR" 2>/dev/null; then
    PROFILE_DIR="$(mktemp -d)"
    echo "[start-ui] could not create the browser profile dir, using $PROFILE_DIR" >&2
fi
LOG="$PROFILE_DIR/browser.log"
export NO_AT_BRIDGE=1   # silences the harmless GTK "atk-bridge" warning

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
START=$SECONDS
"$BROWSER_BIN" "${FLAGS[@]}" >"$LOG" 2>&1
if [ $((SECONDS - START)) -lt 5 ]; then
    # Exiting this fast means the browser failed or handed off to another process
    # (common with snap browsers). Keep the server up rather than killing the menu.
    echo "[start-ui] the browser exited immediately; see $LOG" >&2
    echo "[start-ui] the menu is still running: open $URL in any browser. Ctrl+C to stop." >&2
    [ -n "$SERVER_PID" ] && wait "$SERVER_PID"
fi
