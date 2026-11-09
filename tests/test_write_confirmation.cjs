#!/usr/bin/env node
'use strict';
// Exercise the real writer through its read-only precheck, with a fake RPC
// session that records and stops at the first read-write open. No console needed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'write-confirmation-'));
const write = (name, text) => {
  const target = path.join(tmp, name);
  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.writeFileSync(target, text);
  return target;
};
const marker = path.join(tmp, 'opened-rw');
const socketPath = path.join(tmp, 'rpc.sock');
const uid = '11111111111111111111111111111111';
let passes = 0;
async function run(script, args, answer) {
  fs.rmSync(marker, {force: true});
  return new Promise((resolve, reject) => {
    const preload = ['--require', path.join(tmp, 'transport.cjs')];
    if (answer !== undefined) preload.push('--require', path.join(tmp, 'prompt.cjs'));
    const child = spawn(process.execPath, [...preload, path.join(ROOT, 'tools', script), ...args], {
      env: {...process.env, TEST_ANSWER: answer ?? '',
        NODE_OPTIONS: '--require=' + JSON.stringify(path.join(tmp, 'transport.cjs'))}, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', b => {output += b;});
    child.stderr.on('data', b => {output += b;});
    child.on('error', reject);
    child.on('close', code => resolve({code, output, opened: fs.existsSync(marker)}));
    // Even a piped affirmative must not authorize a write.
    child.stdin.end('yes\n');
  });
}
async function main() {
  write('run/switch2/current-acquisition.json', JSON.stringify({session: 'test', socketPath}));
  write('run/switch2/ro/root/current-root.json', JSON.stringify({session: 'test', pid: 1, rootHandle: 1}));
  write('run/switch2/app/session.cjs', `
    const fs = require('node:fs');
    class Session {
      constructor() {this.handles = new Set();}
      async initialize() {}
      async ipc(label, root, command) {
        if (command === 51) {
          fs.writeFileSync(${JSON.stringify(marker)}, label);
          throw Error('TEST: read-write boundary reached');
        }
        return {result: 0, moves: [2]};
      }
      async close() {}
      async cleanup() {}
    }
    module.exports = {Session};
  `);
  write('run/switch2/app/domain.cjs', 'module.exports = {};');
  write('run/shared/ipc.cjs', 'module.exports = {};');
  write('run/switch2/app/filesystem.cjs', `
    module.exports = {openFile: async () => ({result: 0x202, canonicalResult: 0x202})};
  `);
  // Replace only terminal I/O: the real allowRisk validation still processes
  // each answer. Production code has no flag or environment bypass.
  write('prompt.cjs', `
    Object.defineProperty(process.stdin, 'isTTY', {value: true});
    require('node:readline/promises').createInterface = () => ({
      question: async prompt => {console.log(prompt); return process.env.TEST_ANSWER;},
      close() {},
    });
  `);
  const source = write('source.dat', 'new');
  const backup = path.dirname(write('backup/old.dat', 'old'));
  const manifest = write('manifest.json', JSON.stringify({files: [{path: '/new.dat', local: source}]}));
  const runDir = path.join(tmp, 'run');
  write('transport.cjs', `
    const {EventEmitter} = require('node:events');
    require('node:net').createConnection = () => {
      const socket = new EventEmitter();
      socket.setEncoding = socket.setTimeout = () => {};
      socket.write = () => queueMicrotask(() => {
        socket.emit('data', '{}'); socket.emit('end');
      });
      queueMicrotask(() => socket.emit('connect'));
      return socket;
    };
  `);
  for (const title of ['010042d022aea000', '0100000000000001']) {
    const args = [runDir, title, uid, backup, manifest];
    for (const answer of [undefined, '', 'no', 'anything']) {
      const r = await run('save-write-stage.cjs', args, answer);
      assert.equal(r.opened, false, r.output);
      assert.notEqual(r.code, 0, r.output);
      assert.match(r.output, /Write plan/);
      assert.ok(r.output.includes(title) && r.output.includes(uid) && r.output.includes('/new.dat'), r.output);
      assert.match(r.output, answer === undefined ? /interactive confirmation required/ : /Write cancelled/);
      passes++;
    }
    for (const answer of ['y', ' YES ']) {
      const r = await run('save-write-stage.cjs', args, answer);
      assert.equal(r.opened, true, r.output);
      assert.match(r.output, /read-write boundary reached/);
      assert.doesNotMatch(r.output, /whitelist/i);
      passes++;
    }
  }
  const restore = await run('save-write-stage.cjs', [runDir, '0100000000000001', uid,
    backup, manifest, '--restore', '--confirm-restore'], undefined);
  assert.equal(restore.opened, false, restore.output);
  assert.match(restore.output, /Restore plan/);
  assert.match(restore.output, /interactive confirmation required/);
  passes++;
  // The single-file wrapper must inherit the mandatory writer prompt.
  const single = await run('save-write-root.cjs', [runDir, '0100000000000001', uid,
    '/new.dat', source, backup], undefined);
  assert.equal(single.opened, false, single.output);
  assert.match(single.output, /interactive confirmation required/);
  passes++;
  for (const answer of [undefined, '', 'no', 'yes']) {
    const r = await run('save-delete-root.cjs', [runDir, '0100000000000001', uid, '/old.dat'], answer);
    assert.equal(r.opened, answer === 'yes', r.output);
    assert.match(r.output, /Delete plan/);
    passes++;
  }
  console.log(passes + ' write confirmation checks passed');
}
main().catch(error => {console.error(error); process.exitCode = 1;})
  .finally(() => fs.rmSync(tmp, {recursive: true, force: true}));
