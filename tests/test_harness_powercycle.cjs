#!/usr/bin/env node
// Offline test for the harness's power-cycle verification, run against a mock console.
//
//   node tests/test_harness_powercycle.cjs
//
// Two runs of `harness boot`, differing only in what the fake camera sees:
//
//   * HDMI up (large frames)  -> the hold did not reach the button: the harness must
//     say so, exit 4, and NOT record a power cycle;
//   * no signal (small frames) -> the console went off: the harness records a power
//     cycle and proceeds to boot (it then fails navigation against the silent OCR,
//     which is fine - the assertion is about the power cycle).
//
// This exists because the verification is what stands between a missed hold and a
// second RPC session, and hardware time is too expensive to test it there.
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync, spawn} = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const HARNESS = path.join(ROOT, 'tools', 'harness.cjs');
let passes = 0, failures = 0;
const ok = (name, detail) => { passes++; console.log('ok    ' + name); if (detail) console.log('      ' + detail); };
const no = (name, detail) => { failures++; console.log('FAIL  ' + name); if (detail) console.log('      ' + detail); };

// The mock console must live in its own process: the harness is run with spawnSync,
// which blocks this process's event loop, so a server here would never answer.
function startMock(dir, {mounted = true} = {}) {
  const file = path.join(dir, 'mock-console.cjs');
  fs.writeFileSync(file, `
const http = require('node:http');
const mounted = ${JSON.stringify(mounted)};
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const send = value => { res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify(value)); };
  if (url.pathname === '/status') return send({ok: true, ip: '127.0.0.1', fw: 'pro-2', ready: true});
  if (url.pathname === '/usb') return send({mounted, hidReady: true, handshake: true, pairStep: 4});
  if (url.pathname.startsWith('/pro')) return send({ok: true, mask: 0});
  if (url.pathname.startsWith('/key')) return send({ok: true});
  if (url.pathname.startsWith('/type')) return send({ok: true, typed: 0, skipped: 0});
  res.writeHead(404); res.end('{}');
});
server.listen(0, '127.0.0.1', () => console.log('PORT ' + server.address().port));
`);
  const child = spawn(process.execPath, [file], {stdio: ['ignore', 'pipe', 'inherit']});
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

function scripts(dir) {
  const camera = path.join(dir, 'camera.sh');
  const ocr = path.join(dir, 'ocr.sh');
  // espota is invoked as `python3 <ESPOTA> ...`, so the stub has to be python.
  const espota = path.join(dir, 'espota-stub.py');
  fs.writeFileSync(espota, 'import sys\nprint("Sending invitation (stub)")\nsys.exit(0)\n');
  fs.writeFileSync(camera, '#!/bin/sh\nhead -c "${CAMERA_BYTES:-200000}" /dev/zero > "$1"\n');
  fs.writeFileSync(ocr, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(camera, 0o755); fs.chmodSync(ocr, 0o755);
  return {camera, ocr, espota};
}

function runBoot({pad, dir, cameraBytes, caps}) {
  const env = {
    ...process.env, PAD: pad, HARNESS_CAMERA: path.join(dir, 'camera.sh'),
    HARNESS_OCR: path.join(dir, 'ocr.sh'), CAMERA_BYTES: String(cameraBytes),
    ESPOTA: path.join(dir, 'espota-stub.py')
  };
  const started = Date.now();
  const result = spawnSync(process.execPath, [HARNESS, 'boot', '--caps', caps],
    {env, encoding: 'utf8', timeout: 180000, cwd: ROOT});
  return {code: result.status, out: (result.stdout || '') + (result.stderr || ''),
    seconds: Math.round((Date.now() - started) / 1000)};
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mock-'));
  const {espota} = scripts(dir);

  // Case 1: HDMI stays up, so the hold did not reach the button.
  {
    const {child, port} = await startMock(dir, {mounted: true});
    const state = path.join(ROOT, '.harness-state.json');
    fs.rmSync(state, {force: true});
    const caps = path.join(dir, 'caps-1');
    const r = runBoot({pad: `http://127.0.0.1:${port}`, dir, cameraBytes: 200000, caps});
    child.kill();
    const said = /did not lose power/.test(r.out);
    const exited = r.code === 4;
    const noState = !fs.existsSync(state);
    if (said && exited && noState) ok('a hold that misses is reported, exits 4, records nothing',
      `${r.seconds}s`);
    else no('a hold that misses is reported, exits 4, records nothing',
      `said=${said} code=${r.code} stateWritten=${!noState}\n` +
      r.out.split('\n').slice(0, 6).concat(r.out.split('\n').slice(-3)).join('\n'));
  }

  // Case 2: no signal, so the console really went off and the cycle counts.
  {
    const {child, port} = await startMock(dir, {mounted: true});
    const state = path.join(ROOT, '.harness-state.json');
    fs.rmSync(state, {force: true});
    const caps = path.join(dir, 'caps-2');
    const r = runBoot({pad: `http://127.0.0.1:${port}`, dir, cameraBytes: 9000, caps});
    child.kill();
    const sawOff = /console is off/.test(r.out);
    let recorded = false;
    try { recorded = Boolean(JSON.parse(fs.readFileSync(state, 'utf8')).powerCycledAt); }
    catch { /* no state */ }
    if (sawOff && recorded) ok('a real power-off is recorded as a fresh boot', `${r.seconds}s`);
    else no('a real power-off is recorded as a fresh boot',
      `sawOff=${sawOff} recorded=${recorded} code=${r.code}\n${r.out.split('\n').slice(-4).join('\n')}`);
    fs.rmSync(state, {force: true});
  }

  fs.rmSync(dir, {recursive: true, force: true});
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
