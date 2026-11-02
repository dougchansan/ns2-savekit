#!/usr/bin/env node
'use strict';
// Install alula's upstream Artemis Launcher into a supported Artemis save.
//
//   node tools/artemis-launcher.cjs stage   --title <id> --backup <dir> [--out <dir>] [--source <dir>]
//   node tools/artemis-launcher.cjs plan    --title <id> --backup <dir> [--source <dir>]
//   node tools/artemis-launcher.cjs install <run> --title <id> [--uid <hex>] [--backup <dir>] --confirm
//   node tools/artemis-launcher.cjs verify  <run> --title <id> [--uid <hex>] [--backup <dir>]
//   node tools/artemis-launcher.cjs restore <run> --title <id> [--uid <hex>] --backup <dir> --confirm-restore
//
// This is a *separate* installer from `inject-launcher.sh`, which installs this
// repository's own ns2jb launcher. Both write the same boot trigger
// (`save9999.dat`), so only one can own it at a time; nothing here changes the
// existing option.
//
// What it does, in order:
//   1. obtains alula's pinned source revision (cache, or download-on-demand) and
//      verifies every file it uses against a recorded sha256;
//   2. builds the save9999.dat boot trigger by retargeting the *game's own*
//      suspend save at the upstream `inject.iet` - the game's container version
//      is kept, so an old upstream save file is never written over a newer one;
//   3. stages the upstream files plus that trigger and writes a deterministic
//      manifest (path, size, sha256, add/replace);
//   4. refuses to replace anything except the boot trigger, and refuses to run
//      without a complete backup;
//   5. writes through the existing `save-write-stage.cjs` (one transaction, hash
//      verified), then pulls the save again and checks it against the manifest.
//
// Exit codes (the toolkit's contract):
//   0  done and verified
//   2  bad usage
//   3  SESSION LOST - the console stopped answering
//   4  NO LIVE HOST - the run folder has no live memory socket
//   5  unsupported title (not one of the two demos upstream supports)
//   6  missing prerequisite - no backup, no save archive, no upstream source
//   7  conflict - a staged file would overwrite something it must not
//   8  verification failed
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');

const TOOLS = __dirname;
const REPO = path.resolve(TOOLS, '..');
const UPSTREAM_REPO = 'https://github.com/alula/switch-artemis-launcher';
const UPSTREAM_COMMIT = 'b9e6de82934dfda1f2c6219aaf305ed980a3d1ba';
const UPSTREAM_TAG = 'v1';
const UPSTREAM_TARBALL = '1eed750f8eedffd73d9556ffd4d7b90b11e02f2ded6896c83fb224ad6b3ac1f1';

// Every upstream byte this installer copies. `common/save9999.dat`, `saveg.dat`
// and `system.dat` are deliberately absent: the first is rebuilt from the game's
// own save, and the other two are the upstream author's own game state, which is
// not ours to overwrite. Verify a revision by these hashes, not by a tarball:
// GitHub regenerates tarballs, but these files are the actual payload.
const UPSTREAM_FILES = {
  'common/inject.iet': 'bf79a739584de93d1569523a8a87e7ef8ce65edcf073b5d2ba37453c4085ada4',
  'common/inject.lua': 'fcc6b5877084df15b45dfbd8c955ee4f802add7030f1c98f3006794f8949a08b',
  'common/http.lua': '2985b8f7040fc40c7e2c18e5cf857c3c5d14c0b9d081ef0a1a8742eab6f026a1',
  'common/exploita.lua': 'a84bb1230b2edd73f469afd5aba69b3ca191e6c25b444cf93d23342b64d6af18',
  'common/proggy.ttf': '527d2a443ce051f93f7e77b855609722b8cb220a9f104b4aa037be5c90b71324',
  'seedsow_save/core.lua': '54d25862dc0d796985ebe69f34a345df16671c97372d67062769d28c293d4ed6',
  'nora2_save/core.lua': 'bf83da2fbf9753f5a7a98df852938eae0ee7d26dda240991aad08e5ebd810505',
};

