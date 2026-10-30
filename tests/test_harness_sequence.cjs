#!/usr/bin/env node
// End-to-end test of the harness's sequence, against a mock console.
//
//   node tests/test_harness_sequence.cjs
//
// Covers the whole path a real boot takes and none of it is otherwise testable
// without a console:
//
//   OTA (with a stub that flips the reported firmware)
//   -> verified power cycle (camera reports no signal)
//   -> pad adoption
//   -> OCR-driven navigation (news view -> A -> tile label -> A)
//   -> dialogs -> direct mode
//   -> OTA the keyboard
//   -> prompt probe (PRINT <marker> answered by the mock)
//   -> the four lines, in order
//   -> 4/4 and the held endpoint
//   -> --after runs with RUN set
//
// The mock OCR reads what the mock board was last asked to type, so "PRINT n" is
// echoed and answered the way the console does; every other screen returns the
// marker text the harness waits for.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {spawn, spawnSync} = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const HARNESS = path.join(ROOT, 'tools', 'harness.cjs');
let passes = 0, failures = 0;
const ok = name => { passes++; console.log('ok    ' + name); };
const no = (name, detail) => { failures++; console.log('FAIL  ' + name); if (detail) console.log('      ' + detail); };

function writeMocks(dir) {
  // Board: reports whatever firmware the OTA stub last wrote, records /type.
  fs.writeFileSync(path.join(dir, 'fw.txt'), 'pro-2');
  fs.writeFileSync(path.join(dir, 'mock-console.cjs'), `
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const dir = ${JSON.stringify(dir)};
const typed = path.join(dir, 'typed.jsonl');
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const send = v => { res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify(v)); };
  if (url.pathname === '/status') {
    const fw = fs.readFileSync(path.join(dir, 'fw.txt'), 'utf8').trim();
    return send({ok: true, ip: '127.0.0.1', fw, ready: true});
  }
  if (url.pathname === '/usb') return send({mounted: true, hidReady: true, handshake: true, pairStep: 4});
  if (url.pathname === '/type') {
    fs.appendFileSync(typed, JSON.stringify({text: url.searchParams.get('text') || ''}) + '\\n');
    return send({ok: true, typed: (url.searchParams.get('text') || '').length, skipped: 0});
  }
  if (url.pathname.startsWith('/pro') || url.pathname.startsWith('/key') ||
      url.pathname === '/up' || url.pathname.startsWith('/press')) return send({ok: true});
  res.writeHead(404); res.end('{}');
});
server.listen(0, '127.0.0.1', () => console.log('PORT ' + server.address().port));
`);
  // OTA stub: python3 <stub> -i ... -f <bin>; report the firmware the bin implies.
  fs.writeFileSync(path.join(dir, 'espota-stub.py'), `import sys, pathlib
args = sys.argv[1:]
bin = args[args.index('-f') + 1] if '-f' in args else ''
fw = 'pro-2' if 'esp32_pro' in bin else 'hid-kb-1'
pathlib.Path(${JSON.stringify(dir)} + '/fw.txt').write_text(fw)
print('Sending invitation (stub)')
`);
  // Camera: "no signal" frames, so the power cycle verifies immediately.
  fs.writeFileSync(path.join(dir, 'camera.sh'), '#!/bin/sh\nhead -c 9000 /dev/zero > "$1"\n');
  // OCR: echo and answer the last typed line (so PRINT <marker> is answered), and
  // otherwise report every marker the harness may be waiting for.
  // OCR mock: it models the three screens the sequence depends on.
  //   PRINT <n>   -> echo then the answer, so the prompt probe sees the result
  //   "\\n" only    -> the confirm dialog has been dismissed
  //   LOAD ...    -> the confirm dialog is up
  //   anything    -> a generic screen carrying every other marker
  fs.writeFileSync(path.join(dir, 'ocr.sh'), `#!/bin/sh
typed=${JSON.stringify(path.join(dir, 'typed.jsonl'))}
last=$(tail -1 "$typed" 2>/dev/null)
case "$last" in
  *PRINT*)
    line=$(printf '%s' "$last" | sed 's/.*"text":"//; s/"}$//; s/\\\\n//')
    printf '0.1 0.60 0.3 0.04\\t%s\\n' "$line"
    printf '0.1 0.50 0.1 0.04\\t%s\\n' "$(printf '%s' "$line" | sed 's/^PRINT //')"
    ;;
  *'"text":"\\n"'*)
    printf '0.1 0.75 0.3 0.04\\tsmilebasic 4\\n'
    printf '0.1 0.35 0.3 0.04\\tmemory bytes free ok\\n'
    ;;
  *LOAD*)
    printf '0.1 0.75 0.3 0.04\\tload the file\\n'
    printf '0.1 0.45 0.3 0.04\\tare you sure\\n'
    ;;
  *)
    printf '0.1 0.75 0.3 0.04\\tsmilebasic 4\\n'
    printf '0.1 0.40 0.3 0.04\\tboot ready\\n'
    printf '0.1 0.35 0.3 0.04\\tmemory bytes free ok\\n'
    ;;
esac
`);
  for (const name of ['camera.sh', 'ocr.sh']) fs.chmodSync(path.join(dir, name), 0o755);
}

