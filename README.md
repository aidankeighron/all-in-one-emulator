# Emulator Menu

A Wii-style menu that launches your games in Dolphin (Wii/GameCube), PCSX2 (PS2), DuckStation (PS1),
RPCS3 (PS3), PPSSPP (PSP) and Ryujinx (Switch). Emulators are installed from inside the menu as Flatpaks, so there is
no Docker and no per-emulator setup. Drop games (or `.zip` files) into your ROMs folder and play.

# Setup (Ubuntu)

Install Flatpak, which the menu uses to install and run the emulators:
```
sudo apt install flatpak
```

## Run from source
```
sudo apt install nodejs npm      # Node 18 or newer
cd ~/all-in-one-emulator
git pull
npm install
npm start                        # windowed
npm start -- --fullscreen        # fullscreen (F11 toggles either way)
```

## Or build a single file to share
```
npm run dist
```
This writes `dist/Emulator Menu-<version>.AppImage`. Send that file to people. They run:
```
sudo apt install flatpak libfuse2t64     # one time
chmod +x "Emulator Menu"*.AppImage
./"Emulator Menu"*.AppImage              # add --fullscreen for fullscreen
```
Nothing else to install: the AppImage already contains the menu and its runtime.

# Using it

1. Click the gear (or press **X** on the controller) to open Settings.
2. Click **Install** next to the emulators you want. They download from Flathub in the background.
   Once installed, **Open** starts the emulator itself so you can map controllers, add BIOS files and
   change settings. Close it to return to the menu.
3. Put your games in the ROMs folder, in a subfolder named after the system:

   | Folder | Emulator | File types |
   |---|---|---|
   | `wii`, `gamecube` | Dolphin | iso, rvz, wbfs, gcm, ciso, gcz, wia, wad |
   | `ps2` | PCSX2 | iso, chd, cso |
   | `ps1` | DuckStation | cue (+ bin), chd, pbp, m3u, iso |
   | `ps3` | RPCS3 | iso, or a game folder containing `PS3_GAME` |
   | `psp` | PPSSPP | iso, cso, pbp |
   | `switch` | Ryujinx (Ryubing) | nsp, xci, nca, nro, nso |

4. Click a game (or press **A**) to play. Closing the emulator brings you back to the menu.

**ROMs folder.** From a source checkout this is `roms/` inside the project (same layout as before, so
your existing `roms/wii` and `roms/gamecube` work as they are). The AppImage uses `~/ROMs`. Change it
any time in Settings, or set the `ROMS_DIR` environment variable.

**Zip files.** Drop `.zip` files anywhere in the ROMs folder, then press the **Zip** button (or **Y**).
They are also processed whenever the menu starts. Games are unzipped into the right system folder
and the zip is deleted (set `KEEP_ZIPS=1` to keep it). A zip placed inside a system folder (for
example `roms/ps2/game.zip`) goes into that folder. Wii/GameCube images are told apart automatically;
for other systems, put the zip in the system folder so the menu knows where it belongs. Zips that
are broken, still copying, or really 7z/RAR files are left alone with a message explaining why.

**Controller.** Move with the d-pad or left stick, **A** launches, **LB/RB** change page, **X**
opens Settings, **Y** imports zips, **B** closes Settings. Inside Settings, the d-pad or stick moves between buttons and **A** presses
the highlighted one. While a game runs, the menu ignores the
controller and (in fullscreen) steps out of the way. The keyboard works too: arrow keys, **Enter** to
launch, **PageUp/PageDown** for pages, **S** for Settings, **Esc** to close it.

If the controller does nothing, open Settings: the **Controller** section lists every pad the
window can see and which buttons it reads as pressed. If it says none are detected, press a button
with the window focused (browsers only expose a controller after its first button press).

## Controller setup per emulator

Each emulator keeps its own settings, so map your controller once in each one (for Dolphin:
Controllers -> Port 1 -> Configure). To reuse a Dolphin setup from the old Docker version:
```
mkdir -p ~/.var/app/org.DolphinEmu.dolphin-emu/config
cp -r ~/all-in-one-emulator/profiles/profile_1/home/.config/dolphin-emu ~/.var/app/org.DolphinEmu.dolphin-emu/config/
```
(after installing Dolphin from the menu).

## BIOS and firmware

PS1 (DuckStation), PS2 (PCSX2), PS3 (RPCS3) and Switch (Ryujinx, which needs `prod.keys` plus a
firmware install) need BIOS, key or firmware files that cannot be redistributed. Each person installs their own through the emulator's own settings.

# Adding another emulator

Add an entry to `emulators.json`: its Flathub ID, the folders it handles, file extensions and
launch arguments (`{rom}` is replaced with the game's path). The menu picks it up on the next start.
If an install fails, check the Flatpak ID there against [flathub.org](https://flathub.org).

# Development

```
npm test           # importer and game-list tests
npm run server     # menu server only, then open http://localhost:3000 in any browser
```

Notes:
- The window runs without Chromium's sandbox (`--no-sandbox`), because Ubuntu 24.04 blocks it for
  apps like this and Electron exits with a "SUID sandbox helper" error otherwise. `npm start` and the
  AppImage pass the flag for you; if you run `electron .` yourself, add `--no-sandbox`. The window only
  ever loads the menu server on `127.0.0.1`.
- Xbox 360 (Xenia) has no Linux build, so it isn't included.
- Switch uses the Ryubing fork of Ryujinx from Flathub (a community package; the original Ryujinx and
  Yuzu were discontinued). Other forks such as Eden ship as AppImages rather than Flatpaks, so they
  would need a different install method than this menu has today.
