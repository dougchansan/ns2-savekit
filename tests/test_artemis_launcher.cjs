#!/usr/bin/env node
// Offline tests for the alula Artemis Launcher installer.
//
//   node tests/test_artemis_launcher.cjs
//
// Everything here runs against fixtures: no console, no network, no upstream
// checkout. The real staged payload is proven separately by the hardware report
// in docs/ARTEMIS-LAUNCHER.md; what these tests protect is the part that decides
// *what* would be written - title selection, the pinned file set, the manifest,
// conflict detection, the backup guard and the rollback list.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const TOOL = path.join(ROOT, 'tools', 'artemis-launcher.cjs');
const launcher = require(TOOL);

let passes = 0, failures = 0;
const test = async (name, fn) => {
  try { await fn(); passes++; console.log('ok    ' + name); }
  catch (error) { failures++; console.log('FAIL  ' + name + '\n      ' + (error && error.message)); }
};
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

// A synthetic upstream tree: the six launcher files plus the per-title core.lua.
// The bytes are fixtures, not upstream code, so nothing third-party is vendored.
function upstreamFixture(files = launcher.LAUNCHER_FILES) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artemis-upstream-'));
  for (const overlay of ['seedsow_save', 'nora2_save']) {
    fs.mkdirSync(path.join(dir, overlay), {recursive: true});
    fs.writeFileSync(path.join(dir, overlay, 'core.lua'), 'core for ' + overlay);
  }
  for (const name of files) {
    fs.mkdirSync(path.join(dir, 'common'), {recursive: true});
    fs.writeFileSync(path.join(dir, 'common', name), 'upstream ' + name);
  }
  return dir;
}

function pinnedFixture(dir) {
  const pinned = {};
  for (const name of ['inject.iet', 'inject.lua', 'http.lua', 'exploita.lua', 'proggy.ttf']) {
    pinned['common/' + name] = sha(fs.readFileSync(path.join(dir, 'common', name)));
  }
  pinned['seedsow_save/core.lua'] = sha(fs.readFileSync(path.join(dir, 'seedsow_save/core.lua')));
  pinned['nora2_save/core.lua'] = sha(fs.readFileSync(path.join(dir, 'nora2_save/core.lua')));
  return pinned;
}

// A backup shaped like save-pull-root's output: manifest.json plus the files.
function backupFixture({withTrigger = true, withManifest = true, extra = []} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artemis-backup-'));
  const entries = [
    {path: '/system.dat', size: 4, sha256: sha(Buffer.from('sys!'))},
    {path: '/saveg.dat', size: 4, sha256: sha(Buffer.from('savg'))},
  ];
  fs.writeFileSync(path.join(dir, 'system.dat'), 'sys!');
  fs.writeFileSync(path.join(dir, 'saveg.dat'), 'savg');
  if (withTrigger) {
    const bytes = Buffer.from('game suspend save');
    fs.writeFileSync(path.join(dir, 'save9999.dat'), bytes);
    entries.push({path: '/save9999.dat', size: bytes.length, sha256: sha(bytes)});
  }
  for (const name of extra) {
    fs.writeFileSync(path.join(dir, name), 'editor ' + name);
    entries.push({path: '/' + name, size: 7, sha256: sha(Buffer.from('editor ' + name))});
  }
  if (withManifest) {
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      archive: 'space=User type=Account rank=0 index=0 uid=aaaaaaaaaaaaaaaa',
      files: entries.length, bytes: entries.reduce((n, e) => n + e.size, 0), entries,
    }));
  }
  return dir;
}

const title = launcher.titleFor('010042d022aea000');

