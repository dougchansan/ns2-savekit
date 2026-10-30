#!/usr/bin/env node
// Classify what the console is showing, from one capture.
//
//   node tools/console-state.cjs                 # capture and classify
//   node tools/console-state.cjs --png now.png   # classify an existing capture
//   node -e "require('./tools/console-state.cjs').classify({text, bytes})"
//
// Why: the harness used to step RIGHT until a label appeared, which on a black or
// wedged screen meant eight blind presses and a failed boot. A single classification
// tells it whether to navigate, wait, power-cycle, or stop and say what is wrong.
//
// The text is the Vision OCR of the capture, lower-cased and joined; the byte length
// is used because a capture with no signal is a fixed tiny PNG (~8609 bytes on this
// card) and an all-black frame is small too, while any drawn screen is much larger.
//
// LIMIT, measured: dense SmileBASIC screens defeat the OCR. The recovered-prompt
// frame (docs/images, "rpc stop 32896") reads as hex noise and classifies as
// `unknown`, not `direct-mode`. So this is a guard for the clean screens the harness
// has to make decisions on - black, no signal, home row, dialogs, TOPMENU - and not
// a proof of state; the harness still verifies markers by their own text before
// typing.
const STATES = ['no-signal', 'black', 'error-dialog', 'wedged-rpc', 'direct-mode',
  'playmenu', 'topmenu', 'home-news', 'home-row', 'unknown'];

const NO_SIGNAL_BYTES = 12000;          // measured: 8609 for a lost signal
const BLACK_BYTES = 40000;              // measured: ~69827 for an all-black 1080p frame

function classify({text = '', bytes = 0} = {}) {
  const t = String(text).toLowerCase();
  if (bytes && bytes <= NO_SIGNAL_BYTES && !t.trim()) return 'no-signal';
  if (bytes && bytes <= BLACK_BYTES && !t.trim()) return 'black';
  if (/2162-0002|error code|\ban error has occurred\b/.test(t)) return 'error-dialog';
  // A finished program prints RPC STOP and returns to the prompt; a stuck one keeps
  // RPC RUNNING with no prompt below it.
  if (/\brpc running\b/.test(t) && !/\brpc stop\b/.test(t)) return 'wedged-rpc';
  // The prompt is reached either freshly ("bytes free") or after a program ends
  // ("RPC STOP" then "OK"); the recovered screen in RESULTS shows the second shape.
  if (/bytes free/.test(t) && /\bok\b/.test(t)) return 'direct-mode';
  if (/\brpc stop\b/.test(t) && /\bok\b/.test(t)) return 'direct-mode';
  if (/playmenu/.test(t)) return 'playmenu';
  if (/topmenu/.test(t) && /make a program/.test(t)) return 'topmenu';
  if (/featured news|a start/.test(t)) return 'home-news';
  if (/smilebasic|mario kart|sports resort|nora/.test(t)) return 'home-row';
  return 'unknown';
}

// What the harness should do next, so the policy lives in one place.
function action(state) {
  switch (state) {
    case 'no-signal': return 'power-cycle';       // console asleep or off
    case 'black': return 'wait';                  // HDMI not settled yet
    case 'wedged-rpc': return 'stop';             // only a power cycle helps
    case 'error-dialog': return 'stop';
    case 'home-news': return 'press-a';           // A leaves the news view
    case 'home-row': return 'select-tile';
    case 'topmenu': return 'enter-direct-mode';
    case 'direct-mode': return 'type';
    case 'playmenu': return 'navigate-menu';
    default: return 'wait';
  }
}

function main() {
  const {execFileSync} = require('node:child_process');
  const fs = require('node:fs');
  const path = require('node:path');
  const ocr = path.join(__dirname, 'vision', 'ocr');
  const at = process.argv.indexOf('--png');
  let png = at >= 0 ? process.argv[at + 1] : '/tmp/console-state.png';
  if (at < 0) {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'avfoundation',
      '-pixel_format', 'uyvy422', '-framerate', '30', '-video_size', '1920x1080',
      '-i', '0:none', '-frames:v', '1', '-update', '1', '-y', png], {timeout: 40000});
  }
  let text = '';
  try {
    text = execFileSync(ocr, [png], {encoding: 'utf8', timeout: 60000})
      .trim().split('\n').filter(l => l.includes('\t'))
      .map(l => l.split('\t').slice(1).join('\t')).join(' ');
  } catch { /* no text is a valid result */ }
  const bytes = fs.existsSync(png) ? fs.statSync(png).size : 0;
  const state = classify({text, bytes});
  console.log(JSON.stringify({state, action: action(state), bytes, png,
    text: text.slice(0, 160)}, null, 2));
}

module.exports = {classify, action, STATES, NO_SIGNAL_BYTES, BLACK_BYTES};
if (require.main === module) main();
