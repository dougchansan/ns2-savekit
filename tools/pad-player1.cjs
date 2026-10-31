#!/usr/bin/env node
// Make sure the ESP32 Pro Controller is adopted as PLAYER 1, so its input is
// reliable and games accept it.
//
//   node tools/pad-player1.cjs status    # is the pad Player 1 right now?
//   node tools/pad-player1.cjs ensure    # make it so (reboot only if needed) - default
//   node tools/pad-player1.cjs reboot    # force a cold boot regardless
//
// Why this exists (measured on the console, 2026-10-31): a pad that WAKES the
// console from sleep comes up as a *secondary* controller - the console polls
// its IN endpoint lazily (/usb hidReady:false), so most input reports are
// dropped at the USB layer, the home menu feels unresponsive, and games ignore
// the pad entirely. The SAME pad attached across a COLD BOOT comes up as
// Player 1: /usb hidReady goes true and stays true, input registers on the
// first press. So "menu input is flaky" and "games ignore the pad" are one bug,
// and the fix for both is the same - boot, don't wake.
//
// This talks only to the ESP32 pad (HTTP) and the fingerbot. No console RPC and
// no save access. Exit 0 = pad is Player 1; non-zero = it is not / could not be.
const PAD = process.env.PAD || 'http://192.168.50.215';
const FINGERBOT = process.env.FINGERBOT || 'http://192.168.50.235:8080';
// Measured reliable values (see docs/HARNESS and docs/HANDOFF-PRO-CONTROLLER):
const BOOT_PRESS_S = Number(process.env.PAD_BOOT_PRESS || 3);   // 1-2 s presses were ignored after the arm was reseated
const OFF_HOLD_S = Number(process.env.PAD_OFF_HOLD || 16);      // a force-off needs ~16 s on the button
const TRAVEL = Number(process.env.PAD_TRAVEL || 100);          // arm depth that actually reaches the button (95 missed)
const SETTLE_MS = 10000;                                        // a boot press <10 s after power-off is ignored

const sleep = ms => new Promise(r => setTimeout(r, ms));
function log(message) { console.error(`${new Date().toLocaleTimeString()}  ${message}`); }

async function http(url, timeout = 8000) {
  try {
    const response = await fetch(url, {signal: AbortSignal.timeout(timeout)});
    return {ok: response.ok, body: await response.text()};
  } catch (error) { return {ok: false, body: 'ERR ' + error.message}; }
}
async function usb() {
  const r = await http(`${PAD}/usb`);
  try { return JSON.parse(r.body); } catch { return null; }
}

// Three signals, read straight off the pad, tell the three states apart:
//   Player 1  - hidReady (tud_hid_n_ready) is true across samples AND the board's
//               reportsSent counter climbs (the console is polling our endpoint).
//   secondary - reportsSent climbs but hidReady is mostly false (polled lazily;
//               input dropped).
//   off/asleep- reportsSent is frozen (the console is not polling at all).
// reportsSent is a monotonic counter on the board; the board stays powered across
// a console reboot, so it never resets and consecutive samples are comparable.
async function controllerState() {
  const ready = [];
  let first, last;
  for (let i = 0; i < 3; i++) {
    const u = await usb();
    if (!u) return {ok: false, state: 'unreachable', reason: 'the board did not answer /usb'};
    if (!u.mounted) return {ok: false, state: 'unmounted', reason: 'the pad is not enumerated by the console'};
    if (i === 0) first = u.reportsSent;
    last = u.reportsSent;
    ready.push(u.hidReady === true);
    if (i < 2) await sleep(900);
  }
  const streaming = last > first;
  const mostlyReady = ready.filter(Boolean).length >= 2;
  let state, reason;
  if (!streaming) { state = 'off'; reason = 'the console is off or asleep (input is not being polled)'; }
  else if (mostlyReady) { state = 'player1'; reason = 'Player 1 (hidReady true and streaming)'; }
  else { state = 'secondary'; reason = 'a secondary controller (hidReady false; input is dropped)'; }
  return {ok: state === 'player1', state, reason, hidReady: ready, reportsSent: last};
}

async function fingerPress(seconds) {
  await http(`${FINGERBOT}/travel?pct=${TRAVEL}`, 12000);
  await http(`${FINGERBOT}/up`, 30000);
  await sleep(800);
  return http(`${FINGERBOT}/press?seconds=${seconds}`, (seconds + 20) * 1000);
}

// Off = the board's reportsSent counter stops climbing (the console stopped
// polling). One frozen interval is enough; a running console adds hundreds/sample.
async function waitOff(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let prev = (await usb() || {}).reportsSent;
  while (Date.now() < deadline) {
    await sleep(2500);
    const now = (await usb() || {}).reportsSent;
    if (now !== undefined && now === prev) return true;
    prev = now;
  }
  return false;
}

// Up = hidReady true and actually streaming. A second boot press is sometimes
// needed (a single press does not always catch), so nudge once if nothing comes.
async function waitPlayerOne(timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  const start = Date.now();
  let nudged = false;
  while (Date.now() < deadline) {
    const u = await usb();
    if (u && u.hidReady) {
      const s = await controllerState();
      if (s.state === 'player1') return true;
    }
    if (!nudged && Date.now() - start > 35000) {
      log('still no picture; a second boot press');
      nudged = true;
      await fingerPress(BOOT_PRESS_S).catch(() => {});
    }
    await sleep(3000);
  }
  return false;
}

async function reboot() {
  log(`force off: ${OFF_HOLD_S} s hold`);
  await fingerPress(OFF_HOLD_S);
  log('waiting for power-off...');
  if (!await waitOff()) log('warning: could not confirm power-off; continuing anyway');
  await sleep(SETTLE_MS);
  log(`boot: ${BOOT_PRESS_S} s press`);
  await fingerPress(BOOT_PRESS_S);
  log('waiting for the pad to come up as Player 1...');
  return waitPlayerOne();
}

async function main() {
  const mode = process.argv[2] || 'ensure';
  if (mode === 'status') {
    const s = await controllerState();
    console.log(JSON.stringify(s, null, 2));
    process.exit(s.ok ? 0 : 1);
  }
  if (mode === 'ensure') {
    const s = await controllerState();
    if (s.state === 'player1') { log('pad is already Player 1'); process.exit(0); }
    log(`pad is ${s.state} (${s.reason}); rebooting so it comes up as Player 1`);
    const ok = await reboot();
    log(ok ? 'pad is now Player 1' : 'could not make the pad Player 1 - check the fingerbot and the pad');
    process.exit(ok ? 0 : 1);
  }
  if (mode === 'reboot') {
    const ok = await reboot();
    log(ok ? 'pad is Player 1' : 'pad did NOT come up as Player 1');
    process.exit(ok ? 0 : 1);
  }
  console.error('usage: node tools/pad-player1.cjs [status|ensure|reboot]');
  process.exit(2);
}
main();
