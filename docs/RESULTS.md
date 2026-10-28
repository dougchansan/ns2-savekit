# Results

Everything here was run on a retail Switch 2 (system software with the microSD
Express support update, item 3 = **(B)**) against the installed Seedsow Lullaby
demo (`010042d022aea000`) and full game (`0100ee5021c9e000`), plus Nintendo
Switch Sports Resort (`04008e001f098000`). Nothing was emulated.

## Save access

| Action | Observed |
| --- | --- |
| Enumerate installed titles over the held session | 9 applications, `BuiltInUser` |
| Open a save that does not exist yet | `0x7d402` for all 3 accounts × 4 spaces × 2 types |
| Open an existing save | `space=User type=Account uid=539fd277…3664 -> ok` |
| Pull full game save | 70 files, 1,993,280 bytes |
| Pull again later (state changed) | 73 files, 2,021,377 bytes |
| Pull demo save after first launch | 9 files, 183,959 bytes |
| Pull save with 275 installed files | 275 files, 4,511,900 bytes |

`0x7d402` is the "no save data" answer, not "in use": a title that has never been
launched reports it for every combination, and it changes to `ok` once the game
creates its save.

## Save launch (Lua inside the game)

Payload v1, installed with the caret retarget `system/ui.asb` → `save:/ns2jb.asb`,
command index `4` → `1`, six event-handler names cleared. Boot produced a **black
screen**, and the pull afterwards returned:

```
/ns2jb-report.txt (1155 bytes)
/save9999.dat     (23367 bytes)   ← still present, not consumed
/ns2jb.asb        (3887 bytes)
```

Report contents (abridged):

```
ns2jb=Lua from save data is running
lua=Lua 5.1
io=table os=table debug=table package=table
os.execute=function io.popen=function debug.sethook=function package.loadlib=function
s.savepath=save:
s.datapath=game:
engine.type=userdata  engine.mt.__index=function
```

So: arbitrary Lua in the shipping game, entered from a save file, with the
engine's own handle. `save9999.dat` surviving means the launcher is not one-shot —
the engine's delete step only runs on its internal suspend path.

Payload v2 added capability probes and an exit through
`jump system/first.iet label="title"`. Boot: black, then **the title screen came
back** — the script ran and handed control back cleanly. Report (968 bytes):

```
open game:/                 -> ok (mount resolves; read returns nil)
open game:/system/init.lua  -> No such file
open save:/ns2jb.asb        -> ok  head="ASB\0\0…"
open sd:/                   -> No such file      (card out)
open /                      -> Invalid argument
open save:/../saveg.dat     -> No such file      (traversal normalised away)
os.execute('true') -> 0     io.popen -> 'popen' not supported
```

Conclusion: full Lua 5.1 with save write, no shell, no `sd:`, no traversal.

## Editor install (third-party save, no JKSV)

`Seedsow-Lua-Editor-Save.zip` v0.1.2 installed into the demo save with
`save-write-stage.cjs`: **275 files, 4,511,900 bytes, 9 replaces, 266 adds**, one
commit, read back and compared:

```
missing []   extra []   hash mismatches []   4,511,900 bytes
```

Then booted and loaded **slot 1**: the editor appeared, with
`Slot 4 sscode004.lua | 85 bytes | TEXT INSERT | Guard ON` and
`Ready. Choose slot 4-120; Save + publish makes it loadable after restart.
Airplane mode is fine.`

That is the released artifact running from a save we installed through our own
write path — no Switch 1, no JKSV, no Nintendo save transfer.

## Game dump (same held session)

OunceCake attached to the running session and mounted `base` + update `65536`
while the FS endpoint stayed live. Mirrored over FTP at ~7.5 MiB/s (74 MiB/s for
the small exefs):

| scope | files | size | manifest sha256 |
| --- | --- | --- | --- |
| whole tree | 95,987 | 20 GB | `76984046eb9721c8…` |
| `base/romfs` | 47,393 | 9.8 GB | `11a6487146b63786…` |
| `base/exefs` | 9 | 59.7 MiB | `67579bde2dfe52f7…` |
| `updates/65536/romfs` | 48,576 | 9.8 GB | `fa64d245cc0edccf…` |
| `updates/65536/exefs` | 9 | — | `41e479786dac1054…` |

