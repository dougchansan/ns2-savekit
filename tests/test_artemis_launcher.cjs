#!/usr/bin/env node
// Offline tests for the Artemis Launcher installer: staging safety, backup
// integrity, receipts, rollback ownership and the post-restore check.
//
//   node tests/test_artemis_launcher.cjs
//
// No console and no network: every console interaction is either a pure
// function or a command that must fail before it opens one. Fixtures are
// synthetic; no real save, no upstream bytes and no third-party file is
// committed.
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const {spawnSync} = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const TOOL = path.join(ROOT, 'tools', 'artemis-launcher.cjs');
const launcher = require(TOOL);
const {validateBackup} = require(path.join(ROOT, 'tools/lib/artemis-backup.cjs'));
const staging = require(path.join(ROOT, 'tools/lib/artemis-staging.cjs'));
const receipts = require(path.join(ROOT, 'tools/lib/artemis-receipt.cjs'));

let passes = 0, failures = 0;
const test = async (name, fn) => {
  try { await fn(); passes++; console.log('ok    ' + name); }
  catch (error) { failures++; console.log('FAIL  ' + name + '\n      ' + (error && error.stack || error)); }
};

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const UID = 'a'.repeat(32);
const TITLE = '010042d022aea000';
const TITLE_OBJ = () => launcher.titleFor(TITLE);

// A minimal valid BOWS v1002 container: a caret whose script target is
// retargetable by tools/artemis-save.py. This is what a real suspend save looks
// like structurally, without any game data.
function bowsFixture(script = 'save:/game.asb') {
  const fields = Buffer.alloc(0x20);
  fields.writeUInt32LE(0, 0x00);              // caret field 1
  fields.writeUInt32LE(0, 0x04);              // caret field 4
  const text = Buffer.from(script);
  fields.writeUInt32LE(text.length, 0x08);
  text.copy(fields, 0x0c);
  const groups = [
    [0x00, [[3, 0x10]]],
    [0x10, [[1, 0x00], [3, 0x08], [4, 0x04]]],
  ];
  const index = [Buffer.alloc(4)];
  index[0].writeUInt32LE(groups.length, 0);
  const parts = [fields, ...index];
  for (const [base, entries] of groups) {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(base, 0);
    head.writeUInt32LE(entries.length, 4);
    parts.push(head);
    for (const [key, offset] of entries) {
      const row = Buffer.alloc(8);
      row.writeUInt32LE(key, 0);
      row.writeUInt32LE(offset, 4);
      parts.push(row);
    }
  }
  const tail = Buffer.alloc(4);
  tail.writeUInt32LE(fields.length, 0);
  const body = Buffer.concat([...parts, tail]);
  const header = Buffer.alloc(12);
  header.write('BOWS', 0, 'latin1');
  header.writeUInt32LE(1002, 4);
  header.writeUInt32LE(body.length, 8);
  return Buffer.concat([header, zlib.deflateSync(body, {level: 9})]);
}

function upstreamFixture() {
  const dir = tmp('artemis-upstream-');
  for (const overlay of ['seedsow_save', 'nora2_save']) {
    fs.mkdirSync(path.join(dir, overlay), {recursive: true});
    fs.writeFileSync(path.join(dir, overlay, 'core.lua'), 'fixture core ' + overlay);
  }
  fs.mkdirSync(path.join(dir, 'common'));
  for (const name of ['inject.iet', 'inject.lua', 'http.lua', 'exploita.lua', 'proggy.ttf']) {
    fs.writeFileSync(path.join(dir, 'common', name), 'fixture ' + name);
  }
  return dir;
}

