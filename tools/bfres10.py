#!/usr/bin/env python3
"""Extract geometry from a Mario Kart World BFRES (nn::g3d2, version 10.2.x).

  python3 tools/bfres10.py <model.bfres> <out.obj> [--preview out.png]

Only what is verified against real files is implemented:

  header   0x28 -> ResModel array (FMDL)
  FMDL     0x20 -> ResVertex (FVTX), 0x28 -> ResShape (FSHP), counts at 0x68/0x6a
  FVTX     0x08 attributes, 0x38 stride array, 0x48 data offset, 0x4c attr count,
           0x4d buffer count, 0x50 vertex count
  FSHP     0x18 mesh array, 0x5b mesh count
  ResMesh  0x20 index offset, 0x2c index count, 0x30 base vertex

The GPU region is the tail of the file: the header's pool size (u32 at 0x16c)
run back from EOF puts the base at exactly the end of the metadata, e.g. a
226,208-byte file with size 0x2d000 gives base 0xA3A0. Index and vertex data
offsets are relative to it. Positions are float3 at record offset 8; the first
eight bytes of a record are packed attributes, not the position.
"""
import os
import struct
import sys

import numpy as np


def u32(b, o):
    return struct.unpack_from('<I', b, o)[0]


def u64(b, o):
    return struct.unpack_from('<Q', b, o)[0]


def ptr(b, o):
    v = u32(b, o)
    return v if 0 < v < len(b) else None


def gpu_base(b):
    """The GPU region ends at EOF; its size is the pool size in the header.

    0x168 holds a small constant (0x24), the size is the u32 at 0x16c.
    """
    size = u32(b, 0x16c)
    if not 0 < size <= len(b):
        raise SystemExit('unexpected GPU pool size 0x%x' % size)
    return len(b) - size


def parse(b):
    model = ptr(b, 0x28)
    if not model or bytes(b[model:model + 4]) != b'FMDL':
        raise SystemExit('no FMDL at 0x28')
    vertex = u64(b, model + 0x20)
    shape = u64(b, model + 0x28)
    vcount = struct.unpack_from('<H', b, model + 0x68)[0]
    scount = struct.unpack_from('<H', b, model + 0x6a)[0]
    mcount = struct.unpack_from('<H', b, model + 0x6c)[0]
    if bytes(b[vertex:vertex + 4]) != b'FVTX':
        raise SystemExit('no FVTX')
    stride = u32(b, u64(b, vertex + 0x38))
    data = gpu_base(b) + u32(b, vertex + 0x48)
    vcount2 = u32(b, vertex + 0x50)
    if bytes(b[shape:shape + 4]) != b'FSHP':
        raise SystemExit('no FSHP')
    mesh = u64(b, shape + 0x18)
    meshes = b[shape + 0x5b]
    index = gpu_base(b) + u32(b, mesh + 0x20)
    icount = u32(b, mesh + 0x2c)
    basev = u32(b, mesh + 0x30)
    return {'model': model, 'vertex': vertex, 'shape': shape, 'meshes': meshes,
            'stride': stride, 'vcount': vcount2 or vcount,
            'data': data, 'index': index, 'icount': icount, 'basev': basev,
            'mcount': mcount}


def position_offset(rec):
    """Where the float3 position starts inside a record.

    It is not fixed: 8 for the accel ring, 0 for the aerial sign. Pick the offset
    whose three axes all span real geometry (a packed-attribute prefix reads as
    zero or garbage on at least one axis).
    """
    n, stride = rec.shape
    best = (0, -1.0)
    for off in range(0, stride - 11, 4):
        v = rec[:, off:off + 12].copy().view('<f4').reshape(n, 3).astype(np.float64)
        if not np.isfinite(v).all() or np.abs(v).max() > 1e5:
            continue
        extent = float((v.max(axis=0) - v.min(axis=0)).min())
        if extent > best[1]:
            best = (off, extent)
    return best[0]

def geometry(b, m):
    rec = b[m['data']:m['data'] + m['stride'] * m['vcount']].reshape(m['vcount'], m['stride'])
    off = position_offset(rec)
    pos = rec[:, off:off + 12].copy().view('<f4').reshape(m['vcount'], 3).astype(np.float64)
    idx = b[m['index']:m['index'] + m['icount'] * 2].copy().view('<u2').astype(np.int64)
    return pos, idx


SUFFIXES = ('_Alb', '_Nrm', '_Mix', '_Occ', '_Emm', '_Body', '_Cutout')


