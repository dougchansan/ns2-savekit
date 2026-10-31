'use strict';
// Ask the console for each title's own name.
//
// The console's control-data reader is the only source that names a Switch 2
// title: blawar/titledb is a Switch 1 catalogue. It is reached through ns:ro (or
// ns:am2 on a build without it), which exposes a reader in command 7989; command
// 0 on that reader fills 0x4000 bytes of NACP for one title id. Found and proven
// in ouncecake (engine/content.cjs) - the commands below are that flow.
//
// Two buffer encodings are tried, because which one a call wants is a property of
// the interface and only the console can say: the recv static ("pointer buffer",
// what ouncecake's fixed-output descriptor resolves to) first, then the map-alias
// descriptor. Whichever answers is used for the rest of the list; if neither does,
// every title keeps its id and the caller carries on.
//
// The session is passed in, not opened here, so this can be tested with a fake
// one. Every failure is a missing name, never an exception: a listing must not
// fail because a name could not be read.
const nacp = require('./nacp.cjs');

const OPEN_READER = 7989;
const READ_CONTROL = 0;
const NACP_SIZE = 0x4000;
const BUFFER = 0x10000;        // low half of the session's owned memory, unused

const SHAPES = [
  {label: 'pointer', options: address => ({pointers: {receive: [{address, size: NACP_SIZE}]}})},
  {label: 'map-alias', options: address => ({receive: [{address, size: NACP_SIZE, mode: 0}]})},
];

async function readOne(s, reader, key, shape) {
  const address = s.base + BUFFER;
  const input = Buffer.alloc(16);
  input[0] = 1;
  input.writeBigUInt64LE(BigInt('0x' + key), 8);
  const reply = await s.ipc('Read title control data', reader, READ_CONTROL, input,
    shape.options(address));
  if (reply.result) return {result: reply.result};
  return {bytes: await s.readOwned(address, NACP_SIZE)};
}

async function read(s, ids, options = {}) {
  const note = options.note || (() => {});
  const names = {};
  let ns = null;
  for (const service of ['ns:ro', 'ns:am2']) {
    try {
      ns = await s.openService(service);
      note('names: ' + service);
      break;
    } catch {
      note('names: ' + service + ' unavailable');
    }
  }
  if (ns === null) return names;

  let reader;
  try {
    const opened = await s.ipc('Open application name reader', ns, OPEN_READER, Buffer.alloc(0));
    if (opened.result || !opened.moves.length) {
      note('names: no control-data reader (0x' +
        (Number(opened.result) & 0x3fffff).toString(16) + ')');
      return names;
    }
    reader = opened.moves[0];
    let shape = null;
    for (const id of ids) {
      const key = String(id).toLowerCase().replace(/^0x/, '');
      let reply = null;
      if (shape) {
        reply = await readOne(s, reader, key, shape);
      } else {
        for (const candidate of SHAPES) {
          const attempt = await readOne(s, reader, key, candidate);
          if (!attempt.result) {
            shape = candidate;
            note('names: control data reads with the ' + shape.label + ' buffer');
            reply = attempt;
            break;
          }
          reply = attempt;
        }
        // The first refusal with nothing read means the read is not available at
        // all, not that this title has no name: stop instead of firing the list.
        if (!shape) {
          note('names: the console refused the control-data read (0x' +
            (Number(reply && reply.result) & 0x3fffff).toString(16) + ')');
          return names;
        }
      }
      if (reply.result) continue;
      const found = nacp.name(reply.bytes);
      if (found) names[key] = found;
    }
  } catch (error) {
    note('names: ' + error.message);
  } finally {
    if (reader !== undefined) await s.close(reader).catch(() => s.handles.delete(reader));
  }
  return names;
}

module.exports = {read, SHAPES, OPEN_READER, READ_CONTROL, NACP_SIZE, BUFFER};