// The demo titles upstream supports. The full games are not supported upstream,
// so they are refused here instead of being written with a payload for a demo.
const TITLES = {
  '010042d022aea000': {
    name: 'Seedsow Lullaby (demo)',
    slug: 'Seedsow-Lullaby-demo',
    overlay: 'seedsow_save',
  },
  '010012900d38a000': {
    name: 'Nora to Oujo to Noraneko Heart 2 (demo)',
    slug: 'Nora-2-demo',
    overlay: 'nora2_save',
  },
};

const LAUNCHER_FILES = ['core.lua', 'exploita.lua', 'http.lua', 'inject.iet',
  'inject.lua', 'proggy.ttf'];
const TRIGGER = 'save9999.dat';

const EXIT = {ok: 0, usage: 2, sessionLost: 3, noHost: 4, unsupported: 5,
  prereq: 6, conflict: 7, verify: 8};

class Failure extends Error {
  constructor(code, message, extra) {
    super(message);
    this.code = code;
    this.extra = extra || [];
  }
}

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fileSha = async file => sha256(await fsp.readFile(file));
const exists = file => fs.existsSync(file);

function note(lines) {
  for (const line of lines) console.error(line);
}

// ---------------------------------------------------------------- arguments --
function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {command, _: []};
  const takesValue = new Set(['title', 'uid', 'backup', 'out', 'source', 'staging']);
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith('--')) { options._.push(token); continue; }
    const name = token.slice(2);
    if (name === 'confirm' || name === 'confirm-restore' || name === 'dry-run' ||
        name === 'json' || name === 'force') {
      options[name] = true;
      continue;
    }
    if (!takesValue.has(name)) throw new Failure(EXIT.usage, 'unknown option --' + name);
    const value = rest[++i];
    if (value === undefined || value.startsWith('--')) {
      throw new Failure(EXIT.usage, '--' + name + ' needs a value');
    }
    options[name] = value;
  }
  return options;
}

function titleFor(id) {
  const key = String(id || '').toLowerCase().replace(/^0x/, '');
  const found = TITLES[key];
  if (!found) {
    throw new Failure(EXIT.unsupported, 'unsupported title ' + (id || '(none)') +
      ' - upstream supports only ' + Object.keys(TITLES).join(', '));
  }
  return {id: key, ...found};
}

function uidFor(options, title) {
  if (options.uid) {
    const hex = String(options.uid).replace(/^0x/i, '').toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(hex)) throw new Failure(EXIT.usage, '--uid must be 32 hex chars');
    return hex;
  }
  // Local, gitignored config. Never a compiled-in account id.
  try {
    const config = JSON.parse(fs.readFileSync(path.join(REPO, 'config/uids.json'), 'utf8'));
    const found = config[title.id];
    if (found) return String(found).toLowerCase();
  } catch { /* no local config */ }
  throw new Failure(EXIT.usage, '--uid is required (or add ' + title.id +
    ' to config/uids.json locally)');
}

// ----------------------------------------------------------------- upstream --
function cacheRoot() {
  // ARTEMIS_CACHE keeps the download cache somewhere writable on locked-down
  // setups; the default is the same XDG-ish path the editor fetch uses.
  return process.env.ARTEMIS_CACHE ||
    path.join(os.homedir(), '.cache', 'ns2-savekit', 'artemis-launcher');
}

function pinnedFor(title) {
  const wanted = {[title.overlay + '/core.lua']: UPSTREAM_FILES[title.overlay + '/core.lua']};
  for (const name of ['common/inject.iet', 'common/inject.lua', 'common/http.lua',
    'common/exploita.lua', 'common/proggy.ttf']) {
    wanted[name] = UPSTREAM_FILES[name];
  }
  return wanted;
}

async function verifyUpstream(directory, pinned = UPSTREAM_FILES) {
  const problems = [];
  for (const [name, want] of Object.entries(pinned)) {
    const file = path.join(directory, name);
    let bytes;
    try {
      bytes = await fsp.readFile(file);
    } catch {
      problems.push('missing ' + name);
      continue;
    }
    if (!want) { problems.push('no pinned hash for ' + name); continue; }
    const got = sha256(bytes);
    if (got !== want) problems.push(name + ' sha256 ' + got.slice(0, 16) + '… != ' + want.slice(0, 16) + '…');
  }
  return problems;
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options});
}

