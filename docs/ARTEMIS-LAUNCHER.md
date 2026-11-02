# alula Artemis Launcher

An installer for [alula's switch-artemis-launcher](https://github.com/alula/switch-artemis-launcher),
plus the hardware report from installing it through this toolkit's save pipeline.

The launcher is **not vendored**. `tools/artemis-launcher.cjs` downloads the
pinned upstream revision at run time, checks every file it uses against a
recorded SHA-256, and only then stages it. No upstream script, font bytes or game
save is stored in this repository.

| | |
| --- | --- |
| upstream | <https://github.com/alula/switch-artemis-launcher> |
| revision | `b9e6de82934dfda1f2c6219aaf305ed980a3d1ba` (tag `v1`) |
| supported titles | `010042d022aea000` Seedsow Lullaby **Demo**, `010012900d38a000` Nora 2 **Demo** |
| unsupported | the full games, and every other title (refused before a save is opened) |
| installed here | Seedsow Lullaby (demo), installed 2026-11-01 and verified on hardware |

## Three different launchers, deliberately kept apart

| | Seedsow Lua Editor | our ns2jb launcher (kit option 4) | alula Artemis Launcher (kit option 8) |
| --- | --- | --- | --- |
| made by | [DialingSpoon527](https://github.com/DialingSpoon527/seedsow-lua-editor) | this repository | [alula](https://github.com/alula/switch-artemis-launcher) |
| gets you | an on-console Lua editor in slots 1-3 | a headless body that runs at every boot | a menu: Hello World slot, HTTP Lua server, update mechanism |
| files | 275, its own slots | `ns2jb.asb`, `ns2jb.lua`, `save9999.dat` | `core.lua`, `inject.iet`, `inject.lua`, `http.lua`, `exploita.lua`, `proggy.ttf`, `save9999.dat` |
| boot trigger | its own slots | `save9999.dat` | `save9999.dat` |
| status | installed and used on hardware | built; option 4 is unchanged | **installed and tested on hardware** (this doc) |

The editor and the two launchers do not share file names, so the editor's files
survive an Artemis Launcher install untouched. The two launchers **do** share the
one boot trigger, `save9999.dat`, so they are alternatives: installing one
replaces the other's boot path. Option 4 is not modified; this is a separate
option and a separate tool.

## What it writes

Only these seven files, and nothing else:

```
add      /core.lua        the per-game core (upstream seedsow_save/ or nora2_save/)
add      /exploita.lua    upstream Hello World payload
add      /http.lua        upstream remote Lua HTTP server
add      /inject.iet      upstream startup loader + launcher menu
add      /inject.lua      upstream launcher
add      /proggy.ttf      upstream console font
replace  /save9999.dat    rebuilt from the game's own suspend save, retargeted at inject.iet
```

`save9999.dat` is **not** upstream's `common/save9999.dat`. That file is a
version-1002 container made from the upstream author's own save; writing it over
a version-1003 save would replace game state. The installer instead takes the
backup's own `save9999.dat` and uses `tools/artemis-save.py launch` to point its
caret at `save:/inject.iet`, keeping the container version and the resume data.
That is why the installed trigger hashes differently from either input but is
still the game's own file.

`saveg.dat` and `system.dat` are **not** written. Upstream's release contains the
author's copies; ours are the game's current files and are left alone.

## Prerequisites

- a **patched** `ns2jb` checkout, a live RPC session and its run folder
  (`switch2/ro/root/current-root.json` present), as for every other write;
- the target demo installed and launched once, so its save archive exists;
- the title on the write allowlist (`config/titles.local.json` is local and
  gitignored; the public list stays empty);
- the account uid, either passed with `--uid` or present in the local
  `config/uids.json`;
- `node` 20+, `python3`, `curl`, `tar` (curl/tar only for the first download).

Firmware and game version:

- **firmware 23.0.1** is the version measured here and the version upstream
  targets. Nothing in this installer checks firmware; the exploit path it depends
  on is the SmileBASIC 4 -> ns2jb one, which is firmware-specific. A different
  firmware is untested.
- **Seedsow Lullaby Demo Ver. 1.0.0** is the build measured here. Its `main`
  matches the offsets in upstream's `core.lua` (verified by disassembly of the
  dumped `main` and by running it: `main @`, `sdk @`, `running on: Ounce`).

## Using it

From the kit (`node tools/kit.cjs`, pick a supported demo):

```
1) List files in this save (read-only)      [save op]
2) Save: back this save up                   [save op]
3) Replace: write files from a directory     [save op]
4) Install payload files (Artemis launcher)  [save op]   <- our ns2jb launcher
5) Install the Seedsow Lua Editor save       [save op]
6) Delete a file (optional)                  [save op]
7) Verify: compare the save with what we wrote [save op]
8) Install alula Artemis Launcher            [save op]   <- this installer
9) Back to the title list
```

Option 8 backs the save up first if there is no backup yet, shows the plan (every
file with its size and hash, add vs replace), and writes only after `y`. Then it
pulls the save again and checks every entry against the manifest.

By hand:

```sh
# pair no console: build the plan from a local backup with a verified checkout
node tools/artemis-launcher.cjs plan \
  --title 010042d022aea000 \
  --backup saves/Seedsow-Lullaby-demo/user-<uid8>/2026-11-01_2055 \
  --source /path/to/verified/switch-artemis-launcher

# exact command the kit runs; --confirm is the write authorization
node tools/artemis-launcher.cjs install <run> \
  --title 010042d022aea000 --uid <32-hex> \
  --backup saves/Seedsow-Lullaby-demo/user-<uid8>/2026-11-01_2055 --confirm

# pull again and compare against the manifest
node tools/artemis-launcher.cjs verify <run> --title 010042d022aea000 --uid <32-hex> \
  --backup saves/Seedsow-Lullaby-demo/user-<uid8>/2026-11-01_2055
```

Exit codes: `0` done and verified, `2` bad usage, `3` session lost, `4` no live
host, `5` unsupported title, `6` missing prerequisite (no backup, no archive, no
upstream), `7` conflict, `8` verification failed.

The download cache is `~/.cache/ns2-savekit/artemis-launcher/<commit>/`. Every
use re-hashes the files, so a cache edit is refused rather than installed.
`--source` accepts a local checkout for offline use, with the same hash gate.

## Conflicts

- **Another file with a launcher name already exists in the save** (for example a
  user's own `core.lua`): the plan reports it and the install exits `7`. Only
  `save9999.dat` may be replaced.
- **`save9999.dat` is missing**: exits `6`. That save has no suspend trigger, so
  this launcher has no way to run.
- **Our ns2jb launcher is installed**: both use `save9999.dat`. Installing
  Artemis Launcher replaces the boot path; `ns2jb.asb`, `ns2jb.lua` and
  `sscode004.lua` stay in the save. Restoring the pre-install `save9999.dat`
  brings the ns2jb boot path back.
- **The Seedsow Lua Editor** is not touched: none of its files collide. While
  Artemis Launcher owns the boot trigger the game does not reach its own slot
  menu, so the editor is only reachable again after a restore.

## Verification

After the write the installer pulls the save again and runs
`tools/verify-save-manifest.cjs` against the staged manifest. A manual check:

```sh
node tools/save-pull-root.cjs <run> 010042d022aea000 /tmp/check <uid> --space 1 --type 1
node tools/verify-save-manifest.cjs /tmp/check staging/alula-artemis/010042d022aea000/manifest.json
```

The save-level proof is stronger than "the files are there": compare the
pre-install backup with the post-install pull. In the hardware run below, exactly
six files were added, one was replaced, and **289 files were byte-identical**.

## Rollback

The installer prints the exact command. It needs the same live session, because
restoring writes to the save:

```sh
node tools/artemis-launcher.cjs restore <run> \
  --title 010042d022aea000 --uid <32-hex> \
  --backup saves/Seedsow-Lullaby-demo/user-<uid8>/2026-11-01_2055 \
  --confirm-restore
```

That restores `save9999.dat` from the backup (the only file it replaced) and
deletes the six files it added, then pulls and compares the trigger. Doing it by
hand is the same two steps:

```sh
node tools/save-write-stage.cjs <run> 010042d022aea000 <uid> <backup> <one-file-manifest.json> \
  --restore --confirm-restore
node tools/save-delete-root.cjs <run> 010042d022aea000 <uid> /core.lua   # and the other five
```

Then restart the console and boot the game: the original resume path is back.
If the game will not boot at all, the recovery path is the same one every save
problem here uses: launch SmileBASIC 4, rerun the ns2jb bootstrap to get a
session, then restore from the untouched backup.

There is a second, upstream-provided recovery: write `<name>2.lua` to update
`core.lua`, `http.lua` or `inject.lua`, and hold **minus** at startup to ignore
the update (`inject.iet` checks `e:isDown(114)`). The payload half of that works
(measured: minus at the launcher menu prints `[!] RECOVERY MODE`). The
**startup** half did not: two boots with minus held continuously through the
resume still loaded `inject2.lua`. Do not rely on it on demo 1.0.0; the backup is
the reliable rollback. Because of that finding the installer never writes an
update file, and this report did not stage a deliberately broken update.

## Hardware test report — 2026-11-01

Environment: retail Switch 2, firmware **23.0.1** (`docs/images/2026-11-01-console-firmware-23.0.1.png`),
Seedsow Lullaby Demo **Ver. 1.0.0** (`docs/images/2026-11-01-seedsow-demo-version.png`),
the demo's own account (uid not recorded in this repository), ns2jb-rpc session `switch2-rIh6OU`
(dial-back from the console, so no console IP is baked into anything here).
Upstream revision `b9e6de82934dfda1f2c6219aaf305ed980a3d1ba`.

| test | result | evidence |
| --- | --- | --- |
| A. launcher screen at boot | **pass** | `docs/images/2026-11-01-artemis-launcher.png` — "switch-artemis-launcher by alula", A/B/Y menu, Proggy font |
| B. slot A Hello World | **pass** | `docs/images/2026-11-01-artemis-hello-ounce.png` — core init, arb r/w, `main @ 0x2e24206000`, `sdk @ 0x2e581bb000`, `running on: Ounce`, then `hello world` |
| C. remote Lua server | **pass** | `docs/images/2026-11-01-artemis-http-server.png`; `GET /status` -> 200; `POST /eval print("hello world")` -> `status: ok / output: hello world`; `print(_G.n2h.platform)` -> `Ounce` |
| D. save upload/delete | **pass** | `PUT /save?path=save:/artemis-probe-20261101.bin` -> 51 bytes; read back equal; `DELETE` -> deleted; follow-up read -> `GONE` |
| E. memory / native interface | **pass** | arb r/w self-test, module base leaks, `svcGetInfo` platform check -> `Ounce`, `TPIDRRO_EL0` read; all non-destructive |
| F. persistence | **partial** | close + relaunch -> launcher again; full power cycle + relaunch -> launcher again; minus at the menu -> recovery mode; **startup minus skip-update not observed** |
| G. compatibility | **pass, with a documented conflict** | editor files byte-identical (289 unchanged); boot trigger is single-owner, so ns2jb boot is displaced until restore |

Save evidence:

- pre-install backup `saves/Seedsow-Lullaby-demo/user-<uid8>/2026-11-01_2055`:
  **290 files, 4,665,778 bytes**, per-file SHA-256 in its `manifest.json`;
- install: **7 files, 104,236 bytes**, `commit -> 0x0`, seven read-back hashes
  match the manifest;
- post-install pull: **296 files**; diff against the backup = 6 added
  (`core.lua`, `exploita.lua`, `http.lua`, `inject.iet`, `inject.lua`,
  `proggy.ttf`), 1 replaced (`save9999.dat`, `d149d71b…` -> `ca472410…`),
  **289 unchanged**.

Staged hashes (SHA-256):

```
core.lua      54d25862dc0d796985ebe69f34a345df16671c97372d67062769d28c293d4ed6
exploita.lua  a84bb1230b2edd73f469afd5aba69b3ca191e6c25b444cf93d23342b64d6af18
http.lua      2985b8f7040fc40c7e2c18e5cf857c3c5d14c0b9d081ef0a1a8742eab6f026a1
inject.iet    bf79a739584de93d1569523a8a87e7ef8ce65edcf073b5d2ba37453c4085ada4
inject.lua    fcc6b5877084df15b45dfbd8c955ee4f802add7030f1c98f3006794f8949a08b
proggy.ttf    527d2a443ce051f93f7e77b855609722b8cb220a9f104b4aa037be5c90b71324
save9999.dat  ca47241097a250615e6a1a5c263f86b16729691d91740754a791c6006e1cd63c
              (rebuilt from the backup's d149d71bf87f160825084c952575c620802ca562db894962be2ca0cc818ab342;
              full hash in the staging manifest)
```

### What remains untested

- **Nora 2 demo** (`010012900d38a000`): the code path is implemented and unit
  tested, but no hardware install was performed in this session.
- **Startup update bypass** (minus held through resume): not effective on demo
  1.0.0 in two attempts. Upstream's fail-safe should be treated as unverified.
- **Other firmware** and other demo builds: only 23.0.1 / Ver. 1.0.0 measured.
- **The full games**: unsupported upstream and refused by this installer.
- **Long-term behaviour**: measured across a close/relaunch and one cold boot,
  not across many boots.

## Security notes

- The HTTP server is **unauthenticated** and listens on TCP 8080. Keep the
  console on a trusted, isolated LAN; never forward the port.
- `POST /eval` is arbitrary Lua inside the game. It is not a sandbox.
- `/eval` can write files under `save:/`; upstream protects the launcher files
  (`core.lua`, `inject.iet`, `inject.lua`, `http.lua`, `proggy.ttf`,
  `save9999.dat`, `saveg.dat`, `system.dat`) from `/save` and `/delete`.
- This is save-based persistence: the launcher runs when *this game* loads. It is
  not a cold-boot jailbreak and does not survive deleting the save.

## Credits

- [alula/switch-artemis-launcher](https://github.com/alula/switch-artemis-launcher) —
  the launcher, the exploit chain, the HTTP server and the update mechanism. Not
  vendored; downloaded and verified at install time.
- Upstream's own credits: [n0llptr/remote_lua_loader](https://github.com/n0llptr/remote_lua_loader),
  [Gezine/ArtemisLuaLoader](https://github.com/Gezine/ArtemisLuaLoader), and the
  Proggy Clean TT font by Tristan Grimmer (redistributed by upstream, downloaded
  here, not bundled).
- [ns2jb](https://gitlab.com/kurumuz/ns2jb) — the exploit that provides the save
  session every write goes through.
