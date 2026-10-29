# MKW's BFRES 10.2 (nn::g3d2) — what the dump actually contains

Mario Kart World's models are not BFRES 3.5. `~/mkw-full` (base + update
`917504`, 45 GB) holds them as **zstd-compressed BFRES v10.2.1**, and the format
is documented by the EPD wiki ([Bfres](https://epd.zeldamods.org/wiki/Bfres),
covering 10.0.0 and 10.2.0). Everything below was verified against
`Model/CmnObj_AccelRing000.CmnObj_AccelRing000_A.bfres.zs`.

## The dump

`~/mkw-full/base/romfs`, 205,660 files / 22.2 GiB:

| bytes | files | what |
| --- | --- | --- |
| 17,886,187,611 | 140,650 | `.zs` — **zstd** (`28 b5 2f fd`), not Yaz0: BFRES models, BNTX textures, `.bphsh` shaders, SARC archives |
| 2,179,304,428 | 20,957 | `.bwav` audio |
| 1,451,368,077 | 49 | `.webm` movies |
| 632,453,853 | 24,113 | `.extm` |
| 536,429,293 | 6,448 | `.norm` |
| 414,592,841 | 6,448 | `.hgte`/`.hght` |
| 97,071,336 | 6,448 | `.mate` |

Models: `Model/*.bfres.zs` (5,827). Textures: `Tex/*.bntx.zs`. The `.extm` /
`.norm` / `.hgte` / `.mate` files are terrain and all begin with `TARB` — a
container this toolkit has no reader for yet.

Decompress with the system `zstd`: `zstd -d file.zs -o file.bfres`.

## Header (verified offsets)

`FRES    ` at 0x00, version `0x000a0201` at 0x08. Pointers are **64-bit offsets
from the start of the file** (little endian, high word usually 0).

| offset | field | sample value |
| --- | --- | --- |
| 0x20 | file name (NW string) | 0x7626 |
| 0x28 | `ResModel*` array | 0xF0 (`FMDL`) |
| 0x30 | model dictionary | 0x188 |
| 0xb0 | `nn::gfx::MemoryPoolInfo*` (GPU region) | 0x168 |
| 0xdc | model count (u16) | 1 |

## Model — `FMDL`

| offset | field | sample |
| --- | --- | --- |
| 0x00 | magic `FMDL` | |
| 0x08 | name | 0x760e |
| 0x18 | skeleton | 0x818 |
| 0x20 | `ResVertex*` array | 0x1b0 (`FVTX`) |
| 0x28 | `ResShape*` array | 0x418 (`FSHP`) |
| 0x30 | shape dictionary | 0x8d8 |
| 0x38 | `ResMaterial*` array | 0x260 (`FMAT`) |
| 0x40 | material dictionary | 0x910 |
| 0x48 | shader reflection | 0x3c0 |
| 0x50 | user data | 0x4d8 |
| 0x68 | vertex count (u16) | 2 |
| 0x6a | shape count (u16) | 2 |
| 0x6c | material count (u16) | 2 |

## Vertex — `FVTX`

| offset | field | sample |
| --- | --- | --- |
| 0x08 | attribute array | 0xfa8 |
| 0x30 | buffer info | 0x1060 |
| 0x38 | stride array | 0x1070 |
| 0x48 | vertex data base, relative to the GPU region | 0x5580 |
| 0x4c | attribute count (u8) | 7 |
| 0x4d | buffer count (u8) | 1 |
| 0x50 | vertex count (u32) | 4,086 |

Each attribute is 0x10 bytes: name pointer, `nn::gfx::AttributeFormat` (u32),
buffer offset (u16), buffer index (u8), dynamic flag (u8). The sample's seven
attributes sit at offsets 0x00, 0x0c, 0x10, 0x14, 0x18, 0x1c, 0x20 in a
**36-byte stride**, with formats 5, 2, 2, 3, 1, 5, 5 — note that the format
numbers are `nn::gfx::AttributeFormat`, not float3/float4 guesses, so the
decoder must map them explicitly.

## Shape and mesh — `FSHP` / `ResMesh`

| offset | field | sample |
| --- | --- | --- |
| 0x10 | `ResVertex*` | 0x1b0 |
| 0x18 | mesh array | 0x948 |
| 0x52 | material index (u16) | 0 |
| 0x56 | vertex index (u16) | 0 |
| 0x5a | skin weight count (u8) | 0 |
| 0x5b | mesh count (u8) | 4 |

`ResMesh` (0x38 bytes each): submesh array at 0x00, index buffer info at 0x18,
index offset at 0x20, topology at 0x24, index format at 0x28 (1 = u16 here),
index count at 0x2c (4,080), base vertex at 0x30, submesh count at 0x34.

## The open question

Vertex and index data live in the file's **GPU region**; the doc says both
offsets (`FVTX+0x48`, `mesh+0x20`) are relative to its start. The base is not yet
pinned down for these files: the header's `MemoryPoolInfo` at 0xb0 → 0x168 does
not yield a base that puts a 4,086-vertex × 36-byte run (147,096 bytes) inside the
226,208-byte file without overlapping the name string at 0x7626. A scan for
float32 position triples found only zeros at 4 KiB-aligned offsets, which suggests
either the positions are not the first attribute or they are quantised (the
format numbers above are consistent with non-float attributes).

Next step is to resolve that base — decode the `MemoryPoolInfo` per
`nn::gfx::MemoryPoolInfo`, or find the block by looking for the index buffer
(4,080 u16 values whose max is below 4,086) and walking back from it. Once the
base is known, the rest of the decoder (attributes → glTF accessors, FSHP → prims,
skeleton, materials, BNTX → PNG) is mechanical.