async function obtainUpstream(title, options) {
  // 1. an explicit checkout the caller already trusts enough to let us verify
  if (options.source) {
    const dir = path.resolve(options.source);
    const problems = await verifyUpstream(dir, pinnedFor(title));
    if (problems.length) {
      throw new Failure(EXIT.prereq, '--source does not match the pinned revision:',
        problems.map(p => '  ' + p));
    }
    return dir;
  }
  // 2. the verified cache
  const cached = path.join(cacheRoot(), UPSTREAM_COMMIT);
  if (exists(cached)) {
    const problems = await verifyUpstream(cached, pinnedFor(title));
    if (!problems.length) return cached;
  }
  // 3. download-on-demand, then verify every file we will use
  try {
    await fsp.mkdir(path.dirname(cached), {recursive: true});
  } catch (error) {
    throw new Failure(EXIT.prereq, 'cannot create the download cache: ' + path.dirname(cached), [
      '  ' + error.message,
      '  set ARTEMIS_CACHE to a writable directory, or pass --source with a verified checkout',
    ]);
  }
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'artemis-launcher-'));
  const tarball = path.join(work, 'upstream.tar.gz');
  const url = 'https://codeload.github.com/alula/switch-artemis-launcher/tar.gz/' + UPSTREAM_COMMIT;
  const fetched = run('curl', ['-fsSL', '--max-time', '120', '-o', tarball, url]);
  if (fetched.status !== 0) {
    throw new Failure(EXIT.prereq, 'could not download the pinned upstream revision ' +
      UPSTREAM_COMMIT + ' and no verified cache exists', [
      '  url: ' + url,
      '  ' + String(fetched.stderr || fetched.error || '').trim().slice(0, 200),
      '  offline? point --source at a verified checkout of ' + UPSTREAM_REPO,
    ]);
  }
  const tarballSha = await fileSha(tarball);
  if (tarballSha !== UPSTREAM_TARBALL) {
    note(['note: tarball sha256 ' + tarballSha.slice(0, 16) + '… differs from the recorded ' +
      UPSTREAM_TARBALL.slice(0, 16) + '… (GitHub may regenerate archives);',
    '      the per-file hashes below still decide whether this revision is accepted.']);
  }
  const extracted = path.join(work, 'src');
  await fsp.mkdir(extracted);
  const untar = run('tar', ['-xzf', tarball, '-C', extracted, '--strip-components=1']);
  if (untar.status !== 0) {
    throw new Failure(EXIT.prereq, 'could not unpack the upstream tarball',
      [String(untar.stderr || '').trim().slice(0, 300)]);
  }
  const problems = await verifyUpstream(extracted, pinnedFor(title));
  if (problems.length) {
    throw new Failure(EXIT.prereq, 'downloaded revision ' + UPSTREAM_COMMIT +
      ' does not match the pinned hashes', problems.map(p => '  ' + p));
  }
  await fsp.rm(cached, {recursive: true, force: true});
  try {
    await fsp.rename(extracted, cached);
  } catch {
    // A cross-device rename fails; copy instead, then verify again.
    await fsp.cp(extracted, cached, {recursive: true});
  }
  const proof = await verifyUpstream(cached, pinnedFor(title));
  if (proof.length) throw new Failure(EXIT.prereq, 'cached copy failed verification', proof);
  return cached;
}

// ------------------------------------------------------------------- backup --
async function readBackupManifest(directory) {
  const file = path.join(directory, 'manifest.json');
  if (!exists(file)) return null;
  try {
    const manifest = JSON.parse(await fsp.readFile(file, 'utf8'));
    if (!Array.isArray(manifest.entries)) return null;
    return manifest;
  } catch {
    return null;
  }
}

