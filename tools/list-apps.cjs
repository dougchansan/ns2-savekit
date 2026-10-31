#!/usr/bin/env node
// List installed applications through the borrowed FS SM client + NCM.
//   node list-apps.cjs <run-directory>
// Read-only: NCM content-meta database enumeration. Every storage that has a
// database is asked - BuiltInUser, SdCard, GameCard - because installed titles do
// not all live on the internal NAND (issue #1: only 18 titles, all internal).
const path = require('node:path');
const {collect} = require('./lib/app-storages.cjs');

async function main() {
  const [runDirectory] = process.argv.slice(2);
  if (!runDirectory) { console.error('usage: node list-apps.cjs <run-directory>'); process.exit(2); }
  const engine = path.join(path.resolve(runDirectory), 'switch2');
  // Load the run's own endpoint client so the memory socket path/protocol match.
  const {connect: runConnect} = require(path.join(engine, 'tools/fs-memory.cjs'));
  const memory = await runConnect();
  const info = await memory.request({command: 'root-native-info'});
  const sm = info.services?.find(item => item.name === 'pm:shell')?.sm;
  if (!sm) throw Error('The run has no borrowed initialized SM client');
  const ncm = await memory.request({command: 'root-native-sm-service', handle: sm, name: 'ncm'});
  if (ncm.transport || ncm.result || !ncm.moves?.length)
    throw Error('ncm lookup failed: transport=' + ncm.transport + ' result=' + ncm.result);
  const handle = ncm.moves[0];
  try {
    const {ids} = await collect(storage => memory.request({
      command: 'root-native-ncm-list-system', handle, storage, metaType: 0x80, installType: 0,
    }), {note: text => console.error(text)});
    // No database at all is a tool problem, not an empty console: "no titles"
    // would otherwise send the caller looking for a missing SD card.
    if (ids.length === 0)
      throw Error('NCM listed no installed applications on any storage ' +
        '(BuiltInUser, SdCard, GameCard)');
    for (const id of ids) console.log(id);
    console.error(`${ids.length} installed applications`);
  } finally {
    await memory.request({command: 'root-native-close-handle', handle}).catch(() => {});
  }
}

main().catch(error => { console.error('FAILED:', error.message); process.exit(1); });