## Untethered boot launcher in the demo save

Installed into `010042d022aea000` in one transaction, all four files verified
against a fresh backup before replacement and hashed back after the commit:

| file | bytes | sha256 (prefix) | role |
| --- | --- | --- | --- |
| `/ns2jb.asb` | 1946 | `f800caa253ec0c3a…` | stub: runs the slot-4 program, else `ns2jb.lua` |
| `/save9999.dat` | 27917 | `f19634f017d17b54…` | suspend launcher: `system/script.asb` #42 → `save:/ns2jb.asb` #1 |
| `/ns2jb.lua` | 1344 | `950fbade47f814af…` | body (fallback path) |
| `/sscode004.lua` | 1344 | `950fbade47f814af…` | body as editor slot 4 (`ssslot004.ref` names it) |

`commit -> 0x0`. The stub resolves its program through `ssslot004.ref`, so the
editor owns the loop: Choose slot 4, edit, Save + publish, restart.

## Console authoring limits and the editor's save path

The engine's text-entry dialog returns **at most 32 characters per entry**, and
the editor passes `textfieldsize='2048'` in vain. `Edit line` therefore replaces
a line with at most 32 characters and silently truncates longer ones, which is
why the payload is written with every line <= 32 characters.

The editor's own storage sequence was observed end to end: after one `Save file`
the save contained

```
ns2jb.lua      1142   (the saved edit)
ns2jb.lua.bak  1197   (previous version, kept for Restore .bak)
ns2jb.lua.new  1142   (staging copy, left behind)
```

so console-side saves do complete, and a bad save has a one-generation undo.

## SD card is not reachable from the game

With the microSD **inserted**, boot-time Lua reported:

```
sd no
sdw no
```

The game's VFS exposes `save:` and resolves `game:`, but not `sd:`. There is no
file channel to the card, so payload output cannot leave the save without an
exploit session (or the screen).

## One save operation per boot

The promoted-root save path crashes the host application with `2162-0002` often
enough that the toolkit assumes one save operation per boot: a pull, a write or a
delete, then restart the console. Two read-only opens in the same boot are enough
to trigger it (observed twice, most recently on a second `--list-only`).

`kit.cjs` prints that reminder after every operation it performs. It is not a
limitation of any single action - the same list runs fine as the first operation
of a boot - so the listing feature stays; the rule is what keeps it reliable.

## Measured: more than one operation per boot does work

The one-operation-per-boot rule is a risk heuristic, not a limit. Measured in a
single boot, back to back, with no restart between:

| step | operation | outcome |
| --- | --- | --- |
| 1 | `save-pull-root` (backup) | 289 files, 4,651,736 bytes |
| 2 | `save-write-stage` (payload install, one commit) | replace checks passed, committed |
| 3 | `save-pull-root --list-only` (verify) | listed 289 files; `ns2jb.asb` 1946, `save9999.dat` 28405 |

The session stayed `ready` throughout and reported 72,872 calls afterwards. So
three save operations in one boot succeeded here, where two had failed earlier the
same day (one of those with `--keep-open`, which left the previous session alive
and broke the *next* one at its first IPC).

What that means for the rules in the README: a restart between operations is
advice, not a requirement - it lowers the chance of the host dropping, but the
drop is probabilistic, not per-operation. `--keep-open` is still wrong: leaving a
session alive is what reliably breaks the next one.
## Failure modes observed (worth knowing before you try)

| Symptom | Cause | What fixed it |
| --- | --- | --- |
| `0x7d402` on every space/type | title has no save data, or the app is holding it | launch the game once; close it fully |
| `2162-0002` host crash | promoted-root save operation, ~3 in 5 attempts | one save op per boot, restart after |
| `FS acquisition did not complete` (console response timeout at stage 2/4) | app not freshly opened, or SD card inserted (changes the FS save allocation) | console restart, SD card out, fresh SmileBASIC |
| `find-metadata failed: No candidate reproduced the external allocator link` | timing-sensitive allocator state | console restart and retry |
| `Directory exceeds the 64/256-entry probe limit` | tool-side list cap, not a console fault | raised to 2048 entries |

## What these results do not prove

- Writes were verified by reading the committed bytes back, not by observing the
  game accept them in every case. Where the game did consume them (editor slot 1,
  suspend boot) that is stated.
