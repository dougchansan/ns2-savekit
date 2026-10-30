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

## 2026-10-28: Switch Pro Controller persona (in progress)

`tools/esp32_pro` presents a Nintendo Switch Pro Controller (`057E:2009`,
"Pro Controller") with the official 209-byte report descriptor, taken from
espp's `hid-rp` (which matches a real controller dump) and printed from a host
build of those constexpr templates. The protocol is ported from espp
`switch_pro`: 0x81 device-info announce on attach (retried until the host
answers), 0x80 init commands (device info / handshake echo / baud rate /
enable-USB-HID), 0x01 subcommands answered with 0x21 replies (`0x02` device
info, `0x03` report mode, `0x10` SPI read with the factory/user calibration
blobs, `0x30` player lights, `0x40` IMU, `0x48` vibration, NFC/IR stubs), and
0x30 input reports at 125 Hz once the host enables USB HID.

Measured so far:

| observation | result |
| --- | --- |
| device enumerates as `057E:2009` | `mounted:true` |
| HID interface configured by the console | **`hidReady:true` once**, at 10:39 |
| host init traffic (`outReports`) | 0 - the 0x80/0x01 handshake has not started yet |
| later attaches (flash, `/reboot`, power cycle) | `mounted:true`, `hidReady:false` |

So the identity and descriptor are accepted by the console at least once, which
no other persona achieved; the handshake itself has not been observed. What is
blocking iteration is now the environment, not the protocol: the console sleeps
about **55 s** after it stops receiving input (keys do not count - measured over
three minutes), and the devboard is powered from the dock, so it drops off WiFi
with the console. Every flash (~35 s) and every attach must fit inside that
window, and most of tonight's attempts lost the race mid-flash.

### Pro Controller persona: where it stops

Refinements and the exact symptom:

| probe | result |
| --- | --- |
| `descRequests` after attach | **1** - the console does fetch our 209-byte report descriptor |
| interface configured (`hidReady`) | false, every attach since the first flash (one earlier read of `true`, unexplained) |
| host init traffic (`outReports`) | 0 - the `0x80` handshake never starts |
| home menu controller indicator | shows only the built-in Joy-Con; our device is not adopted |
| identity refinements tried | `bcdDevice` 0x0210 (a real pad reports 2.10), `bcdUSB` 0x0200, product/manufacturer strings |
| report sizes checked by parsing the descriptor | 0x21/0x30/0x81 all 63 bytes, i.e. 64 on the wire - they fit the endpoint |

So the console gets as far as asking for the report descriptor and then declines
the device, with no handshake traffic at all. The next things to compare are the
parts we have not matched byte-for-byte: the complete configuration/interface
descriptor (bInterval, endpoint order, `iInterface`), and a real controller's
descriptor length (203 vs our 209) - espp claims a byte-for-byte match, but that
claim is worth verifying against a dump before trusting it.

Two useful side effects of this work: the console **stays awake while our USB
device is attached** (it slept every ~55 s before), and the devboard is
battery-powered, so it no longer drops off WiFi with the console.

## 2026-10-28 15:30-16:10: the pad-driven loop, and where stage 2 now fails

The other agent's work was verified end to end with the pad, not by hand:

- **The Pro Controller is adopted.** `/usb` shows `handshake:true`, `pairStep:4`
  and the console's init sequence (`80:05 80:01 80:02 1:03 80:04 1:48 1:02 1:08
  1:10 ... 1:40 1:30`). With the pad I navigated the home menu, picked the
  **retail** SmileBASIC 4 tile (the white tile with no DEMO banner), selected the
  `doug` account, dismissed the tag/info dialogs and took "Make a Program" into
  direct mode: `SMILEBASIC for Nintendo Switch ver 4.4.9 ... OK`.
- **Typing via the Flipper bridge works.** `flipper2jb` could not start Bad KB
  while it was already open (`RPC status 17`), but sending the three input events
  from its own start path (`request(23, integer(1,4)+integer(2,typ))` for
  typ 0,2,1) ran the session script. The console printed `BOOT OK 3925528160 /
  HOST CONNECTED / RPC RUNNING`, and `rpc.cjs <run> status` reported
  `ready: true`, 896 calls.

### Stage 2 after the harness fix

The pin-accounting retry works: the reserved-gap record that used to fail with
`Unexpected manager allocation size: 12288` now reports `allocated: 12272` (the
expected 59 x 208) across 23 reservation checks. Three attempts inside the run
then died later, each differently:

| attempt | error |
| --- | --- |
| 1 | `Overwrite missed the qualified canary; retain resources for recovery` |
| 2 | `Native batch did not terminate; resources retained` |
| 3 | `Console response timed out; restart the application` |

So the 12288 bug is gone; what remains is the timing-sensitive heap grooming.
A new hypothesis worth testing: the pad streams `0x30` input reports at 125 Hz,
which is a continuous USB interrupt load on the console exactly while the
exploit is grooming the heap. A `/pause` on the pad (stop streaming after the
menu work, before `V=START`) would test that cheaply.

### Two environmental faults seen again

- **HDMI output dies while the console is alive.** After launching SmileBASIC the
  capture went black at 1080p, 1440p and 720p while the console answered ping and
  kept polling the pad (`reportsSent` climbing, `rawSet` climbing). A power cycle
  restores it; the app launch seems to trigger it.
- **The Fingerbot lost its travel.** `dp102` (down) and `dp105` (rest) were both
  95, so `/press` moved nothing until the arm was reseated; even then the 16 s
  hold only powered the console off on the second attempt. `/press?seconds=N` is
  the endpoint to use (switch mode, host-timed).

## 2026-10-28 17:46: 4/4, reached by the automated cycle

`tools/cycle.py` now goes from a wedged console to a held FS root with no hands
and no fixed tile offsets. The run that did it: `switch2-cyPbdM`, `4/4 REACHED`,
`switch2/ro/root/current-root.json` present, `list-apps` reporting 9 titles.

What it took, in order:

1. **Power**: 16 s force-off, 1 s press (Fingerbot `/press?seconds=N`).
2. **Leave the news view**: the console boots onto the news channel, where no
   tile is selected and no title label exists. **B** (or HOME) enters the game
   row. The earlier DOWN presses were pushing focus onto the icon row and made
   the menu look empty.
3. **Select by reading the screen**: macOS Vision OCR (`tools/vision/ocr.swift`,
   built with `xcrun swiftc`) reads the title label above the selected tile. The
   cycle steps RIGHT one tile at a time until the label names SmileBASIC (and not
   DEMO). A fixed offset cannot work: the row reorders with recency and skips
   virtual-game-card tiles.
4. **Drive the dialogs by text**: "who is using the software" -> A, "tag
   information" -> A, "Make a Program" -> A, then wait for `bytes free`.
5. **Silence the pad**: `/stream?on=0` stops the 125 Hz 0x30 reports during the
   acquisition (the one console-side load we can remove); `/stream?on=1` before
   navigating.
6. **Session**: start `run.cjs`, upload a fresh script through the Flipper bridge,
   press Run, wait for 4/4 / `current-root.json`.

Stage 2 took 3m38s this time and passed.

### Then a sweep wedged the native path

`tools/probe-commands.cjs <run> 0 24` (attempting to find an fsp-srv
`OpenSdCardFileSystem` id) left the session answering `status` but refusing every
native request with `Another memory request is active`. `list-apps` had worked
seconds earlier, so the probe itself is what wedged it: one command in 0..24
blocks rather than returning. If that sweep is retried it must be narrowed and
run only on a throwaway session.

### SD card, what is known

- The savekit has **no** SD-card path: it opens save archives through fsp-srv
  51/53 on the promoted root, and those take a `SaveDataAttribute` (space,
  program id, uid, type). Spaces include `2 = SdSystem` and `4 = SdUser`, so a
  *save* can live on the SD, but that is not the SD filesystem.
- SmileBASIC's own `TXT:` project storage — the thing `LOAD "TXT:NS2"` reads — is
  on the SD card, so the game clearly reaches it; that is the path the operator
  meant by "SD works, it is just RNG".
- Reading arbitrary SD files over the exploit needs an SD filesystem open on the
  promoted root, which is what the sweep was looking for.

## 2026-10-28 18:49: SD card inserted, tested from SmileBASIC itself

The operator inserted a microSD card and asked whether savekit can pull from it.
Two separate paths exist, and the game-side one was tested directly by typing
BASIC through the Flipper (no exploit needed):

| typed | console answered |
| --- | --- |
| `FILES "SD:/"` | `Illegal format (FILES)` |
| `FILES "SD:"` | `Illegal format (FILES)` |
| `OPEN "SD:/x.txt" FOR INPUT AS #1` | `Syntax error` (this build's OPEN syntax differs) |
| `FILES` | `-- 3 files --` then `TXT:@BACKUP.PRG`, `TXT:@BACKUP.TXT`, `TXT:NS2` |

