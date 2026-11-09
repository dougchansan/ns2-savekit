'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
test('worker timeout preserves identity and planned calls without reading reserved memory', async () => {
  const mod = {exports: {}};
  const source = fs.readFileSync(path.join(process.env.NS2JB_ROOT || path.resolve(__dirname, '../../ns2jb'), 'engine/switch2/app/native-worker.cjs'), 'utf8');
  vm.runInNewContext(source, {module: mod, Buffer, setTimeout, Date,
    require: name => {
      if (name === './session.cjs') return {live: {sdk: 100}, check: (ok, message) => {if (!ok) throw Error(message);}};
      if (name === './filesystem.cjs') return {};
      if (name === './worker.cjs') return {code: {tryWait: {offset: 8}}};
      if (name === '../../shared/frames.cjs') return {};
      return require(name);
    }});
  let polls = 0;
  const s = {threads: new Set([123]), rpc: {call3: async () => {polls++; return 0;}},
    readOwned: async () => {throw Error('must not read reserved memory');}};
  const worker = {label: 'wave-commit', thread: 123, joined: false,
    calls: [{name: 'wait:master', function: 10, args: [1000, 0, 0, 0]},
      {name: 'commit', kind: 'ipc', function: 20, args: [2000, 4096, 99, 0]}]};
  await assert.rejects(mod.exports.join(s, worker, 0), error => {
    assert.match(error.message, /wave-commit/);
    assert.equal(error.workerFailure.thread, 123);
    assert.equal(error.workerFailure.executingStep, null);
    assert.equal(error.workerFailure.calls[1].name, 'commit');
    assert.doesNotThrow(() => JSON.stringify(error.workerFailure));
    return true;
  });
  assert.equal(polls, 1);
  assert.equal(s.threads.has(123), true);
  assert.equal(worker.joined, false);
});