// A backup directory as save-pull-root writes it. `identity` adds the full
// programId/uid fields; without them it is a legacy backup.
function backupFixture({identity = true, partial = false, failed = [], extra = [],
  trigger = true, titleId = TITLE, uid = UID, corrupt = false, mutate,
  realTrigger = false, contents = {}} = {}) {
  const dir = tmp('artemis-backup-');
  const entries = [];
  const add = (name, bytes) => {
    fs.writeFileSync(path.join(dir, name), bytes);
    entries.push({path: '/' + name, size: bytes.length, sha256: sha(bytes)});
  };
  add('system.dat', Buffer.from('sys!'));
  add('saveg.dat', Buffer.from('savg'));
  if (trigger) add('save9999.dat', realTrigger ? bowsFixture() : Buffer.from('game suspend save'));
  for (const name of ['ns2jb.asb', 'ns2jb.lua', 'ssedit1.lua', 'sed01.asb']) add(name, 'x' + name);
  for (const name of extra) add(name, 'editor ' + name);
  for (const [name, bytes] of Object.entries(contents)) add(name, bytes);
  if (corrupt) fs.writeFileSync(path.join(dir, 'system.dat'), 'corrupt');
  const manifest = {
    archive: 'space=User type=Account rank=0 index=0 uid=' + String(uid).slice(0, 16),
    files: entries.length,
    bytes: entries.reduce((n, e) => n + e.size, 0),
    partial,
    failed,
    entries,
  };
  if (identity) { manifest.programId = titleId; manifest.uid = uid; }
  if (mutate) mutate(manifest);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return dir;
}

async function loadValid(dir) {
  const backup = await validateBackup(dir, {trigger: 'save9999.dat'});
  assert.strictEqual(backup.ok, true, backup.problems.join('; '));
  return backup;
}

function planFixture() {
  const files = launcher.LAUNCHER_FILES.map(name => ({
    path: '/' + name, local: name, size: 10, sha256: sha(Buffer.from(name)),
    replace: false,
  }));
  files.push({path: '/save9999.dat', local: 'save9999.dat', size: 20,
    sha256: sha(Buffer.from('installed trigger')), replace: true});
  return {files, manifest: {}, conflicts: []};
}

async function receiptFixture({backupDir = backupFixture(), status = null,
  progress} = {}) {
  const backup = await loadValid(backupDir);
  const title = TITLE_OBJ();
  const receipt = launcher.makeReceipt({
    title, uid: UID, backup, plan: planFixture(), upstream: {},
  });
  if (status) receipt.status = status;
  if (progress) receipt.progress = progress;
  return {receipt, backup, title};
}

function liveFromReceipt(receipt) {
  return {entries: receipt.installed.map(entry => ({path: entry.path, size: entry.size,
    sha256: entry.sha256}))};
}

function receiptFixtureClone(receipt, mutate) {
  const copy = JSON.parse(JSON.stringify(receipt));
  mutate(copy);
  return copy;
}

// Stage with a stub retarget (the real one needs a BOWS container).
async function stageFixture({upstream = upstreamFixture(), backup, out,
  retarget = (input, output) => fs.copyFileSync(input, output)} = {}) {
  const title = TITLE_OBJ();
  const staged = await launcher.stageTo({title, upstream, backup, outDir: out, retarget});
  const plan = await launcher.buildManifest({title, outDir: staged.build, backup});
  await launcher.writeManifest(staged.build, plan.manifest);
  await staging.promoteBuild(staged.build, staged.target, title.id);
  return {plan, out: staged.target};
}