So SmileBASIC 4.4.9's programmatic file API exposes **only `TXT:`**; `SD:` is
rejected as an illegal device format, deterministically, not intermittently. The
`TXT:` store is where the `NS2` payload lives, and it is the same store that
`LOAD "TXT:NS2"` reads; pulling it never needed the SD card (the save-pull tools
already do it).

What has *not* been tested is the TOPMENU **File Manager**, which is a separate
code path from the BASIC `FILES`/`OPEN` commands and is the only place the card
might actually be visible to the game. Reaching it from direct mode was not
solved in this session (B and + did not open the menu).

Exploit-side, nothing changed: savekit has no SD filesystem open, and an unknown
fsp-srv command id wedges the session (see the 17:46 entry), so the sweep that
would find one has to run on a throwaway session.

### The card and stage 2

With the card inserted, two of three attempts failed before the session (tile
selection) and the one that connected failed stage 2 in 3m50s. Without the card,
stage 2 passed twice today. That matches the existing failure-table entry ("SD
card inserted changes the FS save allocation"). One pass/fail is not proof, but
the direction is consistent: keep the card out for the exploit, card in for any
game-side SD test.

## 2026-10-28 19:20: save moved to the SD card, and the pin cost it changes

The operator moved SmileBASIC's save to the microSD card (System Settings > Data
Management) and asked for another attempt. The console launches the game and the
RPC connects, but stage 2 fails in every attempt so far, and the failures name a
number worth recording:

**`Pinning allocation cost changed` — measured `pinCost = 14992`.**

With the save on internal storage the pinned allocation is **13616** bytes; with
the save moved to the SD card it is **14992**. `probe-reserved-gap.cjs` asserted
the constant exactly, so the acquisition aborted at the pin.

`engine/switch2/memory/probe-reserved-gap.cjs` now logs the measured cost and
accepts **either 13616 or 14992**. With that, attempt `iStKAD` moved past the pin
and failed later at `Overwrite missed the qualified canary`, i.e. the gate was
real and is now passed, but the rest of the acquisition is still not landing:

| run | result |
| --- | --- |
| jdi5V5 | pin did not land in the canary window |
| EVQ78U | pin cost changed (13616 asserted, measured 14992) |
| XEZ0ei | pin cost changed |
| bSTw3j | pin cost changed |
| iStKAD | overwrite missed the qualified canary (after accepting 14992) |
| Yb06QR | FS acquisition did not complete (7 min, no error row) |

So moving the save to the SD card is not just "insert a card": it changes the FS
save allocation the heap groom depends on, and the groom has not been re-tuned for
it. The card can stay for game-side tests, but a 4/4 session today needs the save
back on internal storage (and, per the earlier note, the card out).

---

# 2026-10-29: input was never broken; there is no SD card; stage 2 fails at the canary

Everything below was measured against the same retail console, docked, with the
capture card and the ESP32-S2 devboard attached. Frames are in `docs/images/`.

## The board was in keyboard mode all along, and `/status` was lying

The prompt for this session said the board ran `hid-pad-1`, whose `/type` returns
`{"ok":true}` and types nothing. Both halves were wrong, and the second one is a
tooling bug worth keeping in mind:

| probe | result | what it means |
| --- | --- | --- |
| `GET /status` | `"fw":"hid-pad-1"`, `padButtons`, `hat` | **always this string in every build** |
| `GET /pad` | **404** | the pad endpoints are compiled out |
| `GET /usb` over 9 s | `readyChecks` stays **0**, `reportsSent` 0 | `streamPad()` is compiled out |
| `GET /type?text=1` then `PRINT 1` | screen showed `1PRINT 1` | **typing works**; the `1` and the next line coalesced |
| `PRINT 1` alone | prints `1` (frame `2026-10-29-input-print1.png`) | keyboard HID is fine |

`esp32_hid.ino`'s `/status` handler had an unconditional `"fw":"hid-pad-1"` literal,
so *every* build of that sketch claimed to be the pad build. That is why "OTA
silently failed to replace the pad firmware": the OTA had worked, and the status
string could not show it. The handler now reports the build it was compiled as
(`hid-kb-1` / `hid-pad-1` / `hid-both-1` plus `keyboard` and `padEndpoints`
booleans), and the keyboard build reports
`{"fw":"hid-kb-1","keyboard":true,"padEndpoints":false}`.

## OTA works in both directions, unattended

`espota.py` against `192.168.50.215:3232` replaced the firmware with no hands on
the board, twice in one session:

| wrote | board then reported | evidence |
| --- | --- | --- |
| `esp32_pro.ino.bin` (1,008,064 B, `/bridge` + `/flipper/*` present) | `fw: pro-2` | `/usb` `handshake:true`, `pairStep:4` after boot |
| `esp32_hid.ino.bin` (`-DKEY_ONLY`) | `fw: hid-kb-1`, `padEndpoints:false` | `/type` typed the exploit lines |

The Pro Controller persona is adopted by this console with no pairing UI
(`descRequests:1`, host init `80:05 80:01 80:02 1:03 80:04 1:48 ... 1:30`), which is
what makes an unattended cycle possible: pad firmware to navigate the home menu,
keyboard firmware to type inside SmileBASIC. Both flashes fit inside the console's
awake window.

## Home menu navigation by OCR works, including System Settings

With the pad adopted, the cycle selected the retail SmileBASIC tile by reading the
label above the focused tile (`•SmileBASIC 4`, then `SmileBASIC 4 Demo Version`,
then `Nintendo Switch Sports Resort`), pressed A, and dismissed the account picker,
the tag-information dialog and its network error (`2155-8007`) to reach direct mode.
Frame `2026-10-29-home-retail-tile.png`.

Inside System Settings the icon row was walked the same way, reading the label
under the icons: `Nintendo Switch Online, GameChat, News, Nintendo eShop, Album,
GameShare, Controllers, Virtual Game Cards, System Settings`.

## There is no SD card in the console

`System Settings > Data Management`, read on screen (frame
`2026-10-29-settings-no-sdcard.png`):

```
System memory      Space available  173 GB
microSD Express card                Not inserted
```

That settles a question the design was built on: **no `main` can be placed on the SD
card right now, and `OpenSdCardFileSystem` cannot be exercised with a card
present.** The SD route is blocked by the physical state of the console, not by the
exploit. It also means SmileBASIC's save is necessarily on internal storage, so the
earlier "save moved to the SD card" condition (pin cost 14992) does not apply to
today's runs.

## Stage 2: two failures, with the exact step and numbers

Success is `switch2/ro/root/current-root.json`; the acquisition writes one `STEP`
line per setup call and a JSON report per attempt.

| run | attempt | where it stopped | numbers |
| --- | --- | --- | --- |
| `switch2-tzBAZl` 13:44 | 1 | `STEP clone-save` → joinAll | `Native batch did not terminate; resources retained` |
| `switch2-tzBAZl` 13:44 | 2 | after `free-space save` | `Console response timed out` (app already wedged) |
| `switch2-YzLRzL` 13:57 | 1 | after metadata + canary waves | **`Overwrite missed the qualified canary`**, `metadataAttempts 4`, `waveAttempts 30`, `freeSpace.save 66,977,792` (required 20,971,520), `freeSpace.tmp 491,520` (required 65,536) |
| `switch2-YzLRzL` 13:57 | 2 | — | `Console response timed out`, `freeSpace.save` down to `50,184,192` |

Readings that follow from it:

- `clone-save` was **not** an SD-card stall (no card is inserted); the first attempt
  passed it, and the step marker's other meaning - the native worker stalling -
  is what happened.
- The canary miss is the same failure recorded on 2026-10-28 as `iStKAD`, and the
  pin-cost assertion did not fire, so the 13616/14992 gate is not what stops it now.
- A wedged attempt costs the *next* attempt inside the same run (it starts against a
  console that is still inside the previous native call), so **one attempt per boot**
  is the operating rule; the in-run retry loop cannot recover through a wedge.
