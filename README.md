# Setup

Switch to X11
```
sudo sed -i 's/#WaylandEnable=false/WaylandEnable=false/' /etc/gdm3/custom.conf
sudo reboot
```

Install Docker and Node.js
```
sudo apt update
sudo apt install -y curl nodejs npm
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER
newgrp docker
```

Allow local windows (needs `xhost`, from `x11-xserver-utils`; `run-dolphin.sh` runs this for you at every launch)
```
sudo apt install -y x11-xserver-utils
xhost +SI:localuser:$USER
```

# Setup Dolphin

Make run-dolphin.sh executable
```
cd ~/all-in-one-emulator
chmod +x run-dolphin.sh
```

Build dolphin
```
cd ~/all-in-one-emulator/dolphin
docker build -t emu-dolphin:latest .
```

## Configure dolphin
Run the container manually
```
~/all-in-one-emulator/run-dolphin.sh
```
The Dolphin window will open. Plug your Xbox controller into the Ubuntu PC.

Go to Controllers -> Port 1 -> Configure, and map your Xbox controller.

Go to Graphics -> Check Start in Fullscreen.

Go to Options -> Hotkey Settings -> Map Exit to a button combo on your controller (like Select + Start).

Close Dolphin. Your settings are now permanently saved to ~/all-in-one-emulator/profiles/profile_1/home/.config/dolphin-emu.

# Run

```
cd ~/all-in-one-emulator/ui
node server.js
```

# Adding games

Put game files (or `.zip` archives containing them) in `roms/`, then press the **Zip** button
in the menu (or **Y** on the controller). `process-roms.sh` unzips archives and files `.iso`,
`.rvz`, etc. into `roms/wii/` or `roms/gamecube/`. It also runs when the server starts.