async function run() {
  // ------------------------------------------------------------- titles/pins --
  await test('the two supported demo ids select their own overlay', () => {
    assert.strictEqual(launcher.titleFor('010042d022aea000').overlay, 'seedsow_save');
    assert.strictEqual(launcher.titleFor('0x010012900d38a000').overlay, 'nora2_save');
    assert.strictEqual(launcher.titleFor('010012900D38A000').slug, 'Nora-2-demo');
  });

  await test('an unsupported title is refused with exit 5, never staged', () => {
    for (const id of ['0100ee5021c9e000', '01005eb012fe2000', '', null]) {
      assert.throws(() => launcher.titleFor(id), error =>
        error instanceof launcher.Failure && error.code === launcher.EXIT.unsupported);
    }
  });

  await test('pinned files exclude upstream game state and match expectedHashes', () => {
    const seedsow = TITLE_OBJ();
    const pinned = launcher.pinnedFor(seedsow);
    assert.deepStrictEqual(Object.keys(pinned).sort(), [
      'common/exploita.lua', 'common/http.lua', 'common/inject.iet', 'common/inject.lua',
      'common/proggy.ttf', 'seedsow_save/core.lua']);
    assert.ok(!Object.keys(pinned).some(n => /saveg\.dat|system\.dat|save9999\.dat/.test(n)));
    const expected = launcher.expectedHashes(seedsow);
    assert.deepStrictEqual(Object.keys(expected).sort(),
      launcher.LAUNCHER_FILES.map(n => '/' + n).sort());
    assert.strictEqual(expected['/core.lua'], pinned['seedsow_save/core.lua']);
  });

  // ----------------------------------------------------------------- staging --
  await test('staging writes the seven files with a deterministic manifest', async () => {
    const backup = await loadValid(backupFixture());
    const out = path.join(tmp('artemis-stage-'), 'payload');
    const {plan} = await stageFixture({backup, out});
    assert.deepStrictEqual(plan.files.map(f => f.path), [
      '/core.lua', '/exploita.lua', '/http.lua', '/inject.iet', '/inject.lua',
      '/proggy.ttf', '/save9999.dat']);
    assert.deepStrictEqual(plan.files.filter(f => f.replace).map(f => f.path), ['/save9999.dat']);
    for (const file of plan.files) {
      assert.match(file.sha256, /^[0-9a-f]{64}$/);
      assert.strictEqual(file.local, path.basename(file.local));
      assert.strictEqual(sha(fs.readFileSync(path.join(out, file.local))), file.sha256);
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    assert.strictEqual(manifest.backupManifestSha256, backup.manifestSha256);
    assert.ok(fs.existsSync(path.join(out, staging.MARKER)));
    assert.ok(!manifest.files.some(f => f.path.includes(staging.MARKER)));
  });

  await test('rebuilding the same staging directory produces identical bytes', async () => {
    const backup = await loadValid(backupFixture());
    const out = path.join(tmp('artemis-det-'), 'payload');
    const once = async () => JSON.stringify((await stageFixture({backup, out})).plan.manifest);
    assert.strictEqual(await once(), await once());
    assert.deepStrictEqual(fs.readdirSync(path.dirname(out))
      .filter(n => n.startsWith('.artemis-build-')), []);
  });

  await test('dangerous staging destinations are refused', async () => {
    for (const out of ['/', os.homedir(), ROOT, path.join(ROOT, 'tools'),
      path.join(ROOT, 'staging')]) {
      await assert.rejects(staging.assertSafeTarget(out, {titleId: TITLE, repo: ROOT}),
        error => error.code === 'EUNSAFE');
    }
  });

  await test('an existing unrelated directory is not deleted', async () => {
    const dir = tmp('artemis-unrelated-');
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'keep');
    await assert.rejects(staging.assertSafeTarget(dir, {titleId: TITLE, repo: ROOT}),
      error => error.code === 'EUNSAFE' && /not ours/.test(error.message));
    assert.strictEqual(fs.readFileSync(path.join(dir, 'keep.txt'), 'utf8'), 'keep');
  });

  await test('a symlinked staging target is refused', async () => {
    const real = tmp('artemis-real-');
    const link = path.join(tmp('artemis-link-'), 'payload');
    fs.symlinkSync(real, link);
    await assert.rejects(staging.assertSafeTarget(link, {titleId: TITLE, repo: ROOT}),
      error => error.code === 'EUNSAFE' && /symlink/.test(error.message));
  });

  await test('a failed build leaves the previous staged payload untouched', async () => {
    const backup = await loadValid(backupFixture());
    const out = path.join(tmp('artemis-keep-'), 'payload');
    await stageFixture({backup, out});
    const before = fs.readFileSync(path.join(out, 'core.lua'));
    const beforeManifest = fs.readFileSync(path.join(out, 'manifest.json'));
    await assert.rejects(staging.assertSafeTarget(out, {titleId: TITLE, repo: ROOT})
      .then(() => launcher.stageTo({title: TITLE_OBJ(), upstream: upstreamFixture(),
        backup, outDir: out, retarget: () => { throw new Error('simulated failure'); }})));
    assert.deepStrictEqual(fs.readFileSync(path.join(out, 'core.lua')), before);
    assert.deepStrictEqual(fs.readFileSync(path.join(out, 'manifest.json')), beforeManifest);
    assert.deepStrictEqual(fs.readdirSync(path.dirname(out))
      .filter(n => n.startsWith('.artemis-build-')), []);
  });

  // ------------------------------------------------------------ backup rules --
  await test('a complete backup validates and exposes identity', async () => {
    const backup = await loadValid(backupFixture());
    assert.deepStrictEqual(backup.identity, {programId: TITLE, uid: UID});
    assert.match(backup.manifestSha256, /^[0-9a-f]{64}$/);
    assert.ok(backup.names.has('/save9999.dat'));
  });

  await test('partial, failed, inconsistent and duplicate manifests are refused', async () => {
    const cases = [
      {partial: true},
      {failed: [{path: '/x', result: '0x2'}]},
      {mutate: m => { m.files = m.entries.length + 1; }},
      {mutate: m => { m.bytes = m.bytes + 1; }},
      {mutate: m => { m.entries.push({...m.entries[0]}); }},
      {mutate: m => { m.entries[0].path = '../escape'; }},
      {mutate: m => { m.entries[0].sha256 = 'nope'; }},
      {corrupt: true},
      {trigger: false},
    ];
    for (const options of cases) {
      const backup = await validateBackup(backupFixture(options), {trigger: 'save9999.dat'});
      assert.strictEqual(backup.ok, false, JSON.stringify(options) + ' should fail');
      assert.ok(backup.problems.length > 0);
    }
  });

  await test('a symlinked backup file is refused', async () => {
    const dir = backupFixture();
    const real = path.join(dir, 'real.bin');
    fs.writeFileSync(real, 'outside');
    fs.unlinkSync(path.join(dir, 'system.dat'));
    fs.symlinkSync(real, path.join(dir, 'system.dat'));
    const backup = await validateBackup(dir, {trigger: 'save9999.dat'});
    assert.strictEqual(backup.ok, false);
    assert.ok(backup.problems.some(p => /symlink/.test(p)));
  });

  await test('identity is required on demand and the truncated archive is not identity', async () => {
    const legacy = backupFixture({identity: false});
    const allowed = await validateBackup(legacy, {trigger: 'save9999.dat'});
    assert.strictEqual(allowed.ok, true);
    assert.strictEqual(allowed.identity, null);
    const refused = await validateBackup(legacy, {trigger: 'save9999.dat', requireIdentity: true});
    assert.strictEqual(refused.ok, false);
    assert.ok(refused.problems.some(p => /identity cannot be established/.test(p)));
    const wrongUid = await validateBackup(backupFixture(), {trigger: 'save9999.dat',
      requireIdentity: true, titleId: TITLE, uid: 'b'.repeat(32)});
    assert.strictEqual(wrongUid.ok, false);
    const wrongTitle = await validateBackup(backupFixture(), {trigger: 'save9999.dat',
      requireIdentity: true, titleId: '010012900d38a000', uid: UID});
    assert.strictEqual(wrongTitle.ok, false);
  });

  // --------------------------------------------------------------- receipts --
  await test('makeReceipt records identity, backup hash and add/replace hashes', async () => {
    const {receipt} = await receiptFixture();
    assert.strictEqual(receipt.status, 'installing');
    assert.strictEqual(receipt.account.uid, UID);
    assert.strictEqual(receipt.title.id, TITLE);
    assert.strictEqual(receipt.upstream.commit, launcher.UPSTREAM_COMMIT);
    assert.match(receipt.backup.manifestSha256, /^[0-9a-f]{64}$/);
    assert.strictEqual(receipt.installed.length, 7);
    const trigger = receipt.installed.find(e => e.path === '/save9999.dat');
    assert.strictEqual(trigger.kind, 'replace');
    assert.strictEqual(trigger.originalSha256, receipt.backup.triggerSha256);
    assert.strictEqual(receipt.installed.filter(e => e.kind === 'add').length, 6);
  });

  await test('receipt validation rejects wrong account, title, commit and paths', async () => {
    const {receipt} = await receiptFixture();
    assert.deepStrictEqual(receipts.validateReceipt(receipt, {titleId: TITLE, uid: UID,
      commit: launcher.UPSTREAM_COMMIT, launcherFiles: launcher.LAUNCHER_FILES,
      trigger: launcher.TRIGGER}), []);
    assert.ok(receipts.validateReceipt(receiptFixtureClone(receipt,
      r => { r.account.uid = 'b'.repeat(32); }), {uid: UID}).length);
    assert.ok(receipts.validateReceipt(receiptFixtureClone(receipt,
      r => { r.title.id = '010012900d38a000'; }), {titleId: TITLE}).length);
    assert.ok(receipts.validateReceipt(receiptFixtureClone(receipt,
      r => { r.upstream.commit = 'f'.repeat(40); }), {commit: launcher.UPSTREAM_COMMIT}).length);
    assert.ok(receipts.validateReceipt(receiptFixtureClone(receipt,
      r => { r.installed.push({path: '/evil.lua', sha256: sha(Buffer.from('x')), kind: 'add'}); }),
      {launcherFiles: launcher.LAUNCHER_FILES}).length);
    assert.ok(receipts.validateReceipt(receiptFixtureClone(receipt,
      r => { r.installed = r.installed.filter(e => e.path !== '/save9999.dat'); }),
      {trigger: launcher.TRIGGER}).length);
  });

  await test('receipts round-trip through the local state directory', async () => {
    const state = tmp('artemis-state-');
    const previous = process.env.ARTEMIS_STATE;
    process.env.ARTEMIS_STATE = state;
    try {
      const {receipt} = await receiptFixture();
      const file = await receipts.writeReceipt(receipt);
      assert.ok(file.startsWith(state));
      assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
      assert.deepStrictEqual(await receipts.readReceipt(TITLE, UID), receipt);
      assert.deepStrictEqual(fs.readdirSync(path.dirname(file)).filter(n => n.includes('.tmp-')), []);
    } finally {
      if (previous === undefined) delete process.env.ARTEMIS_STATE;
      else process.env.ARTEMIS_STATE = previous;
    }
  });

  // ------------------------------------------------------ rollback preflight --
  await test('preflight accepts an untouched installation', async () => {
    const {receipt, backup} = await receiptFixture();
    const analysis = launcher.analyzeReceiptState({live: liveFromReceipt(receipt), receipt,
      backup, title: TITLE_OBJ()});
    assert.deepStrictEqual(analysis.problems, []);
  });

  await test('preflight refuses a modified launcher payload and names it', async () => {
    const {receipt, backup} = await receiptFixture();
    const live = liveFromReceipt(receipt);
    live.entries.find(e => e.path === '/http.lua').sha256 = sha(Buffer.from('edited by user'));
    const analysis = launcher.analyzeReceiptState({live, receipt, backup, title: TITLE_OBJ()});
    assert.deepStrictEqual(analysis.modified, ['/http.lua']);
    assert.ok(analysis.problems.some(p => /\/http\.lua was modified/.test(p)));
  });

  await test('preflight reports missing and unexpected files', async () => {
    const {receipt, backup} = await receiptFixture();
    const live = liveFromReceipt(receipt);
    live.entries = live.entries.filter(e => e.path !== '/proggy.ttf');
    const withoutCore = receiptFixtureClone(receipt,
      r => { r.installed = r.installed.filter(e => e.path !== '/core.lua'); });
    live.entries.push({path: '/core.lua', size: 1, sha256: sha(Buffer.from('foreign'))});
    const analysis = launcher.analyzeReceiptState({live, receipt: withoutCore, backup,
      title: TITLE_OBJ()});
    assert.ok(analysis.problems.some(p => /\/proggy\.ttf is missing/.test(p)));
    assert.ok(analysis.problems.some(p => /\/core\.lua is present but not owned/.test(p)));
  });

  await test('preflight resumes a partially restored install', async () => {
    const {receipt, backup} = await receiptFixture({status: 'restoring',
      progress: {trigger: 'done', deleted: ['/core.lua', '/http.lua']}});
    const live = liveFromReceipt(receipt);
    live.entries = live.entries.filter(e => !['/core.lua', '/http.lua'].includes(e.path));
    live.entries.find(e => e.path === '/save9999.dat').sha256 = receipt.backup.triggerSha256;
    const analysis = launcher.analyzeReceiptState({live, receipt, backup, title: TITLE_OBJ()});
    assert.deepStrictEqual(analysis.problems, []);
    assert.deepStrictEqual(analysis.deleted.sort(), ['/core.lua', '/http.lua']);
  });

  await test('preflight resumes when a delete landed but its receipt update did not', async () => {
    const {receipt, backup} = await receiptFixture({status: 'restoring',
      progress: {trigger: 'pending', deleted: []}});
    const live = liveFromReceipt(receipt);
    live.entries = live.entries.filter(e => e.path !== '/http.lua');
    const analysis = launcher.analyzeReceiptState({live, receipt, backup, title: TITLE_OBJ()});
    assert.deepStrictEqual(analysis.problems, []);
    assert.deepStrictEqual(analysis.deleted, ['/http.lua']);
  });

  await test('preflight resumes when the trigger landed but its receipt update did not', async () => {
    const {receipt, backup} = await receiptFixture({status: 'restoring',
      progress: {trigger: 'pending', deleted: []}});
    const live = liveFromReceipt(receipt);
    live.entries.find(e => e.path === '/save9999.dat').sha256 = receipt.backup.triggerSha256;
    const analysis = launcher.analyzeReceiptState({live, receipt, backup, title: TITLE_OBJ()});
    assert.deepStrictEqual(analysis.problems, []);
    assert.strictEqual(analysis.triggerAlreadyRestored, true);
  });

  await test('a second restore sees the post-rollback state and is a no-op', async () => {
    const initial = await receiptFixture();
    const adds = initial.receipt.installed.filter(e => e.kind === 'add').map(e => e.path);
    const {receipt, backup} = await receiptFixture({status: 'restored',
      progress: {trigger: 'done', deleted: adds}});
    // The save after a restore: backup trigger, launcher files gone, and an
    // unrelated editor file that must not be reported as unexpected.
    const live = {entries: [
      {path: '/save9999.dat', size: 19, sha256: receipt.backup.triggerSha256},
      {path: '/ssedit1.lua', size: 5, sha256: sha(Buffer.from('editor'))},
    ]};
    const analysis = launcher.analyzeReceiptState({live, receipt, backup, title: TITLE_OBJ()});
    assert.deepStrictEqual(analysis.problems, []);
    assert.deepStrictEqual(analysis.deleted.sort(), adds.sort());
    assert.strictEqual(analysis.triggerAlreadyRestored, true);
  });

  await test('preflight refuses a replaced trigger that is not the expected one', async () => {
    const {receipt, backup} = await receiptFixture();
    const live = liveFromReceipt(receipt);
    live.entries.find(e => e.path === '/save9999.dat').sha256 = sha(Buffer.from('other boot'));
    const analysis = launcher.analyzeReceiptState({live, receipt, backup, title: TITLE_OBJ()});
    assert.ok(analysis.problems.some(p => /save9999\.dat live sha256/.test(p)));
  });

  await test('preflight warns about upstream update files without deleting them', async () => {
    const {receipt, backup} = await receiptFixture();
    const live = liveFromReceipt(receipt);
    live.entries.push({path: '/inject2.lua', size: 1, sha256: sha(Buffer.from('update'))});
    const analysis = launcher.analyzeReceiptState({live, receipt, backup, title: TITLE_OBJ()});
    assert.deepStrictEqual(analysis.problems, []);
    assert.deepStrictEqual(analysis.updates, ['/inject2.lua']);
  });

  await test('post-restore verification requires the backup trigger and absent adds', async () => {
    const {receipt, backup} = await receiptFixture();
    const clean = {entries: [{path: '/save9999.dat', size: 19,
      sha256: receipt.backup.triggerSha256}]};
    assert.deepStrictEqual(launcher.postRestoreProblems({post: clean, receipt, backup}), []);
    const lingering = {entries: [...clean.entries,
      {path: '/http.lua', size: 1, sha256: sha(Buffer.from('x'))}]};
    assert.ok(launcher.postRestoreProblems({post: lingering, receipt, backup})
      .some(p => /http\.lua is still present/.test(p)));
    const wrongTrigger = {entries: [{path: '/save9999.dat', size: 1,
      sha256: sha(Buffer.from('wrong'))}]};
    assert.ok(launcher.postRestoreProblems({post: wrongTrigger, receipt, backup}).length);
  });

  // ------------------------------------------------------- editor/ns2jb compat --
  await test('a re-install over the same pinned bytes is a replace, not a conflict', async () => {
    const upstream = upstreamFixture();
    const out = path.join(tmp('artemis-repeat-'), 'payload');
    const first = await launcher.stageTo({title: TITLE_OBJ(), upstream, backup:
      await loadValid(backupFixture()), outDir: out,
      retarget: (input, output) => fs.copyFileSync(input, output)});
    const staged = {};
    for (const name of launcher.LAUNCHER_FILES) staged[name] = fs.readFileSync(path.join(first.build, name));
    const expected = {};
    for (const [name, bytes] of Object.entries(staged)) expected['/' + name] = sha(bytes);
    const backup2 = await loadValid(backupFixture({contents: staged}));
    const plan = await launcher.buildManifest({title: TITLE_OBJ(), outDir: first.build,
      backup: backup2, expected});
    assert.deepStrictEqual(plan.conflicts, []);
    assert.deepStrictEqual(plan.files.filter(f => f.replace).length, 7);
    const wrong = {...expected, '/core.lua': sha(Buffer.from('not the pinned core'))};
    const conflict = await launcher.buildManifest({title: TITLE_OBJ(), outDir: first.build,
      backup: backup2, expected: wrong});
    assert.deepStrictEqual(conflict.conflicts.map(c => c.name), ['/core.lua']);
    assert.ok(!conflict.files.some(f => f.path === '/core.lua'));
  });

  await test('editor and ns2jb files in the backup are untouched by the plan', async () => {
    const backup = await loadValid(backupFixture({extra: ['sscode004.lua']}));
    const out = path.join(tmp('artemis-compat-'), 'payload');
    const {plan} = await stageFixture({backup, out});
    assert.deepStrictEqual(plan.conflicts, []);
    const touched = plan.files.map(f => f.path);
    for (const name of ['/ssedit1.lua', '/sed01.asb', '/sscode004.lua', '/ns2jb.asb', '/ns2jb.lua']) {
      assert.ok(!touched.includes(name), name + ' must not be installed over');
    }
  });

  // ---------------------------------------------------------- CLI behaviour --
  await test('install refuses without --confirm even with valid prerequisites', () => {
    if (spawnSync('python3', ['--version']).status !== 0) {
      console.log('      (python3 missing; retarget step cannot run - skipped)');
      return;
    }
    const state = tmp('artemis-state-');
    const result = spawnSync(process.execPath, [TOOL, 'install', 'no-such-run',
      '--title', TITLE, '--uid', UID, '--backup', backupFixture({realTrigger: true}),
      '--source', upstreamFixture(), '--out', path.join(tmp('artemis-cli-'), 'payload')], {
      encoding: 'utf8', env: {...process.env, ARTEMIS_STATE: state},
    });
    assert.strictEqual(result.status, launcher.EXIT.usage, result.stderr);
    assert.match(result.stderr, /--confirm/);
  });

  await test('install without --backup and without a session fails closed', () => {
    const result = spawnSync(process.execPath, [TOOL, 'install', 'no-such-run',
      '--title', TITLE, '--uid', UID, '--confirm'], {
      encoding: 'utf8', env: {...process.env, ARTEMIS_STATE: tmp('artemis-state-'),
        ARTEMIS_SAVES: tmp('artemis-saves-')},
    });
    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /pull did not complete|FAILED/i);
  });

  await test('restore without a receipt and without --adopt-legacy is refused', () => {
    const result = spawnSync(process.execPath, [TOOL, 'restore', 'no-such-run',
      '--title', TITLE, '--uid', UID, '--backup', backupFixture(), '--confirm-restore'],
      {encoding: 'utf8', env: {...process.env, ARTEMIS_STATE: tmp('artemis-state-')}});
    assert.strictEqual(result.status, launcher.EXIT.usage, result.stderr);
    assert.match(result.stderr, /adopt-legacy/);
  });

  await test('restore refuses a backup whose identity cannot be established', () => {
    const result = spawnSync(process.execPath, [TOOL, 'restore', 'no-such-run',
      '--title', TITLE, '--uid', UID, '--backup', backupFixture({identity: false}),
      '--confirm-restore'], {encoding: 'utf8',
      env: {...process.env, ARTEMIS_STATE: tmp('artemis-state-')}});
    assert.strictEqual(result.status, launcher.EXIT.prereq, result.stderr);
    assert.match(result.stderr, /identity cannot be established|does not record/);
  });

  await test('a bad uid and an unknown option exit 2', () => {
    const badUid = spawnSync(process.execPath, [TOOL, 'install', 'x', '--title', TITLE,
      '--uid', 'zz'], {encoding: 'utf8'});
    assert.strictEqual(badUid.status, launcher.EXIT.usage);
    const badOption = spawnSync(process.execPath, [TOOL, 'stage', '--nope'], {encoding: 'utf8'});
    assert.strictEqual(badOption.status, launcher.EXIT.usage);
  });

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

run().catch(error => { console.error(error); process.exit(1); });
