#!/usr/bin/env node
// Single-file adapter for the staged writer: identical prompts, path handling,
// commit and read-back verification for root and nested files.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {validateSavePath} = require('./lib/write-policy.cjs');
async function main() {
  const args = process.argv.slice(2);
  const replace = args.includes('--replace');
  const [run, title, uid, target, local, backup = '-'] = args.filter(a => a !== '--replace');
  if (!run || !title || !uid || !target || !local) throw Error(
    'usage: node save-write-root.cjs <run> <program-id> <uid> <save-path> <local-file> [backup-directory] [--replace]');
  validateSavePath(target);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'save-write-'));
  try {
    const manifest = path.join(temp, 'manifest.json');
    await fs.writeFile(manifest, JSON.stringify({files: [{path: target, local: path.resolve(local), replace}]}));
    const result = spawnSync(process.execPath, [path.join(__dirname, 'save-write-stage.cjs'),
      run, title, uid, backup, manifest], {stdio: 'inherit'});
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally { await fs.rm(temp, {recursive: true, force: true}); }
}
main().catch(error => {console.error('FAILED:', error.message); process.exitCode = 1;});
