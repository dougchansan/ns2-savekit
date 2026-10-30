#!/usr/bin/env node
// One boot-to-4/4 cycle for the Switch 2 harness, driven over the network only.
//
//   node tools/harness.cjs boot                 # power cycle, launch retail SmileBASIC, stop at direct mode
//   node tools/harness.cjs session              # keyboard firmware, type the four lines, wait for 4/4
//   node tools/harness.cjs full                 # boot, then session, retrying the boot on a failed acquisition
//   node tools/harness.cjs status               # report the newest run without touching the console
//
// Every transition writes a screenshot to --caps (default /tmp/ns2caps) and a line
// to stdout, so a failure can be diagnosed from what the console actually showed.
//
// Exit codes are the documented ones:
//   0  4/4 (current-root.json exists) and the run is ready
//   3  SESSION LOST  - the console stopped answering mid-sequence (wedge)
//   4  NO LIVE HOST  - the host never came up / console never connected
//   5  console never reached direct mode
//   6  no 4/4 after the configured retries (stage 2 flake; a new boot is next)
//
// Why this exists: the manual sequence needs a pad to navigate the home menu and a
// USB keyboard to type, and the board can only present one persona per flash. So
// `boot` runs the Pro Controller firmware, and `session` OTA-flashes the keyboard
// firmware once the console is already inside SmileBASIC. Both flashes are proven
// reversible (docs/RESULTS.md), which is what makes the cycle unattended.
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync, spawn, spawnSync} = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PAD = process.env.PAD || 'http://192.168.50.215';
const FINGERBOT = process.env.FINGERBOT || 'http://192.168.50.235:8080';
const MAC_IP = process.env.MAC_IP || '192.168.50.235';
const RPC_DIR = process.env.RPC_DIR || path.join(process.env.HOME, 'ns2jb-rpc');
const ESPOTA = process.env.ESPOTA ||
  path.join(process.env.HOME, 'Library/Arduino15/packages/esp32/hardware/esp32/3.3.12/tools/espota.py');
const PRO_BIN = path.join(ROOT, 'tools/esp32_pro/build/esp32.esp32.esp32s2/esp32_pro.ino.bin');
const KEY_BIN = path.join(ROOT, 'tools/esp32_hid/build/esp32.esp32.esp32s2/esp32_hid.ino.bin');
// Overridable so the state machine can be exercised against a mock console: a test
// supplies a camera command that writes frames from a queue and an OCR command that
// returns scripted text. Defaults are the real capture card and Vision.
const CAMERA = process.env.HARNESS_CAMERA || null;
const OCR = process.env.HARNESS_OCR || path.join(ROOT, 'tools/vision/ocr');
const COMMAND = 'V=START(39380,192,168,50,235,0,0,0,0)';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const VERBS = ['boot', 'session', 'full', 'status', 'state'];
const {classify} = require('./console-state.cjs');
const MODE = VERBS.includes(argv[0]) ? argv[0] : 'full';
const CAPS = arg('caps', '/tmp/ns2caps');
const RETRIES = Number(arg('retries', '2'));
const STAGE2_WAIT = Number(arg('wait', '600')) * 1000;
const AFTER = arg('after', process.env.HARNESS_AFTER || null);
// Measured after reseating the arm: a 1 s press no longer boots the console (1, 2 and
// 4 s all failed), while 3 s did. HDMI also appears only around t+40 s, so the wait
// for a picture is longer than it used to be.
const BOOT_PRESS_MS = Number(arg('boot-press', process.env.HARNESS_BOOT_PRESS || '3000'));
// Measured 18:13: after reseating the arm, travel 95 no longer reaches the power
// button at all (two 16 s holds left the console untouched) while 100 does. Set it
// before every cycle when asked, so the depth is a property of the rig, not a guess.
const TRAVEL = arg('travel', process.env.HARNESS_TRAVEL || null);
// Operator rule, from the console side: ONE RPC session per boot. If a session dies,
// the console is restarted with a hard power cycle - a wedged application never
// accepts a second host, and trying costs a boot. The timestamps live outside the
// process so a killed run still counts as having used the boot.
const STATE = path.join(ROOT, '.harness-state.json');
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; }
}
function writeState(patch) {
  fs.writeFileSync(STATE, JSON.stringify({...readState(), ...patch}, null, 2) + '\n');
}
function oneSessionPerBoot(state = readState()) {
  if (!state.lastSessionAt) return {ok: true};
  if (state.powerCycledAt && state.powerCycledAt > state.lastSessionAt) return {ok: true};
  return {ok: false,
    message: 'this boot already used its one RPC session (' +
      new Date(state.lastSessionAt).toISOString() + '). Restart the console with a hard ' +
      'power cycle before another session; a wedged application will not accept a second host.'};
}
fs.mkdirSync(CAPS, {recursive: true});

