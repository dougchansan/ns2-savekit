# ns2-savekit

Read, back up, install and modify **save data for any installed Switch 2 game**,
driven over a live [ns2jb](https://gitlab.com/kurumuz/ns2jb) RPC connection.
Nothing in the save path is game-specific: it opens a title's save archive, moves
files in or out, commits, and verifies by hash.

The second half of the repository applies that same save access to one engine:
Artemis. There, a save file's execution pointer can be retargeted so the game
resumes *our* Lua instead of its own script — code execution from save data
alone. That part is engine-specific and lives in `payloads/` and
`tools/artemis-save.py`; everything else works on any title you own.

The exploit itself is **not** in this repository. We link to upstream rather than
vendor it, so this tree contains no exploit code, no keys, and no game content.

## What is proven, on hardware

Every claim below was executed on a retail Switch 2 with the demo and full game
installed, and the numbers are reproducible from the commands in
[docs/RESULTS.md](docs/RESULTS.md).

| Result | Evidence |
| --- | --- |
| Read another title's save through the promoted `pid=1` fsp-srv root | 70-file / 2.0 MB pull of `0100ee5021c9e000`, byte-verified |
| Write another title's save in one committed transaction | 275 files, 4,511,900 bytes, read back and hashed |
| Run arbitrary Lua inside a shipping Artemis game from save data alone | `ns2jb-report.txt` written by the game's own interpreter |
| Install a third-party save with no JKSV, no Switch 1, no Nintendo transfer | Seedsow Lua Editor v0.1.2 running from slot 1 |
| Full unsandboxed Lua 5.1 inside the game | `io`, `os`, `debug`, `package`, `loadstring`, `dofile` all present |

## Any title, not just Artemis

The `tools/` scripts take a program id and an account uid; they do not know or
care what engine the game uses.

| Job | Tool |
| --- | --- |
| Back up any title's save | `save-pull-root.cjs` (read-only, no commit) |
| Restore, update, mod, or install a save someone else built | `save-write-stage.cjs` (one open, one commit, per-file hash verify) |
| List what is in a save without pulling it | `save-pull-root.cjs --list-only` |
| Remove one file | `save-delete-root.cjs` |
| Find which account owns a save | `find-save-uid.cjs`, or pass the uid yourself |
| See what exists | `list-apps.cjs` |

Artemis is where we prove the harder half — running code from a save — but a
save backup/restore/mod workflow needs nothing Artemis-specific, and the same
code installed the 275-file Seedsow Lua Editor save byte-for-byte.

## The two mechanisms

**1. Save access (`tools/`).** The exploit hands us a session whose fsp-srv root
runs as `pid=1`. That root passes the save-data access check that a normal
application session fails with `FS 6400`, so we can open any whitelisted title's
save, read it, write new files into it, commit, and verify by re-reading.

**2. Save launch (`payloads/`, `tools/artemis-save.py`).** An Artemis slot save
records where execution resumes:

```
caret = { flags, ?, script-path, command-index, ?, ?, command-record }
```

Retarget `script-path` at `save:/name.asb` and the game resumes there instead of
its own script. `.asb` files are a plain-text Lua container (`ASB\0\0`, a command
count, then `lua` / `calllua` / `wait` / `stop` records), so a four-command file
puts our own chunk in front of the engine. The header names from
`system/table/list_switch.tbl` give a second, zero-edit entry point:
`save_prefix="save"` with `save_suspend=9999` makes the game look for
`save9999.dat` at boot and resume it — that file is the launcher, and the game
does not delete it when the caret has been retargeted.

## Safety model

Writes are the only dangerous operation, and they are fenced:

- **Read-only by default.** `save-pull-root.cjs` uses fsp-srv command 53 and
  never commits.
- **Disposable titles only.** A hard-coded whitelist; anything else is refused
  before a handle is opened.
- **Backup required.** Every write needs a prior pull directory; the target is
  compared against it before it is touched.
- **Add-only unless explicit.** New files are added; existing files may only be
  replaced when the manifest marks them and the live bytes still hash to the
  backup copy.
- **One transaction.** All files are written under a single open, one commit,
  then re-opened read-only and every file is hashed back.
- **Save-root only.** Paths must be `/name`; `..`, nested paths and absolute
  paths are rejected.

**Several save operations per session are fine.** Seven ran back to back in one
boot (four archive pulls plus three absent probes) with the session still live, and
a pull + write + verify sequence before that. Restart the console only if an
operation actually fails. The one thing that reliably breaks the next session is
`--keep-open`, which leaves the previous one alive - it exists as a diagnostic, not
for normal use.

## Quick start

Two things are needed before anything else: an exploit session held open, and
this checkout. The exploit is not part of this repository - get it from
[ns2jb](https://gitlab.com/kurumuz/ns2jb) and keep it in its own directory.

```sh
# 1. Start the exploit and leave it running. It prints the run folder.
node run.cjs --rpc 192.168.50.34
#    -> Run folder: runs/switch2-XXXXXX
#    then, in a freshly opened SmileBASIC:
#      RUN
#      REMOVE NSR,&H60000000,&H3FFFFFFF
#      V=START(39380,192,168,50,34,0,0,0,0)

# 2. Drive everything else from the guided menu
node tools/kit.cjs
```

`kit.cjs` finds the newest held session (or takes one as an argument) and opens
straight onto the thing you pick from - the installed titles, with names, ids and
write permission in one view:

```
9 installed applications  (✔ = write-allowed)
---------------------------------------------
  [1] ✔ Nora to Oujo to Noraneko Heart 2 (trial)  (010012900d38a000)
  [2] ✔ Seedsow Lullaby (demo)                     (010042d022aea000)
  [3] ✔ Wagamama High Spec (trial)                 (01005eb012fe2000)
  [4]   Pokémon Sword + Pokémon Sword Expansion Pass (0100abf008968000)
  [5]   SmileBASIC 4 (demo)                        (0100b4b00f9f6000)
  [6]   SmileBASIC 4                               (0100c9100b06a000)
  [7] ✔ Seedsow Lullaby (full)                     (0100ee5021c9e000)
  [8]   Nintendo Switch Sports Resort              (04008e001f098000)
  [9]   Mario Kart™ World                          (0400c3f00006e000)

Number 1-9 (blank = quit):
```

Press **`i`** at that prompt for the read-only inventory instead - every archive,
every account, with size and state (`ok`, `sparse`, `empty`), which is the quickest
way to see what is worth pulling before touching anything:

```
  game                                          user  files      size  state  id
  ✔ Seedsow Lullaby (demo)                        1    289     4.4M  ok     010042d022aea000
  ✔ Seedsow Lullaby (full)                        1     75     2.0M  ok     0100ee5021c9e000
    Mario Kart™ World                             1      1     0.8M  sparse 0400c3f00006e000
  ✔ Nora to Oujo to Noraneko Heart 2 (trial)      1     10     0.1M  ok     010012900d38a000
    Pokémon Sword + Pokémon Sword Expansion Pass  2      0     0.0M  empty  0100abf008968000
```

`node tools/inventory.cjs <run-directory>` runs it standalone.

Pick a number and that save's options open; asking for the account uid only if it
is not already remembered:

```
Seedsow Lullaby (demo)  (010042d022aea000)
  (each entry opens the save once; several in a row usually work - restart if one fails)
  1) List files in this save (read-only)      [save op]
  2) Save: back this save up                   [save op]
  3) Replace: write files from a directory     [save op]
  4) Install payload files (Artemis launcher)  [save op]
  5) Install the Seedsow Lua Editor save       [save op]
  6) Delete a file (optional)                  [save op]
  7) Verify: compare the save with what we wrote [save op]
  8) Back to the title list
```

Everything marked `[save op]` opens the save, so **each may be used once per
console boot** - the marker, and the line above the menu, are there so you pick
the one you need instead of discovering the limit when the second one crashes the
host.

The two install actions **back the save up themselves** if you have not backed it
up yet, so installing the editor save or the payload files is one choice rather
than "back up, then install": the backup is taken inside the same action, then the
files are built from it and written in one commit.

The editor install also **fetches its own release** when the directory is missing
or empty - `tools/fetch-editor-save.sh` pulls the official 0BSD zip from GitHub
into `~/.cache/ns2-savekit/seedsow-editor`, so there is nothing to download by
hand. Point it at an existing directory only if you want a specific copy.

Step 3 is the generic one: point it at any directory of files - a save backup from
another console, the editor's release, a mod - and it builds the manifest, marks
what already exists as a verified replace, and writes it in one commit.

Every action prints the command it runs, shows the file list and asks before
writing, and `7` pulls the save once and compares it byte-for-byte with the
staging directory to prove the write landed.

**Verify is itself a save operation**, so it cannot follow a write in the same
boot: the order is back up -> write -> restart the console -> verify as the first
operation of the next boot. The menu says so, and refuses to quietly attempt a
second operation.

Session folders are looked for in `$NS2_RUNS`, `./runs`, a sibling
`ns2jb-rpc/runs` or `ns2jb/runs`, and `~/ns2jb-rpc/runs` / `~/ns2jb/runs`.

### The two installs are different things

They share the mechanism - write files into a save so the game runs Lua - but the
artefacts and the purpose differ.

| | option 4: payload files | option 5: Seedsow Lua Editor save |
| --- | --- | --- |
| what | 4 files: `ns2jb.asb` (stub), `save9999.dat` (launcher), `ns2jb.lua` and `sscode004.lua` (body) | 275 files: `sed01-03.asb`, `ssedit1-3.lua`, `ssseed*.bin`, `ss*.asb`, slots 1-3 launchers |
| who made it | this repository | [DialingSpoon527's editor](https://github.com/DialingSpoon527/seedsow-lua-editor) (fetched, not bundled) |
| gets you | headless: our body runs at every boot, no UI, no console authoring | a console-side editor: type Lua with the game's keyboard, slots 4-120, Save + publish |
| footprint | replaces nothing but slot 4 | replaces slots 1-3 and adds its own files |

**Order matters if you want both.** Install the editor first (it writes slot 4's
hello example), then the payload (which takes slot 4 for its body). Do it the
other way round and the editor's install puts the example back, and the stub will
happily run "Hello from a persistent Lua slot!" instead of your payload. Having
both is the intended end state: the editor authors `sscode004.lua`, the stub runs
it at boot.

### First run: two things you set, nothing ships

Nothing about anyone else's console is in this repository:

- **`config/titles.json` is a template.** Its `write` list is empty, so on a fresh
  clone every title appears *without* a ✔ and every write is refused. Copy the ids
  you are willing to write to into `config/titles.local.json` (gitignored) and they
  start showing ✔:

  ```json
  { "write": [ { "id": "010042d022aea000", "name": "Seedsow Lullaby (demo)" } ] }
  ```

  Reads, backups and the editor install's *source* need none of this - only writing
  into a save does.

- **`config/uids.json` starts empty.** A save archive is keyed by title *and*
  account, so the first title you touch asks which user owns the save:

  ```
  Which user owns this save?
    1) user 1   539fd277…3664
    2) user 2   6cd51710…3664
    3) user 3   e3f05df2…3664
    4) all users (one folder per user)
  ```

  The slots come from the console's account service, not from a list; the answer is
  remembered per title, so it asks once per title at most. `4` probes each account
  read-only and pulls only the ones that actually have a save.

### Console input over WiFi (no kernel extension)

The Mac cannot present a USB keyboard without an unsigned kernel extension, and on
some macOS builds no matching KDK exists, so input runs on an ESP32-S2 instead: the
Flipper WiFi Devboard flashed with `tools/esp32_hid/` is a USB keyboard for the
console and an HTTP endpoint for us at the same time.

```sh
node tools/hid-type.cjs http://<devboard-ip> --status
node tools/hid-type.cjs http://<devboard-ip> 'PRINT 1'
node tools/hid-type.cjs http://<devboard-ip> --stdin < bootstrap.txt
```

Flashing, when the board is in BOOT+RST download mode:

```sh
cd tools/esp32_hid
arduino-cli compile --fqbn esp32:esp32:esp32s2 --export-binaries esp32_hid.ino
arduino-cli upload  --fqbn esp32:esp32:esp32s2 -p /dev/cu.usbmodem* esp32_hid.ino
```

The board prints nothing to the Mac; find it by scanning for its endpoint:

```sh
seq 1 254 | xargs -P 64 -I{} sh -c 'curl -s -m 1 http://192.168.50.{}/status \
  2>/dev/null | grep -q "\"ok\":true" && echo 192.168.50.{}'
```

SmileBASIC inverts letter case on USB keyboards; the firmware applies that rule, so
text goes through `/type` rather than raw HID codes.
## Worked example: Seedsow Lullaby demo, pull then install

One session, one save operation, uid typed once (nicknames are not decoded yet, so
the account is addressed by its 16-byte uid).

```sh
node ~/ns2jb-rpc/run.cjs --rpc 192.168.50.34     # prints: Run folder: runs/switch2-XXXXXX
node tools/kit.cjs ~/ns2jb-rpc/runs/switch2-XXXXXX
```

```
9 installed applications  (✔ = write-allowed)
  [1] ✔ Nora to Oujo to Noraneko Heart 2 (trial)  (010012900d38a000)
  [2] ✔ Seedsow Lullaby (demo)                     (010042d022aea000)
  …

Number 1-9 (blank = quit): 2
account uid (32 hex chars): 539fd27752770010a6ec4984c56d3664   ← once, then remembered

Seedsow Lullaby (demo)  (010042d022aea000)
  (CHOOSE ONE, ONLY ONE SAVE OPERATION IS ALLOWED PER SESSION)
  1) List files in this save (read-only)      [save op]
  2) Save: back this save up                     [save op]
  3) Replace: write files from a directory        [save op]
  4) Install payload files (Artemis launcher)     [save op]
  5) Install the Seedsow Lua Editor save          [save op]
  6) Delete a file (optional)                     [save op]
  7) Verify: compare the save with what we wrote  [save op]
  8) Back to the title list

Number 1-8 (blank = back): 2

$ node tools/save-pull-root.cjs …/switch2-XXXXXX 010042d022aea000 \
      /…/ns2-savekit/saves/Seedsow-Lullaby-demo 539fd27752770010a6ec4984c56d3664
mounted space=User type=Account uid=539fd27752770010a6ec4984c56d3664
  /system.dat (5583 bytes)
  /saveg.dat (2104 bytes)
  …
done: 290 files, 4651736 bytes -> /…/saves/Seedsow-Lullaby-demo
```

Pull lands in `saves/Seedsow-Lullaby-demo/user-539fd277/2026-10-28_0244` - a folder per
game, per account, per pull, so nothing is overwritten and older pulls stay
comparable. No path is asked for. Restart
the console, run the kit again, and choose `5` to put a save *back* — the editor
release is fetched automatically when the directory is missing:

```
Number 1-8 (blank = back): 5
Directory with the editor save (blank = fetch it for me) [~/.cache/…]:
unpacked 273 files into ~/.cache/ns2-savekit/seedsow-editor
$ node tools/save-write-stage.cjs … 275 files, one commit
```

`3` does the same for any directory of files — a backup from another console, a
mod, or a save you built yourself. `7` verifies afterwards, on the *next* boot,
because verify is itself a save operation.
## Install the Seedsow Lua Editor save

Requirements: `node` 20+, `python3`, `curl`, `unzip`, and a held ns2jb session
(`node run.cjs --rpc <computer-ip>` printing `Run folder: runs/switch2-XXXXXX`).

**Step 0 — the target save must already exist.** fsp-srv creates no save data;
the game does. Launch Seedsow Lullaby Demo once, get to the title screen, and
close it fully (**Home → X → Close**). Until you do, every attempt returns
`0x7d402` for all account/space/type combinations.

```sh
# 1. Which account owns the save? (16-byte AccountUid, printed as hex)
node tools/find-save-uid.cjs runs/switch2-XXXXXX 010042d022aea000

# 2. Back the save up (read-only) -- this is required before any write
node tools/save-pull-root.cjs runs/switch2-XXXXXX 010042d022aea000 saves/demo <uid>

# 3. Fetch the editor release (0BSD, from GitHub; nothing is bundled here)
./tools/fetch-editor-save.sh /tmp/seed

# 4. Build the install manifest: existing files become verified replaces,
#    everything else is add-only
python3 tools/build-editor-manifest.py /tmp/seed saves/demo staging/manifest.json

# 5. One transaction: open, write 275 files, commit, re-read and hash them all
node tools/save-write-stage.cjs runs/switch2-XXXXXX 010042d022aea000 <uid> \
     saves/demo staging/manifest.json
```

Boot the demo and choose **Load → slot 1**; the title of that slot reads
**LUA EDITOR V3** and the editor appears. Tested exactly this way on hardware:
275 files, 4,511,900 bytes, every hash identical to the release, no JKSV, no
Switch 1 and no Nintendo save transfer.

If step 5 reports `Directory exceeds the N-entry probe limit`, your copy is older
than the 2048-entry limit — raise it in `tools/save-pull-root.cjs` and
`tools/save-write-stage.cjs`.

## Next: untethered

See [docs/RESULTS.md](docs/RESULTS.md). The launcher already survives
reboots, so the only thing still tied to SmileBASIC is *getting bytes on and off
the console*. Splitting the payload into a stable boot stub plus an
editor-authored `ns2jb.lua` removes the last PC from the loop.

Status of that split, so nobody has to guess:

- `payloads/ns2jb-stub.lua` (loads `save:/ns2jb.lua`), `payloads/ns2jb.lua`
  (body), and `tools/build-untethered.sh` (builds all three files from a backup)
  are written and pass a local smoke test with a mock engine.
- They are **not yet installed on hardware**. What is proven on hardware is the
  single-file launcher (`ns2jb.asb`) running Lua at boot, and the editor install.
- Until the stub is installed, editing the payload still means rewriting
  `ns2jb.asb` from a host with a held session.

## Credits

- **[Seedsow Lua Editor](https://github.com/DialingSpoon527/seedsow-lua-editor)** by
  [DialingSpoon527](https://github.com/DialingSpoon527) — BSD Zero Clause (0BSD).
  This project would not exist without it: its save format notes and
  `tools/asb.py` / `tools/indexed_save.py` are the basis for
  `tools/artemis-save.py`, and its released save is what we install to prove the
  write path end to end. The save itself is **downloaded from their release**,
  never bundled here — see `tools/fetch-editor-save.sh`. If you want to run Lua
  on the console with a proper editor UI, use their project.
- **[ns2jb](https://gitlab.com/kurumuz/ns2jb)** (kurumuz) — the exploit that gives
  the held session every tool here talks to. Not vendored; fetched from upstream.
- **Artemis engine** — no code or assets included; no affiliation.

## Layout

```
tools/     save pull/write/list/enumerate, ASB encoder, caret patcher, FTP mirror
payloads/  Lua that runs inside the game: bootstrap probe, capability probe, env map + pluto fuzz
docs/      TECHNICAL.md (mechanism + IPC layout), RESULTS.md (hardware evidence
           and the untethered roadmap), PATCHED-ENGINE.md (upstream patches)
tests/     offline round-trip and manifest tests (do not prove console behaviour)
```

## Licence and third parties

Our code is MIT (see [LICENSE](LICENSE)). Third-party components and links are
listed in [NOTICE](NOTICE): ns2jb (upstream exploit, linked), Seedsow Lua Editor
(0BSD, its save is fetched, not bundled), and the Artemis engine itself (no
affiliation).
