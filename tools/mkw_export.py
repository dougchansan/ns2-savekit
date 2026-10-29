#!/usr/bin/env python3
"""Export one Mario Kart World model with its textures.

  python3 tools/mkw_export.py <model.bfres.zs> <out-dir> [--tex-source DIR]

Produces, under <out-dir>:

  <name>.obj          geometry, one group per mesh
  <name>.mtl          material with map_Kd / map_Ks / map_Ke / map_Bump
  tex/<texture>.png   every texture the model references, decoded

<model.bfres.zs> is zstd-compressed; <tex-source> defaults to the Tex directory
next to the model's romfs (../Tex), where the referenced textures live.
"""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import numpy as np
from PIL import Image

import bfres10
import bntx_decode


def decompress(path, target):
    out = subprocess.run(['zstd', '-d', '-q', '-f', path, '-o', target], capture_output=True)
    if out.returncode != 0:
        raise SystemExit('zstd failed: ' + out.stderr.decode('utf-8', 'replace')[:200])
    return target


def export_texture(tex_source, ref, out_dir):
    source = os.path.join(tex_source, ref + '.bntx.zs')
    if not os.path.exists(source):
        return None
    raw = subprocess.run(['zstd', '-d', '-q', '-c', source], capture_output=True).stdout
    info, rgba = bntx_decode.decode_texture(raw, 0)
    os.makedirs(out_dir, exist_ok=True)
    target = os.path.join(out_dir, ref + '.png')
    Image.fromarray(rgba, 'RGBA').save(target)
    return target


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    if len(args) < 2:
        raise SystemExit(__doc__)
    model_path, out_dir = args[0], args[1]
    tex_source = (sys.argv[sys.argv.index('--tex-source') + 1]
                  if '--tex-source' in sys.argv else None)
    if tex_source is None:
        # romfs/Model/x.bfres.zs -> romfs/Tex
        tex_source = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(model_path))), 'Tex')
    name = os.path.basename(model_path).split('.bfres')[0]
    os.makedirs(out_dir, exist_ok=True)

    raw_path = os.path.join(out_dir, name + '.bfres')
    decompress(model_path, raw_path)
    b = np.fromfile(raw_path, dtype=np.uint8)
    model = bfres10.parse(b)

    shapes_out = []
    offset_by_stride = {}
    for si, shape in enumerate(model['shapes']):
        stride = shape['vertex']['stride']
        pos, meshes = bfres10.shape_geometry(b, shape, offset_by_stride.get(stride))
        offset_by_stride.setdefault(stride, bfres10.position_offset(
            b[shape['vertex']['data']:shape['vertex']['data'] +
              stride * shape['vertex']['count']].reshape(shape['vertex']['count'], stride)))
        shapes_out.append(('s%d' % si, pos, meshes))

    refs = bfres10.texture_references(b)
    decoded = []
    for ref in refs:
        target = export_texture(tex_source, ref, os.path.join(out_dir, 'tex'))
        if target:
            decoded.append(ref)
        else:
            print('  missing texture: %s' % ref)

    mtl = os.path.join(out_dir, name + '.mtl')
    bfres10.write_mtl(mtl, decoded, 'tex')
    obj = os.path.join(out_dir, name + '.obj')
    bfres10.write_obj(obj, shapes_out, name, os.path.basename(mtl))
    os.unlink(raw_path)

    vertices = sum(len(sh[1]) for sh in shapes_out)
    indices = sum(len(m) for sh in shapes_out for m in sh[2])
    print('%s: %d shapes, %d groups, %d vertices, %d indices, %d/%d textures' % (
        name, len(model['shapes']), sum(len(sh[2]) for sh in shapes_out), vertices, indices, len(decoded), len(refs)))
    print('wrote %s, %s, %s/tex/' % (obj, mtl, out_dir))


if __name__ == '__main__':
    main()
