'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {discoverRuns} = require('../tools/lib/run-discovery.cjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'run-discovery-'));
try {
  const repo = path.join(tmp, 'work/project/kit');
  fs.mkdirSync(repo, {recursive: true});
  const run = path.join(tmp, 'work/ns2jb/runs/session');
  fs.mkdirSync(path.join(run, 'switch2'), {recursive: true});
  fs.writeFileSync(path.join(run, 'connect.txt'), 'V=START(...)');
  assert.equal(findWaiting()[0].state, 'waiting-for-console');
  function findWaiting() { return discoverRuns({repo, cwd: repo, home: tmp, override: run}).filter(x => x.dir === fs.realpathSync(run)); }
  fs.writeFileSync(path.join(run, 'connection.json'), '{}');
  assert.equal(findWaiting()[0].state, 'initializing');
  fs.writeFileSync(path.join(run, 'switch2/current-acquisition.json'), '{}');
  const find = override => discoverRuns({repo, cwd: repo, home: tmp, override}).filter(x => x.dir.startsWith(fs.realpathSync(tmp)));
  let results = find();
  assert.equal(results.length, 1);
  assert.equal(results[0].promoted, false);
  fs.mkdirSync(path.join(run, 'switch2/ro/root'), {recursive: true});
  fs.writeFileSync(path.join(run, 'switch2/ro/root/current-root.json'), '{}');
  assert.equal(find()[0].promoted, true);
  assert.equal(find(run).length, 1);
  assert.equal(find(path.dirname(run)).length, 1);
  console.log('ancestor discovery, incomplete root and override tests passed');
} finally { fs.rmSync(tmp, {recursive: true, force: true}); }
