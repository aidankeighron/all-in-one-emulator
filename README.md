# Emulator Menu

A Wii-style menu that launches your games in Dolphin (Wii/GameCube) and Ryujinx (Switch). Emulators are installed from inside the menu as Flatpaks, so there is
no Docker and no per-emulator setup. Drop games (or `.zip`, `.rar` or `.7z` files) into your ROMs folder and play.

# Windows

The menu runs on Windows too. The differences from Linux:

- **Emulators are not installed by the menu.** Download them yourself (Settings -> Games has a **Download** button
  for each) and either unzip each one into its own folder inside the emulators folder (the **Open folder** button
  there opens it), or press **Locate** and choose the emulator's program (`Dolphin.exe`, `Ryujinx.exe`). The menu also
  looks in the usual places such as `C:\Dolphin-x64`.
- **Save slots and cloud saves work the same.** They use the emulator's data in `%APPDATA%` (or the folder beside a
  portable copy). Open each emulator once first so it creates its folders. Cloud saves need
  [Git for Windows](https://git-scm.com/download/win), signed in so that `git push` works.
- **Controllers:** the menu sees what the window sees, so press a button on a controller with the menu focused.
  Xbox controllers are set up through XInput and others through SDL. Dolphin handles a real Wii Remote or an
  official GameCube adapter itself (the adapter needs its driver set up in Dolphin first).
- **Back + Start to quit a game is Linux only.** On Windows use the emulator's own Stop or Exit.
- **Game library:** a Windows computer can browse and download games from the Linux host the same way. Hosting from
  Windows also works, but Windows Firewall will ask to allow it.
- Build a Windows app on a Windows machine with `npm run dist:win` (a single portable `.exe` in `dist/`). Building it
  on Linux needs Wine.

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
   | `switch` | Ryujinx (Ryubing) | nsp, xci, nca, nro, nso |

4. Click a game (or press **A**) to play. Closing the emulator brings you back to the menu.

   **Back to the menu from inside a game:** hold **Back + Start** for about 1.5 seconds. This works in every emulator, no mapping needed, but it ends
   the game like closing the emulator, so save first. The menu reads the controller through
   `/dev/input/js*`; if that isn't readable on your system, the combo does nothing, and you can still
   quit with each emulator's own Stop/Exit (Dolphin's Stop, for example, also returns to the menu).
   Set `EMU_NO_HOTKEY=1` to turn the combo off. The Wii's own **Home -> Wii Menu** can't be hooked:
   Dolphin runs it as the Wii's real software, so it opens the emulated Wii System Menu, not this one.

**ROMs folder.** From a source checkout this is `roms/` inside the project (same layout as before, so
your existing `roms/wii` and `roms/gamecube` work as they are). The AppImage uses `~/ROMs`. Change it
any time in Settings, or set the `ROMS_DIR` environment variable.

**Archives.** Drop `.zip`, `.rar` or `.7z` files anywhere in the ROMs folder, then press the import button (the box icon, or **Y**).
They are also processed whenever the menu starts. Games are unzipped into the right system folder
and the archive is deleted (set `KEEP_ZIPS=1` to keep it). A zip placed inside a system folder (for
example `roms/switch/game.zip`) goes into that folder. Wii/GameCube images are told apart automatically;
for other systems, put the zip in the system folder so the menu knows where it belongs. Zips that
are broken or still copying are left alone with a message explaining why. Zip and RAR need nothing installed;
`.7z` needs 7-Zip (`p7zip-full` on Linux).

**Controller.** Move with the d-pad or left stick, **A** selects, **LB/RB** change page, **X**
opens Settings, **Y** imports zips, **B** closes Settings. Press **down** from the last row of games to
reach the bottom buttons (refresh, import zips, settings) and **left/right** at the edge of the grid to
reach the page arrows. Inside Settings, the d-pad or stick moves between buttons and **A** presses
the highlighted one. While a game runs, the menu ignores the controller and (in fullscreen) steps out
of the way. The keyboard works too: arrow keys, **Enter** to select, **PageUp/PageDown** for pages,
**S** for Settings, **Esc** to close it.

