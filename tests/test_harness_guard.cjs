#!/usr/bin/env node
// Offline tests for the harness's two safety rules.
//
//   node tests/test_harness_guard.cjs
//
// These are the rules that cost hardware time when they are wrong: one RPC session
// per boot, and a power cycle that must be observed. The decision functions are pure
// so they can be checked without a console.
const assert = require('node:assert');
const {oneSessionPerBoot, markerAnswered} = require('../tools/harness.cjs');

let passes = 0, failures = 0;
const test = (name, fn) => {
  try { fn(); passes++; console.log('ok    ' + name); }
  catch (error) { failures++; console.log('FAIL  ' + name + '\n      ' + error.message); }
};

test('a boot with no recorded session may start one', () => {
  assert.strictEqual(oneSessionPerBoot({}).ok, true);
});

test('a boot whose session was used refuses another', () => {
  const verdict = oneSessionPerBoot({lastSessionAt: 10});
  assert.strictEqual(verdict.ok, false);
  assert.match(verdict.message, /hard power cycle/);
});

test('a power cycle BEFORE the session does not authorise a second one', () => {
  assert.strictEqual(oneSessionPerBoot({lastSessionAt: 10, powerCycledAt: 5}).ok, false);
});

test('a power cycle AFTER the session does authorise a new one', () => {
  assert.strictEqual(oneSessionPerBoot({lastSessionAt: 10, powerCycledAt: 20}).ok, true);
});

test('the prompt probe needs the echo and the result, not one of them', () => {
  // The command echoes, so a dead prompt shows the marker once and nothing else.
  assert.strictEqual(markerAnswered('PRINT 4242', [], '4242'), false);
  assert.strictEqual(markerAnswered('PRINT 4242 4242', [], '4242'), true);
  assert.strictEqual(markerAnswered('', [{text: '4242'}], '4242'), true);
  assert.strictEqual(markerAnswered('', [], '4242'), false);
  // A longer number must not satisfy a shorter marker.
  assert.strictEqual(markerAnswered('PRINT 42421', [{text: '42421'}], '4242'), false);
});

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
