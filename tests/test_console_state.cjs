#!/usr/bin/env node
// Offline tests for tools/console-state.cjs.
//
//   node tests/test_console_state.cjs
//
// The classifier is the harness's decision point, so each state is exercised with
// the text and frame sizes that were actually observed on this console (see
// docs/RESULTS.md); a wrong classification would send the cycle to the wrong action.
const assert = require('node:assert');
const {classify, action, NO_SIGNAL_BYTES} = require('../tools/console-state.cjs');

let passes = 0, failures = 0;
const test = (name, fn) => {
  try { fn(); passes++; console.log('ok    ' + name); }
  catch (error) { failures++; console.log('FAIL  ' + name + '\n      ' + error.message); }
};

const at = (text, bytes) => ({text, bytes});

test('a lost signal is no-signal, whatever the size edge is', () => {
  assert.strictEqual(classify(at('', 8609)), 'no-signal');
  assert.strictEqual(classify(at('', NO_SIGNAL_BYTES)), 'no-signal');
  assert.strictEqual(action('no-signal'), 'power-cycle');
});

test('a small frame with no text is black and waits', () => {
  assert.strictEqual(classify(at('', 25000)), 'black');
  assert.strictEqual(action('black'), 'wait');
});

test('the wedged RPC screen is wedged-rpc, not direct mode', () => {
  const text = 'boot ok 3925528160 host connected rpc running';
  assert.strictEqual(classify(at(text, 200000)), 'wedged-rpc');
  assert.strictEqual(action('wedged-rpc'), 'stop');
});

test('a finished program prints RPC STOP and is direct mode', () => {
  const text = 'boot ok 3925528160 host connected rpc running rpc stop 32896 ok [workspace]';
  assert.strictEqual(classify(at(text, 152860)), 'direct-mode');
  assert.strictEqual(action('direct-mode'), 'type');
});

test('the direct-mode prompt is direct mode', () => {
  assert.strictEqual(classify(at('smilebasic for nintendo switch 134216720 bytes free ok', 150000)),
    'direct-mode');
});

test('the crash dialog is an error, not a menu', () => {
  assert.strictEqual(classify(at('error code: 2162-0002 an error has occurred', 276361)),
    'error-dialog');
  assert.strictEqual(classify(at('error code 2155-8007 an error has occurred', 200000)),
    'error-dialog');
});

test('the news view wants A, the game row wants tile selection', () => {
  assert.strictEqual(classify(at('featured news indie world a start', 900000)), 'home-news');
  assert.strictEqual(action('home-news'), 'press-a');
  assert.strictEqual(classify(at('smilebasic 4 mario kart 8 deluxe', 920920)), 'home-row');
  assert.strictEqual(action('home-row'), 'select-tile');
});

test('TOPMENU and PLAYMENU are told apart', () => {
  assert.strictEqual(classify(at('topmenu settings projects make a program', 383590)), 'topmenu');
  assert.strictEqual(classify(at('playmenu local samples published works [workspace]', 312676)),
    'playmenu');
});

test('nonsense text is unknown, not a guess', () => {
  assert.strictEqual(classify(at('qqq zzz', 200000)), 'unknown');
  assert.strictEqual(action('unknown'), 'wait');
});

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