Only the controller you are actually using steers the menu (the one whose buttons or sticks moved
last), and a stick that rests off-centre is learned as its centre after a second, so a drifting stick or
a second device can't take over the menu.

**Controllers page.** One page to the left of the first games page (**LB** from the games, or the left
arrow) shows every controller the system can see, which player it is, whether it is USB or Bluetooth,
and where it will play (GameCube port, Wii Remote slot).

If the controller does nothing in the menu, check the Controllers page: it lists what the system can see. If
it is empty, press a button on the controller with the window focused (browsers only expose a controller
after its first button press).

**Settings.** Three sections, switched with the tabs or **LB / RB**: **Games** (ROMs folder, emulators),
**Sound & controls** (menu sound, automatic controller setup) and **Game library** (sharing games between
computers, with a **How does this work?** walkthrough).

**Artwork.** Each game tile shows a picture when one can be found, and the game's name otherwise:

| System | Where the picture comes from |
|---|---|
| Wii, GameCube | The game ID in the disc header (`.iso`, `.gcm`, `.wbfs`, `.rvz`, `.wia`), then the cover from [GameTDB](https://www.gametdb.com), the same source Dolphin's own cover view uses |
| Anything else | A picture you put next to the game with the same name: `Game.iso` + `Game.png` (`.jpg` and `.webp` work too). This also overrides the automatic picture. |

Downloaded pictures are cached in `~/.config/all-in-one-emulator/artwork`, so each is fetched once and
games work offline afterwards. Compressed `.ciso`/`.gcz` Dolphin images and Switch games have no automatic source; use the
same-name picture for those.

**Sound.** The menu has sound effects (moving, selecting, paging, opening Settings, starting a game,
errors) and background music that pauses while a game runs. Out of the box it plays small built-in
synthesised sounds and a quiet ambient loop. To use your own, put audio files (wav, mp3, ogg, m4a, flac)
in `~/.config/all-in-one-emulator/sounds` (the menu creates the folder with a `README.txt` the first
time it runs):

| File | Plays when |
|---|---|
| `boot`, `move`, `select`, `back`, `page`, `open`, `close`, `launch`, `error`, `toggle` | the menu starts, the selection moves, a button is pressed, you go back, change page, open or close Settings, start a game, hit an error, flip an option |
| `music/` folder | any number of tracks, played in name order on repeat |

A file named after an event replaces just that sound. Reopen Settings after adding files. Turn sound
off or change the effects and music volume in Settings -> Sound. No sound files are bundled: use
recordings you have the right to use. Set `SOUNDS_DIR` to keep the pack somewhere else.

## Save slots and cloud saves

Clicking a game opens a sheet from the bottom of the screen: **Which save do you want to play with?**
Each save is a named slot with its own save data, showing when it was last updated and on which computer.
Pick one, or choose **New save** and name it on the on-screen keyboard. On the sheet: **A** plays,
**X** renames, **Y** deletes, **Start** shows older versions, **B** closes. If the emulator already had a save on
this computer from before slots existed, **Use my old save** copies it into a new slot (the original is left alone).

Uploading needs git to be signed in to GitHub, even for a public repository (reading never does). The menu tries, in
order: whatever git already has (credential helper, SSH key), a token (`cloudToken` in `config.json`, a `cloud-token.txt` file beside the program, the
`GITHUB_TOKEN` / `GH_TOKEN` variable, or the GitHub CLI after `gh auth login`), then the SSH form of the address.
A save that could not be uploaded stays on this computer and is sent the next time the menu starts or refreshes.

How it syncs (only these three moments, nothing in the background):

| When | What happens |
|---|---|
| The menu starts | Checks the cloud, uploads anything that was waiting, and downloads newer versions of saves already on this computer |
| You click a game | Checks again, shows the slots, and downloads a newer cloud save before the emulator starts |
| The game closes | The slot you played is uploaded (queued for later if you are offline) |

If the same save changed on two computers, a sheet asks: **use the cloud save**, **keep this computer's**, or
**keep both**. The other one is never lost: the local copy is zipped to `~/.config/all-in-one-emulator/saves/backups`
first, and every upload is a new version you can restore from the **Start** history.

**How slots work.** Each slot gets its own data root that links back to the emulator's real folder for settings,
firmware, keys and caches, except the folders holding game saves. The emulator is started pointed at that root
(Ryujinx `-r`, Dolphin `-u`), so slots are isolated without locating or parsing any game's save files. Dolphin slots
cover GameCube memory cards and Wii game saves; Ryujinx slots cover the Switch save folders. Open each emulator
once from Settings before using slots (Ryujinx needs its folders to exist).

**Where saves go.** To the `saves` branch of this project's repository (the one the menu was cloned from), as
plain files. There are no settings for it. The menu uses your normal `git` login, so `git push` must already work
from this computer. History only grows; very old versions can be removed by squashing that branch.

**Privacy.** A save upload contains only the slot's save folders: never games, keys, firmware or emulator
settings. If the repository is public, anyone can read what is pushed to it: game progress, the save names you
type, this computer's name, and timestamps. Commits carry a generic author, not your identity. Cloning the
project also downloads its `saves` branch unless you clone with `--single-branch`.

## Game library: share games between your computers

One computer can share its games, and another can browse and download them from inside the menu.

Settings -> **Game library** has a **How does this work?** button that walks through every step. In short:

**On the computer that has the games:** turn on **Share this computer's games**.
It shows an address (like `192.168.1.20:8765`) and an access key. Nothing is shared without the key.

**On the other computer:** enter that address and key under **Get games from another computer**, then **Save**. The menu downloads the host's game list (generated fresh by the host every time, so it is
always current). Games you already have are normal tiles. Games you don't have show a download icon and the size;
click one, press **Download**, and it downloads into the right folder in your ROMs folder. You can keep browsing
while it downloads, cancel it, and start it again later to continue where it stopped. If the host is off, the
last list you saw stays visible.