- File hashes from the dump are local integrity hashes; FTPS here has no per-file
  digest, only a `SIZE` comparison per file.
- The offline tests in `tests/` cover encoders and manifest logic. They are not
  evidence about console behaviour.

---

# Next steps: untethered

# Next steps: untethered

"We are untethered" means: the game runs our code at boot, and we can change that
code, without SmileBASIC, an RPC session, or a PC in the loop. We are already
half-way there, and the remaining half is smaller than it looks.

## What already survives without the exploit

`save9999.dat` + `save:/ns2jb.asb` are ordinary files in the save. The engine
looks for the suspend slot at every boot (`save_prefix="save"`,
`save_suspend=9999`) and resumes it, so **every launch of the game runs our Lua
with no exploit present**. Verified: after a boot that ran the payload, the
launcher file was still there and still pointed at `save:/ns2jb.asb` — the
engine's delete-after-load step only runs on its own `suspend_load` path, which a
retargeted caret bypasses.

So the console no longer needs SmileBASIC to *execute* anything. What still needs
it is everything that moves bytes across the boundary:

| Still tethered | Because |
| --- | --- |
| editing the payload | `ns2jb.asb` is written from the Mac by `save-write-stage.cjs` |
| reading the payload's output | `ns2jb-report.txt` is pulled over fsp-srv |
| re-arming after a game update | the launcher blob is generated on the Mac |

Each of those has a console-only replacement.

## 1. Split the launcher into a stub and an editable body

Today `ns2jb.asb` embeds the whole payload, so changing behaviour means rewriting
the ASB from the Mac. Make it a stub that reads a Lua file and runs it:

```lua
function ns2jb_boot(engine)
  local base = engine:var("s.savepath")
  local file = io.open(base .. "/ns2jb.lua", "rb")
  if not file then return end
  local source = file:read("*a")
  file:close()
  local chunk = loadstring(source, "@" .. base .. "/ns2jb.lua")
  if chunk then pcall(chunk, engine) end
end
```

`ns2jb.lua` is not on the editor's protected list (`ssedit*`, `ssseed*`,
`ssboot*`, `ssethumb`, `sed01–03.`, `ssNNN.asb`), so the editor can write it with
**Save file** or **Save + publish**. That closes the authoring loop: edit on the
console, restart the game, code runs. The stub itself then never needs to change.

## 2. Output on screen instead of in a file

The reason our dialog never appeared during the first launch was that the
suspend-resume path restores a script position, not a drawn scene — nothing had
built the UI. That is no longer true once the editor or the title screen is up.
Have the payload end with a dialog (and keep the `jump system/first.iet
label="title"` fallback), so results are read on the TV instead of pulled.

If a file is still wanted, write it as Lua comments into a slot the editor can
open (`sscodeNNN.lua`) — the editor displays it with no PC involved.

## 3. Re-arm from the console

Re-arming is a byte copy, not a parse: keep a prebuilt retargeted blob in the
save (say `ns2jb-seed.bin`) and have the payload copy it to `save9999.dat`:

```lua
local src = io.open(base .. "/ns2jb-seed.bin", "rb"); local data = src:read("*a"); src:close()
local dst = io.open(base .. "/save9999.dat", "wb"); dst:write(data); dst:flush(); dst:close()
```

`io.open(..., "wb")` on `save:` is confirmed working from inside the game, so a
game update that removes the suspend file no longer costs an exploit session.

## 4. Keep both launchers

The editor's slot mechanism (`save0001.dat` → `save:/sed01.asb`) and our suspend
slot are independent. Keep them both: if a title update changes one, the other
still lands. The editor also gives a third thing we did not have — a way to run a
program **on demand** rather than only at boot.

## 5. Then the native work, still PC-free

With a self-updating boot payload, native-code experiments stop costing exploit
cycles. The v3 payload already sketches the loop: mutate a pluto blob, call
`unpersist`, flush a line per case, and guard against boot loops with a marker
file that disables the risky block after a crash. Once an input kills the
process, the same mechanism persists it for the next boot.

The remaining thing that genuinely wants the exploit is bulk exfiltration —
pulling multi-megabyte dumps off the console. OunceCake over FTP does that well
while a session is held, and it is not needed for anything else.

