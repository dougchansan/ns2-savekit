'use strict';
const readline = require('node:readline/promises');

function validateSavePath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') ||
      /[\\\x00-\x1f\x7f]/.test(value) || Buffer.byteLength(value) >= 0x301 ||
      value.slice(1).split('/').some(part => !part || part === '.' || part === '..')) {
    throw Error('Invalid save path: ' + value);
  }
  return value;
}

async function allowRisk(ok, message) {
  if (ok) return;
  // Each exception needs its own affirmative answer. Piped input cannot silently
  // authorize a write, and the normal plan confirmation does not waive risks.
  if (!process.stdin.isTTY) throw Error(message + '; interactive confirmation required');
  const rl = readline.createInterface({input: process.stdin, output: process.stdout});
  try {
    const answer = await rl.question(message + '. Continue? [y/N]: ');
    if (!/^(y|yes)$/i.test(answer.trim())) throw Error('Write cancelled: ' + message);
  } finally { rl.close(); }
}
async function confirmWrite({title, uid, space = 1, type = 1, rank = 0, index = 0, files, operation = 'Write'}) {
  console.log('\n' + operation + ' plan');
  console.log('  title   ' + title);
  console.log('  account ' + uid);
  console.log('  space   ' + space + ', type ' + type + ', rank ' + rank + ', index ' + index);
  for (const file of files) console.log('  ' + file);
  await allowRisk(false, operation + ' save data for ' + title);
}
module.exports = {allowRisk, validateSavePath, confirmWrite};
