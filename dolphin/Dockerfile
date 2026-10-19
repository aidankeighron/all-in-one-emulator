FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Install Mesa/Vulkan drivers, SDL2 for Xbox controllers, and the Dolphin PPA
RUN apt-get update && apt-get install -y \
    software-properties-common \
    libvulkan1 mesa-vulkan-drivers vulkan-tools \
    libsdl2-2.0-0 libpulse0 libpipewire-0.3-0 \
    qt6-qpa-plugins qt6-wayland \
    udev dbus-x11 && \
    add-apt-repository -y ppa:ubuntuhandbook1/dolphin-emu && \
    apt-get update && apt-get install -y dolphin-emu && \
    rm -rf /var/lib/apt/lists/*

# Ubuntu installs games to /usr/games, which is not on Docker's default PATH
ENTRYPOINT ["/usr/games/dolphin-emu"]