// A closed stdout must not kill a cycle: the work matters, the log is a convenience.
process.stdout.on('error', error => { if (error.code !== 'EPIPE') throw error; });

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
function log(message) { console.log(`${new Date().toLocaleTimeString()}  ${message}`); }

async function http(url, timeout = 20000, method = 'GET') {
  try {
    const response = await fetch(url, {method, signal: AbortSignal.timeout(timeout)});
    return {ok: response.ok, status: response.status, body: await response.text()};
  } catch (error) {
    return {ok: false, status: 0, body: 'ERR ' + error.message};
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function capture(tag) {
  const file = path.join(CAPS, `${stamp()}-${tag}.png`);
  const command = CAMERA
    ? () => execFileSync('sh', ['-c', `${CAMERA} "${file}"`], {timeout: 40000})
    : () => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'avfoundation',
      '-pixel_format', 'uyvy422', '-framerate', '30', '-video_size', '1920x1080',
      '-i', '0:none', '-frames:v', '1', '-update', '1', '-y', file], {timeout: 40000});
  // The capture card fails transiently (a frame in flight when ffmpeg opens it), and a
  // single failure used to abort a whole boot.
  try { command(); } catch { command(); }
  return file;
}

// OCR rows are "x y w h<TAB>text" with Vision's origin at the bottom left.
function screen(tag) {
  const image = capture(tag);
  let rows = [];
  try {
    rows = execFileSync(OCR, [image], {encoding: 'utf8', timeout: 60000}).trim().split('\n')
      .filter(l => l.includes('\t')).map(line => {
        const [box, ...rest] = line.split('\t');
        const [x, y, w, h] = box.trim().split(/\s+/).map(Number);
        return {x, y, w, h, text: rest.join('\t').trim(), image};
      });
  } catch { /* no text at all is a valid frame */ }
  const text = rows.map(r => r.text).join(' ').toLowerCase();
  const band = (lo, hi) => rows.filter(r => r.y >= lo && r.y <= hi).map(r => r.text);
  return {image, rows, text, titleRow: band(0.70, 0.82), iconRow: band(0.09, 0.15)};
}

// One word for what the console is showing, from the same frame the OCR came from.
function stateOf(shot) {
  let bytes = 0;
  try { bytes = fs.statSync(shot.image).size; } catch { /* capture vanished */ }
  return classify({text: shot.text, bytes});
}

let padFailures = 0;
async function press(query, ms = 90, pause = 1600) {
  const reply = await http(`${PAD}/pro?${query}&ms=${ms}`);
  // A dead pad used to drive dozens of blind presses (plus OCR) before anything
  // failed. Reset on any success; give up after 8 presses in a row go unanswered.
  if (reply.ok) padFailures = 0;
  else if (++padFailures >= 8)
    throw Error('pad stopped answering (' + padFailures + ' presses failed): ' + reply.body.slice(0, 80));
  await sleep(pause);
  return reply;
}

async function padStatus() {
  const r = await http(`${PAD}/status`);
  try { return JSON.parse(r.body); } catch { return {ok: false, fw: null}; }
}

async function ota(bin, expectFw) {
  if (!fs.existsSync(bin)) throw Error(`firmware image missing: ${bin}`);
  log(`OTA ${path.basename(bin)} -> ${expectFw}`);
  const before = await padStatus();
  if (before.fw === expectFw) { log(`already ${expectFw}`); return; }
  // espota binds a UDP port for the board's answer. A previous upload that has not
  // exited yet makes the next one fail with "Listen Failed: Address already in use",
  // which reads like a board problem and is not.
  try { execFileSync('pkill', ['-f', 'espota.py'], {timeout: 5000}); } catch { /* none */ }
  await sleep(500);
  try {
    execFileSync('python3', [ESPOTA, '-i', '192.168.50.215', '-p', '3232', '-f', bin],
      {encoding: 'utf8', timeout: 300000, stdio: ['ignore', 'pipe', 'pipe']});
  } catch (error) {
    throw Error('espota failed: ' + (error.stderr || error.message).toString().slice(0, 300));
  }
  for (let i = 0; i < 40; i++) {
    await sleep(2500);
    const now = await padStatus();
    if (now.fw === expectFw) {
      log(`board reports ${now.fw}`);
      // The console drops the first HID report after a re-enumeration, so prime it
      // with an unmodified modifier (no text, no side effects) before typing.
      await http(`${PAD}/key?code=225`, 8000);
      await sleep(900);
      return;
    }
  }
  throw Error(`board never reported ${expectFw} after OTA (still ${(await padStatus()).fw})`);
}

