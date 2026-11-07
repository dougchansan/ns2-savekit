#!/usr/bin/env node
// Offline tests for tools/pull-inventory.cjs driving the real tools/save-pull-root.cjs
// child. No console, no network, no deps.
//
//   node tests/test_pull_inventory_exact.cjs
//
// An inventory row names one archive: (space, type, uid, application id, rank,
// index). The bulk puller must back up that archive and nothing else. These tests
// run the actual parent CLI, which spawns the actual child CLI, against a fake
// engine run directory: switch2/app/session.cjs and filesystem.cjs are small
// stand-ins that answer the read-only open (cmd 53) from a table of archives, and
// the endpoint socket answers root-native-info. All IDs are invented.
const assert = require('node:assert');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const USER = '0123456789abcdeffedcba9876543210';
const ZERO = '00'.repeat(16);
const APP_LOCKED = '0x0100000000000101';   // locked account save + common save
const APP_ZERO = '0x0100000000000102';     // common save + a user's save
const APP_NORMAL = '0x0100000000000103';   // one ordinary account save

// The console's archives. `locked` answers 0xe02 like the running app's own save.
const ARCHIVES = [
  {id: 11, app: APP_LOCKED, uid: USER, locked: true, files: {'/user.sav': 'locked user'}},
  {id: 12, app: APP_LOCKED, uid: ZERO, files: {'/common.sav': 'common of locked app'}},
  {id: 13, app: APP_ZERO, uid: ZERO, files: {'/zero.sav': 'common save'}},
  {id: 14, app: APP_ZERO, uid: USER, files: {'/user.sav': 'user save'}},
  {id: 15, app: APP_NORMAL, uid: USER, files: {'/dir/normal.sav': 'normal account save'}},
];

const FAKE_SESSION = String.raw`'use strict';
const fs = require('node:fs');
const path = require('node:path');
const run = path.join(__dirname, '..', '..');
const fixture = JSON.parse(fs.readFileSync(path.join(run, 'fixture.json'), 'utf8'));
const log = op => fs.appendFileSync(path.join(run, 'ops.log'), JSON.stringify(op) + '\n');
const u64 = v => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
class Session {
  constructor() { this.base = 0x100000; this.mem = new Map(); this.handles = new Map(); this.next = 100; }
  async initialize() {}
  add(object) { this.handles.set(++this.next, object); return this.next; }
  async openService(name) { log({op: 'service', name}); return this.add({kind: 'acc'}); }
  async write(at, bytes) { this.mem.set(at, Buffer.from(bytes)); }
  async read(at, size) { return (this.mem.get(at) || Buffer.alloc(size)).subarray(0, size); }
  async close(handle) { this.handles.delete(handle); }
  async cleanup() { this.handles.clear(); }
  async ipc(name, handle, cmd, input, options = {}) {
    const object = this.handles.get(handle);
    if (object && object.kind === 'acc') {
      if (cmd === 2) {
        const users = Buffer.alloc(0x80);
        fixture.users.forEach((u, i) => Buffer.from(u, 'hex').copy(users, i * 16));
        this.mem.set(options.pointers.receive[0].address, users);
      }
      return {result: 0, moves: []};
    }
    if (handle !== fixture.root || cmd !== 53) throw Error('unexpected command ' + handle + '/' + cmd);
    const request = {space: input[0], app: '0x' + input.readBigUInt64LE(8).toString(16).padStart(16, '0'),
      uid: input.subarray(16, 32).toString('hex'), staticId: input.readBigUInt64LE(32).toString(),
      type: input[40], rank: input[41], index: input.readUInt16LE(42)};
    log({op: 'open53', ...request});
    const found = fixture.archives.find(a => a.app === request.app && a.uid === request.uid &&
      request.space === 1 && request.type === 1 && request.rank === 0 && request.index === 0);
    if (!found) return {result: 0x7d402, moves: []};
    if (found.locked) return {result: 0xe02, moves: []};
    return {result: 0, moves: [this.add({kind: 'save', archive: found})]};
  }
}
module.exports = {Session, u64};
`;

const FAKE_FILESYSTEM = String.raw`'use strict';
const children = (files, dir) => {
  const prefix = dir.endsWith('/') ? dir : dir + '/';
  const names = new Map();
  for (const [full, text] of Object.entries(files)) {
    if (!full.startsWith(prefix)) continue;
    const [name, ...rest] = full.slice(prefix.length).split('/');
    names.set(name, rest.length ? {name, type: 0, size: 0} : {name, type: 1, size: Buffer.byteLength(text)});
  }
  return [...names.values()];
};
module.exports = {
  async listDirectory(s, save, dir) { return children(s.handles.get(save).archive.files, dir); },
  async openFile(s, save, full) {
    const text = s.handles.get(save).archive.files[full];
    return {result: 0, handle: s.add({kind: 'file', bytes: Buffer.from(text)})};
  },
  async fileSize(s, handle) { return BigInt(s.handles.get(handle).bytes.length); },
  async readFile(s, handle, offset, size) { return s.handles.get(handle).bytes.subarray(offset, offset + size); },
};
`;

