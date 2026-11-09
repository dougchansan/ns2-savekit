'use strict';
// The single-file writer is an adapter; committed-byte verification is covered
// by test_save_write_stage_verification.cjs against the shared implementation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sourcePath = path.join(__dirname, '../tools/save-write-root.cjs');
async function run(extra = [], result = {status: 0}, target = '/slots/0/save.dat') {
  let call;
  const errors = [];
  const process = {argv: ['node', sourcePath, '/run', '0100000000000001',
    '1'.repeat(32), target, '/replacement.dat', '/backup', ...extra]};
  await vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), {
    __dirname: path.dirname(sourcePath), process,
    console: {error: (...args) => errors.push(args.join(' '))},
    require(name) {
      if (name === 'node:child_process') return {spawnSync(executable, args, options) {
        call = {executable, args, options,
          manifest: JSON.parse(fs.readFileSync(args[5], 'utf8'))};
        return result;
      }};
      if (name === './lib/write-policy.cjs') return require('../tools/lib/write-policy.cjs');
      return require(name);
    },
  });
  return {call, code: process.exitCode, errors: errors.join('\n')};
}

test('single-file adapter forwards a nested target and replacement mode to the staged writer', async () => {
  const r = await run(['--replace']);
  assert.equal(r.code, 0, r.errors);
  assert.equal(path.basename(r.call.args[0]), 'save-write-stage.cjs');
  assert.deepEqual(Array.from(r.call.args.slice(1, 5)), ['/run', '0100000000000001', '1'.repeat(32), '/backup']);
  assert.deepEqual(r.call.manifest.files, [{path: '/slots/0/save.dat', local: '/replacement.dat', replace: true}]);
  assert.equal(r.call.options.stdio, 'inherit');
  assert.equal(fs.existsSync(path.dirname(r.call.args[5])), false, 'temporary manifest is removed');
});

test('single-file adapter propagates child failure and removes the temporary manifest', async () => {
  const r = await run([], {status: 7});
  assert.equal(r.code, 7);
  assert.equal(r.call.manifest.files[0].replace, false);
  assert.equal(fs.existsSync(path.dirname(r.call.args[5])), false);
});

test('single-file adapter reports spawn failure', async () => {
  const r = await run([], {error: Error('spawn failed'), status: null});
  assert.equal(r.code, 1);
  assert.match(r.errors, /spawn failed/);
  assert.equal(fs.existsSync(path.dirname(r.call.args[5])), false);
});

test('single-file adapter rejects traversal before invoking the writer', async () => {
  const r = await run([], {status: 0}, '/slots/../save.dat');
  assert.equal(r.code, 1);
  assert.equal(r.call, undefined);
  assert.match(r.errors, /Invalid save path/);
});