## Order I would do it in

1. Stub + `ns2jb.lua` loader (one exploit session to install, then never again).
2. Dialog output over a live UI (no session).
3. Seed blob + re-arm (no session).
4. Re-run the pluto fuzz from the boot payload and read the result on screen.
5. Only then spend console time on the malformed-BOWS/pluto native targets.

## Why a second save operation can drop the session (investigation)

Symptom: the first save operation of a boot usually succeeds; a second one often
ends with the host application reporting 2162-0002, or with `console response
timed out`.

What we can rule out: it is not the command interface (the correct commands and
shapes are proven - see the save-info reader numbers above), and it is not the
title or the space (every space behaves the same). What is left is the *lifetime*
of what we open:

1. each tool opens a save filesystem through the promoted root, then closes it;
2. each tool creates a session process and then calls cleanup, which tears down
   the handles it owns;
3. the promoted root itself lives in the exploited process, so anything that
   invalidates its handles affects the next operation.

`save-pull-root.cjs --keep-open` exists to tell those apart: it leaves the save
mounted and skips cleanup, so the next operation runs against a session that was
never torn down. Comparing `--keep-open` against the default across boots is the
experiment: if the second operation survives with `--keep-open`, the teardown is
what kills the session, not the save open itself, and the fix belongs in our
close/cleanup path rather than in the exploit.

---

# 2026-10-28: controller persona, and a console that cannot be woken

Work in this section was done on the same retail console. It ends blocked on
physical input, and the measurements that got there are recorded because each one
rules something out.

## Session attempt: stage 1 hung, and a dead session cannot be re-entered

`run.cjs --rpc` created `runs/switch2-Lxus1B`. The console was already in
SmileBASIC direct mode with the bootstrap loaded from an earlier boot, so the
sequence started at `RUN`:

| step | screen said | host log |
| --- | --- | --- |
| `RUN` | `DIST BOOT READY 1015`, then `OK` (no `RPC RUNNING` this time) | waiting |
| `REMOVE NSR,&H60000000,&H3FFFFFFF` | `Out of memory (REMOVE)` - the required marker | waiting |
| `V=START(39380,192,168,50,235,0,0,0,0)` | `BOOT OK 3925528160` / `HOST CONNECTED` / `RPC RUNNING` | `Connected. Checking the console...` then `1/4 Checking the console` |
| 60 s later | `RPC RUNNING`, no prompt | `Error: Console response timed out; restart the application` |

The console-side program stayed in its native call: a fresh host
(`runs/switch2-uo2cLG`) never saw `HOST CONNECTED` in 45 s, and pressing Enter
(which is `+`/STOP on a keyboard) did not break it. So a session that dies at
stage 1 is not recoverable by another host - it needs the application restarted,
which is the next section.

## The controller work: what the core does, and what the console accepts

All builds below are `arduino-cli` 1.5.1 with `esp32:esp32` 3.3.12 on the
Flipper WiFi Devboard (`esp32s2`), flashed over OTA to `192.168.50.215:3232`.
A `/usb` endpoint reports `mounted` (`ESPUSB::operator bool`), `hidReady`
(`tud_hid_n_ready(0)`), how many reports were sent, and whether the host ever
sent an output report.

| build | descriptor | VID:PID | `mounted` | `hidReady` | outcome |
| --- | --- | --- | --- | --- | --- |
| keyboard only | 63 B keyboard | 303A (Espressif) | true | **true** | typing works (`/type` -> `typed 8`) |
| keyboard only | 63 B keyboard | **057E:0337** | true | **true** | VID/PID alone is not what the console rejects |
| keyboard + GC adapter | 63 + 214 B merged | 057E:0337 | true | false | configured, never polled (`reportsSent` stuck at 2) |
| GC adapter only | 214 B (WUP-028 dump) | 057E:0337 | true | false | configured, never polled |
| Pokken pad only | 89 B gamepad | 0F0D:0092 | - | - | **never tested awake** (console slept first) |

Two things were ruled out along the way:

- **It is not the HID parser.** The core returns NULL from
  `tud_hid_descriptor_report_cb` if `esp_hid_parse_report_map` rejects the
  descriptor, which stalls the interface. Calling that same parser from the
  firmware (a `/parse` endpoint) shows the keyboard descriptor *and* a
  vendor-defined rebuild of the WUP-028 descriptor parse (8-byte input and
  8-byte output reports for the pad). So the descriptor was acceptable and
  something else stopped the console from polling it.