async function requireBackup(directory, title) {
  if (!directory) throw new Failure(EXIT.prereq, 'a backup directory is required (--backup)');
  const dir = path.resolve(directory);
  if (!exists(dir)) throw new Failure(EXIT.prereq, 'backup does not exist: ' + dir);
  const manifest = await readBackupManifest(dir);
  if (!manifest) {
    throw new Failure(EXIT.prereq, 'backup has no manifest.json: ' + dir +
      ' - use a directory produced by save-pull-root.cjs');
  }
  const names = new Set(manifest.entries.map(entry => entry.path));
  if (!names.has('/' + TRIGGER)) {
    throw new Failure(EXIT.prereq, 'this save has no /' + TRIGGER +
      ' suspend file, so the launcher has no boot trigger; unsupported save layout', [
      '  title: ' + title.name + ' (' + title.id + ')',
      '  backup: ' + dir,
    ]);
  }
  const total = manifest.entries.reduce((n, entry) => n + (entry.size || 0), 0);
  return {dir, manifest, names, bytes: total};
}

// ------------------------------------------------------------------ staging --
async function retargetSave(input, output) {
  const script = path.join(TOOLS, 'artemis-save.py');
  const built = run('python3', [script, 'launch', input, 'inject.iet', output]);
  if (built.status !== 0) {
    throw new Failure(EXIT.prereq, 'could not build the boot trigger from the backup',
      [String(built.stderr || built.stdout || '').trim().slice(0, 400)]);
  }
  const shown = run('python3', [script, 'show', output]);
  const text = String(shown.stdout || '');
  const scriptLine = /script='([^']+)'/.exec(text);
  const versionLine = /BOWS v(\d+)/.exec(text);
  if (!scriptLine || scriptLine[1] !== 'save:/inject.iet') {
    throw new Failure(EXIT.verify, 'retargeted save9999.dat does not point at save:/inject.iet',
      [text.slice(0, 300)]);
  }
  if (!versionLine || !['1002', '1003'].includes(versionLine[1])) {
    throw new Failure(EXIT.unsupported, 'unsupported save container version: ' +
      (versionLine ? versionLine[1] : 'unknown'));
  }
  return {version: versionLine[1]};
}

function stageDirFor(title, options) {
  return path.resolve(options.out || options.staging ||
    path.join(REPO, 'staging', 'alula-artemis', title.id));
}

async function stagePackage({title, upstream, backup, outDir, retarget = retargetSave}) {
  await fsp.rm(outDir, {recursive: true, force: true});
  await fsp.mkdir(outDir, {recursive: true});
  for (const name of LAUNCHER_FILES) {
    const from = name === 'core.lua'
      ? path.join(upstream, title.overlay, 'core.lua')
      : path.join(upstream, 'common', name);
    await fsp.copyFile(from, path.join(outDir, name));
  }
  const built = await retarget(path.join(backup.dir, TRIGGER), path.join(outDir, TRIGGER));
  return built;
}

async function buildManifest({title, outDir, backup}) {
  const names = (await fsp.readdir(outDir))
    .filter(name => name !== 'manifest.json')
    .sort();
  const files = [];
  const conflicts = [];
  for (const name of names) {
    const local = path.join(outDir, name);
    const bytes = await fsp.readFile(local);
    const replace = backup.names.has('/' + name);
    if (replace && name !== TRIGGER) {
      conflicts.push({name: '/' + name,
        reason: 'already exists in this save and is not the boot trigger'});
      continue;
    }
    files.push({path: '/' + name, local, size: bytes.length,
      sha256: sha256(bytes), replace});
  }
  if (!files.some(file => file.path === '/' + TRIGGER)) {
    throw new Failure(EXIT.prereq, 'staging has no ' + TRIGGER);
  }
  const manifest = {
    purpose: 'install alula Artemis Launcher into ' + title.name + ' (' + title.id + ')',
    title: title.name,
    programId: title.id,
    upstream: {
      repo: UPSTREAM_REPO,
      commit: UPSTREAM_COMMIT,
      tag: UPSTREAM_TAG,
      overlay: title.overlay,
    },
    backup: path.resolve(backup.dir),
    generatedBy: 'tools/artemis-launcher.cjs',
    files,
  };
  return {manifest, conflicts, files};
}

