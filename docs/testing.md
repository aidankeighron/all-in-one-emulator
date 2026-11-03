# Testing by hand (Ubuntu)

`npm test` covers the logic. These are the parts that need real hardware or real services. Keep a terminal open
next to the menu: lines starting `[SAVES]`, `[PADS]`, `[PAUSE]`, `[LIBRARY]` and `[LAUNCH]` say what happened.

## 1. Multiple controllers

1. Plug in two controllers (two USB, or one USB and one Bluetooth). Open the **Controllers** page (LB from the first page).
   Each shows its own card with LEDs for its player number, in the order the system registered them.
2. Select the second controller's card: the hints at the bottom show what its buttons do. **A** -> choose Player 1: the cards swap
   places and the LEDs follow. **X** -> change its Wii, GameCube or Switch mapping. Unplug and replug it: it should stay where you put it.
3. Start a Wii or GameCube game: both controllers should work. Check `[PADS] dolphin: configured (Player 1: …, Player 2: …)`.
4. Start a Switch game: `~/.var/app/io.github.ryubing.Ryujinx/config/Ryujinx/Config.json` should list `Player1` and `Player2`
   in `input_config`, and a `Config.json.emulator-menu.bak` should exist.
5. If a button is wrong in Dolphin, fix it in Dolphin and turn off automatic controller setup (Settings -> Sound & controls).

## 2. Pause menu

1. Start any game. Hold **Back + Start** (**−** and **+** on a Switch controller or a real Wii Remote) for the time set in Settings -> Sound & controls (1.5 seconds by default; try 0 and 2 too). Expect `[PAUSE]` in the terminal, the game freezing (sound stops) and
   a dark, see-through layer over the game with the Paused screen on it. If it does not appear over the game, or appears but
   ignores the controller, the desktop is not putting the new window in front or giving it focus (some Wayland setups):
   note which desktop you use and what you see.
2. **B** closes the menu and the game continues exactly where it was. Press buttons on a controller: its card in the bottom bar lights up.
3. **Change controllers** (bottom right): change Player 1's controller or a mapping, close the screen: it now says the game has to
   start again, with the focus on **Reset**. Turning a controller off and on again instead should say *Nothing to restart*. Choose **Reset** (right; it asks for A twice): the game closes, the save uploads (`[SAVES]`), and the same game
   starts again on the same save with the new settings.
4. **Connect a controller** during the pause works the same as on the Controllers page.
5. **Quit to menu** (left; asks for A twice) ends the game; the save is uploaded as usual. Dolphin must close without asking
   "Do you want to stop the current emulation?".
6. If the game could not be frozen the screen says it keeps running behind the menu. Check `flatpak ps` while a game runs.

## 3. Save system

1. Put the token in `cloud-token.txt` next to `package.json` (fine-grained token, only the saves repository, Contents read/write).
   Restart the menu. No `[SAVES]` error should appear. If one does, its text names which sign-in ways failed and why.
2. Click a game: the sheet shows **Default**. Press A and play, quit. Expect `Saved “Default” · … MB`, and in the saves
   repository a `saves` branch with `saves/<system>__<game>/<id>/data.zip` and `meta.json`.
3. **Use my old save** (shown when the emulator already had a save): choose it, play, check the progress is there.
4. Offline test: turn off the network, play and quit. The sheet says it could not reach the cloud and why, and keeps the save.
   Reconnect and restart the menu: it uploads.
5. Two computers: same token on both. Play on one, then open the game on the other: it downloads the newer save first.
   To see the conflict prompt, change the same save on both before syncing.
6. **Start** on a save shows older versions; restoring one makes it a new version.

## 4. Connecting Switch controllers and Wii Remotes

Linux needs Bluetooth (the menu offers to install it) and kernel 5.16 or newer for Switch controllers.

- **Switch Pro Controller / Joy-Con:** Controllers page -> **Connect a controller**: it should say *Looking for
  controllers…* straight away. Hold the sync button; the controller should be listed with ✓ (no `br-connection-create-socket`
  failure) and appear as a controller card. Try a Joy-Con that was used with a real Switch since it was paired here: it should
  be paired afresh by itself. In Dolphin check that both halves of a pair work as one pad.
