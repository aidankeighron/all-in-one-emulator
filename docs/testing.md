# Testing by hand (Ubuntu)

`npm test` covers the logic. These are the parts that need real hardware or real services. Keep a terminal open
next to the menu: lines starting `[SAVES]`, `[PADS]`, `[PAUSE]`, `[LIBRARY]` and `[LAUNCH]` say what happened.

## 1. Multiple controllers

1. Plug in two controllers (two USB, or one USB and one Bluetooth). Open the **Controllers** page (LB from the first page).
   Each shows its own card with LEDs for its player number, in the order the system registered them.
2. **Players and mappings**: set Player 2 to the second controller in the dropdown (A opens it, up/down choose, A picks).
   Unplug and replug it: it should stay Player 2.
3. Start a Wii or GameCube game: both controllers should work. Check `[PADS] dolphin: configured (Player 1: …, Player 2: …)`.
4. Start a Switch game: `~/.var/app/io.github.ryubing.Ryujinx/config/Ryujinx/Config.json` should list `Player1` and `Player2`
   in `input_config`, and a `Config.json.emulator-menu.bak` should exist.
5. If a button is wrong in Dolphin, fix it in Dolphin and turn off automatic controller setup (Settings -> Sound & controls).

## 2. Pause menu

1. Start any game. Hold **Back + Start** for the time set in Settings -> Sound & controls (1.5 seconds by default; try 0 and 2 too). Expect `[PAUSE]` in the terminal, the game freezing (sound stops) and
   a dark, see-through layer over the game with the Paused screen on it. If it does not appear over the game, or appears but
   ignores the controller, the desktop is not putting the new window in front or giving it focus (some Wayland setups):
   note which desktop you use and what you see.
2. **Resume** (or B): the game continues exactly where it was.
3. **Change controllers**: change Player 1's controller or a mapping, close the screen: it now says *Controllers changed*
   and highlights **Restart game**. Choose it: the game closes, the save uploads (`[SAVES]`), and the same game
   starts again on the same save with the new settings.
4. **Connect a controller** during the pause works the same as on the Controllers page.
5. **Quit to menu** ends the game; the save is uploaded as usual.
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

- **Switch Pro Controller / Joy-Con:** Controllers page -> **Connect a controller**; hold the sync button; the menu pairs and
  connects it. It should then appear as a controller card. Joy-Cons show as two controllers.
- **Wii Remote:** press 1 + 2; the menu sees it; choose **Use as Wii Remote 1**. Start a Wii game and press 1 + 2 again when
  it starts. Do not pair the remote in Ubuntu's own Bluetooth settings: Dolphin cannot use it afterwards.
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