async function run() {
  await test('the two supported demo ids select their own overlay', () => {
    assert.strictEqual(launcher.titleFor('010042d022aea000').overlay, 'seedsow_save');
    assert.strictEqual(launcher.titleFor('0x010012900d38a000').overlay, 'nora2_save');
    assert.strictEqual(launcher.titleFor('010012900D38A000').slug, 'Nora-2-demo');
  });

  await test('an unsupported title is refused with exit 5, never staged', () => {
    for (const id of ['0100ee5021c9e000', '01005eb012fe2000', '0400c3f00006e000', '', null]) {
      assert.throws(() => launcher.titleFor(id), error => {
        assert.ok(error instanceof launcher.Failure);
        assert.strictEqual(error.code, launcher.EXIT.unsupported);
        return true;
      });
    }
  });

  await test('the pinned set has the overlay core.lua and no game-state files', () => {
    const seedsow = launcher.pinnedFor(launcher.titleFor('010042d022aea000'));
    const nora = launcher.pinnedFor(launcher.titleFor('010012900d38a000'));
    assert.deepStrictEqual(Object.keys(seedsow).sort(), [
      'common/exploita.lua', 'common/http.lua', 'common/inject.iet', 'common/inject.lua',
      'common/proggy.ttf', 'seedsow_save/core.lua']);
    assert.deepStrictEqual(Object.keys(nora).sort(), [
      'common/exploita.lua', 'common/http.lua', 'common/inject.iet', 'common/inject.lua',
      'common/proggy.ttf', 'nora2_save/core.lua']);
    // saveg.dat/system.dat/save9999.dat are deliberately not taken from upstream.
    for (const name of Object.keys({...seedsow, ...nora})) {
      assert.doesNotMatch(name, /saveg\.dat|system\.dat|save9999\.dat/);
    }
  });

  await test('upstream verification accepts the pinned bytes and rejects changes', async () => {
    const dir = upstreamFixture();
    const pinned = pinnedFixture(dir);
    assert.deepStrictEqual(await launcher.verifyUpstream(dir, pinned), []);
    fs.writeFileSync(path.join(dir, 'common', 'http.lua'), 'tampered');
    const problems = await launcher.verifyUpstream(dir, pinned);
    assert.strictEqual(problems.length, 1);
    assert.match(problems[0], /http\.lua sha256/);
    fs.rmSync(path.join(dir, 'common', 'inject.iet'));
    assert.ok((await launcher.verifyUpstream(dir, pinned)).some(p => /missing common\/inject\.iet/.test(p)));
  });

  await test('staging produces exactly the seven files, sorted, with hashes', async () => {
    const upstream = upstreamFixture();
    const backupDir = backupFixture();
    const backup = await launcher.requireBackup(backupDir, title);
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'artemis-stage-'));
    await launcher.stagePackage({title, upstream, backup, outDir: out,
      retarget: (input, output) => fs.copyFileSync(input, output)});
    const plan = await launcher.buildManifest({title, outDir: out, backup});
    assert.deepStrictEqual(plan.files.map(f => f.path), [
      '/core.lua', '/exploita.lua', '/http.lua', '/inject.iet', '/inject.lua',
      '/proggy.ttf', '/save9999.dat']);
    assert.deepStrictEqual(plan.files.filter(f => f.replace).map(f => f.path), ['/save9999.dat']);
    for (const file of plan.files) {
      assert.match(file.sha256, /^[0-9a-f]{64}$/);
      assert.strictEqual(file.size, fs.statSync(file.local).size);
      assert.strictEqual(sha(fs.readFileSync(file.local)), file.sha256);
    }
    assert.strictEqual(plan.manifest.upstream.commit, launcher.UPSTREAM_COMMIT);
    assert.strictEqual(plan.manifest.programId, '010042d022aea000');
  });

  await test('the manifest is deterministic: same inputs, same bytes', async () => {
    const upstream = upstreamFixture();
    const backup = await launcher.requireBackup(backupFixture(), title);
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'artemis-det-'));
    const build = async () => {
      await launcher.stagePackage({title, upstream, backup, outDir: out,
        retarget: (input, output) => fs.copyFileSync(input, output)});
      return JSON.stringify((await launcher.buildManifest({title, outDir: out, backup})).manifest);
    };
    assert.strictEqual(await build(), await build());
  });

  await test('an existing non-trigger file is a conflict, not a silent overwrite', async () => {
    const upstream = upstreamFixture();
    const backupDir = backupFixture({extra: ['core.lua']});
    const backup = await launcher.requireBackup(backupDir, title);
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'artemis-conflict-'));
    await launcher.stagePackage({title, upstream, backup, outDir: out,
      retarget: (input, output) => fs.copyFileSync(input, output)});
    const plan = await launcher.buildManifest({title, outDir: out, backup});
    assert.deepStrictEqual(plan.conflicts.map(c => c.name), ['/core.lua']);
    assert.ok(!plan.files.some(f => f.path === '/core.lua'), 'conflict must not be written');
    assert.ok(plan.files.some(f => f.path === '/save9999.dat'));
  });

  await test('a save without save9999.dat is refused before staging', async () => {
    const backupDir = backupFixture({withTrigger: false});
    await assert.rejects(launcher.requireBackup(backupDir, title), error => {
      assert.strictEqual(error.code, launcher.EXIT.prereq);
      assert.match(error.message, /no \/save9999\.dat suspend file/);
      return true;
    });
  });

  await test('a directory without a pull manifest is not a backup', async () => {
    const dir = backupFixture({withManifest: false});
    await assert.rejects(launcher.requireBackup(dir, title), error => {
      assert.strictEqual(error.code, launcher.EXIT.prereq);
      assert.match(error.message, /no manifest\.json/);
      return true;
    });
    await assert.rejects(launcher.requireBackup('/tmp/definitely-not-a-backup-' + process.pid, title),
      error => error.code === launcher.EXIT.prereq);
  });

  await test('rollback removes only the launcher files, never a backup file', () => {
    const backup = {names: new Set(['/save9999.dat', '/system.dat', '/saveg.dat', '/core.lua'])};
    assert.deepStrictEqual(launcher.installedAdditions(backup),
      ['exploita.lua', 'http.lua', 'inject.iet', 'inject.lua', 'proggy.ttf']);
  });

  await test('the restore plan replaces exactly the boot trigger from the backup', () => {
    const backup = {names: new Set(['/save9999.dat', '/system.dat'])};
    assert.deepStrictEqual(launcher.installedAdditions(backup), launcher.LAUNCHER_FILES);
    assert.ok(!launcher.installedAdditions(backup).includes('save9999.dat'));
  });

  await test('staging path is deterministic and --out overrides it', () => {
    assert.strictEqual(launcher.stageDirFor(title, {}),
      path.join(ROOT, 'staging', 'alula-artemis', '010042d022aea000'));
    assert.strictEqual(launcher.stageDirFor(title, {out: '/tmp/elsewhere'}), '/tmp/elsewhere');
  });

  await test('install/restore refuse without an explicit authorization flag', () => {
    const base = [TOOL, 'install', 'no-such-run', '--title', '010042d022aea000',
      '--uid', '00'.repeat(16), '--backup', '/tmp/none'];
    const noConfirm = spawnSync(process.execPath, base, {encoding: 'utf8'});
    assert.notStrictEqual(noConfirm.status, 0);
    assert.match(noConfirm.stderr, /backup does not exist|open .*no-such-run/);
    const restore = spawnSync(process.execPath,
      [TOOL, 'restore', 'no-such-run', '--title', '010042d022aea000', '--uid', '00'.repeat(16),
        '--backup', '/tmp/none', '--confirm-restore'], {encoding: 'utf8'});
    assert.notStrictEqual(restore.status, 0);
    assert.strictEqual(restore.status, launcher.EXIT.prereq);
  });

  await test('a bad uid and an unknown option exit 2', () => {
    const badUid = spawnSync(process.execPath,
      [TOOL, 'install', 'x', '--title', '010042d022aea000', '--uid', 'zz'], {encoding: 'utf8'});
    assert.strictEqual(badUid.status, launcher.EXIT.usage);
    assert.match(badUid.stderr, /32 hex/);
    const badOption = spawnSync(process.execPath, [TOOL, 'stage', '--nope'], {encoding: 'utf8'});
    assert.strictEqual(badOption.status, launcher.EXIT.usage);
    assert.match(badOption.stderr, /unknown option/);
  });

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

run().catch(error => { console.error(error); process.exit(1); });