async function writeManifest(outDir, manifest) {
  await fsp.writeFile(path.join(outDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n');
}

// ------------------------------------------------------------- console work --
function childExit(result) {
  const text = String(result.stderr || '') + String(result.stdout || '');
  if (/ENOENT.*memory\.sock/i.test(text)) return EXIT.noHost;
  if (/transport (?:failed )?0xf601/i.test(text)) return EXIT.sessionLost;
  return null;
}

function runStep(script, args, options = {}) {
  const child = run(process.execPath, [path.join(TOOLS, script), ...args], options);
  const lost = childExit(child);
  if (lost === EXIT.noHost) throw new Failure(EXIT.noHost, 'NO LIVE HOST: ' + script);
  if (lost === EXIT.sessionLost) throw new Failure(EXIT.sessionLost, 'SESSION LOST: ' + script);
  return child;
}

async function pullBackup(session, title, uid, directory) {
  await fsp.mkdir(path.dirname(directory), {recursive: true});
  const child = runStep('save-pull-root.cjs',
    [session, title.id, directory, uid, '--space', '1', '--type', '1']);
  if (child.status !== 0) {
    throw new Failure(EXIT.prereq, 'the backup did not complete; nothing was written',
      [String(child.stderr || child.stdout || '').trim().slice(0, 400)]);
  }
  const manifest = await readBackupManifest(directory);
  if (!manifest || !manifest.entries.length) {
    throw new Failure(EXIT.prereq, 'the backup is empty: ' + directory);
  }
  return directory;
}

async function newestBackup(title, uid) {
  const base = path.join(REPO, 'saves', title.slug, 'user-' + uid.slice(0, 8));
  if (!exists(base)) return null;
  const entries = (await fsp.readdir(base, {withFileTypes: true}))
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(base, entry.name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const dir of entries) {
    if (await readBackupManifest(dir)) return dir;
  }
  return null;
}

async function install(options) {
  const title = titleFor(options.title);
  const session = path.resolve(options._[0] || '');
  if (!options._[0]) throw new Failure(EXIT.usage, 'install needs a run directory');
  const uid = uidFor(options, title);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');

  let backupDir = options.backup ? path.resolve(options.backup) : null;
  if (!backupDir) {
    backupDir = await newestBackup(title, uid);
    if (backupDir) console.log('using the existing backup: ' + backupDir);
  }
  if (options['dry-run']) {
    if (!backupDir) {
      throw new Failure(EXIT.prereq,
        'dry run needs a local backup (--backup); nothing was pulled or written');
    }
    const backup = await requireBackup(backupDir, title);
    const upstream = await obtainUpstream(title, options);
    const outDir = stageDirFor(title, options);
    await stagePackage({title, upstream, backup, outDir});
    const plan = await buildManifest({title, outDir, backup});
    printPlan(title, backup, plan);
    console.log('\ndry run: nothing was pulled and nothing was written to the console.');
    return EXIT.ok;
  }
  if (!backupDir) {
    const target = path.join(REPO, 'saves', title.slug, 'user-' + uid.slice(0, 8),
      stamp + '-artemis-backup');
    console.log('no backup yet: pulling one into ' + target);
    backupDir = await pullBackup(session, title, uid, target);
  }
  const backup = await requireBackup(backupDir, title);
  const upstream = await obtainUpstream(title, options);
  const outDir = stageDirFor(title, options);
  await stagePackage({title, upstream, backup, outDir});
  const plan = await buildManifest({title, outDir, backup});
  printPlan(title, backup, plan);
  if (plan.conflicts.length) {
    throw new Failure(EXIT.conflict, 'refusing to overwrite files this installer does not own',
      plan.conflicts.map(c => '  ' + c.name + ': ' + c.reason));
  }
  if (!options.confirm) {
    throw new Failure(EXIT.usage,
      'refusing to write without --confirm (this is the explicit write authorization)');
  }
  await writeManifest(outDir, plan.manifest);

  console.log('\nwriting in one transaction (save-write-stage.cjs)');
  const written = runStep('save-write-stage.cjs',
    [session, title.id, uid, backup.dir, path.join(outDir, 'manifest.json')],
    {stdio: 'inherit'});
  if (written.status !== 0) {
    throw new Failure(written.status === 3 ? EXIT.sessionLost : EXIT.verify,
      'the write did not complete; the backup at ' + backup.dir + ' is intact');
  }

  const verifyDir = path.join(path.dirname(backup.dir), stamp + '-artemis-verify');
  console.log('\nverifying by pulling the save again into ' + verifyDir);
  const pulled = runStep('save-pull-root.cjs',
    [session, title.id, verifyDir, uid, '--space', '1', '--type', '1']);
  if (pulled.status !== 0) {
    throw new Failure(EXIT.verify, 'the verify pull failed; re-pull before believing the write');
  }
  const checked = runStep('verify-save-manifest.cjs',
    [verifyDir, path.join(outDir, 'manifest.json')]);
  if (checked.status !== 0) {
    throw new Failure(EXIT.verify, 'the pulled save does not match the manifest');
  }
  console.log('installed and verified: ' + outDir);
  console.log('backup: ' + backup.dir);
  console.log('rollback: node tools/artemis-launcher.cjs restore ' + session +
    ' --title ' + title.id + ' --uid ' + uid + ' --backup ' + backup.dir + ' --confirm-restore');
  return EXIT.ok;
}

function printPlan(title, backup, plan) {
  const replaces = plan.files.filter(file => file.replace);
  const adds = plan.files.filter(file => !file.replace);
  console.log('\n' + title.name + ' (' + title.id + ')');
  console.log('backup: ' + backup.dir + '  (' + backup.manifest.entries.length +
    ' files, ' + backup.bytes + ' bytes)');
  console.log('add    ' + adds.length + ' file(s), replace ' + replaces.length + ' file(s)');
  for (const file of plan.files) {
    console.log('  ' + (file.replace ? 'replace' : 'add    ') + ' ' +
      file.path.padEnd(16) + String(file.size).padStart(8) + '  ' + file.sha256.slice(0, 16));
  }
  if (plan.conflicts.length) {
    console.log('CONFLICTS');
    for (const conflict of plan.conflicts) {
      console.log('  ' + conflict.name + ': ' + conflict.reason);
    }
  }
}

async function restore(options) {
  const title = titleFor(options.title);
  const session = path.resolve(options._[0] || '');
  if (!options._[0]) throw new Failure(EXIT.usage, 'restore needs a run directory');
  const uid = uidFor(options, title);
  const backup = await requireBackup(options.backup, title);
  if (!options['confirm-restore']) {
    throw new Failure(EXIT.usage,
      '--restore overwrites live save data; pass --confirm-restore after reading the plan');
  }
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'artemis-restore-'));
  const outDir = path.join(work, 'stage');
  await fsp.mkdir(outDir);
  const local = path.join(outDir, TRIGGER);
  await fsp.copyFile(path.join(backup.dir, TRIGGER), local);
  const bytes = await fsp.readFile(local);
  const manifest = {
    purpose: 'restore the pre-install boot trigger for ' + title.name,
    files: [{path: '/' + TRIGGER, local, size: bytes.length, sha256: sha256(bytes),
      replace: true}],
  };
  const manifestPath = path.join(work, 'manifest.json');
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  console.log('1/3 restoring ' + TRIGGER + ' from the backup (live bytes are overwritten)');
  const written = runStep('save-write-stage.cjs',
    [session, title.id, uid, backup.dir, manifestPath,
      '--restore', '--confirm-restore'], {stdio: 'inherit'});
  if (written.status !== 0) {
    throw new Failure(EXIT.verify, 'the boot trigger was not restored; nothing else was changed');
  }

  console.log('2/3 removing the launcher files this installer added');
  const added = await installedAdditions(backup);
  for (const name of added) {
    const deleted = runStep('save-delete-root.cjs',
      [session, title.id, uid, '/' + name]);
    if (deleted.status !== 0) {
      throw new Failure(EXIT.verify, 'could not remove /' + name +
        '; the boot trigger is already restored, so the game boots normally');
    }
  }

  console.log('3/3 checking the restore');
  const verifyDir = path.join(path.dirname(backup.dir), 'restore-verify-' + Date.now());
  const pulled = runStep('save-pull-root.cjs',
    [session, title.id, verifyDir, uid, '--space', '1', '--type', '1']);
  if (pulled.status !== 0) throw new Failure(EXIT.verify, 'verify pull failed');
  const restored = path.join(verifyDir, TRIGGER);
  if (!exists(restored)) throw new Failure(EXIT.verify, TRIGGER + ' is missing after restore');
  const want = backup.manifest.entries.find(entry => entry.path === '/' + TRIGGER);
  const got = await fileSha(restored);
  if (!want || got !== want.sha256) {
    throw new Failure(EXIT.verify, TRIGGER + ' does not match the backup after restore');
  }
  console.log('restored: ' + TRIGGER + ' sha256 ' + got.slice(0, 16) +
    '… matches the backup; ' + added.length + ' launcher file(s) removed.');
  await fsp.rm(work, {recursive: true, force: true});
  return EXIT.ok;
}

