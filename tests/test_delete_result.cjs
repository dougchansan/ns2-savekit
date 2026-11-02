#!/usr/bin/env node
// Offline tests for save-delete-root's result handling.
//
//   node tests/test_delete_result.cjs
//
// The delete tool used to print a filesystem result and then trust the commit,
// so a refused DeleteFile could look like success. These tests pin the mapping
// and the command's fail-closed behaviour; console calls themselves are not
// made here.
const assert = require('node:assert');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {
  EXIT, classifyFsResult, exitForClass, isGone, exitForErrorText,
} = require(path.join(__dirname, '..', 'tools/lib/delete-result.cjs'));

const TOOL = path.join(__dirname, '..', 'tools', 'save-delete-root.cjs');
let passes = 0, failures = 0;
const test = (name, fn) => {
  try { fn(); passes++; console.log('ok    ' + name); }
  catch (error) { failures++; console.log('FAIL  ' + name + '\n      ' + error.message); }
};

test('a zero result is the only successful deletion', () => {
  assert.strictEqual(classifyFsResult(0), 'deleted');
  assert.strictEqual(exitForClass('deleted'), EXIT.ok);
  assert.strictEqual(isGone(EXIT.ok), true);
});

test('a not-found result is distinct and non-zero', () => {
  assert.strictEqual(classifyFsResult(0x2), 'not-found');
  assert.strictEqual(exitForClass('not-found'), EXIT.notFound);
  assert.notStrictEqual(EXIT.notFound, 0);
  assert.strictEqual(isGone(EXIT.notFound), true, 'already absent is safe to skip');
});

test('every other filesystem result is a failure', () => {
  for (const value of [0x1, 0x6400, 0x7d402, 0x202, 0x2ee002]) {
    assert.strictEqual(classifyFsResult(value), 'failed', '0x' + value.toString(16));
    assert.strictEqual(exitForClass('failed'), EXIT.failed);
    assert.strictEqual(isGone(exitForClass('failed')), false);
  }
});

test('commit failure is a distinct non-zero exit and never "gone"', () => {
  assert.strictEqual(EXIT.commit, 12);
  assert.notStrictEqual(EXIT.commit, 0);
  assert.strictEqual(isGone(EXIT.commit), false);
});

test('transport failures are classified separately from filesystem failures', () => {
  assert.strictEqual(exitForErrorText('ENOENT: no such file, open memory.sock'), EXIT.noHost);
  assert.strictEqual(exitForErrorText('transport failed 0xf601'), EXIT.sessionLost);
  assert.strictEqual(exitForErrorText('something else'), EXIT.other);
});

test('the command exits 2 without arguments', () => {
  const result = spawnSync(process.execPath, [TOOL], {encoding: 'utf8'});
  assert.strictEqual(result.status, EXIT.usage);
  assert.match(result.stderr, /usage:/);
});

test('the command fails closed on a run directory that does not exist', () => {
  const result = spawnSync(process.execPath, [TOOL, '/tmp/definitely-not-a-run-' + process.pid,
    '010042d022aea000', 'a'.repeat(32), '/proggy.ttf'], {encoding: 'utf8'});
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /FAILED:/);
});

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
