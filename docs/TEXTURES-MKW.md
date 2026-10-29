# MKW textures: `Ounce` containers

`Tex/*.bntx.zs` in `~/mkw-full` are BNTX files with one difference from the
documented format: the texture container at 0x20 has magic **`Ounc`** instead of
`NX  `. Everything else follows the BNTX layout
([epd-libraries/bntxlibrary](https://github.com/epd-libraries/bntxlibrary/blob/aa4ddded283a796bf0a804d83a02d684bd01a629/docs/Structure.md)),
so the metadata is fully readable:

| offset | field |
| --- | --- |
| 0x20 | container magic, count, info array, data, dictionary, pools |
| BRTI+0x10 | flags, storage dimension, tile mode, swizzle |
| BRTI+0x16 | mip count |
| BRTI+0x1C | texture format |
| BRTI+0x24/0x28/0x2C/0x30 | width, height, depth, layers |
| BRTI+0x50/0x54 | texture size, alignment |
| BRTI+0x60 | name (pascal string in the `_STR` table) |

`tools/bntx_ounce.py` prints this for one file or an inventory of a directory:

```
CmnTex_Stage_SFCMarioCircuit_MarioBody_Alb   813x813  mips 10 fmt 0x00003406 size  241664 (0.37 B/px)
Shadow_Game03_X031_Z123_Shadow               512x512  mips 10 fmt 0x00000a01 size  701440 (2.68 B/px)
BakeEmpty_Bake                              8192x8192 mips 14 fmt 0x00003406 size 22372352 (0.33 B/px)
```

## The payload is a native GPU image

The names end in `.Ounce64`, and `Ounce` is the **platform codename**, not a
codec: the game's `sdk` module carries symbols `nn::wsi::ounce::native::NativeWindow`,
`nn::gpu::sdk::GpuOunceUserImageDescriptor`, `GpuOunceImagePixelFormat`,
`GpuOunceImageBlockFormat`, `MakeRgbaBlockImagePreference`, and `main` contains the
build path `D:\home\Project\Drive\App\Rom\Ounce64\Product_CSPGO_Optimize\code2\...`.

So the data is in whatever block-compressed format the GPU natively takes, and the
`BRTI` format ids (`0x3406`, `0x1f0a`, `0x3401`, `0xa01`) are `nn::gfx` image
formats for that generation. Sizes are consistent with that reading: the 8192² and
813² albedos sit at ~0.27-0.3 B/px for the base level (≈2 bpp, i.e. an 8×8 block
format), while the 512² shadow is ~2.67 B/px including mips, i.e. plain 16-bit.

Two things are missing before pixels come out: the block layout behind those four
format ids, and the surface tiling (the `swizzle`/`tile mode` fields are 0 here, so
at least some of these are linear).

The concrete next step is to identify the format ids — the mangled
`GpuOunceImageBlockFormat`/`GpuOunceImagePixelFormat` names are in `sdk`, so the
enumerator values are recoverable, and the block size can be confirmed against the
declared texture size (blocks × block bytes × mip factor must equal `BRTI+0x50`).