Only files the menu itself lists as games can be downloaded, never anything else on the host. The connection is
plain HTTP with a key: use it on your home network or over a private network such as [Tailscale](https://tailscale.com)
for different places, and don't forward the port to the internet. If the host has a firewall, allow the port
(`sudo ufw allow from 192.168.0.0/16 to any port 8765`, or `sudo ufw allow in on tailscale0 to any port 8765`).
Games are copyrighted: share only copies you made from games you own, between your own computers.

## Controller setup per emulator

The menu detects the controllers plugged in (Xbox, Switch Pro/Joy-Con, GameCube via the official
adapter, Wii Remote, other gamepads) and, right before a game starts, writes them into that
emulator's settings. Plug a controller in, start a game, and it works. Turn this off with the toggle in
Settings -> Sound & controls.

| Emulator | What is set up |
|---|---|
| Dolphin | GameCube ports 1-4 and Wii Remotes 1-4. A gamepad becomes both a GameCube controller and an emulated Wii Remote with Nunchuk (right stick points, left stick is the Nunchuk stick). A connected Wii Remote is set to *Real Wiimote*. With an official GameCube adapter, ports without a gamepad use the adapter. |
| Ryujinx | Linux: each player's controller is written into Ryujinx's `Config.json` (`input_config`) by its SDL id, keeping your own button layout for that player. Open Ryujinx once first. Windows: set up once with **Open** in Settings. |

Players are numbered in the order the system registered the controllers. Existing settings in the files
are kept; only the controller entries are replaced, and the first time a file is changed the original is
copied next to it as `<file>.emulator-menu.bak`. Nothing is written when no suitable controller is
connected, so keyboard setups are left alone.

## Players and mappings

On the Controllers page, **Players and mappings** sets up everything for Dolphin from inside the menu.

- **Players:** four players, each with a **controller** (automatic, a particular connected controller, a real
  Wii Remote, or not playing), a **Wii mapping** and a **GameCube mapping**. Choices are remembered by controller
  name, so a pad keeps its player when you unplug it and plug it in again. Changes are written to Dolphin
  immediately (**Sync now** repeats it) and again every time a game starts, so: quit a game, change who has which
  controller here, start another game, and it is picked up.
- **Mappings:** each mapping is a small JSON file in `~/.config/all-in-one-emulator/mappings/` (`%APPDATA%` on
  Windows). **Edit mappings** lists the built-in ones (Wii Remote + Nunchuk, Wii Remote only, sideways, wheel,
  gyro pointer for Switch pads, Classic Controller, two GameCube layouts). Built-ins are read-only: press
  **Duplicate to edit**, then change any control with its dropdown, set the extension (Nunchuk, Classic
  Controller, nothing) and whether the remote is held sideways, and **Save**. Players pick mappings from their own
  dropdowns, so an Xbox pad can use one mapping with a Nunchuk and another without.
- With a gamepad: up/down/left/right move, **A** steps a dropdown forward, **X** steps it back, **B** closes.
- The control and input names were checked against Dolphin's source code. Not verified on a real Dolphin install.
- Not covered: Ryujinx (see above), and a mapping cannot yet be shared between computers.

## Connecting Wii Remotes and Switch controllers

Everything is done from the menu: on the Controllers page (LB from the first page, or click the controller
chip at the top right) choose **Connect a controller**.

- **Linux:** if Bluetooth is not installed or switched off, the menu offers to install and start it (it uses
  `pkexec`, so you get one password prompt; `apt`, `dnf`, `pacman` and `zypper` are supported). Then:
  - **Switch Pro Controller / Joy-Con:** hold the sync button; the menu finds the controller, pairs, trusts
    and connects it. It then works like any gamepad. Needs Linux 5.16 or newer (the menu checks).
  - **Wii Remote:** press 1 + 2; the menu checks it is in range, then **Use as Wii Remote N** tells Dolphin to
    use that many real remotes. The menu deliberately does not pair Wii Remotes with the computer: Dolphin
    connects to them itself, and cannot once the system has taken them. It also gives Dolphin's Flatpak
    Bluetooth access. Press 1 + 2 again when a game starts.
- **Windows:** Windows owns pairing, so the menu opens its Bluetooth page and lists the steps; the Wii Remote
  count works the same way.
- Not done through the menu: Ryujinx's own controller mapping (see the table above). Joy-Cons are paired one
  at a time and appear as two controllers.
- This was tested against a stand-in for `bluetoothctl`, not real Wii Remotes or Switch controllers.

Things to know:
- A real Wii Remote is connected by Dolphin itself (hold 1+2); the menu only tells Dolphin to use it.
- The official GameCube adapter needs the udev rule from Dolphin's documentation so the Flatpak may use it.
  Adapter controllers play on the port they are plugged into.
- Third-party GameCube adapters in "PC" mode look like ordinary gamepads and are not assigned to GameCube ports.
- The Dolphin control names are written from its documented format and have not been checked against
  every version. If a button is wrong, fix it once in the emulator; the menu
  rewrites the controller entries each launch, so turn automatic setup off if you want to keep manual changes.

To reuse a Dolphin setup from the old Docker version instead (turn automatic setup off first):
```
mkdir -p ~/.var/app/org.DolphinEmu.dolphin-emu/config
cp -r ~/all-in-one-emulator/profiles/profile_1/home/.config/dolphin-emu ~/.var/app/org.DolphinEmu.dolphin-emu/config/
```

## BIOS and firmware

Switch (Ryujinx, which needs `prod.keys` plus a
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