function record(archive) {
  return {id: String(archive.id), space: 1, type: 1, rank: 0, index: 0, uid: archive.uid,
    applicationId: archive.app, size: '1048576'};
}

let socketPath, server, tmp, tools, run;
async function setup() {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'pull-exact-test-'));
  tools = path.join(tmp, 'tools');
  await fsp.mkdir(path.join(tools, 'lib'), {recursive: true});
  await fsp.mkdir(path.join(tmp, 'config'));
  await fsp.writeFile(path.join(tmp, 'config/titledb-cache.json'), '{}');
  for (const name of ['pull-inventory.cjs', 'save-pull-root.cjs', 'lib/titles.cjs',
    'lib/save-attr.cjs', 'lib/save-tree.cjs'])
    await fsp.copyFile(path.join(ROOT, 'tools', name), path.join(tools, name));
  run = path.join(tmp, 'run');
  await fsp.mkdir(path.join(run, 'switch2/app'), {recursive: true});
  await fsp.mkdir(path.join(run, 'switch2/ro/root'), {recursive: true});
  await fsp.writeFile(path.join(run, 'switch2/app/session.cjs'), FAKE_SESSION);
  await fsp.writeFile(path.join(run, 'switch2/app/filesystem.cjs'), FAKE_FILESYSTEM);
  await fsp.writeFile(path.join(run, 'fixture.json'),
    JSON.stringify({root: 17, users: [USER], archives: ARCHIVES}));
  socketPath = process.platform === 'win32'
    ? '\\\\.\\pipe\\pull-exact-' + process.pid : path.join(tmp, 'memory.sock');
  server = net.createServer(socket => {
    socket.on('error', () => {});
    socket.once('data', () => socket.end(JSON.stringify({session: 'fixture'}) + '\n'));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  await fsp.writeFile(path.join(run, 'switch2/current-acquisition.json'),
    JSON.stringify({session: 'fixture', socketPath}));
  await fsp.writeFile(path.join(run, 'switch2/ro/root/current-root.json'),
    JSON.stringify({session: 'fixture', pid: 1, rootHandle: 17}));
  await fsp.writeFile(path.join(tmp, 'inventory.json'),
    JSON.stringify({entries: ARCHIVES.map(record)}));
}

function node(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {stdio: ['ignore', 'pipe', 'pipe']});
    let out = '';
    child.stdout.on('data', b => { out += b; });
    child.stderr.on('data', b => { out += b; });
    child.on('error', reject);
    child.on('close', code => resolve({code, out}));
  });
}
const pullInventory = (output, ...args) => node([path.join(tools, 'pull-inventory.cjs'), run, output,
  '--inventory', path.join(tmp, 'inventory.json'), '--limit', '0', ...args]);
const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const opens = () => fs.existsSync(path.join(run, 'ops.log'))
  ? fs.readFileSync(path.join(run, 'ops.log'), 'utf8').trim().split('\n').map(JSON.parse)
    .filter(op => op.op === 'open53') : [];
const key = a => `1:1:${a.uid}:${a.app}:${a.id}`;
const folderOf = (output, id) => fs.readdirSync(output).find(name => name.endsWith('-id' + id));
async function fresh(name) {
  await fsp.rm(path.join(run, 'ops.log'), {force: true});
  return path.join(tmp, name);
}

const tests = [];
const test = (name, fn) => tests.push({name, fn});

test('a locked account is recorded as refused, not backed up from the common save', async () => {
  const output = await fresh('locked');
  const result = await pullInventory(output, '--only', '11');
  assert.strictEqual(result.code, 0, result.out);
  const progress = readJSON(path.join(output, 'inventory-progress.json'));
  assert.deepStrictEqual(progress.done, [], 'locked row must not be done:\n' + result.out);
  assert.match(progress.failed.find(f => f.key === key(ARCHIVES[0])).error, /0xe02/);
  assert.strictEqual(folderOf(output, 11), undefined, 'no backup folder for a refused archive');
  // Exactly one open, with the requested user - no fallback to uid 0.
  assert.deepStrictEqual(opens().map(op => op.uid), [USER]);
});

