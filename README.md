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

1. Click the gear at the bottom right (or press **X** on the controller) to open Settings.
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

   **Back to the menu from inside a game:** hold **Back + Start** (**Share + Options** on PlayStation
   controllers) for about 1.5 seconds. This works in every emulator, no mapping needed, but it ends
   the game like closing the emulator, so save first. The menu reads the controller through
   `/dev/input/js*`; if that isn't readable on your system, the combo does nothing, and you can still
   quit with each emulator's own Stop/Exit (Dolphin's Stop, for example, also returns to the menu).
   Set `EMU_NO_HOTKEY=1` to turn the combo off. The Wii's own **Home -> Wii Menu** can't be hooked:
   Dolphin runs it as the Wii's real software, so it opens the emulated Wii System Menu, not this one.

**ROMs folder.** From a source checkout this is `roms/` inside the project (same layout as before, so
your existing `roms/wii` and `roms/gamecube` work as they are). The AppImage uses `~/ROMs`. Change it
any time in Settings, or set the `ROMS_DIR` environment variable.

**Zip files.** Drop `.zip` files anywhere in the ROMs folder, then press the import button (the box icon, or **Y**).
They are also processed whenever the menu starts. Games are unzipped into the right system folder
and the zip is deleted (set `KEEP_ZIPS=1` to keep it). A zip placed inside a system folder (for
example `roms/ps2/game.zip`) goes into that folder. Wii/GameCube images are told apart automatically;
for other systems, put the zip in the system folder so the menu knows where it belongs. Zips that
are broken, still copying, or really 7z/RAR files are left alone with a message explaining why.

**Controller.** Move with the d-pad or left stick, **A** selects, **LB/RB** change page, **X**
opens Settings, **Y** imports zips, **B** closes Settings. Press **down** from the last row of games to
reach the bottom buttons (refresh, import zips, settings) and **left/right** at the edge of the grid to
reach the page arrows. Inside Settings, the d-pad or stick moves between buttons and **A** presses
the highlighted one. While a game runs, the menu ignores the controller and (in fullscreen) steps out
of the way. The keyboard works too: arrow keys, **Enter** to select, **PageUp/PageDown** for pages,
**S** for Settings, **Esc** to close it.

**Controllers page.** One page to the left of the first games page (**LB** from the games, or the left
arrow) shows every controller the system can see, which player it is, whether it is USB or Bluetooth,
and where it will play (GameCube port, Wii Remote slot, PS1/PS2 pad).

If the controller does nothing in the menu, open Settings: the **Controllers** section lists every pad the
window can see and which buttons it reads as pressed. If it says none are detected, press a button
with the window focused (browsers only expose a controller after its first button press).

**Artwork.** Each game tile shows a picture when one can be found, and the game's name otherwise:

| System | Where the picture comes from |
|---|---|
| Wii, GameCube | The game ID in the disc header (`.iso`, `.gcm`, `.wbfs`, `.rvz`, `.wia`), then the cover from [GameTDB](https://www.gametdb.com), the same source Dolphin's own cover view uses |
| PS2 | The serial in `SYSTEM.CNF` on a `.iso`, then the cover from GameTDB |
| PSP | `ICON0.PNG` stored inside the `.iso` or `EBOOT.PBP` (nothing is downloaded) |
| PS3 | `PS3_GAME/ICON0.PNG` in a game folder or `.iso` |
| Anything else | A picture you put next to the game with the same name: `Game.iso` + `Game.png` (`.jpg` and `.webp` work too). This also overrides the automatic picture. |

Downloaded pictures are cached in `~/.config/all-in-one-emulator/artwork`, so each is fetched once and
games work offline afterwards. Compressed `.ciso`/`.gcz` Dolphin images, `.chd`/`.cso` discs, PS1 and
Switch games have no automatic source; use the same-name picture for those.

## Controller setup per emulator

The menu detects the controllers plugged in (Xbox, Switch Pro/Joy-Con, GameCube via the official
adapter, Wii Remote, PlayStation, other gamepads) and, right before a game starts, writes them into that
emulator's settings. Plug a controller in, start a game, and it works. Turn this off with the toggle in
Settings -> Controllers; **Apply now** does it for every installed emulator without starting a game.

| Emulator | What is set up |
|---|---|
| Dolphin | GameCube ports 1-4 and Wii Remotes 1-4. A gamepad becomes both a GameCube controller and an emulated Wii Remote with Nunchuk (right stick points, left stick is the Nunchuk stick). A connected Wii Remote is set to *Real Wiimote*. With an official GameCube adapter, ports without a gamepad use the adapter. |
| PCSX2 | Pad 1 and 2 (DualShock 2) |
| DuckStation | Pad 1 and 2 (analog controller) |
| PPSSPP | Nothing needed: it maps connected gamepads by itself |
| RPCS3, Ryujinx | Not automatic: their controller settings depend on per-device IDs. Set them up once with **Open** in Settings. |

Players are numbered in the order the system registered the controllers. Existing settings in the files
are kept; only the controller entries are replaced, and the first time a file is changed the original is
copied next to it as `<file>.emulator-menu.bak`. PCSX2 and DuckStation must have been opened once so
their settings files exist (use **Open** in Settings). Nothing is written when no suitable controller is
connected, so keyboard setups are left alone.

Things to know:
- A real Wii Remote is paired by Dolphin itself (hold 1+2); the menu only tells Dolphin to use it. Dolphin
  needs Bluetooth access, which the Flatpak has by default.
- The official GameCube adapter needs the udev rule from Dolphin's documentation so the Flatpak may use it.
  Adapter controllers play on the port they are plugged into.
- Third-party GameCube adapters in "PC" mode look like ordinary gamepads and are not assigned to GameCube ports.
- The Dolphin, PCSX2 and DuckStation control names are written from those emulators' documented formats and
  have not been checked against every version. If a button is wrong, fix it once in the emulator; the menu
  rewrites the controller entries each launch, so turn automatic setup off if you want to keep manual changes.

To reuse a Dolphin setup from the old Docker version instead (turn automatic setup off first):
```
mkdir -p ~/.var/app/org.DolphinEmu.dolphin-emu/config
cp -r ~/all-in-one-emulator/profiles/profile_1/home/.config/dolphin-emu ~/.var/app/org.DolphinEmu.dolphin-emu/config/
```

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
