#!/usr/bin/env node
'use strict';
// Install alula's upstream Artemis Launcher into a supported Artemis save.
//
//   node tools/artemis-launcher.cjs stage   --title <id> --backup <dir> [--out <dir>] [--source <dir>]
//   node tools/artemis-launcher.cjs plan    --title <id> --backup <dir> [--source <dir>]
//   node tools/artemis-launcher.cjs install <run> --title <id> [--uid <hex>] [--backup <dir>] --confirm
//   node tools/artemis-launcher.cjs verify  <run> --title <id> [--uid <hex>] [--backup <dir>]
//   node tools/artemis-launcher.cjs restore <run> --title <id> [--uid <hex>] --backup <dir> \
//        --confirm-restore [--dry-run] [--adopt-legacy]
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
//   3. stages the upstream files plus that trigger in a marked build directory
//      under <repo>/staging (or the OS temp dir), then promotes it atomically.
//      A failed build never deletes the previous staged payload;
//   4. validates the backup's manifest, every file hash, the trigger and the
//      full program/account identity before anything is written;
//   5. writes a local installation receipt (full account uid, backup manifest
//      hash, upstream commit, installed hashes) before the console write;
//   6. writes through `save-write-stage.cjs` (one transaction, hash verified),
//      pulls the save again, and checks it against the manifest;
//   7. `restore` is receipt-driven: it refuses to delete a file whose live
//      bytes differ from what this installer recorded. Installs made before
//      receipts existed take a conservative `--adopt-legacy` path that requires
//      live bytes to match the pinned upstream release exactly.
//
// Exit codes (the toolkit's contract):
//   0  done and verified
//   2  bad usage / missing authorization flag
//   3  SESSION LOST - the console stopped answering
//   4  NO LIVE HOST - the run folder has no live memory socket
//   5  unsupported title (not one of the two demos upstream supports)
//   6  missing prerequisite - no backup, invalid backup, no upstream source
//   7  conflict - a file would be overwritten, deleted or was modified
//   8  verification failed
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');