def texture_references(b):
    """Texture names in the model's string table.

    They are pascal strings (u16 length, then chars) and match the Tex/ file names
    exactly, e.g. CmnObj_AccelRing000_Body_Cutout_Alb. Only strings that look like
    texture references are returned, so attribute/shader names are skipped.
    """
    refs = set()
    for off in range(0, len(b) - 4):
        length = struct.unpack_from('<H', b, off)[0]
        if not 6 <= length <= 64 or off + 2 + length > len(b):
            continue
        chunk = b[off + 2:off + 2 + length]
        if not all(32 <= c < 127 for c in chunk):
            continue
        try:
            text = chunk.tobytes().decode('ascii')
        except UnicodeDecodeError:
            continue
        if text.startswith('CmnObj_') or text.startswith('CmnTex_') or text.startswith('Stage_') \
                or text.startswith('Driver_') or text.startswith('Kart_'):
            if any(s in text for s in SUFFIXES):
                refs.add(text)
    return sorted(refs)


def write_mtl(path, refs, tex_dir):
    """Write a material file mapping the model onto decoded textures."""
    import os
    name = os.path.basename(path)
    base = {ref: ref for ref in refs}
    albedo = next((r for r in refs if r.endswith('_Alb')), None)
    normal = next((r for r in refs if r.endswith('_Nrm')), None)
    mask = next((r for r in refs if r.endswith('_Mix')), None)
    emissive = next((r for r in refs if r.endswith('_Emm')), None)
    with open(path, 'w') as f:
        f.write('# generated by tools/bfres10.py\n')
        f.write('newmtl %s\n' % os.path.splitext(name)[0])
        f.write('Kd 1.000 1.000 1.000\n')
        for ref, key in ((albedo, 'map_Kd'), (mask, 'map_Ks'), (emissive, 'map_Ke')):
            if ref:
                f.write('%s %s\n' % (key, os.path.join(tex_dir, ref + '.png')))
        if normal:
            f.write('map_Bump %s\n' % os.path.join(tex_dir, normal + '.png'))
        f.write('\n')


def write_obj(path, pos, idx, name, material=None):
    with open(path, 'w') as f:
        f.write('# %s\n' % name)
        if material:
            f.write('mtllib %s\n' % material)
            f.write('usemtl %s\n' % os.path.splitext(material)[0])
        for p in pos:
            f.write('v %.6f %.6f %.6f\n' % tuple(p))
        for i in range(0, len(idx) - 2, 3):
            a, b_, c = idx[i], idx[i + 1], idx[i + 2]
            if a != b_ and b_ != c and a != c:
                f.write('f %d %d %d\n' % (a + 1, b_ + 1, c + 1))


def preview(path, pos, idx):
    from PIL import Image, ImageDraw
    w, h = 640, 640
    img = Image.new('RGB', (w, h), (18, 18, 22))
    draw = ImageDraw.Draw(img)
    xy = pos[:, :2]
    lo, hi = xy.min(axis=0), xy.max(axis=0)
    span = float((hi - lo).max()) or 1.0
    scale = (w - 40) / span
    screen = [(w / 2 + (x - (lo[0] + hi[0]) / 2) * scale,
               h / 2 - (y - (lo[1] + hi[1]) / 2) * scale) for x, y in xy]
    for i in range(0, len(idx) - 2, 3):
        a, b_, c = int(idx[i]), int(idx[i + 1]), int(idx[i + 2])
        if a != b_ and b_ != c and a != c:
            draw.polygon([screen[a], screen[b_], screen[c]], outline=(90, 190, 255))
    img.save(path)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    if len(args) < 2:
        raise SystemExit(__doc__)
    b = np.fromfile(args[0], dtype=np.uint8)
    m = parse(b)
    pos, idx = geometry(b, m)
    print('vertices %d stride %d  indices %d (max %d)  meshes %d  materials %d' % (
        m['vcount'], m['stride'], m['icount'], int(idx.max()), m['meshes'], m['mcount']))
    print('bounds x %.2f..%.2f  y %.2f..%.2f  z %.2f..%.2f' % (
        pos[:, 0].min(), pos[:, 0].max(), pos[:, 1].min(), pos[:, 1].max(),
        pos[:, 2].min(), pos[:, 2].max()))
    refs = texture_references(b)
    mtl = None
    if refs:
        if '--tex-dir' in sys.argv:
            tex_dir = sys.argv[sys.argv.index('--tex-dir') + 1]
        else:
            tex_dir = 'tex'
        mtl = os.path.splitext(args[1])[0] + '.mtl'
        write_mtl(mtl, refs, tex_dir)
        print('textures: %s' % ', '.join(refs))
    write_obj(args[1], pos, idx, args[0].split('/')[-1], mtl and os.path.basename(mtl))
    print('wrote', args[1])
    if '--preview' in sys.argv:
        out = sys.argv[sys.argv.index('--preview') + 1]
        preview(out, pos, idx)
        print('wrote', out)


if __name__ == '__main__':
    main()
