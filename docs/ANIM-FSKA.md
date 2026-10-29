# MKW skeletal animation (`FSKA`) — what is known and what is left

Status 2026-10-29. Skeletons are done (`FSKL`, exported for every model). This
document is the research result for the animation curves: the verified structures,
the one reference that documents them, the open questions with the measurements
that contradict a naive reading, and the experiment plan that would finish it.

## Reference

* [smm2recomp `docs/formats/bfres.md`](https://github.com/smm2recomp/smm2recomp/blob/8c0b2d417cd8fc86294bf1d0fc08795ebd3569e3/docs/formats/bfres.md)
  — BFRES 0.9 (Switch 1), but its `FSKA`, bone-animation and curve sections match
  what MKW (g3d2 10.2) actually contains, down to the 0x50 / 0x38 / 0x30 record
  sizes. This is the document to work from.
* [Syroot.NintenTools.Bfres `AnimCurve`](http://docs.syroot.com/nintentools/api/Syroot.NintenTools.Bfres.AnimCurve.html)
  — same field set for Switch BFRES, useful for naming.
* [EPD wiki Bfres](https://epd.zeldamods.org/wiki/Bfres) — v10.0/10.2 models,
  vertex, shape and material; it does **not** cover FSKA.

## Verified in MKW (g3d2 10.2)

`DriverA_Mario_MBike.anim.bfres` (40 clips) is the reference file. All checks below
were run against it.

### FSKA header — 0x50 bytes each

| offset | field | verified value |
| --- | --- | --- |
| +0x04 | size | 4352 |
| +0x08 | name (NW string) | `MBikeBackL`, `MBikeDamageThunder`, … |
| +0x20 | bind indices (u16 per bone anim, 0xFFFF = bind by name) | 0x1008, a run of `0xFFFF` |
| +0x28 | bone-animation array | 0x1078 |
| +0x40 | **frame count** | 30 (every curve ends at frame 30.0) |
| +0x44 | curve count | 105 |
| +0x48 | baked size | |
| +0x4C | **bone-animation count** | 55 |

Note the correction against the reference: it lists +0x40 as the frame count and
+0x4C as the bone-animation count, which is what the data shows — an earlier index
tool of ours had them swapped (55 frames / 30 bone anims); it now reads 30 frames /
55 bone anims, consistent with every curve's end frame.

The 55 bone animations exceed the model's 33 bones because clips target shared-rig
bone names (`ScarfDesert`, `Scarf_Pilot`, `Waist`, …), so binding must be by name
(`bind indices` 0xFFFF) and unmatched bones simply stay at rest.

### Bone animation — 0x38 bytes each

| offset | field | verified |
| --- | --- | --- |
| +0x00 | bone name | `Root`, `Skl_Root`, `Arm_1_L`, … |
| +0x08 | curves array | 0x1cd0 (Skl_Root) |
| +0x10 | base values | 0x1ca8 |
| +0x28 | flags | 0x03000e38 (Skl_Root) |
| +0x2E | curve count (u8) | 3 (Skl_Root), 6 (Arm_1_L) |

### Curve — 0x30 bytes each

| offset | field | verified |
| --- | --- | --- |
| +0x00 | frames array | 0x1d60 |
| +0x08 | keys array | 0x1d68 |
| +0x10 | flags (u16) | 0x400A / 0x4006 |
| +0x12 | key count (u16) | 3, 5, 8 |
| +0x14 | target (u32) | 0x10/0x14/0x18 translation xyz, 0x20/0x24/0x28 rotation xyz |
| +0x18 | start frame (f32) | 0.0 |
| +0x1C | end frame (f32) | 30.0 |
| +0x20 | ? | 0 on every curve sampled |
| +0x24 | ? | 0.001187 (rotation curves), 0 (translation curves) |
| +0x28 | delta (end − start value) | 0.240 (Skl_Root rot x), 0.145 (Arm_1_L trans x) |
| +0x2C | ? | 0 |

Flags decode as the reference describes: `0x400A` = frame type 2 (u8 frames), key
type 2 (s8 keys), curve type 0 (cubic), and `0x4006` = key type 1 (s16 keys). Frame
bytes for a curve are exactly `[0, 19, 30]` / `[0, 4, 8, 8, 12, 18, 27, 30]`, so the
frame-type decoding is confirmed.

## Open questions (what blocks sampling)

1. **Where the scale lives.** The reference puts `scale` at +0x20, `offset` at
   +0x24 and `delta` at +0x28. Measured: +0x20 is 0 everywhere, +0x24 is non-zero
   only on rotation curves, +0x28 matches the expected delta. Either g3d2 inserts a
   field (so scale sits at +0x24 and offset at +0x28), or scale is stored as 0 to
   mean "1" and +0x24 is something else entirely.
   *Corroboration for the shifted reading:* Skl_Root's rotation-x keys span
   `176` (s8, −68…113) and `0.24048 / 176 ≈ 0.00137`, close to the 0.001187 at
   +0x24; the translation curve's s16 keys span `38360` and `0.145198 / 38360 ≈
   3.8e−6`, but its +0x24 is 0, which does not fit. So the scale question is **not
   settled**.
2. **How cubic keys map to values, and their width.** Cubic keys are 4
   coefficients per key, but the byte span does not settle the width. Arm_1_L's
   translation-x curve has 8 keys and its key array runs from 0x1f68 to the next
   curve's frames at 0x1f90 — **40 bytes, i.e. 5 bytes per key**. Cubic s16 would
   be 64, cubic s8 32, linear s16 32. So either keys carry per-key padding or an
   extra trailing key, or the coefficient count/width differs from the reference.
   Reading the stream as s16 gives `[-11679, 13216, -10112, …]`, far larger than a
   0.15-unit translation at scale 1.
3. **Wrap modes and bool curves** (bits 8–9 / 12–13 pre/post wrap, curve types
   4–7) are untested; looping clips (`MBikeBackL` is a loop) will need them.

## Experiment plan

Cheap and decisive, in order:

1. **Rest-pose check.** Sample every curve of one clip at frame 0 and, after
   applying the curve scale, compare against the bone's rest transform from the
   same file's `FSKL` (scale/rotation/translation are all exported already). The
   scale is correct exactly when frame-0 values match the rest pose across many
   curves — that is a strong least-squares fit for the scale/offset pair.
2. **Delta check.** `delta` should equal `(max − min) × scale` over the curve's
   keys. Solving that per curve gives the scale independently; the two must agree.
3. **Cross-check with a second clip** (`MBikeDamage`, 62 curves) and with a
   different rig (`DriverA_BabyPeachExplore_LBike`, 132 curves, 117 frames) so a
   coincidental match on one file cannot pass.
4. Only then implement sampling and glTF animation export: bones are already in
   `<model>.skeleton.json`, so the exporter needs the per-curve key evaluation
   (`v(t) = c0 + c1·t + c2·t² + c3·t³` per segment) plus the wrap rules for loops.

## What is already in the repository

| tool | does |
| --- | --- |
| `tools/bfres10.py` | `skeleton(b)` → bone name/parent/scale/rotation/translation |
| `tools/mkw_export.py` | writes `<model>.skeleton.json` for every model |
| `tools/bfres10_anim.py` | indexes every `FSKA`: name, frames, bone anims, curves |

4,803 models have skeletons (385 rigged with more than 10 bones, max 77). 1,024
`.anim.bfres` files are indexed but not sampled.