- 66 MB is free in SmileBASIC's save, so the "20 MiB save as storage" fallback has
  more room than the prompt assumed.

## NSO verification is implemented and tested (host side)

`tools/nso-verify.cjs` parses the header per switchbrew's NSO0 layout, checks magic,
version, reserved word, unknown flags, section file ranges (in order, non-overlapping,
inside the file), page-aligned memory offsets, module name at 0x100, and then LZ4
decompresses each compressed section and compares its SHA-256 with the hash in the
header. Section layout is confirmed by arithmetic on the real files:

```
main: text 0x108+0x1786d9 = rodata 0x1787e1; +0x98584 = data 0x210d65; +0xfbb5 ≈ 0x220d5a = filesize
```

Measured on three genuine exefs segments: `main` (module `Artemis`), `rtld`
(`nnrtld`), `sdk` (`nnSdk`) - **all three section hashes verify**, which is what
proves the LZ4 decoder rather than assuming it. `tests/test_nso_verify.cjs` builds
an uncompressed NSO, then corrupts it four ways; 13/13 pass:

```
synthetic uncompressed NSO passes           flipped byte in real NSO -> exit 3
text offset inside the header -> exit 3     truncated real NSO -> exit 3
data past EOF -> exit 3                     missing file -> exit 4 (not 3)
zeroed text -> exit 3                       --no-hash still checks structure
```

One real anomaly: the demo's `main` declares `bss = 0x22010c70` (~571 MB) while
`rtld` and `sdk` declare small bss. bss is not page aligned in any of them, so
alignment is only a note; 571 MB is large enough to be worth a second look, but the
file's hashes are intact, so the header is self-consistent.

## SmileBASIC program metadata: what is where

The prompt pointed at `saves/all/Seedsow-Lullaby-demo/f/###/META`; that path does not
exist. The SmileBASIC 4 save is a separate title (`saves/all/SmileBASIC-4-demo/`)
and contains exactly five files:

| file | size | content |
| --- | --- | --- |
| `f/###/META` | 11152 | header + name + thumbnail (below) |
| `f/###/TNS2` | 2986 | the `TXT:NS2` program (our bootstrap) |
| `f/###/T@BACKUP.TXT` | 2960 | `TXT:@BACKUP.TXT` |
| `config.dat` | 4416 | `c4BS` magic, then 64-byte-ish tool entries `#TOOL/SBSMILE.PRG`, `#TOOL/GAHAKU.PRG` |
| `tag.dat` | 14004 | **100% zero except one byte** - no tags set |

`META` is exactly `0x70 + 40*69*4 = 11152` bytes, and the 11040-byte tail renders a
crisp 40x69 32-bit gear-smiley icon (any other width/start gives a sheared image).
But the same offset 0x70 holds the UTF-16 text `PCPM0005` + `[WORKSPACE]`, and the
program list on screen does show `[WORKSPACE]` in the bottom-left of direct mode. So
the name bytes and the pixel data overlap, and one of two readings must be true:

1. the file is `0x70` header + `PCPM0005` + name + pixels, and the "crisp icon" is
   the icon area starting later than 0x70; or
2. the icon really starts at 0x70 and the name is painted into its first pixels.

Neither has been proven, and the prompt's "look at the files and mutate a backup" step
is exactly the experiment that settles it: rename the workspace on the console, pull
the save, diff `META`. That needs a live session and is the next metadata step.

## Name and artwork on the HOME MENU are not reachable from a save

This is the claim the mission asked to settle before promising anything, and the
answer is the pessimistic one:

- the tile's name and artwork on the HOME menu are metadata of the **title**, in its
  control data (the NACP inside the signed control NCA). Save data is a separate,
  writable archive; nothing in it is consulted for the tile;
- observed on this console: the HOME tile reads **`SmileBASIC 4`**, while the
  save-controlled workspace name is **`[WORKSPACE]`** and the store contains `NS2`.
  Three different strings - the menu is not reading our save for the tile;
- no NACP was available in this session to inspect directly (the exefs/romfs dumps on
  the host contain no control NCA), so the NACP statement rests on the platform
  layout plus that observation, **not** on a failed rename attempt.

Therefore the launcher entry that can honestly be renamed is the **program/project
entry inside SmileBASIC** (its name and thumbnail, in the save), or the Seedsow save's
own launcher path - not the HOME tile. No home-menu rename is claimed anywhere in
this repository.

## 2026-10-29 later: five boots, five stage-2 failures, and what that means

After the measurements above, five full boots were driven end to end with the new
harness (OTA pro -> power cycle -> OCR to retail SmileBASIC -> OTA keyboard -> type
the four lines). Every boot reached direct mode; every boot failed stage 2, at a
*different* step each time:

| boot | run | stopped at | numbers |
| --- | --- | --- | --- |
| 13:44 | `tzBAZl` | `clone-save` | `Native batch did not terminate; resources retained` |
| 13:44 | `tzBAZl` | (in-run retry) | `Console response timed out` |
| 13:57 | `YzLRzL` | canary | `canaryChanged:true`, `markerSelected:false`, 4 metadata, 30 waves, free 66,977,792 vs 20,971,520 |
| 14:06 | `HUNLNS` | after canary landed | `canaryChanged:true`, `markerSelected:true`, then `Console response timed out` |
| 14:16 | `2QJTXK` | `clone-save` again | stalled 2 min, then acquisition aborted |

The screen after the last failure showed `BOOT OK 3925528160 / HOST CONNECTED /
RPC RUNNING` - the application is **alive and wedged inside our native batch**, not
crashed (no `2162-0002`). So the failures are not "the console died"; they are the
in-app native worker failing to complete, at whichever step it happens to stall.

Because the failure point moves between boots, this is a placement/timing race in
the groom rather than one broken call, and repeating the same boot is not a
measurement. The reading that does follow: stage 2 succeeded 7 times on 2026-10-28
and has failed 5/5 today on the same game binary (`sdkCrc32 3925528160`), so
something about the environment changed and has not been identified. The
non-timeout knob that exists (`NS2_CONSOLE_TIMEOUT_MS`, `NS2_NATIVE_TIMEOUT_MS`)
only moves the failure, per the commit that added it.

## Harness defects found by running it (both now fixed)

| symptom | cause | fix |
| --- | --- | --- |
| confirm dialog stayed up, then `RUN` typed into it | the console **drops the first HID report** after a re-enumeration, so the first Enter never landed | prime the keyboard with a bare Shift after every flash, and retry Enter until the dialog is gone |
| harness aborted although the console printed the marker | Vision splits `Out of memory (REMOVE)` across lines, and the pattern was the whole sentence | match the distinctive word (`memory`, `boot\s*ready`) instead |

## SmileBASIC `META`: the name is 32 bytes inside the thumbnail

`META` is `0x70` header + `40*69*4 = 11040` bytes. The thumbnail is BGRA at `0x70`
(verified pixel-for-pixel against an independent decoder: 0 differing pixels), and
the file's first pixels are literally the metadata:

```
row 0, pixels 0..7:  50 43 50 4d | 30 30 30 35 | 5b 00 57 00 | ...
                     "PCPM"       "0005"        "[W"
```

So the layout is: 8-byte tag `PCPM0005` + a **NUL-terminated UTF-16 name, filling a
32-byte block** at `0x70..0x8f`, which overlaps the thumbnail's first 8 pixels (a
black margin, so nothing is visibly lost). `[WORKSPACE]` is 11 characters = 22 bytes
+ NUL = 24, exactly filling the block after the tag.

Consequences, stated as what is measured and what is not:

- measured: the name occupies at most 32 - 8 = 24 bytes, i.e. **11 characters plus
  NUL** in this sample, and the `[WORKSPACE]` label is what direct mode draws;
- not measured: whether the engine reads the name to the NUL (variable length) or to
  a fixed 32-byte boundary. **"Homebrew Launcher" (17 characters) does not fit the
  observed block**, so the launcher name will have to be shortened (e.g.
  `HOMEBREW`) unless a rename experiment shows the field grows;
- the experiment that settles it is: rename on the console, pull the save, diff
  `META` (`node tools/smb-meta.cjs diff old new`). It needs a live session.

`tag.dat` is 14003 zero bytes out of 14004, so no tags exist to carry a name;
`config.dat` is a `c4BS` list of tool programs (`#TOOL/SBSMILE.PRG`,
`#TOOL/GAHAKU.PRG`), not the program list.

