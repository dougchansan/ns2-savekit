#!/usr/bin/env node
// List installed applications through the borrowed FS SM client + NCM.
//   node list-apps.cjs <run-directory> [--no-names]
// Read-only: NCM content-meta database enumeration over every storage that has a
// database (BuiltInUser, SdCard, GameCard), then the console's own name for each
// title it has not named before. A name never fails the listing: if the console
// will not give one, the id is printed on its own.
const path = require('node:path');
const {collect} = require('./lib/app-storages.cjs');
const consoleNames = require('./lib/console-names.cjs');
const titles = require('./lib/titles.cjs');

const NAMES_BYTES = 0x20000;   // owned memory: NACP buffer sits at base + 0x10000

// The console's control-data reader: the only source that names a Switch 2 title
// (blawar/titledb is a Switch 1 catalogue), which is why list-apps reads it.
async function readNames(engine, ids, note) {
  const {Session} = require(path.join(engine, 'app/session.cjs'));
  let s;
  try {
    s = new Session('title-names-' + Date.now(), NAMES_BYTES);
    s.record = async () => {};
    await s.initialize();
  } catch (error) {
    note('names: no session for the read (' + error.message + ')');
    return {};
  }
  try {
    return await consoleNames.read(s, ids, {note});
  } finally {
    await s.cleanup().catch(() => {});
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const known = new Set(['--no-names']);
  for (const arg of argv) {
    if (arg.startsWith('--') && !known.has(arg)) throw Error('unknown option ' + arg);
  }
  const [runDirectory] = argv.filter(arg => !arg.startsWith('--'));
  if (!runDirectory) {
    console.error('usage: node list-apps.cjs <run-directory> [--no-names]');
    process.exit(2);
  }
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
  const note = text => console.error(text);
  try {
    const {ids} = await collect(storage => memory.request({
      command: 'root-native-ncm-list-system', handle, storage, metaType: 0x80, installType: 0,
    }), {note});
    // No database at all is a tool problem, not an empty console: "no titles"
    // would otherwise send the caller looking for a missing SD card.
    if (ids.length === 0)
      throw Error('NCM listed no installed applications on any storage ' +
        '(BuiltInUser, SdCard, GameCard)');
    for (const id of ids) console.log(id);
    console.error(`${ids.length} installed applications`);
    if (argv.includes('--no-names')) return;
    // Only ids the console has not already named: the cache makes the second
    // listing (and every other tool) free of the read.
    const cached = titles.deviceNames();
    const missing = ids.filter(id => !cached[id.toLowerCase()]);
    if (missing.length === 0) return;
    const names = await readNames(engine, missing, note);
    const count = Object.keys(names).length;
    titles.rememberDeviceNames(names);
    console.error(`names: ${count} of ${missing.length} new titles named from the console` +
      (count < missing.length ? ' (the rest keep their id)' : ''));
  } finally {
    await memory.request({command: 'root-native-close-handle', handle}).catch(() => {});
  }
}

main().catch(error => { console.error('FAILED:', error.message); process.exit(1); });