async function waitAwake() {
  for (let i = 0; i < 40; i++) {
    const r = await http(`${PAD}/status`, 4000);
    if (r.ok) return true;
    await sleep(2000);
  }
  return false;
}

// Power off with a long hold, then a short press to boot. Measured: 16 s holds the
// button long enough for a force-off, 1 s is a boot press, 0.1 s only toggles sleep.
// Did the console actually lose power? A hold that misses the button leaves HDMI up
// and USB mounted, which the fingerbot cannot tell us - so it is measured, not
// assumed. Without this, "power cycled" was written down even when nothing happened,
// and the one-session-per-boot guard would then allow a second session on a console
// that never rebooted.
async function consoleWentOff(seconds = 26) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const usb = await http(`${PAD}/usb`, 4000);
    try { if (JSON.parse(usb.body).mounted === false) return 'usb-detached'; } catch { /* board down */ }
    let frame = null;
    try { frame = capture('power-off'); } catch { /* capture card hiccup */ }
    try { if (frame && fs.statSync(frame).size <= 12000) return 'no-signal'; } catch { /* gone */ }
    await sleep(2000);
  }
  return null;
}

async function powerCycle() {
  if (TRAVEL) {
    const reply = await http(`${FINGERBOT}/travel?pct=${TRAVEL}`, 15000);
    log('fingerbot: travel ' + TRAVEL + ' (' + reply.body.slice(0, 40) + ')');
  }
  log('fingerbot: arm up + 16 s hold (force off)');
  const before = readState();
  await http(`${FINGERBOT}/up`, 30000);
  await sleep(1000);
  const off = await http(`${FINGERBOT}/press?seconds=16`, 45000);
  log('  ' + off.body);
  const gone = await consoleWentOff();
  if (!gone) {
    log('the console did not lose power (HDMI still up, USB still mounted): the hold ' +
      'did not reach the button. Not claiming a power cycle.');
    return false;
  }
  log('console is off (' + gone + ')');
  // Give the power-off time to finish: a boot press 2 s later was ignored (measured
  // 17:53), while a press 15 s later booted the console (17:51).
  await sleep(10000);
  log(`fingerbot: ${BOOT_PRESS_MS / 1000} s press (boot)`);
  const on = await http(`${FINGERBOT}/press?seconds=${BOOT_PRESS_MS / 1000}`, 30000);
  log('  ' + on.body);
  for (let i = 0; i < 20; i++) {
    await sleep(3000);
    const r = await http(`${PAD}/status`, 4000);
    if (r.ok) { log('board answering again (console has USB power)'); break; }
  }
  // waitAwake() re-polls the board before we use the boot, so no blind settle wait
  // is needed here. Only now is this a boot we may put one session on.
  writeState({powerCycledAt: Date.now(), powerCycledFrom: before.lastSessionAt || null});
  log('power cycle verified (' + gone + ')');
  return true;
}

// The PaD must be adopted as a Pro Controller before any menu input registers.
async function waitPadAdopted() {
  for (let i = 0; i < 40; i++) {
    const r = await http(`${PAD}/usb`, 5000);
    try {
      const d = JSON.parse(r.body);
      if (d.handshake === true) { log(`pad adopted (pairStep ${d.pairStep})`); return true; }
    } catch { /* not up yet */ }
    await sleep(2000);
  }
  return false;
}