## Payload v1 exists, and refuses to lie about execution

`payloads/ns2jb-launcher.lua` + `payloads/nso-verify.lua` implement the part of the
launcher the sandbox can actually do, and say so on screen:

| condition | dialog |
| --- | --- |
| no `sd:` at all (measured on this console) | `missing main on sd card` + `sd: not available in this sandbox` |
| `sd:` present, no `main` | `missing main on sd card` + `file not found` |
| `main` is not an NSO0, or is truncated | `invalid main on sd card` + the reason |
| `main` passes the header checks | `main verified: <module>` + sizes + `execution needs FS privileges - not done` |

It does **not** execute `main`, and the dialog says so: execution needs a native
loader with FS privileges, nothing measured gives the Lua sandbox one (io yes,
io.popen no, `sd:` refused, no native load proven), and the escalating step lives in
the BASIC bootstrap which needs a host. A payload that claimed to run `main` from
Lua would be reporting something that has not happened.

Offline tests (`lua tests/test_payload_lua.lua`, 13/13) drive the launcher against a
stubbed engine and filesystem, and run `nso-verify.lua` against the demo's real
`main`: structure accepted, `contentsVerified = false` (no LZ4 in the sandbox), and
the launcher's dialog says `contents not hashed`.

## 2026-10-29 later still: the launcher entry is the PLAYMENU card, and names have rules

Done on the console in direct mode, with no exploit session: F12 opens TOPMENU,
`Projects` (up twice, A) opens the **PLAYMENU**, which is the list a user picks a
program from. Frame `2026-10-29-playmenu-card.png`.

```
PLAYMENU   [Local] Samples Published Works Public Key
  card: gear icon  [WORKSPACE]        (title)
        [WORKSPACE]                   (file name)
        2026.10.22 14:52:51  size 20275
  right: Title [WORKSPACE] / File Name [WORKSPACE] / User Name / Details / Tag
  footer: A Hold for Submenu   - Display Files   B Back   A/+ Run
```

So the thing that can honestly be renamed is **this card**: its Title, its File
Name and its geometry come from the project's save metadata (the `META` name and
its 40x69 icon), and it is what "launching from the console's own menu" means for
this chain. It is still not the HOME tile.

### Filenames: no spaces, at least 16 characters

| typed | console | evidence |
| --- | --- | --- |
| `SAVE "TXT:HOMEBREW"` | `OK`, and `FILES` then lists `TXT:HOMEBREW` | `2026-10-29-files-after-save.png` |
| `SAVE "TXT:HOMEBREW LAUNCHER"` | **`Illegal format (SAVE:1)`** | `2026-10-29-savename-illegal.png` |
| `SAVE "TXT:HOMEBREWLAUNCHER"` | accepted (16 chars) | the save dialog showed that File Name |

So `Homebrew Launcher` cannot be a filename: spaces are rejected outright. A
single-token name of 16 characters is accepted.

Two further facts from the same measurements:

- saving under a new filename does **not** change the project name: the bottom-left
  label stayed `[WORKSPACE]` and the PLAYMENU still showed one card, `[WORKSPACE]`.
  Files and projects are different things, and only the project card is pickable.
- the PLAYMENU's `Tag` field is empty, consistent with `tag.dat` being zeros.

### Negative result: the rename submenu did not open

`A Hold for Submenu` is advertised in the footer. Two pad holds (1.4 s and 2.0 s,
`/pro?a=1&raw=1` then release) left the screen unchanged. It is not known whether
this is the pad's A not reaching a "hold" handler, or the submenu needing a
different button; what is known is that the rename was **not** exercised from the
UI. The rename path that remains is the one this project is built around: write the
`META` name (and icon) into the save and read the card afterwards.

### The Flipper bridge works; Bad KB typing does not reach the console

`GET /flipper/ping` on the pro firmware answered
`{"heartbeat":true,"baudOk":true,"rpcOk":true}`, and `/flipper/type` +
`/flipper/run` staged and started a Bad KB script twice (`wrote 10`, `app: Bad KB`).
Nothing was typed on either attempt (12 s settle on the second). So the UART side
of that bridge is healthy and the Flipper's USB is not in the console's USB path in
this rig, which leaves the ESP32 keyboard build as the only typing channel - and it
requires an OTA re-enumeration after SmileBASIC has already launched.

## 2026-10-29 14:38: 4/4 after applying the missing engine patches

The five failures above were tested against an engine that was **missing two of the
patches this toolkit requires**. `patches/README.md` lists them and says to apply
them before `run.cjs` starts, because the host copies `engine/` into each run folder:

| patch | state before | state now |
| --- | --- | --- |
| `0001-shared-ipc-pointer-descriptors.diff` | absent (7 of 54 added lines present, all incidental) | applied verbatim |
| `0002-mounted-save-inspect-export.diff` | absent (0 of 2) | applied, merged with upstream's renamed `resolved` field |
| `rest-engine-lib-bridge.cjs.diff` | absent | applied |
| session / ncm / find-metadata / probe-reserved-gap / run | already present | unchanged |

With those in place, the very next boot reached **4/4**: run `switch2-uy0bDz`,
root held at 14:38:47, `current-root.json` with `pid: 1`, `rootHandle: 26509737`,
`calls 39068`, and the pipeline in its held state
(`switch2/fs-execution-current.json` with `retainedEndpoint.ready`).

That is one boot, so it is not proof that the patches were the only cause - but the
contrast (0/5 without, 1/1 with, same console, same game binary, same harness) is
the strongest signal recorded today, and the patch notes predict exactly this class
of failure. The two patch-dependent capabilities were then observed working:

| capability | evidence |
| --- | --- |
| `ListAllUsers` | `save-pull-root.cjs` printed `account users: 3` - before 0001 this fails with `transport 0xf601` |
| installed-title enumeration | `list-apps.cjs`: 9 applications, `BuiltInUser` |
| held FS endpoint for tools | `fs-execution-current.json` `retainedEndpoint: {ready: true}`, `list-apps` ran against a live session |

Installed titles seen (this boot):

```
0x010012900d38a000  Nora to Oujo to Noraneko Heart 2 (trial)
0x010042d022aea000  Seedsow Lullaby (demo)
0x01005eb012fe2000  Wagamama High Spec (trial)
0x0100abf008968000  (unmapped)
0x0100b4b00f9f6000  SmileBASIC 4 (demo)
0x0100c9100b06a000  SmileBASIC 4 (retail)
0x0100ee5021c9e000  Seedsow Lullaby (full)
0x04008e001f098000  Nintendo Switch Sports Resort
0x0400c3f00006e000  (unmapped)
```

### A save cannot be pulled from the title that hosts the exploit

Pulling retail SmileBASIC's own save (`0100c9100b06a000`) from a session hosted
**by retail SmileBASIC** fails for every combination, and the interesting one is:

```
space=User type=Account uid=539fd27752770010 -> 0xe02
space=<everything else>                      -> 0x7d402
```

`0xe02` is not `0x7d402` ("no save data"): the save exists, and the running
application holds it. So the metadata milestone cannot read SmileBASIC's save from
a SmileBASIC-hosted session at all; it needs a session hosted by another title (the
Seedsow demo), or the save pulled while SmileBASIC is not running. That is a real
constraint on the plan, and it was only visible by trying it.

### The second save-touching operation crashed the console with 2162-0002

The Seedsow demo pull (`010042d022aea000`, the backup before any write) died during
account enumeration with `Console response timed out; restart the application`, and
the console then showed **`2162-0002`** (frame `2026-10-29-2162-0002.png`). That is
the documented promoted-root failure (RESULTS, "2162-0002 host crash"), and it came
after `list-apps` plus one save probe in the same boot - consistent with "a restart
between save operations is advice, not a requirement, but the drop is
probabilistic".

The same frame records the console's system version: **23.0.1** (the error screen
prints `(X2) 23.0.1` next to the model/serial block).

So this boot achieved 4/4 and two read-only enumerations, and did not get a save
file: the backup for the wipe+inject milestone is still the 2026-10-28 copy in
`saves/Seedsow-Lullaby-demo/user-539fd277/2026-10-28_0244`, and the launcher set is
built from it (`tools/build-untethered.sh` with `BODY`/`EXTRA`, staged and hashed).

### probe-sd was not reached

