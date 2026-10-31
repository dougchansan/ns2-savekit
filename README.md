# ns2-savekit

read, back up, restore and modify save data for **any installed Switch 2 game**
over a live [ns2jb](https://gitlab.com/kurumuz/ns2jb) session. the save path is
not game-specific: it opens a title's save archive, moves files in or out,
commits, and verifies by hash.

the same access is then used for one more thing: an Artemis save be retargeted
so the game resumes *our* Lua instead of its own script. that is the "save
launch" half (`payloads/`, `tools/artemis-save.py`); the save half works on any
title you own.

the exploit is **not** here. nothing in this repo is exploit code, keys, or game
content.

## what you need

- a **patched** `ns2jb` checkout, an exploit session held open, and the run
  folder it prints (`runs/switch2-XXXXXX`, containing
  `switch2/ro/root/current-root.json`). the host is
  [ns2jb-rpc](https://github.com/dougchansan/ns2jb-rpc) or `run.cjs` from the
  ns2jb checkout.
- firmware 23.0.1 and SmileBASIC 4 (retail) to deliver the exploit.
- node (no npm install; nothing to build).

## quick start

```sh
# 0. patch the engine once, before the first run. the host copies engine/ into
#    every run folder at startup, so patch first, then start a new session.
sh patches/apply.sh ~/ns2jb

# 1. start the host and leave it running. <local ip> is THIS computer's LAN ip:
#    the console dials back, so it must be reachable from the switch.
cd ~/ns2jb-rpc && node run.cjs --rpc <local ip>
#   -> run folder: runs/switch2-XXXXXX

# 2. in a freshly opened SmileBASIC, with a.b.c.d = the four octets of <local ip>:
#      RUN
#      REMOVE NSR,&H60000000,&H3FFFFFFF
#      V=START(39380,a,b,c,d,0,0,0,0)

# 3. back here, drive everything from the menu
node tools/kit.cjs                    # newest run folder, or:
node tools/kit.cjs ~/ns2jb-rpc/runs/switch2-XXXXXX
```

the patch step is not optional; skip it only if the checkout already has the
changes. `docs/PATCHED-ENGINE.md` explains what each patch fixes.

## the kit

`tools/kit.cjs` adds no save logic of its own: it shells out to the proven
scripts and prints the exact command before each one.

| menu | what it does |
| --- | --- |
| list | list the files in a save (read-only) |
| backup | pull the save into `saves/<game>/user-<uid>/<timestamp>` |
| replace | write files from a directory, in one transaction |
| delete | remove one file at the save root |
| verify | pull again and compare every file with the backup |
| launcher / editor | Artemis only: install the payload set or the Seedsow Lua Editor save |

writes are fenced:

- read-only by default; a write needs a prior backup and compares the live
  bytes against it before replacing anything;
- only titles on the allowlist (`config/titles.json`, plus your
  `config/titles.local.json`) can be written;
- one open, one commit, then every file is read back and hashed;
- paths must be `/name`; `..`, nested paths and absolute paths are rejected.

several save operations per boot usually work; restart the console only if one
actually fails. the one thing that reliably breaks the next session is leaving a
previous one open (`--keep-open`, a diagnostic only).

## any title, by hand

```sh
# back up
node tools/save-pull-root.cjs <run> <title-id> saves/botw <uid>
node tools/pull-all.cjs <run> saves/all --batch 4      # every archive it finds
node tools/saves-report.cjs saves/all                  # what was pulled

# restore a pulled directory (back up -> write -> pull -> verify, in that order)
sh tools/save-restore.sh <run> <title-id> <uid> saves/botw [--space N --type N]
```

`<uid>` is the 16-byte account uid in hex; `--list-uids` prints them. the pull
prints `mounted space=… type=… uid=…` - read that line, it is how you learn that
the right archive opened. `docs/RESTORE.md` covers the restore path and its
limits; `docs/SAVE-ARCHIVES.md` covers which archive an open selects.

## save launch (the Artemis half)

an Artemis slot save stores where execution resumes. retarget that pointer at
`save:/name.asb` and the game resumes there; an ASB is a plain Lua container, so
a few commands put our chunk in front of the engine. a second, zero-edit entry
point is the suspend file: `save_prefix="save"` + `save_suspend=9999` makes the
game look for `save9999.dat` at boot.

- `docs/LAUNCHER.md` - the chain, what is proven on hardware, what is blocked.
- `tools/build-untethered.sh` - build the stub + body + suspend launcher from a
  backup; `tools/inject-launcher.sh` - backup, build, write, pull and verify.
- the stub/body split is built and smoke-tested, not yet installed on hardware.

## troubleshooting

| what you see | what it means | what to do |
| --- | --- | --- |
| `0x7d402` for every account | the game has not made a save yet | launch it and close it fully (Home -> X -> Close), then retry |
| `could not tell whether … has save data` / `exited without listing anything` | the read-only probe never listed an archive; an older puller called that "no save" (issue #2) | update the tools; the kit now names this instead of calling the save absent |
| `Directory exceeds the N-entry probe limit` | your copy predates the 2048-entry limit | raise it in `tools/save-pull-root.cjs` and `tools/save-write-stage.cjs` |
| `could not list installed applications` / `could not list accounts` | one of `inventory.cjs`'s two enumerations failed; the lines under it are the child's own error and a hint | follow the hint; an account failure can be worked around with `node tools/inventory.cjs <run> <uid>` |
| `EEXIST …-ncm-system-programs.bin` | the engine checkout is unpatched | `sh patches/apply.sh ~/ns2jb`, then start a new run - an existing run folder keeps the old engine copy |
| `ListAllUsers: transport 0xf601` | the engine has no CMIF pointer descriptors; not a console fault | apply the patches and start a new run |
| `SESSION LOST` / `transport 0xf601` during a pull or write | the console stopped answering | restart the console, reopen SmileBASIC, start a new session |
| `NO LIVE HOST` / `memory.sock` | the session folder is stale or gone | start the host again and use the run folder it prints |
| title listed without `✔` | it is not on your write allowlist | add its id to `config/titles.local.json` |
| names are missing, ids only | titledb has not been fetched yet, or does not list the title | run once with network; paste the stub the tools print into `config/titles.local.json` |

## tests

offline, no console, no network:

```sh
node tests/test_kit_probe.cjs        # kit save detection (5)
node tests/test_inventory.cjs        # inventory reporting (7)
node tests/test_save_attr.cjs        # save attribute packing (9)
node tests/test_titles.cjs           # name fallbacks (5)
node tests/test_restore_manifest.cjs # generic restore path (6)
node tests/test_nso_verify.cjs       # NSO0 parsing, LZ4, hashes (13)
node tests/test_smb_meta.cjs         # META name block surgery (5)
sh   tests/test_inject_dryrun.sh     # injection builder/manifest (3)
lua  tests/test_payload_lua.lua      # launcher payload decisions (13)
lua  tests/test_metadata_lua.lua     # name/thumbnail writer (12)
python3 tests/test_offline.py        # save/ASB encoders (8)
```

## layout

```
tools/     pull/write/restore/list/inventory, ASB encoder, launcher builders
payloads/  Lua that runs inside the game: launcher stub, body, metadata
patches/   the engine patches the tools need (apply before the first run)
config/    write allowlist template (local config files are gitignored)
docs/      LAUNCHER, RESTORE, SAVE-ARCHIVES, TECHNICAL, PATCHED-ENGINE, RESULTS
tests/     offline suites; none of them prove console behaviour
```

the controller/esp32 work lives in
[ns2-console](https://github.com/dougchansan/ns2-console); the content/asset
pipeline is in [ns2-assets](https://github.com/dougchansan/ns2-assets).

## credits and licence

our code is MIT (see [LICENSE](LICENSE)). third-party components and links are
listed in [NOTICE](NOTICE): ns2jb (the exploit, linked not vendored), Seedsow Lua
Editor (0BSD; its save is downloaded, never bundled), titledb (MIT, names only),
and the Artemis engine (no affiliation, no game content).
