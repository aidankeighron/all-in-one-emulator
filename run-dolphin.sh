#!/bin/bash
# Usage: ./run-dolphin.sh "/roms/gamecube/Game.iso"   (path as seen inside the container)
#        ./run-dolphin.sh                              (no game: open the Dolphin GUI to configure)

# Always resolve paths from this script's location so it works from any cwd (e.g. the UI server)
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE="$ROOT/profiles/profile_1"
mkdir -p "$ROOT/roms" "$PROFILE/config" "$PROFILE/dolphin"

# -b is batch mode (exit on close), -e executes the game
ARGS=()
[ -n "$1" ] && ARGS=(-b -e "$1")

docker run --rm \
  --name dolphin_instance \
  --ipc=host \
  --security-opt seccomp=unconfined \
  -e DISPLAY="$DISPLAY" \
  -e XDG_RUNTIME_DIR="/run/user/$(id -u)" \
  -e PULSE_SERVER="unix:/run/user/$(id -u)/pulse/native" \
  --device /dev/dri:/dev/dri \
  --device /dev/input:/dev/input \
  -v /tmp/.X11-unix:/tmp/.X11-unix:rw \
  -v "/run/user/$(id -u):/run/user/$(id -u):rw" \
  -v /run/udev/data:/run/udev/data:ro \
  -v "$ROOT/roms:/roms:ro" \
  -v "$PROFILE/config:/root/.config/dolphin-emu:rw" \
  -v "$PROFILE/dolphin:/root/.local/share/dolphin-emu:rw" \
  emu-dolphin:latest "${ARGS[@]}"