The session was lost before `probe-sd.cjs` could run, so `OpenSdCardFileSystem`
(cmd 18) remains **unmeasured** - and with no microSD Express card inserted there
would be nothing to open even if the command exists.

## 2026-10-30 14:51: second 4/4, and cmd 18 finally answered

The patched engine produced a second consecutive 4/4 (run `switch2-i1FuBB`, held
endpoint ready at 14:54:02). So the patch hypothesis now stands at **2/2 boots with
0001+0002 applied versus 0/5 without**, on the same console and game binary. That is
still a small sample, but it is no longer a single lucky boot.

### `OpenSdCardFileSystem` (cmd 18): accepted, no filesystem, 0x320002

The first version of `probe-sd.cjs` reported `transport 0xf601` for every id 16-22,
which is **not an answer about the command**: `0xf601` is what the native `send`
returns, meaning the request never produced a reply. Two things were wrong:

1. the probe reused the run's `rootHandle`, which is a post-RO artefact and can go
   stale - a fresh `fsp-srv` session through SM accepts the same calls;
2. the command packets carried the CMIF `pid` flag, and after one such request the
   session refuses every later call with `0xf601`.

With the correct shape - a fresh `fsp-srv` session, `Initialize` (cmd 1) with the
pid, then **cmd 18 with no input and no pid flag** - the answer is:

```
18: result 0x320002, moves 0
```

`0x320002` is an FS result (module 1), not a transport failure, and no handle is
returned. On this console there is no microSD Express card inserted, so the reading
consistent with every other measurement is "no card to open". What is now proven is
that the command **exists and is accepted on this firmware (23.0.1)**; what is *not*
proven is whether it returns a filesystem when a card is present. That still needs a
card in the slot and one more session.

### The promoted root handle can be stale by the time tools use it

`save-pull-root.cjs` took `rootHandle` from `ro/root/current-root.json` and sent cmd
53 to it; in run `switch2-i1FuBB` every send returned `0xf601`, while the same engine
happily enumerated accounts (`acc:u0`, 3 uids) in the same session. A fresh
`openService('fsp-srv')` + `Initialize` worked for cmd 18 in that same session. So
`current-root.json` is evidence that the root *was* promoted, not a live handle to
keep using after the RO stage.

### Two sessions lost, both inside a save-open sweep, with the console alive

`save-pull-root.cjs` sweeps 4 spaces x 5 types x every account uid - up to 60
`OpenSaveDataFileSystem` calls - before it opens the save it wants. Both attempts to
pull the Seedsow demo backup died inside that sweep (`SESSION LOST`), and the frames
show the console **alive in `RPC RUNNING`**, not crashed: the application is wedged
inside an unresolved IPC, exactly like the stage-2 wedges.

The fix applied to the tool: `--space N --type N` restricts the open to one
combination (the write tool already opens exactly one, User/Account, and has never
needed a sweep). The next session should pull with
`--space 1 --type 1`, which is also what `save-write-stage.cjs` assumes.

### The in-run retry is what fills `tmp`, so the first attempt is the only one

The failed boot `switch2-eZQxjq` shows why attempt 2 is worse than attempt 1:

| attempt | error | free in `tmp` |
| --- | --- | --- |
| 1 | `Overwrite missed the qualified canary` (`canaryChanged:true`, `markerSelected:false`) | 491,520 bytes reported, required 65,536 |
| 2 | `Console response timed out` | **131,072 bytes** |

The acquisition's scratch lives on the tiny `tmp` mount (~512 KiB). Its extent
directories are only reclaimed by the pipeline's "Remove exploit scratch from prior
launches" step, which runs **once per boot, not between attempts**. So each in-run
retry starts with less space and fails earlier (the `free-space tmp` stalls). The
operating rule that follows is stronger than "one attempt per boot": the pool's
`MAX_ATTEMPTS = 3` should be 1, and a canary miss should cost a power cycle.

## 2026-10-29 15:20-15:43: the tmp mount, and why stage 2 stalls now

After the two 4/4 boots at 14:38 and 14:52, stage 2 stopped passing. The stall is
always the same shape: the last line is `STEP free-space tmp`, and it sits there for
7-10 minutes per attempt before the pipeline gives up.

Measured state of the mounts (from the run's own `scratch-cleanup.json`, which now
records them before deleting anything):

```
save: ["NS2_GAP_1793322731612", "f", "tag.dat", "config.dat"]
tmp : ["tmp.dat"]
```

`tmp` is a small file-backed mount with one `tmp.dat` in it. Its free space was
491,520 bytes on a healthy boot, **131,072** after a failed attempt, and stayed at
131,072 across a power cycle. The acquisition's extent tree (~290 nested 32-character
directories) is built on that mount, so at 131 KB it cannot fit.

Two things were tried:

1. **Cleanup can now see the mounts and walk nested paths.** It found and removed one
   `NS2_GAP_...` directory on `save` and nothing on `tmp`, so the leftover is not a
   root-level `NS2_GAP` entry in `tmp`. It is inside the `tmp.dat` image, where a
   directory listing of the mount cannot reach it.
2. **The save stands in for tmp when tmp is tight** (below 393,216 bytes). The
   fallback fired on every attempt (`tmpFallback: {free: 131072}`) and `tmp` then
   reported the save's 66,945,024 bytes, so from that point the extent tree is built
   on the save.

**And the stall did not move.** Three attempts with the fallback active each stalled
with `STEP free-space tmp` as the last line, which means the blocking call is after
the space checks - the 16 MiB commit file, the ~45-level canary path, the canary
file, or the extent tree. So tmp space is *a* difference from the healthy boots but
not the cause of this stall.

Because that is three identical failures, the next step is instrumentation rather
than another boot: `probe-reserved-gap.cjs` now logs `STEP commit-data`,
`STEP canary-parents`, `STEP canary-file`, `STEP canary-type`,
`STEP selected-directory`, `STEP extent-directories` and `STEP extent-marker`. The
next stall will name the call that blocks instead of costing a boot to guess.

## 2026-10-29 16:02: the tmp mount is fixed; the stall is the gap-content open

Two things came out of instrumenting the acquisition.

### The tmp image can be reclaimed, and now is

`tmp` is a file-backed mount holding one `tmp.dat`. Deleting that file and
committing restored the mount exactly as predicted:

```
tmp before/after: 131072 -> 491520
reset: {'file': 'tmp.dat', 'type': 1, 'command': 1, 'result': 0}
```

491,520 bytes is the free space the two 4/4 boots had, so this puts every boot back
on the healthy configuration. The cleanup step now does it whenever tmp is below
393,216 bytes free, and records the before/after numbers in `scratch-cleanup.json`.
Two bugs on the way there, both recorded because they cost boots:

- matching the entry by its directory-entry *type* rejected it (the type byte for
  this file is 1, not the directory value), so the first version silently did
  nothing (`tmpReset: null`, free space unchanged);
- the save-stands-in-for-tmp fallback is now opt-in (`NS2_TMP_FALLBACK=1`): with it
  on, the stall moved from `free-space tmp` to `extent-marker` - further, but still
  a stall, and the extent tree belongs on tmp as designed.

### The stall after that is in the gap-content phase

With tmp healthy the acquisition walks through the new markers -
`commit-data`, `canary-parents (45)`, `canary-file`, `canary-type`,
`selected-directory`, `extent-directories (3)`, `extent-marker` - and then stops for
6+ minutes with `extent-marker` as the last line. So the blocking call is one of the
three that follow it:

```
STEP extent-marker
  s.ipc('Open own gap content', root, 200)     <-- marked 'open-gap-content' now
  domain.storageSize(s, storage)               <-- marked 'storage-size' now
  check(storageSize >= probeReadSize)
```

`root` there is the promoted fsp-srv session, and cmd 200 is a non-standard id, so
"the command never returns" is the first thing to test rather than assume. The next
boot's log names which of the two blocks.

## 2026-10-29 16:09-16:20: fast failures, and the canary window types

Two changes made failed boots cheap instead of expensive, and the instrumented log
localised the remaining failure to the canary qualification.

### Failures now cost minutes, not half an hour

`acquire.cjs` defaulted to `MAX_ATTEMPTS = 3` with a 10-minute deadline each, so a
boot that was going to fail spent up to ~30 minutes failing. Measured: a success
takes 4-5 minutes and a stalled attempt produces no new step marker for minutes.
Both are now configurable and default to **one attempt, 7-minute budget**
(`NS2_ACQUIRE_ATTEMPTS`, `NS2_ACQUIRE_BUDGET_MS`). Observed after the change:

