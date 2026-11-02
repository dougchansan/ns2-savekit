'use strict';
// Installation receipts for the Artemis Launcher installer.
//
// A backup proves what the save looked like *before* the write. It does not
// prove that a file currently on the console was put there by this installer -
// the user may have edited a launcher script, or another install may be in
// place. A receipt records exactly what this installer wrote, so rollback can
// refuse to delete anything whose bytes changed after installation.
//
// Receipts are local state, never committed: they contain the full account uid.
// They live outside the repository and survive console reboots and new RPC
// sessions. ARTEMIS_STATE overrides the directory.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const VERSION = 1;
const KIND = 'ns2-savekit/artemis-launcher-receipt';
const STATUSES = new Set(['installing', 'installed', 'install-failed', 'restoring', 'restored',
  'restore-failed']);

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const HEX32 = /^[0-9a-f]{32}$/;
const HEX16 = /^[0-9a-f]{16}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const SAFE_NAME = /^[A-Za-z0-9_.-]+$/;

function stateRoot() {
  return process.env.ARTEMIS_STATE ||
    path.join(os.homedir(), '.local', 'state', 'ns2-savekit', 'artemis-launcher');
}

function receiptDir() {
  return path.join(stateRoot(), 'receipts');
}

// One receipt per title+account. The uid is hashed into the filename so the
// full account id is not exposed by a directory listing, but it is also stored
// inside the receipt (mode 0600) because restore must compare it exactly.
function receiptPath(titleId, uid) {
  const id = String(titleId).toLowerCase();
  const account = String(uid).toLowerCase();
  if (!HEX16.test(id) || !HEX32.test(account)) throw Error('receipt path needs a title id and uid');
  const tag = sha256(Buffer.from(id + ':' + account)).slice(0, 16);
  return path.join(receiptDir(), id + '-' + tag + '.json');
}

async function readReceipt(titleId, uid) {
  const file = receiptPath(titleId, uid);
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error('receipt is not valid JSON: ' + file);
    error.code = 'ERECEIPT';
    throw error;
  }
}

// Write-then-rename: an interrupted receipt write must not leave a half file
// that restore would trust. 0600 because the account uid is inside.
async function writeReceipt(receipt) {
  const file = receiptPath(receipt.title.id, receipt.account.uid);
  await fsp.mkdir(path.dirname(file), {recursive: true, mode: 0o700});
  const temp = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
  await fsp.writeFile(temp, JSON.stringify(receipt, null, 2) + '\n', {mode: 0o600});
  await fsp.rename(temp, file);
  return file;
}

// Structural validation only. Backup-vs-receipt checks are done by the caller,
// which has the validated backup object (manifest hash, trigger hash, identity).
function validateReceipt(receipt, {titleId, uid, commit, launcherFiles, trigger} = {}) {
  const problems = [];
  if (!receipt || typeof receipt !== 'object') return ['receipt is empty'];
  if (receipt.version !== VERSION) problems.push('unsupported receipt version ' + receipt.version);
  if (receipt.kind !== KIND) problems.push('not an Artemis Launcher receipt');
  if (!receipt.title || !HEX16.test(String(receipt.title.id || ''))) {
    problems.push('receipt has no valid title id');
  } else if (titleId && receipt.title.id !== String(titleId).toLowerCase()) {
    problems.push('receipt is for ' + receipt.title.id + ', not ' + titleId);
  }
  if (!receipt.account || !HEX32.test(String(receipt.account.uid || ''))) {
    problems.push('receipt has no full account uid');
  } else if (uid && receipt.account.uid !== String(uid).toLowerCase()) {
    problems.push('receipt is for a different account');
  }
  if (!receipt.upstream || !/^[0-9a-f]{40}$/.test(String(receipt.upstream.commit || ''))) {
    problems.push('receipt has no upstream commit');
  } else if (commit && receipt.upstream.commit !== commit) {
    problems.push('receipt was made for upstream ' + receipt.upstream.commit.slice(0, 12) +
      '…, not the pinned ' + commit.slice(0, 12) + '…');
  }
  if (!receipt.status || !STATUSES.has(receipt.status)) problems.push('unknown receipt status');
  if (!receipt.backup || !HEX64.test(String(receipt.backup.manifestSha256 || ''))) {
    problems.push('receipt has no backup manifest hash');
  }
  if (!Array.isArray(receipt.installed) || receipt.installed.length === 0) {
    problems.push('receipt lists no installed files');
    return problems;
  }
  const allowed = new Set([...(launcherFiles || []), trigger || 'save9999.dat'].map(n => '/' + n));
  const seen = new Set();
  for (const entry of receipt.installed) {
    if (!entry || typeof entry !== 'object') { problems.push('receipt entry is not an object'); continue; }
    if (!allowed.has(entry.path)) { problems.push('receipt lists an unexpected path ' + entry.path); continue; }
    if (seen.has(entry.path)) { problems.push('receipt lists ' + entry.path + ' twice'); continue; }
    seen.add(entry.path);
    if (!HEX64.test(String(entry.sha256 || ''))) problems.push('receipt entry ' + entry.path + ' has no sha256');
    if (entry.kind !== 'add' && entry.kind !== 'replace') {
      problems.push('receipt entry ' + entry.path + ' has kind ' + entry.kind);
    }
    if (entry.kind === 'replace' && !HEX64.test(String(entry.originalSha256 || ''))) {
      problems.push('receipt replace entry ' + entry.path + ' has no original sha256');
    }
  }
  if (!seen.has('/' + (trigger || 'save9999.dat'))) {
    problems.push('receipt does not record the boot trigger');
  }
  return problems;
}

module.exports = {
  VERSION, KIND, STATUSES, stateRoot, receiptDir, receiptPath,
  readReceipt, writeReceipt, validateReceipt, sha256,
};