async function launchSmileBASIC() {
  // Act on what the console is showing rather than pressing and hoping. The old
  // behaviour stepped RIGHT through a black or wedged screen eight times, which cost
  // boots; a wedged RPC loop or a crash dialog cannot be navigated at all.
  let shot = screen('menu');
  let dark = 0;
  for (let step = 0; step < 40; step++) {
    const state = stateOf(shot);
    log(`  state: ${state}`);
    if (state === 'home-row' || state === 'topmenu' || state === 'playmenu' ||
        state === 'direct-mode') break;
    if (state === 'wedged-rpc' || state === 'error-dialog') {
      throw Error(`console is ${state}; a power cycle is required before another launch ` +
        `(frame ${shot.image})`);
    }
    // Right after a power-on the console has no signal for a while, so this is a
    // wait, not a failure - but a minute of it means it never came up.
    if (state === 'no-signal' || state === 'black') {
      // The console takes ~40 s to show a picture after the boot press, and it sleeps
      // ~50 s after its last input - so wait, and nudge it so it does not sleep while
      // we are waiting for HDMI.
      dark++;
      if (dark === 12) {
        log('  still no picture after 40 s; pressing the power button again');
        await http(`${FINGERBOT}/press?seconds=${BOOT_PRESS_MS / 1000}`, 30000);
      }
      if (dark > 30) throw Error('console never produced a picture after the power cycle');
      if (dark % 3 === 0) await press('b=1', 60, 300);
      await sleep(3000);
      shot = screen('menu-' + step);
      continue;
    }
    dark = 0;
    if (state === 'home-news') {
      log('  leaving the news view (A)');
      await press('a=1', 100, 2500);
    } else {
      await sleep(3000);                       // unknown: HDMI may still be settling
    }
    shot = screen('menu-' + step);
  }
  if (!shot.titleRow.length) { await press('a=1', 100, 2500); shot = screen('row2'); }
  // Walk the row, reading the label above the selected tile. The row reorders, so
  // a fixed offset is not usable; the retail tile is the one with no DEMO banner.
  const wanted = () => {
    const labels = shot.titleRow.join(' | ');
    return {labels, hit: /smilebasic/i.test(labels) && !/demo/i.test(labels)};
  };
  let found = false;
  for (const direction of ['right', 'left']) {
    for (let step = 0; step < (direction === 'right' ? 12 : 24); step++) {
      const {labels, hit} = wanted();
      log(`  label: ${labels || '(none)'}`);
      if (hit) { found = true; break; }
      await press(`${direction}=1`, 90, 1500);
      shot = screen(`${direction}-${step}`);
    }
    if (found) break;
  }
  if (!found) throw Error('never selected the retail SmileBASIC tile');
  log('launching retail SmileBASIC 4');
  await press('a=1', 120, 12000);
  // Dialogs: account picker -> tag information -> TOPMENU ("Make a Program").
  for (let step = 0; step < 8; step++) {
    const s = screen('after-launch-' + step);
    const short = s.rows.map(r => r.text).join(' ').slice(0, 110);
    log(`  screen: ${short || '(no text)'}`);
    if (/bytes free|bytes\b/i.test(s.text) && /\bok\b/i.test(s.text)) return s.image;
    await press('a=1', 120, 6000);
  }
  throw Error('never reached the direct-mode prompt');
}

function typeText(base, text) { return http(`${base}/type?text=${encodeURIComponent(text)}`, 30000); }

// The confirm dialog's default button is Yes, so Enter accepts it. A single Enter
// is not reliable right after a flash (the first report is dropped), so retry and
// stop as soon as the dialog is gone - an extra Enter on the prompt is harmless.
async function confirmDialog() {
  // The console drops reports right after a flash, and a short Enter is the one that
  // gets lost: retry with a longer key hold, then with the pad's A (the dialog accepts
  // it), before declaring the dialog stuck.
  for (let i = 0; i < 6; i++) {
    if (i < 2) await typeText(PAD, '\n');
    else if (i < 4) await http(`${PAD}/key?code=40&ms=250`, 8000);
    else await press('a=1', 120, 400);
    await sleep(2000);
    const s = screen('confirm');
    if (!/are you sure/i.test(s.text)) return s;
    log(`  confirm dialog still up after attempt ${i + 1}; retrying`);
  }
  throw Error('confirm dialog would not dismiss');
}

// Poll the screen until the text matches, so a wait is tied to what was actually
// drawn rather than to a guessed sleep. Patterns must survive OCR: the console
// draws "Out of memory (REMOVE)" and Vision returns it split across lines, so the
// marker tests look for the distinctive word, not the sentence.
async function waitFor(pattern, tag, seconds = 30) {
  const deadline = Date.now() + seconds * 1000;
  let last;
  while (Date.now() < deadline) {
    last = screen(tag);
    if (new RegExp(pattern, 'i').test(last.text)) return last;
    await sleep(1500);
  }
  throw Error(`console never showed /${pattern}/ (last frame ${last && last.image})`);
}