| try | boot | acquisition | outcome |
| --- | --- | --- | --- |
| 1 | 16:10 | 16:12:34 -> 16:13:34 | canary miss, **1 min** |
| 2 | 16:14 | 16:16:21 -> 16:19:45 | canary miss, **3.5 min** |

### The gap-content phase is not the block

The markers added last round answered it:

```
STEP extent-marker
STEP open-gap-content            <- returned
STEP storage-size
STEP storage-size-ok 144827272   <- 144,827,272 bytes
```

So `Open own gap content` (fsp-srv cmd 200 on the promoted root) and the storage-size
query both work; the earlier 6-minute silence at `extent-marker` was the *next*
phase. That rules out the command-id and stale-handle hypotheses for this stall.

### The canary sweep stops at the first window, whatever its type

The acquisition's positive sweep walks the marker offset in 0x30-byte steps and
breaks at the first row that shows a receive-order window. What those windows looked
like:

| try | offset | canaryType | changed | window | result |
| --- | --- | --- | --- | --- | --- |
| 1 | 0x2340 | 1 | [] | false | skip |
| 1 | 0x2370 | **null** | `["canary"]` | true | committed -> `markerSelected false` |
| 2 | 0x2340 | **0** | `["canary"]` | true | committed -> miss |

The qualification wants an *owned* canary (`canaryResult === 0 && canaryType === 1`),
so a null-typed window can never satisfy it - but the sweep committed to it anyway.
It now keeps sweeping past a null-typed window. This cannot turn a passing case into
a failing one: if every offset is null the run ends at the same failure with the last
offset, and a typed window is still accepted exactly as before.

What is *not* yet explained is try 2's `type=0` window at the first offset. If the
same offset keeps producing type 0, the qualification may need a rule for it too -
that is the next thing to measure rather than guess.

## 2026-10-29 16:25-16:40: the sweep was one-directional and out of range

Widening the canary sweep to look for an owned window exposed two things about the
search itself, and one about the console.

### The sweep crashed outside the marker buffer, so only ~6 offsets existed upward

`wave()` writes the marker path at `activeMarkerOffset` inside an `extent`-sized
buffer, and the original sweep only walked upward from the base offset. At offset
9312 the run died with:

```
RangeError: The value of "offset" is out of range. It must be >= 0 && <= 9281. Received 9312
    at wave (probe-reserved-gap.cjs:418) <- retryWave <- main
```

So upward from the 0x2340 base there are only a handful of usable slots before the
buffer ends. The sweep now alternates +/- 0x30 steps from the base and **skips**
offsets the buffer cannot hold. (The first version clamped to the edge instead, which
made every upward attempt past 0x2400 repeat that same offset - 14 of 24 lines in one
sweep were 0x2400, half the waves spent on one measurement.)

### Across 24 offsets in both directions, ownership and window never coexisted

One sweep, alternating up and down:

| offset | canaryType | changed | window |
| --- | --- | --- | --- |
| 0x2340 | 0 | `["canary"]` | true |
| 0x2370 | null | `["canary"]` | true |
| 0x2310 | 0 | `["canary"]` | true |
| 0x23d0 | null | `["canary"]` | true |
| 0x2280 | **1** | `[]` | **false** |
| 0x21c0 | **1** | `[]` | **false** |
| 0x2250 ... 0x2130 | 0 | `["canary"]` | true |

The qualification wants an *owned* canary (`canaryType === 1`) **and** a receive-order
window. In this run every owned reading had no window, and every windowed reading was
type 0 or null. That is not an offset-search problem any more: the two halves of the
qualification are mutually exclusive in this console state, whatever offset is tried.

What that means: the 14:38 and 14:52 successes were not luck about *where* to land, or
the sweep would have found a slot; something about the console or the application's
heap state changed between those boots and now. The next measurement should compare a
successful boot's row (the `cases` array in the report) against a failing one for the
same profile, rather than extending the sweep further.

### The success signature: many waves, and the first window looks the same

The run folders on this machine still contain **39 successful acquisitions** from
2026-10-27/28, and they answer a question the failing runs cannot: what does a
successful report look like?

| run | cases in the report | markerSelected | first positive row |
| --- | --- | --- | --- |
| `uy0bDz` (success) | **42** | true | margin 1428, selected false, type 0, result 0, changed `["canary"]` |
| `i1FuBB` (success) | **38** | true | margin 2345, selected false, type 0, result 0, changed `["canary"]` |
| `LG83Yh` (failure) | 11 | *unset* (crashed) | margin 2580, selected false, type 0, result 0, changed `["canary"]` |

Two readings:

- the *first* positive window in a failing run has exactly the shape of the first
  positive window in a successful one, so the discriminator is not the window's
  appearance at the base offset - the successful run simply kept going (**38-55
  cases** against 9-11 in the failures) until a later wave qualified;
- that makes the earlier "commit to the first window" behaviour the real defect, and
  the widened, in-range, bidirectional sweep the right shape of fix. It also means
  today's failures were ending runs that the successful ones would have continued.

So the next boot is a fair test of the fixed sweep rather than another identical
retry. If it still fails, the comparison to make is against a successful run's
*qualified* row (`selectedMarker: true`), not its first window.

## 2026-10-29 16:41: correction - the sweep was right the first time

The three sweep changes from the previous hour were reverted after reading the
stored successful reports properly. The evidence, from `uy0bDz` and `i1FuBB` (both
4/4) versus the recent failures:

| report | positive rows | each row looks like | markerSelected |
| --- | --- | --- | --- |
| success `uy0bDz` | **2** | margin 1428/1880, selected false, **type 0**, result 0, changed `["canary"]` | true |
| success `i1FuBB` | **2** | margin 2345/1750, selected false, **type 0**, result 0, changed `["canary"]` | true |
| failure `yCKell` | **25** | same first row, then 24 more | *never reached* |

`type 1` never appears in the **positive** profile of a successful run - it appears
in `abort-control` and in the `extent-present` qualification, which is a different
profile. So "prefer a typed window" was reading the wrong rows: the successful runs
committed to the **first** window, which is `type 0` with the canary changed, exactly
what the original code does and exactly what I made it skip.

The cost of being wrong was visible: the widened sweep turned a 2-wave positive phase
into 25 waves, and the runs then ended with `socket hang up` instead of a canary
verdict. (Some of those transport losses were self-inflicted - hosts were killed
while restarting loops - but the 25-wave phase was not.) The sweep is back to
`markerOffset + attempt * 0x30`, breaking at the first window.

### What the failures actually are

With the sweep reverted, the comparison points at the *qualification*, not the
sweep. In `uy0bDz` and `i1FuBB` the `extent-present` row has
`selectedMarker: true`, `canaryType 1`, `canaryResult 0`, `changed []` - and one
failing run (`P9kh82`) reached **exactly that state** (`markerSelected: true`,
`storageSize` recorded) and then lost the connection (`socket hang up`).

So the canary qualification does still happen; what fails now is either the canary
miss (`markerSelected false` at 16:12) or losing the RPC connection after it. Those
are different problems, and only the first is a grooming race.

## 2026-10-29 16:45: the repeat that fails, and the fingerbot stops reaching

### The failure after qualification is the *repeat*, not the canary

The one boot in this stretch that got past the canary qualified properly
(`markerSelected: true`) and then failed with a different error:

```
Error: Repeated overwrite missed the canary; retain resources for recovery
  at probe-reserved-gap.cjs:650
CANARY offset=0x2370 type=null changed=["canary"] margin=2536 window=true
```

The code explains it. Qualification is:

```js
report.markerSelected = canaryChanged && positive.canaryType === 0 &&
  changedPaths.every(n => n === 'canary') && hasWindow(positive);
```

so **`canaryType === 0` is required** - the opposite of what the reverted change assumed
(see the correction above; this is the same evidence from the other direction). Then,
because it qualified, the acquisition repeats the positive wave to prove the landing
reproduces:

```js
const repeated = await retryWave('positive');       // restarts at the base offset
if (!repeated.triggerAborted && !report.markerReproduced) throw ...
```

That repeat started the sweep from the base offset again. When the base had no
receive-order window on the second pass, it walked on to 0x2370, landed on an
unowned canary (`type=null`) and failed. The repeat is now **pinned to the offset
that qualified** (`retryWave('positive', qualifiedOffset)`), so it re-tests the same
landing instead of searching for a new one. Committed, not yet proven.