function startMock(dir) {
  const child = spawn(process.execPath, [path.join(dir, 'mock-console.cjs')],
    {stdio: ['ignore', 'pipe', 'inherit']});
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(Error('mock console did not report a port')), 15000);
    child.stdout.on('data', part => {
      buffer += part;
      const match = buffer.match(/PORT (\d+)/);
      if (match) { clearTimeout(timer); resolve({child, port: Number(match[1])}); }
    });
  });
}

// A stand-in host: prints a run folder, then publishes the held root the harness
// polls for. It is the smallest thing that satisfies run.cjs's contract.
function fakeHost(rpcDir) {
  fs.mkdirSync(rpcDir, {recursive: true});
  fs.writeFileSync(path.join(rpcDir, 'run.cjs'), `
const fs = require('node:fs'), path = require('node:path');
const run = path.join(__dirname, 'runs', 'fake-' + process.pid);
fs.mkdirSync(path.join(run, 'switch2', 'ro', 'root'), {recursive: true});
fs.writeFileSync(path.join(run, 'run.log'), '1/4 Checking the console\\n');
console.log('Run folder: ' + run);
setTimeout(() => {
  fs.writeFileSync(path.join(run, 'switch2', 'pipeline.json'),
    JSON.stringify({hold: {state: 'ready'}}));
  fs.writeFileSync(path.join(run, 'switch2', 'ro', 'root', 'current-root.json'),
    JSON.stringify({session: 'fake', pid: 1, rootHandle: 1}));
}, 3000);
`);
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-seq-'));
  const rpcDir = path.join(dir, 'rpc');
  writeMocks(dir);
  fakeHost(rpcDir);
  const {child, port} = await startMock(dir);
  const pad = `http://127.0.0.1:${port}`;
  const marker = path.join(dir, 'after-ran');
  const caps = path.join(dir, 'caps');

  const env = {
    ...process.env, PAD: pad, FINGERBOT: pad, RPC_DIR: rpcDir, MAC_IP: '127.0.0.1',
    HARNESS_CAMERA: path.join(dir, 'camera.sh'), HARNESS_OCR: path.join(dir, 'ocr.sh'),
    ESPOTA: path.join(dir, 'espota-stub.py'), HARNESS_AFTER: `sh -c 'echo ran > ${marker}'`
  };
  const started = Date.now();
  const result = spawnSync(process.execPath,
    [HARNESS, 'full', '--wait', '60', '--caps', caps, '--after', `sh -c 'echo ran > ${marker}'`],
    {env, cwd: ROOT, encoding: 'utf8', timeout: 240000});
  child.kill();
  const out = (result.stdout || '') + (result.stderr || '');
  const seconds = Math.round((Date.now() - started) / 1000);

  const typed = fs.existsSync(path.join(dir, 'typed.jsonl'))
    ? fs.readFileSync(path.join(dir, 'typed.jsonl'), 'utf8').trim().split('\n')
      .map(line => JSON.parse(line).text)
    : [];
  // Each typed line carries the newline the harness appends, and the prompt probe
  // (PRINT <marker>) legitimately comes first.
  const wanted = ['LOAD "TXT:NS2"\n', '\n', 'RUN\n', 'REMOVE NSR,&H60000000,&H3FFFFFFF\n'];
  const start = typed.findIndex(text => text === wanted[0]);
  const order = start >= 0 && wanted.every((text, i) => typed[start + i] === text);
  const started4 = typed.some(text => text.startsWith('V=START(39380,192,168,50,235'));
  const after = fs.existsSync(marker);

  if (result.status === 0) ok('the whole cycle exits 0', `${seconds}s`);
  else no('the whole cycle exits 0', `code=${result.status}\n` + out.split('\n').slice(-8).join('\n'));
  if (order) ok('the four lines are typed in order before V=START');
  else no('the four lines are typed in order before V=START', JSON.stringify(typed.slice(0, 6)));
  if (started4) ok('V=START is sent with the nine-argument form');
  else no('V=START is sent with the nine-argument form', JSON.stringify(typed.slice(-2)));
  if (after) ok('--after runs once the held endpoint reports ready');
  else no('--after runs once the held endpoint reports ready', out.split('\n').slice(-6).join('\n'));
  if (/power cycle verified/.test(out)) ok('the power cycle was verified before the session');
  else no('the power cycle was verified before the session', out.split('\n').slice(0, 8).join('\n'));

  fs.rmSync(dir, {recursive: true, force: true});
  fs.rmSync(path.join(ROOT, '.harness-state.json'), {force: true});
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