// Type one line, then confirm the console echoed the marker we expect. Typing is
// cheap to retry but expensive to get wrong, so it is always verified on screen.
async function typeLine(text, expect) {
  const r = await typeText(PAD, text + '\n');
  log(`  typed ${JSON.stringify(text.slice(0, 40))} -> ${r.body.slice(0, 60)}`);
  if (expect) return waitFor(expect, 'typed', 20);
  await sleep(1500);
  return null;
}

function newestRun() {
  const dir = path.join(RPC_DIR, 'runs');
  const names = fs.readdirSync(dir).filter(n => n.startsWith('switch2-'));
  names.sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
  return names.length ? path.join(dir, names[0]) : null;
}

function readRun(run) {
  const out = {run, log: '', root: false, error: null, stages: []};
  try { out.log = fs.readFileSync(path.join(run, 'run.log'), 'utf8'); } catch {}
  out.root = fs.existsSync(path.join(run, 'switch2', 'ro', 'root', 'current-root.json'));
  out.stages = [...out.log.matchAll(/^\s*([1-4])\/4 .*$/gm)].map(m => m[0].trim());
  const err = out.log.split('\n').filter(l => l.startsWith('Error:'));
  if (err.length) out.error = err[err.length - 1];
  return out;
}

// Wait for the pipeline's held state, which is when savekit tools can use the run.
async function waitHeld(run, seconds = 300) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(run, 'switch2', 'pipeline.json'), 'utf8'));
      if (record.hold && record.hold.state === 'ready') return true;
    } catch { /* the file appears once the pipeline starts */ }
    await sleep(1500);
  }
  return false;
}

// --after runs one shell command with RUN pointing at the session, which is the
// point of the whole cycle: a 4/4 that nobody uses costs another boot.
function runAfter(run) {
  if (!AFTER) return null;
  log('after: ' + AFTER);
  const result = spawnSync('sh', ['-c', AFTER], {
    stdio: 'inherit', env: {...process.env, RUN: run}, timeout: 30 * 60 * 1000
  });
  log('after exit ' + (result.status === null ? '(killed)' : result.status));
  return result.status === null ? 7 : result.status;
}

// Is BASIC actually listening? Screen text is unreliable on dense screens (the hex
// dump defeats the OCR), so ask the interpreter instead: PRINT 7, then look for the
// result. Typing into a wedged application changes nothing and costs two seconds,
// which is far cheaper than booting a host against a dead prompt.
// Pure decision for the prompt probe, so it can be tested without a console. The
// command echoes, so a single occurrence proves nothing; the result is either a
// second occurrence or a row that is exactly the marker.
function markerAnswered(text, rows, marker) {
  const occurrences = (String(text).match(new RegExp('\\b' + marker + '\\b', 'g')) || []).length;
  const resultLine = (rows || []).some(row => String(row.text).trim() === marker);
  return occurrences >= 2 || resultLine;
}

async function promptAlive() {
  const marker = String(1000 + Math.floor(Math.random() * 9000));
  await typeText(PAD, 'PRINT ' + marker + '\n');
  for (let i = 0; i < 4; i++) {
    await sleep(1500);
    const shot = screen('prompt-alive');
    if (markerAnswered(shot.text, shot.rows, marker))
      return {alive: true, frame: shot.image};
  }
  return {alive: false, frame: capture('prompt-dead')};
}