test('an explicit all-zero uid is kept and opens the common save, not a user save', async () => {
  const output = await fresh('zero');
  const result = await pullInventory(output, '--only', '13');
  assert.strictEqual(result.code, 0, result.out);
  const progress = readJSON(path.join(output, 'inventory-progress.json'));
  assert.deepStrictEqual(progress.done, [key(ARCHIVES[2])], result.out);
  const folder = path.join(output, folderOf(output, 13));
  const manifest = readJSON(path.join(folder, 'manifest.json'));
  assert.strictEqual(manifest.uid, ZERO);
  assert.strictEqual(fs.readFileSync(path.join(folder, 'zero.sav'), 'utf8'), 'common save');
  assert.ok(!fs.existsSync(path.join(folder, 'user.sav')), 'a user save was written for the zero-uid row');
  assert.deepStrictEqual(opens().map(op => op.uid), [ZERO]);
});

test('ordinary account and common rows pull with matching manifests', async () => {
  const output = await fresh('normal');
  const result = await pullInventory(output, '--only', '12', '--only', '14', '--only', '15');
  assert.strictEqual(result.code, 0, result.out);
  const progress = readJSON(path.join(output, 'inventory-progress.json'));
  assert.deepStrictEqual(progress.done.sort(), [ARCHIVES[1], ARCHIVES[3], ARCHIVES[4]].map(key).sort());
  assert.deepStrictEqual(progress.failed, []);
  const normal = path.join(output, folderOf(output, 15));
  assert.strictEqual(readJSON(path.join(normal, 'manifest.json')).uid, USER);
  assert.strictEqual(fs.readFileSync(path.join(normal, 'dir/normal.sav'), 'utf8'), 'normal account save');
  assert.strictEqual(opens().length, 3, 'one open per row');
});

test('an old done record whose manifest names another uid is re-verified, and its files kept', async () => {
  const output = await fresh('stale');
  // What the unfixed puller left behind: the locked row marked done, holding the common save.
  const slug = require(path.join(tools, 'lib/titles.cjs')).slug(APP_LOCKED);
  const folder = path.join(output, `${slug}-space1-type1-id11`);
  await fsp.mkdir(folder, {recursive: true});
  await fsp.writeFile(path.join(folder, 'common.sav'), 'common of locked app');
  await fsp.writeFile(path.join(folder, 'manifest.json'), JSON.stringify({programId: '0100000000000101',
    uid: ZERO, space: 1, type: 1, rank: 0, index: 0, files: 1, partial: false, failed: []}));
  await fsp.writeFile(path.join(output, 'inventory-progress.json'),
    JSON.stringify({done: [key(ARCHIVES[0])], absent: [], failed: []}));

  const dry = await pullInventory(output, '--only', '11', '--dry-run');
  assert.strictEqual(dry.code, 0, dry.out);
  assert.match(dry.out, /re-verif/i);
  assert.ok(fs.existsSync(path.join(folder, 'manifest.json')), '--dry-run must not move files');
  assert.deepStrictEqual(readJSON(path.join(output, 'inventory-progress.json')).done, [key(ARCHIVES[0])]);
  assert.deepStrictEqual(opens(), []);

  const result = await pullInventory(output, '--only', '11');
  assert.strictEqual(result.code, 0, result.out);
  const progress = readJSON(path.join(output, 'inventory-progress.json'));
  assert.deepStrictEqual(progress.done, [], result.out);
  assert.match(progress.failed.find(f => f.key === key(ARCHIVES[0])).error, /0xe02/);
  const kept = fs.readdirSync(output).filter(name => name.includes('-id11.unverified-'));
  assert.strictEqual(kept.length, 1, 'previous files kept beside the re-verified row');
  assert.strictEqual(fs.readFileSync(path.join(output, kept[0], 'common.sav'), 'utf8'), 'common of locked app');
});

test('a matching old done record stays done without reopening the archive', async () => {
  const output = await fresh('resume');
  assert.strictEqual((await pullInventory(output, '--only', '15')).code, 0);
  await fsp.rm(path.join(run, 'ops.log'), {force: true});
  const again = await pullInventory(output, '--only', '15');
  assert.strictEqual(again.code, 0, again.out);
  assert.match(again.out, /nothing pending/);
  assert.deepStrictEqual(opens(), []);
});

test('manual save-pull-root keeps its discovery fallback without --exact', async () => {
  const output = await fresh('manual');
  const result = await node([path.join(tools, 'save-pull-root.cjs'), run, APP_LOCKED.slice(2), output,
    USER, '--space', '1', '--type', '1']);
  assert.strictEqual(result.code, 0, result.out);
  assert.strictEqual(readJSON(path.join(output, 'manifest.json')).uid, ZERO);
  assert.deepStrictEqual(opens().map(op => op.uid), [USER, ZERO]);
});

(async () => {
  let passes = 0, failures = 0;
  await setup();
  try {
    for (const {name, fn} of tests) {
      try { await fn(); passes++; console.log('ok    ' + name); } catch (error) {
        failures++;
        console.log('FAIL  ' + name + '\n      ' + String(error.message).split('\n').join('\n      '));
      }
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fsp.rm(tmp, {recursive: true, force: true});
  }
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