- **Joy-Cons with joycond on:** connect both, then press L + R: they should become one controller card.
- **Wii Remote:** press 1 + 2; the menu connects it (*Wii Remote connected*). In the menu, hold it upright: the D-pad moves,
  A chooses, B goes back. Start a Wii game with an Xbox pad on player 1, the Wii Remote on player 2 and a Switch controller on
  player 3: in the game each must control its own player (check `Device =` in `WiimoteNew.ini`: `SDL/0/Xbox 360 Controller`,
  `SDL/0/Nintendo Switch Joy-Con (L/R)` for a joycond pair). If the remote does nothing in the game, press 1 + 2; if it
  still does not, remove it on the Controllers page (B) and let Dolphin connect it when the game starts, and note it.
- **Let Dolphin use Wii Remotes:** after the remote connects, press **Let Dolphin use Wii Remotes** (password once). Check that
  `/etc/udev/rules.d/72-emulator-menu-wiimote.rules` exists and `ls -l /dev/hidraw*` shows a `+` (an ACL) on the remote's
  device. Then start a Wii game with the remote still connected to the computer: it should work without pressing 1 + 2.
- **A Wii Remote joining mid-game:** start a Wii game with only an Xbox pad, then turn a paired Wii Remote on (press a button).
  It should become player 2 in the game, and the pause menu should not ask for a restart. `WiimoteNew.ini` should show
  `Source = 2` for Wiimote2-4.
- **Everyone at once:** open Connect a controller and put two Joy-Cons and a Wii Remote in sync mode at the same time. Each
  should be listed as it connects; press Done. With joycond on, L + R on the pair should make it a player.
- **Batteries:** with Joy-Cons connected, their tile should show *Battery …*; `ls /sys/class/power_supply` should list
  `nintendo_switch_controller_battery_<address>`. Let one run low: the tile and the top-right chip turn red and the menu
  names it once.
- **Removing:** on a joycond pair press **B** -> **Disconnect**: both Joy-Cons should switch off, the player becomes free, and a
  button press brings them back. **Forget** should unpair them (`bluetoothctl devices Paired`). A *waiting* Wii Remote tile:
  **B** -> **Let it go** removes it.
- If something fails, copy the terminal lines and the text in the Connect screen.

## 5. Two computers on one network (library sharing, and moving files)

- Hosting from **Windows**: the first time, Windows asks whether to allow the program through the firewall; answer **Private**.
  If that prompt was dismissed (or the network is set to *Public*), other computers time out. Fix, in an administrator PowerShell:
  `New-NetFirewallRule -DisplayName "Emulator Menu library" -Direction Inbound -Protocol TCP -LocalPort 8765 -Action Allow -Profile Private`
  and set the network to *Private* (Settings -> Network -> your connection). The same applies to any other server on the PC,
  e.g. `python -m http.server 8000` needs port 8000 allowed.
- Linux hosting needs `sudo ufw allow from 192.168.0.0/16 to any port 8765`.
- Tailscale on both computers avoids firewall and address problems.
- To move a small file (like `cloud-token.txt`) once: [PairDrop](https://pairdrop.net) (browser, direct between the two
  computers), `croc send <file>` / `croc <code>`, or Tailscale's `tailscale file cp`. Do not paste the token into
  chat apps or shared drives you do not control.

## 5. Joy-Cons as one controller, and rumble

- **Windows:** Controllers page -> **Connect a controller** -> **Use two Joy-Cons as one controller**. Run the four steps (the driver
  step shows a Windows permission prompt). Afterwards the Joy-Cons should show as one *Xbox 360 Controller* card, BetterJoy should start by
  itself when the menu starts, and games should see one pad. Check `[BETTERJOY]` lines in the terminal.
- **Linux:** same screen: install joycond (password), pair both Joy-Cons, **Turn on**, press L + R together. One
  *Nintendo Switch Combined Joy-Cons* card replaces the two halves.
- **Rumble:** with a wired Xbox controller start a Wii or GameCube game and trigger rumble; in Ryujinx check
  `"rumble": {"enable_rumble": true}` for the player in `Config.json`. Turn it off in the mapping editor (**Rumble (vibration)**) to compare.