- **It is not `build_opt.h` syntax**, except that it must contain flags only:
  a comment line in `build_opt.h` is split into bare words and the compile fails
  with `cannot specify '-o' with '-c' ... with multiple files`.

Then the console stopped enumerating the device altogether: after several OTA
reboots (each a USB detach/attach) the *proven keyboard build* also reported
`mounted:false`, so the console's USB host, not the firmware, was the wedged end.

## Fingerbot: the documented `/hold` did not exist on the running server

The server answering `192.168.50.235:8080` was started at 01:56, before
`fingerbot/fingerbot.py` was last edited at 02:38. It exposes only
`/press`, `/on`, `/off`, `/status` - `GET /hold?seconds=10` answers
`{"ok": false, "error": "use /press /on /off /status"}`.

That matters because `pulse()` is what sets the sustain DP. The running server's
`/press` is `set(dp1=true)`, and `dp103` (press sustain, tenths of a second) was
**1** - so "press, sleep 10, off" is a **0.1 s tap**, not a 10 s hold.

Starting the current source on a second port works, provided the old server is
stopped first: it holds the BLE connection, and a second scanner finds no
advertisements (`Fingerbot not found`) until it is killed. With that done:

```
GET /hold?seconds=10 -> {"ok": true, "action": "hold?seconds=10", "ticks": 100, "restored": 1}
```

## The blocking measurement

A genuine 100-tick hold should force a Switch off in hardware. It did not:

| probe | result |
| --- | --- |
| `ping 192.168.50.91` immediately after the 10 s hold | replies, 5-8 ms |
| OUI of `192.168.50.91` (`c8:91:43:0d:8c:2e`) | Nintendo - so the console is powered, not off |
| capture during three taps and a 6 s hold | 84 frames, all 8609 bytes, byte-identical (no signal) |
| capture pipeline itself (Mac screen, device `3:none`) | 1.28 MB frame - the card and camera permission are fine |

A console in sleep keeps WiFi up with network standby and drops HDMI and dock
USB, which is exactly what is observed. A 10 s power-button hold cannot be
ignored by the hardware, so the Fingerbot is not reaching the button; every
later probe of the USB personas was therefore taken against a host that was
asleep, and is not evidence about the persona.

## State left behind

- Firmware: **keyboard only, Espressif VID** - the build proven to type
  (`/pad` answers 404, which is how to tell it apart from the controller build).
- Fingerbot: current source serving on **8080** again (it has `/tap` and
  `/hold`), after stopping the stale process.
- Console: asleep, answering ping, with no video and no dock USB; it needs a
  physical power-button press before any session work can continue.
- `tools/loop.cjs` is the supervisor for that sequence. Its power and launch
  stages are written but **untested against a live console**; the bootstrap
  stages are the hand-verified sequence above.

## 2026-10-28 later: power control proven, stage 2 regressed

The console was woken by hand and everything below was then measured against a
live console at the home menu.

### Fingerbot: both directions work, with the right timings

The current `fingerbot.py` (`pulse()`) is what makes a hold possible:

| command | what it does | observed |
| --- | --- | --- |
| `GET /hold?seconds=10` | sets dp103=100, presses, restores dp103 | console powers **off** |
| `GET /hold?seconds=1` | sets dp103=10 | console powers **on** from off |
| `GET /tap` | one 0.1 s press | too short to power on from off; it toggles sleep when already on |

A 10 s hold followed by a 1 s press produced a clean boot to the home menu with
no hands on the console, and the keyboard re-enumerated (`mounted:true`,
`hidReady:true`). The earlier "the fingerbot is not reaching the button"
conclusion was wrong: it was the 0.1 s tap that was too short, and a press while
the console is already on puts it to sleep instead of powering it on.

### The home menu does not accept a USB keyboard

With the proven keyboard build mounted on a console sitting at the home menu,
Left and Enter produced **three byte-identical frames** (632,955 bytes each). So
the keyboard can type into SmileBASIC but cannot launch it; that is exactly the
gap the controller work is meant to close.