// Files are "ours" to delete only when the backup does not contain them. The
// launcher set is fixed, so this is a closed list, not a guess from the save.
function installedAdditions(backup) {
  return LAUNCHER_FILES.filter(name => !backup.names.has('/' + name));
}

async function verify(options) {
  const title = titleFor(options.title);
  const session = path.resolve(options._[0] || '');
  if (!options._[0]) throw new Failure(EXIT.usage, 'verify needs a run directory');
  const uid = uidFor(options, title);
  const backup = await requireBackup(options.backup, title);
  const upstream = await obtainUpstream(title, options);
  const outDir = stageDirFor(title, options);
  await stagePackage({title, upstream, backup, outDir});
  const plan = await buildManifest({title, outDir, backup});
  await writeManifest(outDir, plan.manifest);
  const verifyDir = path.join(path.dirname(backup.dir), 'verify-' + Date.now());
  const pulled = runStep('save-pull-root.cjs',
    [session, title.id, verifyDir, uid, '--space', '1', '--type', '1']);
  if (pulled.status !== 0) throw new Failure(EXIT.verify, 'verify pull failed');
  const checked = runStep('verify-save-manifest.cjs',
    [verifyDir, path.join(outDir, 'manifest.json')]);
  if (checked.status !== 0) throw new Failure(EXIT.verify, 'the save does not match the manifest');
  console.log('verified: ' + outDir);
  return EXIT.ok;
}

