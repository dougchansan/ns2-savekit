#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-archives-'));
const tools = path.join(tmp, 'tools');
const write = (name, contents) => {
  const file = path.join(tmp, name);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, contents);
  return file;
};
for (const name of ['kit.cjs', 'lib/titles.cjs']) {
  write('tools/' + name, fs.readFileSync(path.join(ROOT, 'tools', name)));
}
const oldRun = path.dirname(path.dirname(path.dirname(path.dirname(write('old/switch2/ro/root/current-root.json', '{}')))));
const newRun = path.dirname(path.dirname(path.dirname(path.dirname(write('new/switch2/ro/root/current-root.json', '{}')))));
write('tools/lib/run-discovery.cjs', `module.exports.discoverRuns = () => [
  {dir: ${JSON.stringify(newRun)}, promoted: true},
  {dir: ${JSON.stringify(oldRun)}, promoted: true}
];`);
const title = '0100000000000002', uid = '22222222222222222222222222222222';
const entries = [
  {id: '10', applicationId: '0x' + title, uid: '0'.repeat(32), space: 1, type: 3, rank: 0, index: 0},
  {id: '11', applicationId: '0x' + title, uid, space: 4, type: 5, rank: 1, index: 7},
  {id: '12', applicationId: '0x0000000000000000', uid: '0'.repeat(32), space: 0, type: 0},
];
write('config/titledb-cache.json', JSON.stringify({[title]: 'Uninstalled Game'}));
const log = path.join(tmp, 'calls.jsonl');
const prefix = `const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({script: require('node:path').basename(__filename), args}) + '\\n');
`;
write('tools/list-apps.cjs', prefix + `if (!process.env.NO_INSTALLED) console.log('0x0100000000000001');`);
write('tools/save-inventory.cjs', prefix + `
if (process.env.INVENTORY_FAIL) process.exit(1);
const out = args[args.indexOf('--json') + 1];
fs.mkdirSync(require('node:path').dirname(out), {recursive: true});
fs.writeFileSync(out, JSON.stringify({entries: ${JSON.stringify(entries)}}));
`);
write('tools/save-pull-root.cjs', prefix + `
if (!args.includes('--list-only')) {
  fs.mkdirSync(args[2], {recursive: true});
  fs.writeFileSync(require('node:path').join(args[2], 'manifest.json'), '{}');
}
console.log('listed 1 files, 4 bytes');`);
write('tools/verify-save-manifest.cjs', prefix + `console.log('VERIFIED test backup');`);
write('tools/save-delete-root.cjs', prefix);
write('tools/save-write-stage.cjs', prefix);
const source = path.dirname(write('source/file.dat', 'new'));
write('tools/build-editor-manifest.py', `import json, sys\njson.dump({'files':[{'path':'/file.dat','local':'unused'}]}, open(sys.argv[3], 'w'))\n`);
function kit(input, env = {}, explicit = true) {
  fs.writeFileSync(log, '');
  const result = spawnSync(process.execPath, [path.join(tools, 'kit.cjs'), ...(explicit ? [newRun] : [])], {
    input, encoding: 'utf8', timeout: 10000, cwd: tmp, env: {...process.env, ...env},
  });
  assert.equal(result.status, 0, result.stderr + '\n' + result.stdout);
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  return {out: result.stdout, calls};
}
function selectedArgs(r, script) { return r.calls.filter(call => call.script === script).map(call => call.args); }
function checkIdentity(args, entry, read) {
  assert.equal(args[1], title);
  const flags = name => args[args.indexOf(name) + 1];
  for (const name of ['space', 'type', 'rank', 'index']) assert.equal(flags('--' + name), String(entry[name]));
  assert.equal(args.includes('--exact'), read);
  assert.ok(args.includes(entry.uid));
}
let count = 0;
try {
  let r = kit('\n\n', {}, false);
  assert.ok(r.out.includes('session: ' + newRun));
  assert.match(r.out, /\[1\] \(blank = default\)/);
  count++;
  r = kit('2\n\n', {}, false);
  assert.ok(r.out.includes('session: ' + oldRun));
  count++;
  r = kit('a\n2\n1\n\n\n\n');
  assert.match(r.out, /Uninstalled Game/);
  assert.match(r.out, /archive id=11/);
  let pulls = selectedArgs(r, 'save-pull-root.cjs');
  assert.equal(pulls.length, 2); // precheck + explicit list, no account sweep
  pulls.forEach(args => checkIdentity(args, entries[1], true));
  count++;
  r = kit('a\n1\n2\n\n\n\n');
  pulls = selectedArgs(r, 'save-pull-root.cjs');
  pulls.forEach(args => checkIdentity(args, entries[0], true));
  assert.match(pulls[1][2], /archive-1-3-10/);
  assert.match(r.out, /Compare the console save with this backup now\? \[Y\/n\]/);
  assert.equal(pulls.length, 3, 'Enter runs a fresh comparison pull');
  assert.equal(selectedArgs(r, 'verify-save-manifest.cjs').length, 1);
  count++;
  r = kit('a\n1\n2\nn\n\n\n\n');
  assert.equal(selectedArgs(r, 'save-pull-root.cjs').length, 2);
  assert.equal(selectedArgs(r, 'verify-save-manifest.cjs').length, 0);
  count++;
  r = kit('a\n2\n4\n/file.dat\ny\n\n\n\n');
  const deletes = selectedArgs(r, 'save-delete-root.cjs');
  assert.equal(deletes.length, 1);
  checkIdentity(deletes[0], entries[1], false);
  count++;
  r = kit('a\n2\n3\n' + source + '\ny\n\n\n\n');
  const writes = selectedArgs(r, 'save-write-stage.cjs');
  assert.equal(writes.length, 1);
  checkIdentity(writes[0], entries[1], false);
  count++;
  r = kit('a\n2\n1\n\n\n\n', {NO_INSTALLED: '1'});
  assert.match(r.out, /archive id=11/);
  count++;
  r = kit('a\n3\n\n\n');
  assert.match(r.out, /verified static save ID/);
  assert.equal(selectedArgs(r, 'save-pull-root.cjs').length, 0);
  count++;
  // A failed refresh must never offer the stale JSON from a previous run.
  r = kit('a\n\n', {INVENTORY_FAIL: '1'});
  assert.doesNotMatch(r.out, /All save archives \(blank/);
  count++;
  console.log(count + ' kit session/archive checks passed');
} finally {fs.rmSync(tmp, {recursive: true, force: true});}
