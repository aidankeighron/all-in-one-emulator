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

Allow Local Windows
```
echo "xhost +local:docker > /dev/null" >> ~/.profile
xhost +local:docker
```

# Setup Dolphin

Make run-dolphin.sh executable
```
cd ~/retro-box
chmod +x run-dolphin.sh
```

Build dolphin
```
cd ~/retro-box/dolphin
docker build -t emu-dolphin:latest .
```

## Configure dolphin
Run the container manually
```
~/retro-box/run-dolphin.sh
```
The Dolphin window will open. Plug your Xbox controller into the Ubuntu PC.

Go to Controllers -> Port 1 -> Configure, and map your Xbox controller.

Go to Graphics -> Check Start in Fullscreen.

Go to Options -> Hotkey Settings -> Map Exit to a button combo on your controller (like Select + Start).

Close Dolphin. Your settings are now permanently saved to ~/all-in-one-emulator/profiles/profile_1/dolphin_config.

# Run

```
cd ~/retro-box/ui-router
node server.js
```