async function startSession() {
  const guard = oneSessionPerBoot();
  if (!guard.ok) { log(guard.message); return {code: 6, run: null, frame: null}; }
  writeState({lastSessionAt: Date.now()});
  await ota(KEY_BIN, 'hid-kb-1');
  const probe = await promptAlive();
  if (!probe.alive) {
    log('the console is not at a BASIC prompt (PRINT produced no result); frame ' + probe.frame);
    log('a wedged application needs a power cycle - do not start a host against it');
    return {code: 5, run: null, frame: probe.frame};
  }
  log('direct mode confirmed (PRINT answered)');
  const logFile = '/tmp/harness-host.log';
  const handle = fs.openSync(logFile, 'w');
  // A host left over from an earlier attempt still holds 39380 and the next run dies
  // with EADDRINUSE before it can print a run folder - which cost three boots on
  // 2026-10-30 00:17 before the log was read.
  try { execFileSync('pkill', ['-f', 'run.cjs --rpc'], {timeout: 5000}); } catch { /* none running */ }
  await sleep(500);
  const host = spawn('node', ['run.cjs', '--rpc', MAC_IP], {cwd: RPC_DIR, stdio: ['ignore', handle, handle]});
  // Watch the host: if it dies (e.g. EADDRINUSE on 39380) fail fast instead of
  // waiting out the whole stage-2 window against a log that will never grow.
  let hostExit = null;
  host.on('exit', (code, signal) => { hostExit = {code, signal}; });
  const hostCrashed = () => hostExit && (hostExit.signal || (hostExit.code !== 0 && hostExit.code !== null));
  let run = null;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const text = fs.readFileSync(logFile, 'utf8');
    const m = text.match(/Run folder: (\S+)/);
    if (m) { run = m[1]; break; }
    if (hostCrashed()) break;
  }
  if (!run) {
    host.kill();
    throw Error('host did not print a run folder' +
      (hostExit ? ` (host exited ${hostExit.signal || 'code ' + hostExit.code})` : '') + '; see ' + logFile);
  }
  log('host run ' + run);
  await typeLine('LOAD "TXT:NS2"');
  await waitFor('are you sure', 'confirm');                  // Yes is preselected
  await confirmDialog();
  await typeLine('RUN', 'boot\\s*ready');
  await typeLine('REMOVE NSR,&H60000000,&H3FFFFFFF', 'memory');
  await typeLine(COMMAND);
  const deadline = Date.now() + STAGE2_WAIT;
  let last = '';
  while (Date.now() < deadline) {
    // Reading run.log/pipeline is cheap, so poll briskly: 4/4, errors and a host
    // crash are noticed within ~2 s instead of up to 10 s.
    await sleep(2000);
    const state = readRun(run);
    if (state.root || /4\/4/.test(state.log)) {
      log(`4/4 REACHED (${state.stages.at(-1) || 'stage 4'})`);
      const frame = capture('4of4');
      // The pipeline holds the FS root only after its RO stages finish; tools
      // answer "Another memory request is active" until then.
      const held = await waitHeld(run);
      log(held ? 'held endpoint ready' : 'WARNING: hold never reported ready');
      const after = runAfter(run);
      return {code: after === null ? 0 : after, run, frame};
    }
    if (state.error) {
      const frame = capture('acquire-failed');
      log('acquisition failed: ' + state.error.slice(0, 140));
      log('frame ' + frame);
      return {code: 3, run, error: state.error, frame};
    }
    if (hostCrashed() && !state.root) {
      const frame = capture('host-exited');
      log('host process exited (' + (hostExit.signal || 'code ' + hostExit.code) +
        ') before 4/4; see ' + logFile);
      return {code: 4, run, frame};
    }
    const stage = state.stages.at(-1) || 'waiting';
    if (stage !== last) { log('  ' + stage); last = stage; }
  }
  const frame = capture('acquire-timeout');
  log('no 4/4 within the wait; frame ' + frame);
  return {code: 6, run, frame};
}

module.exports = {markerAnswered, oneSessionPerBoot};

if (require.main === module) (async () => {
  if (MODE === 'state') {
    const shot = screen('state');
    const state = stateOf(shot);
    console.log(JSON.stringify({state, frame: shot.image,
      text: shot.text.slice(0, 160)}, null, 2));
    process.exit(0);
  }
  if (MODE === 'status') {
    const run = newestRun();
    if (!run) { console.log('no runs'); process.exit(4); }
    const state = readRun(run);
    console.log(JSON.stringify({run, root: state.root, stages: state.stages,
      error: state.error && state.error.slice(0, 200)}, null, 2));
    process.exit(state.root ? 0 : 3);
  }

  if (MODE === 'boot' || MODE === 'full') {
    await ota(PRO_BIN, 'pro-2');
    if (!await powerCycle()) {
      log('stopping: no power cycle, so there is no fresh boot to use');
      process.exit(4);
    }
    if (!await waitAwake()) { log('board never came back; is the console plugged in?'); process.exit(4); }
    if (!await waitPadAdopted()) { log('pad was not adopted by the console'); process.exit(3); }
    const frame = await launchSmileBASIC();
    log('direct mode reached; frame ' + frame);
    if (MODE === 'boot') process.exit(0);
  }

  if (MODE === 'session' || MODE === 'full') {
    const result = await startSession();
    process.exit(result.code);
  }
  console.error('usage: node tools/harness.cjs boot|session|full|status [--caps DIR] [--wait SECONDS]');
  process.exit(2);
})().catch(error => {
  log('HARNESS ERROR: ' + error.message);
  try { log('frame ' + capture('harness-error')); } catch {}
  process.exit(error.message.includes('never reached') || error.message.includes('not ready') ? 5 : 3);
});