async function stage(options) {
  const title = titleFor(options.title);
  const backup = await requireBackup(options.backup, title);
  const upstream = await obtainUpstream(title, options);
  const outDir = stageDirFor(title, options);
  await stagePackage({title, upstream, backup, outDir});
  const plan = await buildManifest({title, outDir, backup});
  await writeManifest(outDir, plan.manifest);
  printPlan(title, backup, plan);
  if (plan.conflicts.length) {
    throw new Failure(EXIT.conflict, 'conflicts in staging', plan.conflicts.map(c => '  ' + c.name));
  }
  console.log('\nstaged: ' + outDir + '/manifest.json');
  return EXIT.ok;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  switch (options.command) {
    case 'stage': return stage(options);
    case 'plan': return stage(options);
    case 'install': return install(options);
    case 'verify': return verify(options);
    case 'restore': return restore(options);
    default:
      throw new Failure(EXIT.usage, 'usage: artemis-launcher.cjs <stage|plan|install|verify|restore> ...');
  }
}

if (require.main === module) {
  main().then(code => process.exit(code)).catch(error => {
    if (error instanceof Failure) {
      console.error('FAILED: ' + error.message);
      note(error.extra || []);
      process.exit(error.code);
    }
    console.error('FAILED: ' + (error && error.stack || error));
    process.exit(1);
  });
}

module.exports = {
  EXIT, Failure, TITLES, UPSTREAM_COMMIT, UPSTREAM_FILES, LAUNCHER_FILES, TRIGGER,
  parseArgs, titleFor, pinnedFor, verifyUpstream, stagePackage, buildManifest,
  installedAdditions, requireBackup, readBackupManifest, stageDirFor,
};