### The fingerbot no longer reaches the power button

The console is now wedged in SmileBASIC's RPC loop (`RPC RUNNING`) and the
fingerbot cannot power-cycle it:

| probe | observation |
| --- | --- |
| three holds of 16 s | console still answers ping, HDMI still shows the wedged screen |
| `/status` | `dp102: 95` (down travel), `dp105: 95` (rest), `dp103: 0` (press sustain) |
| `/up` then status | `/up` answers `dp1: false`, the next `/status` reports `dp1: true` |
| 1 s press vs no press | two captures with **identical sha256** |

Two presses leaving the frame byte-identical is the same signature as the earlier
"arm travel" fault (`RESULTS.md`, 2026-10-28: at `dp102` 85 every press was a silent
no-op). Power control therefore needs the arm reseated physically; no host-side
command can recover the console until then.

## 2026-10-29 16:54: a recovered session without a power cycle, and what cannot recover one

### An RPC-loop wedge can end by itself, and then a new session needs no menu work

While the console was stuck in the RPC loop, a 16 s power-button hold was followed by
a screen that had *finished*:

```
BOOT OK 3925528160
HOST CONNECTED
RPC RUNNING
RPC STOP  32896
OK
[WORKSPACE]
```

i.e. the bootstrap's `RPC()` had returned and BASIC was back at its direct-mode
prompt, with the keyboard firmware still attached. From there a new session needs
only the four lines - no power cycle, no home-menu navigation:

```
LOAD "TXT:NS2"  -> confirm dialog -> RUN -> "BOOT READY 1015" -> REMOVE -> "Out of memory (REMOVE)"
V=START(39380,192,168,50,235,0,0,0,0)          -> run switch2-kjr7s0
```

That run failed in 2 minutes with `Native batch did not terminate; resources
retained` - a different failure from the canary, and evidence that a reused,
long-running application is not equivalent to a fresh one.

### A native-call wedge is not recoverable from here

The next wedge behaved differently and pinned down the boundary:

| action | result |
| --- | --- |
| 16 s hold | capture byte-identical to before (`239109` bytes), screen unchanged |
| kill the host process (`run.cjs`) | capture byte-identical again |
| `/status` on the fingerbot | `dp102: 95`, `dp105: 95`, `dp103: 0` |

So the wedge broke only when the application was in the **RPC read**, not when it was
inside a native call: the earlier `RPC STOP` came from the read returning, and neither
killing the host nor a hold touches a native stall. That is also the second
independent sign that the fingerbot no longer reaches the button, since a hardware
long-press cannot be ignored by the console.

## 2026-10-29 16:52: metadata can be written from either side

The name and thumbnail write path exists in two forms, both tested against the real
console sample:

| piece | what it does | proof |
| --- | --- | --- |
| `tools/smb-meta.cjs` | dump/diff/name/icon on a pulled META | `node tests/test_smb_meta.cjs` 7/7 |
| `payloads/ns2jb-metadata.lua` | the same surgery in Lua, for the console side | `lua tests/test_metadata_lua.lua` 15/15 |

Both keep the file at 11152 bytes and, on the real sample, change **only** the 32-byte
name block (`0x70..0x8f`) - verified byte by byte in both test suites. Two bugs found
while writing them, both mine: the slot's capacity must be the block's 22 bytes (not
the current string's, which shrank and then refused a name that fit), and the tag
lives in the thumbnail's first pixels, so replacing an icon deletes the tag and it
must be re-stamped.

The measured limit stands: **11 characters** (`HOMEBREW` fits, `HOMEBREWLAUNCHER`
does not). `--allow-overlap` writes past the block, into the thumbnail's black
margin, and is explicitly marked unproven on a console.

## 2026-10-29 16:59: the artwork chooser's data path

The chooser now exists as three pieces that can be tested without a console, plus
the one piece that cannot be written yet.

| piece | state |
| --- | --- |
| `tools/artwork-build.cjs` | builds 40x69 BGRA blobs (11040 bytes) from PNGs or four built-in samples, writes `index.txt`, optionally a contact sheet |
| `payloads/ns2jb-artwork.lua` | reads the index, selects an entry, applies it through the metadata library, reports what it did |
| `payloads/ns2jb-metadata.lua` | the byte surgery (see above) |
| the grid of previews | **not written**: the engine's drawing and input API is unknown |

`lua tests/test_artwork_lua.lua` runs the payload against a stub engine and
filesystem: 8/8, covering "no index", default selection, selection by file name,
selection by title, an unknown name, a missing metadata library, the success dialog's
list, and that the applied META keeps its 11152-byte size.

What is honest about the UI: only `dialog` and `jump` tags are proven on this engine,
so the selection is read from `save:/art/choice.txt` (line 1 artwork, line 2 project
name) rather than drawn. The data path and the write path do not change when a
drawing API becomes known - only `choose()` gets a real picker in front of it. The
built-in samples render as expected (`docs/images/2026-10-29-artwork-sheet.png`).

The measured name limit still applies end to end: the chooser refuses to write more
than the 22-byte block unless `--allow-overlap` is passed, so a chosen name has to be
11 characters or fewer.

## 2026-10-29 17:02: a recovered application is not a usable session host

The console freed itself once more (16 s hold -> `RPC STOP 32896` at the prompt), and
this time the prompt was proven live before anything else was typed:

```
RPC STOP      32896
OK
PRINT 1
1
OK
```

So the application answered BASIC again. The next step killed it: `LOAD "TXT:NS2"`
was typed and echoed - `LOAD "TXT:NS2"` appears with no dialog and no `OK` - and from
that moment the console stopped responding to input. Three probes left the capture
**byte-identical** (`255345` bytes):

| probe | result |
| --- | --- |
| another Enter | no change |
| 16 s hold | no change |
| `PRINT 2` after the hold | no change |

Two readings, both useful:

- the recovery after a failed acquisition produces an application whose file layer is
  already broken - the first `LOAD` froze it - so "recovered prompt" is not the same
  as "usable session host", and spending a rare recovered window on a full exploit
  run is a poor bet;
- the hold that broke the earlier wedge did nothing here, which is consistent with
  the wedge being inside a native call this time: only the *RPC read* wedge is
  reachable from outside.

This is also where `tools/console-state.cjs` shows its limit in the record: that
screen's OCR is dominated by the hex dump, so the classifier calls it `unknown` even
though a human reads `RPC STOP` and the prompt. The classifier guards the clean
screens; it does not replace looking.

## 2026-10-29 17:07: the fingerbot cannot reach the button at any depth

`/travel?pct=N` sets the down position (`dp102`) directly, so the "arm drifted" theory
was testable rather than assumed. Measured:

| down depth | 16 s hold | result |
| --- | --- | --- |
| 95 (as found) | yes | capture unchanged, `255345` bytes, console pings |
| **100** (max) | yes | capture unchanged, `255345` bytes, console pings |

A deeper press at the servo's maximum does not reach the button either, so the arm is
displaced rather than under-travelled - it needs reseating by hand. The device was put
back to 95 so the next operator finds it as it was.

### The harness now asks the interpreter instead of reading the screen

The recovered-prompt screen defeats the OCR (hex noise), so "is the console listening?"
cannot be answered by text. `startSession` now types `PRINT <random 4-digit>` and
requires the marker **twice** - once as the echoed command and once as its result -
before starting a host. A wedged application shows only the echo (or nothing), and the
harness reports that instead of booting against a dead prompt. Typing into a dead app
is harmless, so the probe costs about two seconds.

## 2026-10-29 17:10: operating rule from the operator - ONE RPC session per boot

The operator's rule, after a day of wedges: **one RPC session per boot; if the
session disconnects, hard-restart the console.** A wedged application never accepts a
second host, and every attempt to reuse one costs a boot. This supersedes the
"recovered prompt" idea recorded earlier: a recovered prompt answered `PRINT 1`, then
died on the first `LOAD`, which is exactly what the rule predicts.

The harness now enforces it rather than trusting the operator to remember:

- `.harness-state.json` (gitignored) records `lastSessionAt` and `powerCycledAt`;
- `startSession()` refuses with exit **6** when a session has already been started
  since the last verified power cycle, and the message says to hard-restart;
- `lastSessionAt` is written **before** the host starts, so a killed run still counts.

And the power cycle itself is now **verified, not assumed**: after the 16 s hold the
harness polls for a real sign of power loss - a no-signal capture (~8609 bytes) or the
board reporting `mounted:false` - for 26 seconds. If neither appears it logs "the hold
did not reach the button", does **not** write `powerCycledAt`, and exits 4. Before
this, a failed hold was recorded as a fresh boot, which would have let the guard
permit a second session on a console that never rebooted.

### A require side effect started a real cycle

Requiring `tools/harness.cjs` from a one-line `node -e` to test a helper executed its
CLI, because the main body was an unguarded IIFE: it flashed the board, held the
button and pressed it - a real console action from a command that was supposed to be
inert. The body is now guarded by `require.main === module`, and `module.exports`
carries the pure helpers (`markerAnswered`, `oneSessionPerBoot`). Measured result of
that accident: the console's screen only **dimmed** (same frozen content, 160792 bytes
against 255345 later), so the hold again did not power it off - which is what the new
verification would now report instead of proceeding.

