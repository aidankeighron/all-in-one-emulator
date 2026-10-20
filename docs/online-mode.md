# Online mode (not built yet)

This is an outline of what an "online mode" could be for the menu, written down so the idea is not lost. **None of it
exists today.** What the menu already does online is small: cloud saves (`ui/lib/saves`) and sharing games between
your own computers (`ui/lib/library.js`).

## What it would be for

Playing together with other people on different computers, started from the menu without setting anything up in
the emulator first.

| System | How online play works in the emulator | What the menu could do |
|---|---|---|
| Wii / GameCube (Dolphin) | **Netplay**: one player hosts, others join with a code. Everyone needs the same game file and the same Dolphin version. | Start Dolphin's Netplay window for the chosen game; show the join code; check the game's checksum matches before starting. |
| Switch (Ryujinx) | **LDN** (local wireless play) carried over the internet by an LDN server (the Ryubing project runs one, `LdnServer`). Needs a passphrase and internet access turned on. | Write `multiplayer_mode`, `multiplayer_ldn_passphrase` and `enable_internet_access` into Ryujinx's `Config.json` (the menu already edits `input_config` there) and show the passphrase to share. |

## Pieces to build

1. **A "Play online" button** on the save sheet next to the save slots: *Host* or *Join*.
2. **Room codes.** Host makes a short code (same style as the library access key, e.g. `K7MQ-4XPD-92RT`); joiners type it.
   Dolphin and Ryujinx have their own ways to connect, so the code mostly carries the address or passphrase.
3. **Same game, same version.** Before joining, compare the game file's size/hash with the host's, and tell the
   player what differs instead of failing inside the emulator.
4. **Controllers.** Reuse the Players screen and the pause menu (Back + Start) so controllers can be changed
   without leaving the game.
5. **Saves.** Decide whether an online session uses a save slot (progress shared with the cloud) or a throwaway one
   so a guest cannot overwrite a real save. Default: a temporary slot that is not uploaded.
6. **Settings.** Display name, and the LDN server address (default Ryubing's), stored in `config.json`.

## Open questions

- Which of Netplay and LDN is wanted first (they share almost nothing)?
- Does it need to work between a Linux and a Windows computer? (Dolphin Netplay does; versions must match.)
- Port forwarding and firewalls: Netplay can use a traffic server so the host needn't open ports. Is a private
  network such as Tailscale (already suggested for library sharing) enough for the first version?
- Legal and safety: only share games you own, between people you trust; room codes should not expose anything but
  the session.
- Testing: none of this can be verified without real emulators and two computers.

## Not in scope

Matchmaking, accounts, chat, or any server run by this project.