### The Pokken persona is accepted at the USB level, but not as input

Merged keyboard + pad build, VID/PID `0F0D:0092`:

```
usb: {"mounted":true,"hidReady":true,"readyChecks":16034,
      "reportsSent":161,"outReports":1,"lastOut":"00 01"}
```

The console configured the interface, polled it continuously, and sent one
output report - the first time a controller persona got that far (the
GameCube-adapter builds were configured but never polled). It is still not
**input**: sweeping all 13 button bits and all 8 hat values left the screen
byte-identical, so the driver is reading reports but not mapping them to a
controller. One capture during the sweep was colour-corrupted (pink/green
static) which is a capture artefact, not a UI change - worth knowing before
reading a frame hash as evidence.

### The board crashes in pad-streaming mode

Twice, while streaming pad reports, the ESP32 dropped off WiFi entirely (no
ping, no HTTP, no mDNS) and needed a power cycle. The keyboard-only build had
run for hours. The first fix (gating sends on `tud_hid_n_ready` and a 3 ms
timeout instead of the 100 ms default) was in place for the second crash, so
that was not sufficient and the cause is still open.

### Stage 2/4 has regressed since 23:02

Every attempt after 22:53 has died in `2/4 Acquiring FS memory`:

| time | error |
| --- | --- |
| 22:53 | **success - 4/4** |
| 23:02 | `Console disconnected` |
| 03:14 | `Native batch did not terminate; resources retained` |
| 09:03 | `Unexpected manager allocation size: 12288` (expected 59 x 208 = 12272) |
| 09:24 | `Switch 2 application connection is not ready` |

The 09:03 attempt is the informative one: a deterministic accounting check, not
a timeout. And it is not a system update - `sdkCrc32` is `3925528160` in both the
22:53 success and the 09:24 failure, so the game binary is the same. Seven
successes before 23:02 and five failures after it, with a clean power cycle and a
freshly launched app in between, is a regression rather than the documented
2/4 flakiness.

Not the cause: no microSD card is inserted (checked with the operator).

## 2026-10-28 later still: what the console will and will not accept as a controller

All tests with the console awake at the home menu, video live, and `/usb` read on
the device.

### The official GameCube descriptor cannot be served

| descriptor | length | `esp_hid_parse_report_map` | console |
| --- | --- | --- | --- |
| official WUP-028, byte-for-byte | 214 | **false** | interface never configured (`hidReady:false`) |
| official with `09 00` -> `09 01` (usage 0 -> 1) | 214 | **false** | same |
| official with a usage added to every nested collection | 232 | **false** | same |
| rebuilt with vendor page, same report ids/lengths | 138 | true | mounts, but never configured or polled |
| rebuilt with Generic Desktop/Gamepad | 89 | true | pad-only: never configured; merged with keyboard: polled |

The core calls `esp_hid_parse_report_map` before it will answer
`GET_DESCRIPTOR(report)`; when that fails it returns NULL and the host's request
STALLs, so the interface is never set up. Espressif's parser rejects the official
descriptor even after those edits, which means the one descriptor Nintendo's
GameCube driver would recognise is the one we cannot present.

### A device that parses still is not a controller

Pad-only builds that parse (GameCube vendor rebuild, Pokken 90-byte) mount but are
never configured - the console does not bind a generic gamepad.

Merged keyboard + gamepad builds *are* polled (`hidReady:true`, reports climbing,
one output report received), but that is the keyboard driver owning the interface:
a full sweep of 13 button bits and 8 hat values, compared on a 1200x1000 crop with
the clock excluded, changed nothing at all. Pressing A does not launch a title.

So on this console, for this toolchain: **keyboard yes, controller no.**

### Two operational facts worth keeping

- The console sleeps roughly **65 s** after it stops receiving input: video is up
  at t=20 s, and by t=70 s the capture is black and USB is gone.
- The devboard is powered from the dock, so it loses WiFi whenever the console
  sleeps or is off. Every "the board crashed" observation was this; there was
  never a crash, which also means the send-timeout bug fix was chasing a ghost.
- The Fingerbot's arm travel (`dp102`) matters: at 85 the arm does not reach the
  button and every press is silently a no-op. Restored to 95, a 16 s hold
  (`dp103=160`) powered the console fully off, and a 1 s press brought it back.