const {validateBackup, describeBackup} = require('./lib/artemis-backup.cjs');
const staging = require('./lib/artemis-staging.cjs');
const receipts = require('./lib/artemis-receipt.cjs');
const {EXIT: DELETE_EXIT, isGone} = require('./lib/delete-result.cjs');

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
// Update files upstream's inject.iet would load instead of the originals. Not
// ours, never deleted, but worth reporting during a restore.
const UPDATE_FILES = ['core2.lua', 'http2.lua', 'inject2.lua'];

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
    if (['confirm', 'confirm-restore', 'dry-run', 'json', 'adopt-legacy'].includes(name)) {
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

function normalizeUid(value) {
  const hex = String(value || '').replace(/^0x/i, '').toLowerCase();
  return /^[0-9a-f]{32}$/.test(hex) ? hex : null;
}

function uidFor(options, title) {
  if (options.uid) {
    const hex = normalizeUid(options.uid);
    if (!hex) throw new Failure(EXIT.usage, '--uid must be 32 hex chars');
    return hex;
  }
  // Local, gitignored config. Never a compiled-in account id.
  try {
    const config = JSON.parse(fs.readFileSync(path.join(REPO, 'config/uids.json'), 'utf8'));
    const found = normalizeUid(config[title.id]);
    if (found) return found;
  } catch { /* no local config */ }
  throw new Failure(EXIT.usage, '--uid is required (or add ' + title.id +
    ' to config/uids.json locally)');
}

// restore may omit --uid when exactly one receipt exists for the title.
async function uidForRestore(options, title) {
  if (options.uid) return uidFor(options, title);
  const found = await receiptsForTitle(title.id);
  if (found.length === 1) {
    console.log('using the account from the installation receipt: ' +
      found[0].account.uid.slice(0, 8) + '…');
    return found[0].account.uid;
  }
  return uidFor(options, title);
}

async function receiptsForTitle(titleId) {
  let names;
  try {
    names = await fsp.readdir(receipts.receiptDir());
  } catch { return []; }
  const found = [];
  for (const name of names) {
    if (!name.startsWith(titleId + '-') || !name.endsWith('.json')) continue;
    try {
      const receipt = JSON.parse(await fsp.readFile(path.join(receipts.receiptDir(), name), 'utf8'));
      if (receipt.title && receipt.title.id === titleId) found.push(receipt);
    } catch { /* unreadable receipts are not a match */ }
  }
  return found;
}

// ----------------------------------------------------------------- upstream --
// Where pulled backups and verification pulls live. ARTEMIS_SAVES keeps tests
// and sandboxes out of the checkout; the default matches the other tools.
function savesRoot() {
  return process.env.ARTEMIS_SAVES || path.join(REPO, 'saves');
}

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

// The reproducible bytes of the launcher set, keyed by save path. This is what
// the legacy restore compares live files against, and what a receipt records.
function expectedHashes(title) {
  const out = {};
  for (const name of LAUNCHER_FILES) {
    out['/' + name] = name === 'core.lua'
      ? UPSTREAM_FILES[title.overlay + '/core.lua']
      : UPSTREAM_FILES['common/' + name];
  }
  return out;
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
async function loadBackup(directory, title, options = {}) {
  const checked = await validateBackup(directory, {
    trigger: TRIGGER,
    requireIdentity: options.requireIdentity === true,
    titleId: title.id,
    uid: options.uid,
  });
  if (!checked.ok) {
    throw new Failure(EXIT.prereq, 'backup failed validation: ' + (checked.dir || directory),
      checked.problems.map(p => '  ' + p));
  }
  return checked;
}

async function pullSnapshot(session, title, uid, directory, label) {
  await fsp.mkdir(path.dirname(directory), {recursive: true});
  const child = runStep('save-pull-root.cjs',
    [session, title.id, directory, uid, '--space', '1', '--type', '1']);
  if (child.status !== 0) {
    throw new Failure(EXIT.prereq, 'the ' + label + ' pull did not complete',
      [String(child.stderr || child.stdout || '').trim().slice(0, 400)]);
  }
  const backup = await validateBackup(directory, {
    trigger: TRIGGER, requireIdentity: true, titleId: title.id, uid,
  });
  if (!backup.ok) {
    throw new Failure(EXIT.prereq, 'the ' + label + ' pull failed validation: ' + directory,
      backup.problems.map(p => '  ' + p));
  }
  return backup;
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

async function fillBuild({title, upstream, backup, build, retarget = retargetSave}) {
  for (const name of LAUNCHER_FILES) {
    const from = name === 'core.lua'
      ? path.join(upstream, title.overlay, 'core.lua')
      : path.join(upstream, 'common', name);
    await fsp.copyFile(from, path.join(build, name));
  }
  return retarget(path.join(backup.dir, TRIGGER), path.join(build, TRIGGER));
}

// Build in a marked sibling, then promote. On any failure only the build
// directory is removed; a previously staged payload stays exactly as it was.
async function stageTo({title, upstream, backup, outDir, retarget = retargetSave, repo = REPO}) {
  const target = await staging.assertSafeTarget(outDir, {titleId: title.id, repo});
  const build = await staging.beginBuild(target, title.id);
  try {
    const built = await fillBuild({title, upstream, backup, build, retarget});
    return {target, build, built};
  } catch (error) {
    await staging.discardBuild(build);
    throw error;
  }
}

// Manifest `local` paths are relative to the manifest's directory. save-write-
// stage is run with cwd = the staging directory, so the manifest stays portable
// and does not capture a machine-specific absolute path.
async function buildManifest({title, outDir, backup}) {
  const names = (await fsp.readdir(outDir))
    .filter(name => name !== 'manifest.json' && !name.startsWith('.'))
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
    files.push({path: '/' + name, local: name, size: bytes.length,
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
    backupManifestSha256: backup.manifestSha256,
    generatedBy: 'tools/artemis-launcher.cjs',
    files,
  };
  return {manifest, conflicts, files};
}

async function writeManifest(directory, manifest) {
  await fsp.writeFile(path.join(directory, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n');
}

async function stageAndPlan({title, backup, options}) {
  const upstream = await obtainUpstream(title, options);
  const outDir = stageDirFor(title, options);
  const {target, build} = await stageTo({title, upstream, backup, outDir});
  // Build failure already discarded the build dir. From here on a failure must
  // discard the build only, never the promoted target.
  try {
    const plan = await buildManifest({title, outDir: build, backup});
    await writeManifest(build, plan.manifest);
    await staging.promoteBuild(build, target, title.id);
    return {target, plan};
  } catch (error) {
    await staging.discardBuild(build);
    throw error;
  }
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

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
}

async function newestBackup(title, uid) {
  const base = path.join(savesRoot(), title.slug, 'user-' + uid.slice(0, 8));
  if (!exists(base)) return null;
  const entries = (await fsp.readdir(base, {withFileTypes: true}))
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(base, entry.name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const dir of entries) {
    const checked = await validateBackup(dir, {
      trigger: TRIGGER, requireIdentity: true, titleId: title.id, uid,
    });
    if (checked.ok) return dir;
  }
  return null;
}

// ------------------------------------------------------------------ receipt --
function makeReceipt({title, uid, backup, plan, upstream}) {
  const original = new Map(backup.entries.map(entry => [entry.path, entry]));
  const now = new Date().toISOString();
  const installed = plan.files.map(file => {
    const entry = {path: file.path, sha256: file.sha256, size: file.size,
      kind: file.replace ? 'replace' : 'add'};
    if (file.replace) {
      const before = original.get(file.path);
      entry.originalSha256 = before.sha256;
      entry.originalSize = before.size;
    }
    return entry;
  });
  return {
    version: receipts.VERSION,
    kind: receipts.KIND,
    status: 'installing',
    origin: 'install',
    createdAt: now,
    updatedAt: now,
    title: {id: title.id, name: title.name},
    account: {uid},
    upstream: {repo: UPSTREAM_REPO, commit: UPSTREAM_COMMIT, tag: UPSTREAM_TAG},
    backup: {
      path: path.resolve(backup.dir),
      manifestSha256: backup.manifestSha256,
      entries: backup.entries.length,
      bytes: backup.bytes,
      triggerSha256: original.get('/' + TRIGGER).sha256,
      identity: backup.identity,
    },
    installed,
    postInstallVerified: false,
    progress: {trigger: 'pending', deleted: []},
  };
}

// ------------------------------------------------------------------- install --
async function install(options) {
  const title = titleFor(options.title);
  const session = path.resolve(options._[0] || '');
  if (!options._[0]) throw new Failure(EXIT.usage, 'install needs a run directory');
  const uid = uidFor(options, title);
  // Authorization is checked before anything is pulled or staged: an install
  // without --confirm must not even create a backup directory.
  if (!options['dry-run'] && !options.confirm) {
    throw new Failure(EXIT.usage,
      'refusing to write without --confirm (this is the explicit write authorization); ' +
      'use the plan/dry-run command to inspect the plan first');
  }
  const runTag = stamp();

  let backupDir = options.backup ? path.resolve(options.backup) : null;
  if (!backupDir) {
    backupDir = await newestBackup(title, uid);
    if (backupDir) console.log('using the existing validated backup: ' + backupDir);
  }
  if (options['dry-run']) {
    if (!backupDir) {
      throw new Failure(EXIT.prereq,
        'dry run needs a local backup (--backup); nothing was pulled or written');
    }
    const backup = await loadBackup(backupDir, title, {requireIdentity: true, uid});
    const {plan} = await stageAndPlan({title, backup, options});
    printPlan(title, backup, plan);
    console.log('\ndry run: nothing was pulled and nothing was written to the console.');
    return EXIT.ok;
  }
  if (!backupDir) {
    const target = path.join(savesRoot(), title.slug, 'user-' + uid.slice(0, 8),
      runTag + '-artemis-backup');
    console.log('no backup yet: pulling one into ' + target);
    backupDir = (await pullSnapshot(session, title, uid, target, 'backup')).dir;
  }
  const backup = await loadBackup(backupDir, title, {requireIdentity: true, uid});
  const {plan, target} = await stageAndPlan({title, backup, options});
  printPlan(title, backup, plan);
  if (plan.conflicts.length) {
    throw new Failure(EXIT.conflict, 'refusing to overwrite files this installer does not own',
      plan.conflicts.map(c => '  ' + c.name + ': ' + c.reason));
  }
  const receipt = makeReceipt({title, uid, backup,
    plan, upstream: {repo: UPSTREAM_REPO, commit: UPSTREAM_COMMIT}});
  const receiptFile = await receipts.writeReceipt(receipt);
  console.log('\nreceipt: ' + receiptFile);

  console.log('\nwriting in one transaction (save-write-stage.cjs)');
  const written = runStep('save-write-stage.cjs',
    [session, title.id, uid, backup.dir, path.join(target, 'manifest.json')],
    {stdio: 'inherit', cwd: target});
  if (written.status !== 0) {
    receipt.status = 'install-failed';
    receipt.error = 'save-write-stage exited ' + written.status;
    receipt.updatedAt = new Date().toISOString();
    await receipts.writeReceipt(receipt);
    throw new Failure(written.status === 3 ? EXIT.sessionLost : EXIT.verify,
      'the write did not complete; the backup at ' + backup.dir + ' is intact');
  }

  const verifyDir = path.join(path.dirname(backup.dir), runTag + '-artemis-verify');
  console.log('\nverifying by pulling the save again into ' + verifyDir);
  const checked = await pullSnapshot(session, title, uid, verifyDir, 'verification');
  const compared = runStep('verify-save-manifest.cjs',
    [verifyDir, path.join(target, 'manifest.json')]);
  if (compared.status !== 0) {
    receipt.status = 'install-failed';
    receipt.error = 'post-install pull did not match the manifest';
    receipt.updatedAt = new Date().toISOString();
    await receipts.writeReceipt(receipt);
    throw new Failure(EXIT.verify, 'the pulled save does not match the manifest');
  }
  receipt.status = 'installed';
  receipt.postInstallVerified = true;
  receipt.updatedAt = new Date().toISOString();
  await receipts.writeReceipt(receipt);
  console.log('installed and verified: ' + target);
  console.log('backup: ' + backup.dir);
  console.log('receipt: ' + receiptFile);
  console.log('rollback: node tools/artemis-launcher.cjs restore ' + session +
    ' --title ' + title.id + ' --uid ' + uid + ' --confirm-restore');
  return EXIT.ok;
}

function printPlan(title, backup, plan) {
  const replaces = plan.files.filter(file => file.replace);
  const adds = plan.files.filter(file => !file.replace);
  console.log('\n' + title.name + ' (' + title.id + ')');
  console.log('backup: ' + backup.dir + '  (' + describeBackup(backup) + ')');
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

// ------------------------------------------------------------------- restore --
function emptyAnalysis() {
  return {problems: [], missing: [], modified: [], unexpected: [], updates: [],
    deleted: [], trigger: null};
}

// Compare a pulled snapshot with what the receipt says this installer wrote.
// A file that differs is never deleted: the user may have edited it.
function analyzeReceiptState({live, receipt, backup, title}) {
  const out = emptyAnalysis();
  const liveMap = new Map(live.entries.map(entry => [entry.path, entry]));
  const installed = new Map(receipt.installed.map(entry => [entry.path, entry]));
  const deleted = new Set((receipt.progress && receipt.progress.deleted) || []);
  const triggerDone = receipt.progress && receipt.progress.trigger === 'done';

  const trigger = installed.get('/' + TRIGGER);
  const liveTrigger = liveMap.get('/' + TRIGGER);
  const expectedTrigger = triggerDone ? backup.entries.find(e => e.path === '/' + TRIGGER).sha256
    : trigger.sha256;
  if (!liveTrigger) {
    out.missing.push('/' + TRIGGER);
    out.problems.push('/' + TRIGGER + ' is missing from the live save');
  } else if (liveTrigger.sha256 !== expectedTrigger) {
    out.modified.push('/' + TRIGGER);
    out.problems.push('/' + TRIGGER + ' live sha256 ' + liveTrigger.sha256.slice(0, 16) +
      '… differs from the expected ' + expectedTrigger.slice(0, 16) + '…');
  }
  out.trigger = liveTrigger ? liveTrigger.sha256 : null;

  for (const entry of receipt.installed) {
    if (entry.path === '/' + TRIGGER) continue;
    const liveEntry = liveMap.get(entry.path);
    if (deleted.has(entry.path)) {
      if (liveEntry) {
        out.problems.push(entry.path + ' was recorded as removed but is still present');
      } else {
        out.deleted.push(entry.path);
      }
      continue;
    }
    if (!liveEntry) {
      out.missing.push(entry.path);
      out.problems.push(entry.path + ' is missing');
    } else if (liveEntry.sha256 !== entry.sha256) {
      out.modified.push(entry.path);
      out.problems.push(entry.path + ' was modified after installation (live ' +
        liveEntry.sha256.slice(0, 16) + '… != installed ' + entry.sha256.slice(0, 16) + '…)');
    }
    if (entry.kind === 'replace') {
      const before = backup.entries.find(e => e.path === entry.path);
      if (!before || before.sha256 !== entry.originalSha256) {
        out.problems.push('receipt original hash for ' + entry.path +
          ' does not match the backup');
      }
    }
  }

  // Files in the launcher namespace that this receipt does not own. Another
  // installation or a user file: never delete, refuse and report.
  const owned = new Set(receipt.installed.map(entry => entry.path));
  for (const name of [...LAUNCHER_FILES, TRIGGER]) {
    const p = '/' + name;
    if (owned.has(p)) continue;
    if (liveMap.has(p)) {
      out.unexpected.push(p);
      out.problems.push(p + ' is present but not owned by this receipt');
    }
  }
  for (const name of UPDATE_FILES) {
    if (liveMap.has('/' + name)) out.updates.push('/' + name);
  }
  return out;
}

function printAnalysis(analysis) {
  console.log('preflight: ' + (analysis.problems.length ? 'REFUSED' : 'ok'));
  for (const problem of analysis.problems) console.log('  problem: ' + problem);
  for (const path of analysis.deleted) console.log('  already removed: ' + path);
  if (analysis.updates.length) {
    console.log('  note: update file(s) present and left alone: ' + analysis.updates.join(', '));
  }
}

// The expected post-rollback state, as a pure check so it can be tested
// offline: the trigger is the backup's, and every file this install added is
// gone. Anything else in the save is out of scope.
function postRestoreProblems({post, receipt, backup}) {
  const postMap = new Map(post.entries.map(entry => [entry.path, entry]));
  const failures = [];
  const postTrigger = postMap.get('/' + TRIGGER);
  if (!postTrigger || postTrigger.sha256 !== receipt.backup.triggerSha256) {
    failures.push(TRIGGER + ' does not match the backup after restore');
  }
  for (const entry of receipt.installed) {
    if (entry.kind !== 'add') continue;
    if (postMap.has(entry.path)) failures.push(entry.path + ' is still present');
  }
  return failures;
}

function requireRestoreAuthorization(options) {
  if (!options['confirm-restore']) {
    throw new Failure(EXIT.usage,
      'refusing to restore without --confirm-restore (this overwrites live save data)');
  }
}

async function restoreFromReceipt({options, title, session, uid, receipt}) {
  const problems = receipts.validateReceipt(receipt, {
    titleId: title.id, uid, commit: UPSTREAM_COMMIT,
    launcherFiles: LAUNCHER_FILES, trigger: TRIGGER,
  });
  if (problems.length) {
    throw new Failure(EXIT.prereq, 'installation receipt failed validation',
      problems.map(p => '  ' + p));
  }
  const backup = await loadBackup(receipt.backup.path, title, {requireIdentity: true, uid});
  if (backup.manifestSha256 !== receipt.backup.manifestSha256) {
    throw new Failure(EXIT.prereq, 'the backup at ' + receipt.backup.path +
      ' changed since installation (manifest hash differs); refusing to restore from it');
  }
  const triggerEntry = backup.entries.find(entry => entry.path === '/' + TRIGGER);
  if (!triggerEntry || triggerEntry.sha256 !== receipt.backup.triggerSha256) {
    throw new Failure(EXIT.prereq, 'the backup trigger does not match the receipt');
  }

  const runTag = stamp();
  const preDir = path.join(path.dirname(backup.dir), runTag + '-restore-preflight');
  console.log('reading the live save before touching it (read-only)');
  const live = await pullSnapshot(session, title, uid, preDir, 'preflight');
  const analysis = analyzeReceiptState({live, receipt, backup, title});
  printAnalysis(analysis);
  if (analysis.problems.length) {
    throw new Failure(EXIT.conflict,
      'refusing to restore: the live save does not match the installation receipt',
      analysis.problems.map(p => '  ' + p));
  }
  if (options['dry-run']) {
    console.log('\ndry run: preflight passed; nothing was changed.');
    return EXIT.ok;
  }
  requireRestoreAuthorization(options);

  receipt.status = 'restoring';
  receipt.updatedAt = new Date().toISOString();
  await receipts.writeReceipt(receipt);

  if (receipt.progress.trigger !== 'done') {
    console.log('1/3 restoring ' + TRIGGER + ' from the backup');
    const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'artemis-restore-'));
    const bytes = await fsp.readFile(path.join(backup.dir, TRIGGER));
    const manifest = {
      purpose: 'restore the pre-install boot trigger for ' + title.name,
      files: [{path: '/' + TRIGGER, local: TRIGGER, size: bytes.length,
        sha256: sha256(bytes), replace: true}],
    };
    await fsp.copyFile(path.join(backup.dir, TRIGGER), path.join(work, TRIGGER));
    await fsp.writeFile(path.join(work, 'manifest.json'),
      JSON.stringify(manifest, null, 2) + '\n');
    const written = runStep('save-write-stage.cjs',
      [session, title.id, uid, backup.dir, path.join(work, 'manifest.json'),
        '--restore', '--confirm-restore'], {stdio: 'inherit'});
    await fsp.rm(work, {recursive: true, force: true});
    if (written.status !== 0) {
      receipt.status = 'restore-failed';
      receipt.error = 'boot trigger restore failed';
      receipt.updatedAt = new Date().toISOString();
      await receipts.writeReceipt(receipt);
      throw new Failure(EXIT.verify, 'the boot trigger was not restored');
    }
    receipt.progress.trigger = 'done';
    receipt.updatedAt = new Date().toISOString();
    await receipts.writeReceipt(receipt);
  } else {
    console.log('1/3 trigger already restored by an earlier attempt');
  }

  console.log('2/3 removing only the launcher files this installation added');
  const added = receipt.installed.filter(entry => entry.kind === 'add');
  for (const entry of added) {
    if (receipt.progress.deleted.includes(entry.path)) continue;
    const deleted = runStep('save-delete-root.cjs',
      [session, title.id, uid, entry.path]);
    if (!isGone(deleted.status)) {
      receipt.status = 'restore-failed';
      receipt.error = 'could not remove ' + entry.path + ' (exit ' + deleted.status + ')';
      receipt.updatedAt = new Date().toISOString();
      await receipts.writeReceipt(receipt);
      throw new Failure(EXIT.verify, 'could not remove ' + entry.path +
        ' (exit ' + deleted.status + '); the trigger is restored, so the game boots normally. ' +
        'Re-run restore to resume; files already removed are skipped.');
    }
    if (deleted.status === DELETE_EXIT.notFound) {
      console.log('  ' + entry.path + ' was already absent');
    }
    receipt.progress.deleted.push(entry.path);
    receipt.updatedAt = new Date().toISOString();
    await receipts.writeReceipt(receipt);
  }

  console.log('3/3 verifying the restored save');
  const postDir = path.join(path.dirname(backup.dir), runTag + '-restore-verify');
  const post = await pullSnapshot(session, title, uid, postDir, 'post-restore');
  const failures = postRestoreProblems({post, receipt, backup});
  for (const name of UPDATE_FILES) {
    if (post.entries.some(entry => entry.path === '/' + name)) {
      console.log('note: /' + name + ' is present; it is an update file, not ours, left alone');
    }
  }
  if (failures.length) {
    receipt.status = 'restore-failed';
    receipt.error = failures.join('; ');
    receipt.updatedAt = new Date().toISOString();
    await receipts.writeReceipt(receipt);
    throw new Failure(EXIT.verify, 'post-restore verification failed',
      failures.map(f => '  ' + f));
  }
  receipt.status = 'restored';
  receipt.updatedAt = new Date().toISOString();
  receipt.restoredAt = receipt.updatedAt;
  await receipts.writeReceipt(receipt);
  console.log('restored and verified: trigger matches the backup; ' +
    added.length + ' launcher file(s) removed.');
  return EXIT.ok;
}

// Installs made before receipts existed. Ownership is established by content:
// every live launcher file must equal the pinned upstream bytes, and the live
// trigger must equal the deterministic retarget of this backup. Anything else is
// reported and refused. No receipt is fabricated; the restore is idempotent so
// an interrupted run can simply be repeated.
async function restoreLegacy({options, title, session, uid, backup}) {
  if (!options['adopt-legacy']) {
    throw new Failure(EXIT.usage,
      'no installation receipt exists for this save. Automatic cleanup is refused ' +
      'because a receipt is what records which files this installer wrote. ' +
      'If you know this installation is ours, re-run with --adopt-legacy: live ' +
      'launcher bytes must then match the pinned upstream release exactly.', [
      '  receipt: ' + receipts.receiptPath(title.id, uid),
      '  (installs made with the first version of this tool have no receipt)',
    ]);
  }
  if (!backup.identity) {
    throw new Failure(EXIT.prereq, 'backup does not record the full program id and account uid; ' +
      'identity cannot be established, so a destructive cleanup is refused. Pull a new ' +
      'backup with the current save-pull-root.cjs and re-install to create a receipt.');
  }

  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'artemis-legacy-'));
  const expected = path.join(work, TRIGGER);
  await retargetSave(path.join(backup.dir, TRIGGER), expected);
  const expectedTrigger = await fileSha(expected);
  await fsp.rm(work, {recursive: true, force: true});

  const runTag = stamp();
  const preDir = path.join(path.dirname(backup.dir), runTag + '-legacy-preflight');
  console.log('legacy installation (no receipt): reading the live save read-only');
  const live = await pullSnapshot(session, title, uid, preDir, 'preflight');
  const liveMap = new Map(live.entries.map(entry => [entry.path, entry]));
  const pinned = expectedHashes(title);
  const problems = [];
  const liveTrigger = liveMap.get('/' + TRIGGER);
  const triggerDone = liveTrigger && liveTrigger.sha256 === backup.entries.find(
    e => e.path === '/' + TRIGGER).sha256;
  const triggerOurs = liveTrigger && liveTrigger.sha256 === expectedTrigger;
  if (!triggerDone && !triggerOurs) {
    problems.push('/' + TRIGGER + ' matches neither the backup nor the deterministic ' +
      'retarget of it');
  }
  for (const [p, want] of Object.entries(pinned)) {
    const entry = liveMap.get(p);
    if (!entry) continue; // already removed by an interrupted restore
    if (entry.sha256 !== want) {
      problems.push(p + ' differs from the pinned upstream release; not deleting it');
    }
  }
  printAnalysis({problems, missing: [], modified: [], unexpected: [], updates: [],
    deleted: [], trigger: liveTrigger && liveTrigger.sha256});
  if (problems.length) {
    throw new Failure(EXIT.conflict, 'refusing the legacy cleanup: ownership is not established',
      problems.map(p => '  ' + p));
  }
  if (options['dry-run']) {
    console.log('\ndry run: legacy preflight passed; nothing was changed.');
    return EXIT.ok;
  }
  requireRestoreAuthorization(options);

  if (!triggerDone) {
    console.log('1/3 restoring ' + TRIGGER + ' from the backup');
    const stage = await fsp.mkdtemp(path.join(os.tmpdir(), 'artemis-legacy-restore-'));
    const bytes = await fsp.readFile(path.join(backup.dir, TRIGGER));
    await fsp.copyFile(path.join(backup.dir, TRIGGER), path.join(stage, TRIGGER));
    await fsp.writeFile(path.join(stage, 'manifest.json'), JSON.stringify({
      purpose: 'legacy restore of the boot trigger',
      files: [{path: '/' + TRIGGER, local: TRIGGER, size: bytes.length,
        sha256: sha256(bytes), replace: true}],
    }, null, 2) + '\n');
    const written = runStep('save-write-stage.cjs',
      [session, title.id, uid, backup.dir, path.join(stage, 'manifest.json'),
        '--restore', '--confirm-restore'], {stdio: 'inherit'});
    await fsp.rm(stage, {recursive: true, force: true});
    if (written.status !== 0) throw new Failure(EXIT.verify, 'the boot trigger was not restored');
  } else {
    console.log('1/3 trigger already restored');
  }

  console.log('2/3 removing the pinned launcher files');
  const removed = [];
  for (const name of LAUNCHER_FILES) {
    const p = '/' + name;
    if (!liveMap.has(p)) continue;
    const deleted = runStep('save-delete-root.cjs', [session, title.id, uid, p]);
    if (!isGone(deleted.status)) {
      throw new Failure(EXIT.verify, 'could not remove ' + p + ' (exit ' + deleted.status +
        '); re-run with --adopt-legacy to resume');
    }
    removed.push(p);
  }

  console.log('3/3 verifying the restored save');
  const postDir = path.join(path.dirname(backup.dir), runTag + '-legacy-verify');
  const post = await pullSnapshot(session, title, uid, postDir, 'post-restore');
  const postMap = new Map(post.entries.map(entry => [entry.path, entry]));
  const failures = [];
  const postTrigger = postMap.get('/' + TRIGGER);
  if (!postTrigger || postTrigger.sha256 !== backup.entries.find(e => e.path === '/' + TRIGGER).sha256) {
    failures.push(TRIGGER + ' does not match the backup after restore');
  }
  for (const p of removed) if (postMap.has(p)) failures.push(p + ' is still present');
  if (failures.length) {
    throw new Failure(EXIT.verify, 'post-restore verification failed',
      failures.map(f => '  ' + f));
  }
  console.log('legacy restore verified: ' + TRIGGER + ' matches the backup; ' +
    removed.length + ' launcher file(s) removed; no receipt was created.');
  return EXIT.ok;
}

async function restore(options) {
  const title = titleFor(options.title);
  const session = path.resolve(options._[0] || '');
  if (!options._[0]) throw new Failure(EXIT.usage, 'restore needs a run directory');
  const uid = await uidForRestore(options, title);

  let receipt = null;
  try {
    receipt = await receipts.readReceipt(title.id, uid);
  } catch (error) {
    throw new Failure(EXIT.prereq, error.message);
  }

  if (receipt) {
    if (options.backup && path.resolve(options.backup) !== path.resolve(receipt.backup.path)) {
      throw new Failure(EXIT.prereq, '--backup ' + path.resolve(options.backup) +
        ' is not the backup this installation was made from (' +
        path.resolve(receipt.backup.path) + '); refusing to mix them');
    }
    console.log('using the installation receipt: ' + receipts.receiptPath(title.id, uid));
    return restoreFromReceipt({options, title, session, uid, receipt});
  }

  const backupDir = options.backup
    ? path.resolve(options.backup)
    : (await receiptsForTitle(title.id))[0]?.backup?.path;
  if (!backupDir) {
    throw new Failure(EXIT.prereq, 'a backup directory is required (--backup); no receipt exists');
  }
  const backup = await loadBackup(backupDir, title, {requireIdentity: true, uid});
  return restoreLegacy({options, title, session, uid, backup});
}

// -------------------------------------------------------------------- verify --
async function verify(options) {
  const title = titleFor(options.title);
  const session = path.resolve(options._[0] || '');
  if (!options._[0]) throw new Failure(EXIT.usage, 'verify needs a run directory');
  const uid = uidFor(options, title);
  const backup = await loadBackup(options.backup, title, {requireIdentity: true, uid});
  const {plan} = await stageAndPlan({title, backup, options});
  const verifyDir = path.join(path.dirname(backup.dir), 'verify-' + Date.now());
  await pullSnapshot(session, title, uid, verifyDir, 'verification');
  const checked = runStep('verify-save-manifest.cjs',
    [verifyDir, path.join(stageDirFor(title, options), 'manifest.json')]);
  if (checked.status !== 0) throw new Failure(EXIT.verify, 'the save does not match the manifest');
  console.log('verified: ' + stageDirFor(title, options) + ' (' + plan.files.length + ' files)');
  return EXIT.ok;
}

async function stage(options) {
  const title = titleFor(options.title);
  if (!options.backup) throw new Failure(EXIT.usage, 'stage needs --backup');
  const backup = await loadBackup(options.backup, title, {triggerOnly: true});
  const {plan, target} = await stageAndPlan({title, backup, options});
  printPlan(title, backup, plan);
  if (plan.conflicts.length) {
    throw new Failure(EXIT.conflict, 'conflicts in staging', plan.conflicts.map(c => '  ' + c.name));
  }
  console.log('\nstaged: ' + path.join(target, 'manifest.json'));
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
    if (error && error.code === 'EUNSAFE') {
      console.error('FAILED: ' + error.message);
      process.exit(EXIT.prereq);
    }
    console.error('FAILED: ' + (error && error.stack || error));
    process.exit(1);
  });
}

module.exports = {
  EXIT, Failure, TITLES, UPSTREAM_COMMIT, UPSTREAM_FILES, LAUNCHER_FILES, TRIGGER,
  UPDATE_FILES, parseArgs, titleFor, pinnedFor, expectedHashes, verifyUpstream,
  buildManifest, writeManifest, analyzeReceiptState, postRestoreProblems, makeReceipt,
  loadBackup, stageDirFor, stageTo, stageAndPlan,
};
