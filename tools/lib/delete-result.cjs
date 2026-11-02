'use strict';
// Result handling for save-delete-root.cjs, kept separate so it can be tested
// without a console.
//
// The tool used to print the DeleteFile result and then rely on the commit,
// which made a failed delete that committed nothing look like success. The
// contract now is:
//   0   deleted, committed, and a read-only reopen proves it is absent
//   10  the file was already absent (not a deletion, but truthful)
//   11  the filesystem refused the delete, or the file is still present
//   12  the delete was accepted but the commit failed
//   3   session lost
//   4   no live host
const EXIT = {
  ok: 0,
  other: 1,
  usage: 2,
  sessionLost: 3,
  noHost: 4,
  notFound: 10,
  failed: 11,
  commit: 12,
};

// SaveData filesystem result codes are 22-bit, module 1 (fs).
const FS_NOT_FOUND = 0x2;

function classifyFsResult(canonical) {
  const value = Number(canonical) & 0x3fffff;
  if (value === 0) return 'deleted';
  if (value === FS_NOT_FOUND) return 'not-found';
  return 'failed';
}

function exitForClass(classification) {
  if (classification === 'deleted') return EXIT.ok;
  if (classification === 'not-found') return EXIT.notFound;
  return EXIT.failed;
}

// A caller that is cleaning up may treat "already absent" as success; it must
// never treat a failed delete as success.
function isGone(exitCode) {
  return exitCode === EXIT.ok || exitCode === EXIT.notFound;
}

function exitForErrorText(text) {
  const value = String(text || '');
  if (/ENOENT.*memory\.sock/i.test(value)) return EXIT.noHost;
  if (/transport (?:failed )?0xf601/i.test(value)) return EXIT.sessionLost;
  return EXIT.other;
}

module.exports = {EXIT, FS_NOT_FOUND, classifyFsResult, exitForClass, isGone, exitForErrorText};
