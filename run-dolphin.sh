#!/bin/bash
# Usage: ./run-dolphin.sh "/roms/gamecube/Game.iso"   (path as seen inside the container)
#        ./run-dolphin.sh                              (no game: open the Dolphin GUI to configure)

# Always resolve paths from this script's location so it works from any cwd (e.g. the UI server)
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE="$ROOT/profiles/profile_1"

# Create these as your user so Docker doesn't create them as root. The profile's home dir
# holds ~/.config/dolphin-emu (settings), ~/.local/share/dolphin-emu (saves) and ~/.cache.
mkdir -p "$ROOT/roms" "$PROFILE/home"

# -b is batch mode (exit on close), -e executes the game
ARGS=()
[ -n "$1" ] && ARGS=(-b -e "$1")

# Run as the host user so the X11, PulseAudio and /run/user sockets are accessible.
# Group names resolve inside the container, so pass the HOST's numeric GIDs for the
# devices we pass through (GPU: video/render, controllers: input, sound: audio).
GROUPS_ARGS=()
for g in video render input audio; do
  gid="$(getent group "$g" | cut -d: -f3)"
  [ -n "$gid" ] && GROUPS_ARGS+=(--group-add "$gid")
done

# Let this user's processes (the container runs as the same UID) talk to the X server.
# Doing it here means it works every launch, without relying on ~/.profile having run.
xhost +SI:localuser:"$(id -un)" >/dev/null 2>&1 || echo "[run-dolphin] warning: xhost failed (DISPLAY=$DISPLAY)" >&2

docker run --rm \
  --name dolphin_instance \
  --ipc=host \
  --security-opt seccomp=unconfined \
  --user "$(id -u):$(id -g)" \
  "${GROUPS_ARGS[@]}" \
  -e HOME=/home/dolphin \
  -e DISPLAY="$DISPLAY" \
  -e XDG_RUNTIME_DIR="/run/user/$(id -u)" \
  -e PULSE_SERVER="unix:/run/user/$(id -u)/pulse/native" \
  --device /dev/dri:/dev/dri \
  --device /dev/input:/dev/input \
  -v /tmp/.X11-unix:/tmp/.X11-unix:rw \
  -v "/run/user/$(id -u):/run/user/$(id -u):rw" \
  -v /run/udev/data:/run/udev/data:ro \
  -v "$ROOT/roms:/roms:ro" \
  -v "$PROFILE/home:/home/dolphin:rw" \
  emu-dolphin:latest "${ARGS[@]}"
