'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(process.env.NS2JB_ROOT || path.resolve(__dirname, '../../ns2jb'), 'engine/switch2/acquire.cjs'), 'utf8');
function load(dir) {
  const mod = {exports: {}};
  const runtime = {
    read: async file => JSON.parse(await fs.promises.readFile(file, 'utf8')),
    save: async (file, value) => fs.promises.writeFile(file, JSON.stringify(value)),
  };
  vm.runInNewContext(source, {module: mod, __dirname: dir, process, Buffer, setTimeout,
    require: name => {
      if (name === '../shared/rpc.cjs') return {a: {session: 'test'}};
      if (name === './ro/runtime.cjs') return runtime;
      if (name === './tools/endpoint.cjs') return {request() {throw Error('unexpected endpoint');}};
      if (name === './memory/verify-proof.cjs') return {verifyProof() {throw Error('unexpected proof');}};
      return require(name);
    }});
  return mod.exports;
}
const clean = {session: 'test', cleanedUp: true, retained: {base: 0, handles: [], threads: []}};
test('only proven cleanup permits retry', () => {
  const {canRetry} = load('/tmp');
  assert.equal(canRetry(clean, 'test', {code: 1, signal: null}), true);
  for (const report of [null, {...clean, session: 'other'}, {...clean, cleanedUp: false},
    {...clean, placementUncertain: true}, {...clean, cleanupError: 'failed'},
    {...clean, retained: {...clean.retained, handles: [1]}},
    {...clean, retained: {...clean.retained, threads: [1]}},
    {...clean, retained: {...clean.retained, base: 123}},
    {...clean, retainedMemory: {pending: true}}, {...clean, memoryControl: {ready: true}}]) {
    assert.equal(canRetry(report, 'test', {code: 1, signal: null}), false);
  }
  assert.equal(canRetry(clean, 'test', {code: null, signal: 'SIGKILL'}), false);
});
for (const scenario of ['clean', 'uncertain', 'missing-report', 'foreign-session']) {
  test('supervisor: ' + scenario, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acquisition-test-'));
    try {
      fs.mkdirSync(path.join(dir, 'memory'));
      const report = {...clean, error: 'Error: simulated failure',
        ...(scenario === 'uncertain' ? {placementUncertain: true, cleanedUp: false} : {}),
        ...(scenario === 'foreign-session' ? {session: 'foreign'} : {})};
      fs.writeFileSync(path.join(dir, 'memory/probe-reserved-gap.cjs'), `
        const fs = require('node:fs'), path = require('node:path');
        fs.appendFileSync(path.join(__dirname, '../launched'), '1');
        const file = path.join(__dirname, 'report-' + process.pid + '.json');
        if (${JSON.stringify(scenario)} !== 'missing-report') {
          fs.writeFileSync(file, JSON.stringify(${JSON.stringify(report)}));
          console.log(JSON.stringify({stage:'connected', file}));
        }
        console.error('preserved diagnostic'); process.exitCode = 1;
      `);
      await assert.rejects(load(dir).start(), scenario === 'clean' ? /attempts exhausted/ : /restart the console/);
      const expected = scenario === 'clean' ? 3 : 1;
      assert.equal(fs.readFileSync(path.join(dir, 'launched'), 'utf8').length, expected);
      const supervisor = JSON.parse(fs.readFileSync(path.join(dir, 'acquisition-supervisor.json')));
      assert.equal(supervisor.attempts.length, expected);
      assert.equal(supervisor.stage, 'failed');
      const logs = supervisor.attempts.map(a => a.log);
      assert.equal(new Set(logs).size, expected);
      for (const log of logs) assert.match(fs.readFileSync(log, 'utf8'), /preserved diagnostic/);
      assert.match(fs.readFileSync(path.join(dir, 'acquisition.log'), 'utf8'), /preserved diagnostic/);
    } finally {fs.rmSync(dir, {recursive: true, force: true});}
  });
}
