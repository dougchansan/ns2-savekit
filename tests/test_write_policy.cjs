'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {validateSavePath, allowRisk} = require('../tools/lib/write-policy.cjs');
(async () => {
  assert.equal(validateSavePath('/slots/0/save.dat'), '/slots/0/save.dat');
  for (const name of ['/', 'relative', '/a/../b', '/a/./b', '/a//b', '/a\\b', '/a\0b']) {
    assert.throws(() => validateSavePath(name), /Invalid save path/);
  }
  await allowRisk(true, 'safe');
  if (!process.stdin.isTTY) await assert.rejects(allowRisk(false, 'No backup'), /interactive confirmation required/);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'write-policy-'));
  try {
    const source = path.join(tmp, 'source'), backup = path.join(tmp, 'backup');
    for (const dir of [source, backup]) fs.mkdirSync(path.join(dir, 'slots', '0'), {recursive: true});
    fs.writeFileSync(path.join(source, 'slots/0/save.dat'), 'new');
    fs.writeFileSync(path.join(backup, 'slots/0/save.dat'), 'old');
    fs.writeFileSync(path.join(source, 'extra.dat'), 'extra');
    const out = path.join(tmp, 'manifest.json');
    const build = base => {
      execFileSync('python3', [path.join(__dirname, '../tools/build-editor-manifest.py'), source, base, out]);
      return JSON.parse(fs.readFileSync(out)).files;
    };
    const files = build(backup);
    assert.equal(files.find(f => f.path === '/slots/0/save.dat').replace, true);
    assert.equal(files.find(f => f.path === '/extra.dat').replace, undefined);
    assert.equal(build('-').length, 2);
    fs.symlinkSync(path.join(backup, 'slots/0/save.dat'), path.join(source, 'link'));
    assert.throws(() => build(backup), /refusing symlink/);
  } finally { fs.rmSync(tmp, {recursive: true, force: true}); }
  console.log('write policy and recursive replace tests passed');
})().catch(error => {console.error(error); process.exitCode = 1;});