## 2026-10-29 17:22: a mock console found the guard's own bug

The harness can now be driven without hardware: `HARNESS_CAMERA` replaces the capture
command and `HARNESS_OCR` the OCR, so `tests/test_harness_powercycle.cjs` runs
`harness boot` against a mock console in a child process (it has to be a child - the
harness is run with `spawnSync`, which blocks this process and would leave an
in-process server unable to answer, which is how the first version of the test hung).

Two cases, both passing:

| camera | harness behaviour |
| --- | --- |
| HDMI up (200 KB frames) | "the hold did not reach the button", exit 4, **no state written** |
| no signal (9 KB frames) | "console is off (no-signal)", records `powerCycledAt`, proceeds to boot |

The second case exposed a real bug in the code I had just added: `powerCycle()`
returned without writing `powerCycledAt` because a patch applied to an anchor that no
longer existed. The one-session-per-boot guard reads that timestamp, so **every session
after the first would have been refused as "this boot already used its session"** -
the rule would have appeared to work while making the arcade unusable. Found offline,
in 31 seconds, instead of after a power cycle and a failed session on hardware.

## 2026-10-29 17:25: the whole cycle runs against a mock console

`tests/test_harness_sequence.cjs` drives `harness full` end to end with no hardware:
a mock board (child process) serving `/status`, `/usb`, `/pro`, `/key`, `/type`, an
OTA stub that flips the reported firmware the way a real flash does, a camera that
reports no signal, and an OCR mock that models the three screens the sequence depends
on - the confirm dialog up, the confirm dialog dismissed, and the prompt answering
`PRINT <n>` with the echo plus the result.

It asserts the things that cost boots when they break:

| assertion | why |
| --- | --- |
| the cycle exits 0 | the whole path completes |
| `power cycle verified` appears | the cycle is not attempted on an unverified boot |
| the four lines are typed in order | `LOAD`, blank (dialog), `RUN`, `REMOVE` |
| `V=START` uses the nine-argument form | the five-argument form fails on this payload |
| `--after` runs once the held endpoint is ready | the save operation is not attempted early |

5/5, about 40 seconds. It would have caught every harness bug this project has hit by
hand: the dropped first keystroke after a flash, the OCR marker that split "Out of
memory (REMOVE)" across lines, the unguarded `require` that started a real cycle, and
the `powerCycle` tail that never recorded a boot.

## 2026-10-29 17:23-17:30: every fingerbot lever tried, none reaches the button

The console has been frozen in a native call since 17:03 (capture 160792 bytes, HDMI
up, pingable). Power control is the only way out and it does not work. What was tried,
so this is not re-litigated:

| lever | value tried | result |
| --- | --- | --- |
| down depth `dp102` (`/travel`) | 95 (as found) | 16 s hold, capture unchanged |
| | **100** (servo maximum) | 16 s hold, capture unchanged |
| rest position `dp105` (`/uppos`) | **88** | 16 s hold, capture unchanged |
| | **100** | 16 s hold, capture unchanged |
| arm release before pressing | `/up` (answers `dp1:false`) | next `/status` reports `dp1:true` again |
| press then verify | 1 s and 16 s presses | capture byte-identical |

The fingerbot answers every command and reports `dp1:true` while claiming to release,
which is what a displaced or stuck arm looks like from here. Both settings were
restored to 95.

Consequence, stated plainly: **the console cannot be power-cycled by anything this
session can reach**, and per the one-RPC-per-boot rule no further session is possible
until it is. The remaining milestones - pinned-repeat boot, backup pull, META/PLAYMENU
rename, injection, payload-v1 message capture - are all built, tested offline, and
waiting on that one physical action.

## 2026-10-30 18:30: every installed save pulled, and the tool was silently doing nothing

With the arm reseated and travel set to **100** (95 no longer reaches the button), a
single boot ran the whole cycle unattended and reached 4/4, then `--after` pulled saves
inside that one session.

| title | files | size | hashes | opened as |
| --- | --- | --- | --- | --- |
| Seedsow Lullaby (demo) | 289 | 4.4 MiB | 289/289 | space=User type=Account |
| Seedsow Lullaby (full) | 75 | 2.0 MiB | 75/75 | space=User type=Account |
| Mario Kart World | 1 | 844 KiB | 1/1 | space=User type=Account |
| Nintendo Switch Sports Resort | 1 | 572 KiB | 1/1 | **space=User type=Device**, uid 000… |
| Nora to Oujo to Noraneko Heart 2 (trial) | 10 | 151 KiB | 10/10 | space=User type=Account |
| SmileBASIC 4 (demo) | 5 | 35 KiB | 5/5 | space=User type=Account |
| Pokemon Sword + Expansion Pass | 0 | 0 | – | space=User type=Account, **empty archive** |
| Wagamama High Spec (trial) | – | – | – | absent (0x7d402 everywhere) |
| SmileBASIC 4 (retail) | – | – | – | not readable: it hosts the exploit and holds its own save |

7 archives, 381 files, 8,341,142 bytes, every non-empty one re-verified against a
SHA-256 manifest written during the copy (`tools/verify-save-manifest.cjs`).

### The pull tool was a no-op, and it reported success

The first run of `pull-all` claimed "pulled 6/9" with **zero files on disk**. Cause: a
rewrite of `save-pull-root.cjs` had introduced `const flags = new Set([...known flag
names...])` and then tested `flags.has('--list-uids')`, `flags.has('--list-only')`,
`flags.has('--keep-open')` and `flags.has('--all')`. Testing membership of the *known*
set is constant, so every invocation behaved as all four flags at once: it printed the
account uids, listed, returned 0, and pull-all recorded a success. Two consequences
worth keeping: a green exit code is not evidence, and the archive is only real when
the files and their hashes are.

Also fixed: `pull-all` now treats "no save data" as an absent title and only stops on a
dropped session; it tries the targeted combination first and falls back to the pull
tool's sweep, recording the space/type that opened each title.

### What this says about generalising (and about Breath of the Wild)

The two limits that would matter for a large title are in the transfer, not in the
tool: files are read in 0x40000-byte chunks with a console-computed hash per chunk,
and a directory read is capped at 2048 entries. Both were exercised here (a 4.4 MiB
archive with 289 files), but a save with a very large single file or more than 2048
entries in one directory has not been. Nintendo Switch Sports Resort proves the
space/type discovery works: its save is a **Device** save with an all-zero uid, which
a User/Account-only tool would have reported as "no save data".

## 2026-10-30 18:46: the pinned repeat works; the failure moved two stages deeper

The run that failed at 18:46 was not the old failure. Its report says:

```
markerSelected: true
markerReproduced: true
error: The bounded native leak contains no qualified, encodable link candidate
```

`markerReproduced: true` is the fix from 2026-10-29 16:45 being exercised on hardware:
the repeat of the canary overwrite is now pinned to the offset that qualified, and it
succeeded. It had failed on every boot since the fix was written, because those boots
never got past the canary.

From there the run went further than any previous boot: the cache-alias path ran
(`profile: cache-combined-leak-0-0-0-1`, `cache.selectedAlias` true), the combined
acquisition required a qualified native over-read, and it failed finding an
**encodable link candidate** - `probe-reserved-gap.cjs:962`. That is two stages past
the canary.

So the acquisition failure has moved, not vanished. What remains is a heap-layout
requirement in the native-link phase (an address candidate the planner can encode),
which retries may or may not satisfy; it is not the same flake as before and should
not be diagnosed with the canary's history.
