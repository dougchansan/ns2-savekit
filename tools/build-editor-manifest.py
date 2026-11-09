#!/usr/bin/env python3
"""Build a save-write-stage manifest that installs a save directory recursively.

  python3 build-editor-manifest.py <source-dir> <backup-dir> <out.json>

Every non-hidden file in <source-dir> becomes an entry preserving its relative path. A file
that already exists in <backup-dir> is marked replace=true, which makes
save-write-stage.cjs verify the live bytes against that backup before it
overwrites them; a file that is not in the backup is add-only.

Hidden files are skipped: .nx_save_meta.bin is JKSV bookkeeping, not save data.
"""
import json
import os
import re
import sys

SAFE = re.compile(r'^[A-Za-z0-9_.-]+$')


def main(argv):
    if len(argv) != 4:
        sys.exit(__doc__)
    source, backup, out = argv[1:]
    names = []
    for root, dirs, entries in os.walk(source, followlinks=False):
        dirs[:] = sorted(d for d in dirs if not d.startswith('.'))
        for name in dirs + entries:
            full = os.path.join(root, name)
            if os.path.islink(full):
                sys.exit('refusing symlink: ' + full)
        for name in sorted(entries):
            if name.startswith('.'):
                continue
            rel = os.path.relpath(os.path.join(root, name), source)
            if any(not SAFE.fullmatch(part) for part in rel.split(os.sep)):
                sys.exit('refusing unsafe entry: ' + rel)
            names.append(rel)
    if not names:
        sys.exit('no files in ' + source)
    files, total, replaced = [], 0, 0
    for name in sorted(names):
        size = os.path.getsize(os.path.join(source, name))
        total += size
        entry = {'path': '/' + name.replace(os.sep, '/'), 'local': os.path.join(source, name)}
        if backup != '-' and os.path.isfile(os.path.join(backup, name)):
            entry['replace'] = True
            replaced += 1
        files.append(entry)
    manifest = {
        'title': 'Seedsow Lullaby demo -- seedsow-lua-editor v0.1.2 save',
        'source': source,
        'backup': backup,
        'files': files,
    }
    with open(out, 'w') as handle:
        json.dump(manifest, handle, indent=2)
        handle.write('\n')
    print('%s: %d files, %d replace, %d add, %.1f MiB'
          % (out, len(files), replaced, len(files) - replaced, total / 1048576.0))


if __name__ == '__main__':
    main(sys.argv)
