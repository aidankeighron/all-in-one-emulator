#!/bin/bash
# Usage: ./run-dolphin.sh "/roms/gamecube/Game.iso"

GAME_PATH="$1"
ARGS="-b -e $GAME_PATH" # -b is batch mode (exit on close), -e executes the game

docker run --rm \
  --name dolphin_instance \
  --ipc=host \
  --security-opt seccomp=unconfined \
  -e DISPLAY=$DISPLAY \
  -e XDG_RUNTIME_DIR=/run/user/$(id -u) \
  -e PULSE_SERVER=unix:/run/user/$(id -u)/pulse/native \
  --device /dev/dri:/dev/dri \
  --device /dev/input:/dev/input \
  -v /tmp/.X11-unix:/tmp/.X11-unix:rw \
  -v /run/user/$(id -u):/run/user/$(id -u):rw \
  -v /run/udev/data:/run/udev/data:ro \
  -v $(pwd)/roms:/roms:ro \
  -v $(pwd)/profiles/profile_1/dolphin:/root/.local/share/dolphin-emu:rw \
  emu-dolphin:latest $ARGS