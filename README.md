# Emulator Menu

A Wii-style menu that launches your games in Dolphin (Wii/GameCube) and Ryujinx (Switch). Emulators are installed from inside the menu as Flatpaks, so there is
no Docker and no per-emulator setup. Drop games (or `.zip`, `.rar` or `.7z` files) into your ROMs folder and play.

# Windows

The menu runs on Windows too. The differences from Linux:

- **Emulators:** press **Install** next to Ryujinx in Settings -> Games. The menu finds the newest Windows release,
  downloads the zip and unpacks it into the emulators folder (`%APPDATA%\all-in-one-emulator\emulators\ryujinx`),
  where it is found automatically; **Remove** deletes that copy again. Sources are listed in `emulators.json`
  (`windows.release`) and tried in order, because a project's download server can be down: Ryujinx's releases API
  on its own Forgejo (`git.ryujinx.app`), then its update server. If both fail, the progress line says why for
  each. Then either download the zip yourself and unzip it into its own folder inside the emulators folder (**Open
  folder** opens it), press **Locate** and choose the program (`Dolphin.exe`, `Ryujinx.exe`), or put a direct zip (or the path of a zip you downloaded, like `C:\Users\you\Downloads\ryujinx-win_x64.zip`)
  address in `config.json` and press **Install** again:
  `{ "emulatorUrls": { "ryujinx": "https://example.com/ryujinx-win_x64.zip" } }`.
  Dolphin has no release feed the menu can read, so it keeps a **Download** button to its website, then
  unzip it or use **Locate**. The menu also looks in the usual places such as `C:\Dolphin-x64`. The source addresses
  have not been verified against the live servers: if **Install** says it could not reach them, use the manual routes
  above, and correct `windows.release` in `emulators.json` once the project's real download address is known.
- **Save slots and cloud saves work the same.** They use the emulator's data in `%APPDATA%` (or the folder beside a
  portable copy). Open each emulator once first so it creates its folders. Cloud saves need
  [Git for Windows](https://git-scm.com/download/win), signed in so that `git push` works.
- **Controllers:** the menu sees what the window sees, so press a button on a controller with the menu focused.
  Xbox controllers are set up through XInput and others through SDL. Dolphin handles a real Wii Remote or an
  official GameCube adapter itself (the adapter needs its driver set up in Dolphin first).
- **The Back + Start pause menu is Linux only.** On Windows use the emulator's own Stop or Exit.
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

4. Click a game (or press **A**) to play. To favorite a game press **X** or **Y** on it (or **F**, or click the star on its tile; only games you have can be starred):
   games you have are listed first (favorites at the top), and games that are only on your other computer start on their own page. Favorites are listed first and keep their star between runs. Closing the emulator brings you back to the menu.

   **Pause menu:** hold **Back + Start** (1.5 seconds by default; Settings -> Sound & controls has a slider from 0 to 2
   seconds in half-second steps, 0 opens it at once). The game is frozen (its processes are stopped, so
   sound and input stand still) and the menu comes to the front with **Quit to menu** (left) and **Reset** (right) as long, thin Wii-style buttons over the game, and at the bottom
   the connected controllers (picture, name, how it is connected, its player lights, and it lights up when you press
   something on it) with **Change controllers** and **Connect controllers** on the right. There is no Resume button:
   **B** closes the menu. Quit and Reset ask for a second **A** press, since they end the game. D-pad moves, A chooses. Holding the buttons again also closes it. Emulators read their controller settings only when a game starts, so after changing controllers the
   screen suggests **Reset**: it ends the game (the save is uploaded as usual) and starts it again on the
   same save. **Quit to menu** ends the game like closing the emulator, so save first. In the app the pause menu is its own
   transparent window above everything, so the frozen game stays visible behind it; in a plain browser it shows inside the page. The menu reads the controller
   through `/dev/input/js*`; if that isn't readable on your system, the combo does nothing, and you can still
   quit with each emulator's own Stop/Exit (Dolphin's Stop, for example, also returns to the menu).
   If the game cannot be frozen, the screen says it keeps running behind the menu.
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
are broken or still copying are left alone with a message explaining why. Zip needs nothing installed. RAR uses 7-Zip, unrar, unar or bsdtar when the computer has one (they handle
big archives such as Switch games), and a built-in reader otherwise, which can fail on very large files. `.7z` needs
7-Zip (`p7zip-full` on Linux).

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
arrow) shows every controller the system can see in player order (Player 1 first), whether it is USB or
Bluetooth, and the mapping it has on the Wii, the GameCube and the Switch. Everything about a controller is
changed here, with the controller itself; the bottom of the screen says what each button does for the
controller on the selected tile:

| Button | Does |
|---|---|
| **A** | Change its player slot: pick Player 1 to 4; whoever was there takes its old place, and each controller keeps the mappings it had |
| **X** | Change its mapping: one list with the Wii, GameCube and Switch mappings made for this kind of controller (or *Automatic*) |
| **Y** | Switch controllers only: combine it with another Switch controller (a left and a right Joy-Con are combined by themselves), or split a pair again |

The **Connect a controller** and **Mappings** tiles open the two screens that stay separate: pairing, and the mapping
editor. (The older **Players and mappings** table is still there from the pause menu's **Change controllers**.)

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
Every game starts with a save called **Default** (made from the emulator's old save if it had one), so you can press A and play. Choose **New save** for another and name it on the on-screen keyboard. On the sheet: **A** plays,
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

**Where saves go.** To the `saves` branch of a separate private repository,
`https://github.com/aidankeighron/all-in-one-emulator-saves` (set `cloudRepoUrl` in `config.json` to use another),
as plain files. History only grows; very old versions can be removed by squashing that branch.

**Setting it up on a computer.** The repository is private, so the menu needs a token to read and write it. Put a
fine-grained GitHub token (this repository only, Contents: Read and write) in a file named `cloud-token.txt` beside
`package.json` (or beside the program). The file is ignored by git, so a zipped copy that includes it works as is.
On your own computer, `gh auth login` or your normal git sign-in works instead. Anyone holding the token can read and
change the saves in that repository and nothing else.

**Privacy.** A save upload contains only the slot's save folders: never games, keys, firmware or emulator
settings. It also holds the save names you type, this computer's name, and timestamps. Commits carry a generic
author, not your identity.

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

## Light and dark

Settings -> Sound & controls -> **Light or dark**: *System* (the default) follows the computer's light/dark setting and
changes with it, or choose *Light* or *Dark*. The choice is saved in `config.json` (`theme`).

# Controller setup per emulator

The menu detects the controllers plugged in (Xbox, Switch Pro/Joy-Con, GameCube via the official
adapter, Wii Remote, other gamepads) and, right before a game starts, writes them into that
emulator's settings. Plug a controller in, start a game, and it works. Turn this off with the toggle in
Settings -> Sound & controls.

| Emulator | What is set up |
|---|---|
| Dolphin | GameCube ports 1-4 and Wii Remotes 1-4. A gamepad becomes both a GameCube controller and an emulated Wii Remote, using the player's mappings (below). A connected Wii Remote is set to *Real Wiimote*. With an official GameCube adapter, ports without a gamepad use the adapter. |
| Ryujinx | Linux: each player's controller is written into Ryujinx's `Config.json` (`input_config`) by its SDL id. Open Ryujinx once first. Windows: a controller is matched to the entry Ryujinx already has for it (set each controller up once with **Open** in Settings; after that the menu keeps it on the right player). The buttons come from the player's Switch mapping; a layout you made in Ryujinx is left alone until you pick a Switch mapping for that player. |

Players are numbered in the order the system registered the controllers. Existing settings in the files
are kept; only the controller entries are replaced, and the first time a file is changed the original is
copied next to it as `<file>.emulator-menu.bak`. Nothing is written when no suitable controller is
connected, so keyboard setups are left alone.

## Mappings

A mapping says which button on the physical controller does what on the emulated one. Each is made for one **console**
(Wii, GameCube, Switch) and one **kind of controller**: *Xbox / generic* (anything that is not Nintendo's),
*Nintendo* (Switch Pro Controller, Joy-Con, a Joy-Con pair) or *official Wii Remote*. A player with **Automatic**
gets the standard mapping for the kind of controller they have, and the lists on the Controllers page and the editor only
offer mappings made for that kind.

| | Xbox / generic | Nintendo (Switch Pro, Joy-Con) | Official Wii Remote |
|---|---|---|---|
| **GameCube** | GameCube (Xbox / generic) | GameCube (Nintendo): the buttons labelled A, B, X, Y act as A, B, X, Y | none: a Wii Remote only plays Wii |
| **Wii** | Wii Classic Controller (automatic), or Wii Remote + Nunchuk | Wii Classic Controller (Nintendo), or Wii Remote + Nunchuk + gyro (automatic) | Official Wii Remote: used as it is, nothing to map |
| **Switch** | Switch (Xbox / generic) | Switch (Nintendo) | none |

The built-in ones have no pointer, shake or tilt (make those yourself); the one exception is the gyro mapping, which
drives the Wii Remote's motion from a Switch controller's motion sensors (Dolphin has to see them, which it does for a
Pro Controller or Joy-Con over Bluetooth). It has no pointer either.

- **Mappings screen** (the **Mappings** tile): each mapping is a small JSON file in `~/.config/all-in-one-emulator/mappings/`
  (`%APPDATA%` on Windows). Built-ins are read-only: **Duplicate to edit**, or **New mapping** to start from the standard
  one for a console and controller. For your own mappings the **Console** and **Controller** dropdowns choose what it
  is for, and every input's dropdown then lists what that kind of controller has, named the way its own buttons are
  labelled (a Nintendo pad's *A* is the right button; an Xbox pad's *A* is the bottom one), with motion sensors and
  Capture for Nintendo pads only. Wii mappings also choose the extension (Nunchuk, Classic Controller, nothing) and
  whether the remote is held sideways; Switch mappings choose which stick is which and whether motion is on.
- **Players:** the *Players and mappings* table (from the pause menu's **Change controllers**) has the same choices with
  dropdowns: controller, Wii mapping, GameCube mapping, Switch mapping. Choices are remembered by controller
  name, so a pad keeps its player when you unplug it and plug it in again. Changes are written to the emulators
  immediately (**Sync now** repeats it) and again every time a game starts.
- With a gamepad: up/down/left/right move, **A** opens a dropdown, up/down choose in it, **A** picks and **B** cancels; **B** closes the screen.
- The control and input names were checked against Dolphin's source code. Not verified on a real Dolphin or Ryujinx install.
- Not covered: a mapping cannot yet be shared between computers.

## Two Switch controllers as one

Bluetooth shows a pair of Joy-Cons as two controllers. There are two ways to get one, and the menu does both:

**Inside the menu (always on).** The menu puts a left and a right Joy-Con together by itself: they show as one **Joy-Con
pair** card, take one player slot and use one mapping. **Y** on a Switch controller combines it with any other Switch
controller, or splits a pair again (a pair you split stays split).

- **Dolphin** does the joining: the menu writes `SDL_JOYSTICK_HIDAPI_COMBINE_JOY_CONS` into the `[SDL_Hints]` section of
  `Dolphin.ini` and uses the device SDL then reports, `Nintendo Switch Joy-Con (L/R)`. This needs a recent Dolphin
  (one that has the SDL Hints settings); on an older one the two halves stay separate. For motion the right Joy-Con's
  sensors are used. Not tested on real Joy-Cons.
- **Ryujinx** reads one device per player, so a pair is written as its left Joy-Con alone, and the setup message says so.

**One real controller for every emulator (a helper, set up once from the menu).** Pairing → **Connect a controller** →
**Use two Joy-Cons as one controller** walks through it; after that it runs by itself.

| | Windows: BetterJoy | Linux: joycond |
|---|---|---|
| What it does | Makes Joy-Cons and the Pro Controller look like Xbox 360 controllers and joins a left and a right Joy-Con into one, with rumble and motion (served on port 26760) | Joins a left and a right Joy-Con into one "Nintendo Switch Combined Joy-Cons" controller (press **L** and **R** together; **SL + SR** makes one a sideways controller) |
| Setup steps | 1. the ViGEmBus driver (its installer asks Windows' permission once, the menu downloads and runs it) 2. BetterJoy (downloaded and unpacked into the menu's emulators folder, its settings set for Xbox pads and the motion server) 3. pair the Joy-Cons in Windows 4. **Turn on** | 1. checks the kernel is 5.16 or newer 2. installs the `joycond` package (`apt`, `dnf` or `zypper`, password once; on other systems the screen links to the build instructions) 3. pair with **Pair a Joy-Con** 4. **Turn on** (`systemctl enable --now joycond`, password once) |
| Afterwards | The menu starts BetterJoy with itself and before every game, shows its virtual Xbox pads instead of the real Joy-Cons, and uses the Xbox mappings. Ryujinx's motion is pointed at BetterJoy's server | joycond is a system service that starts at boot. The menu shows the combined controller instead of the two halves it joined |
| Needs | Windows 10/11. Download addresses come from GitHub; set `emulatorUrls.betterjoy` or `emulatorUrls.vigembus` in `config.json` (a web address, or a file on this computer) if they cannot be reached | A distribution that has the `joycond` package |

Not tested on real Windows or Joy-Cons. The addresses for the downloads (`Davidobot/BetterJoy`, `nefarius/ViGEmBus` on
GitHub) could not be checked from where this was built, so if **Download BetterJoy** reports a missing zip, download
BetterJoy yourself and point `emulatorUrls.betterjoy` at it. BetterJoy's own settings file differs between versions, so
the menu only edits keys that exist; if buttons are swapped, change that in BetterJoy's settings.

## Rumble

Rumble is on out of the box for gamepads that have it (a wired Xbox controller such as the PowerA 1510523-01 is a standard
XInput pad and needs nothing installed). Dolphin gets both motors of the pad on the GameCube and Wii controllers
(`Rumble/Motor` = `Motor L` | `Motor R`), and Ryujinx's `rumble.enable_rumble` is turned on, on Windows and Linux. Every
mapping has a **Rumble (vibration)** setting (on by default) in the mapping editor to turn it off. A controller without
motors simply does nothing. On Linux the pad needs force-feedback support in the kernel (the `xpad` driver has it). With
BetterJoy or joycond, rumble goes through the same way.

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
- Joy-Cons are paired one at a time. They appear as two controllers and are combined into one by the menu (see *Two
  Switch controllers as one*).
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

# Testing

[docs/testing.md](docs/testing.md) lists what needs real hardware (multiple controllers, the pause menu, saves,
Bluetooth) and how to try each, plus how to get two computers talking (Windows firewall, Tailscale).

# Ideas for later

- [Online mode](docs/online-mode.md): outline only, nothing built.

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
