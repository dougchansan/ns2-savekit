#!/usr/bin/env node
// Pull another title's save data through the exploit's promoted (pid=1) fsp-srv
// root, enumerating account uids with the CMIF pointer-buffer ListAllUsers call.
//
//   node save-pull-root.cjs <run-directory> <program-id> <output-directory> [uid-hex]
//
// Why the promoted root: a normal application session gets FS 6400
// (PermissionDenied) for another title's save. The exploit already promotes the
// cached PID of its dedicated fsp-srv root (ro/root/current-root.json, pid 1),
// which passes fsp-srv's save-data access check. Read-only command 53 is used
// so the save is never modified; it is closed before the process exits.
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');

function request(socketPath, command) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let input = '';
    socket.setEncoding('utf8');
    socket.setTimeout(120000, () => socket.destroy(new Error('memory request timed out')));
    socket.on('error', reject);
    socket.on('connect', () => socket.write(JSON.stringify(command) + '\n'));
    socket.on('data', part => { input += part; });
    socket.on('end', () => {
      try {
        const result = JSON.parse(input);
        if (result.error) throw new Error(result.error);
        resolve(result);
      } catch (error) { reject(error); }
    });
  });
}

const code = value => '0x' + (Number(value) & 0x3fffff).toString(16);
const SPACES = {0: 'System', 1: 'User', 2: 'SdSystem', 3: 'Temporary', 4: 'SdUser'};
const TYPES = {0: 'System', 1: 'Account', 2: 'Bcat', 3: 'Device', 4: 'Temporary', 5: 'Cache'};

async function main() {
  let argv = process.argv.slice(2);
  const listOnly = argv.includes('--list-only');
  const listUids = argv.includes('--list-uids');
  // Crash investigation knobs: keep the save mounted, keep the session alive.
  const keepOpen = argv.includes('--keep-open');
  // Targeted open: the space/type sweep below can be up to 60 opens of other
  // titles' saves, and on this console a sweep is what wedges the session inside
  // an unresolved IPC call (2026-10-29: two sessions lost that way, console alive
  // in RPC RUNNING). When the combination is known, open exactly one.
  const optionValue = name => {
    const at = argv.indexOf(name);
    if (at < 0) return null;
    const value = argv[at + 1];
    if (!/^[0-9]+$/.test(value)) throw Error(name + ' needs a number');
    return Number(value);
  };
  const onlySpace = optionValue('--space');
  const onlyType = optionValue('--type');
  argv = argv.filter((a, i) => a !== '--list-only' && a !== '--list-uids' && a !== '--keep-open' &&
    a !== '--space' && a !== '--type' && !(i > 0 && ['--space', '--type'].includes(argv[i - 1])));
  const [runDirectory, programText, outputDirectory, forcedUid] = argv;
  if (!runDirectory || !programText || !outputDirectory) {
    console.error('usage: node save-pull-root.cjs <run-directory> <program-id> <output-directory> ' +
      '[uid-hex] [--space N] [--type N] [--list-only]');
    process.exit(2);
  }
  const run = path.resolve(runDirectory);
  const engine = path.join(run, 'switch2');
  const current = JSON.parse(await fs.readFile(path.join(engine, 'current-acquisition.json'), 'utf8'));
  const rootProof = JSON.parse(await fs.readFile(path.join(engine, 'ro/root/current-root.json'), 'utf8'));
  if (rootProof.session !== current.session || rootProof.pid !== 1 || !rootProof.rootHandle)
    throw Error('The run has no promoted fsp-srv root (expected pid 1)');
  const root = rootProof.rootHandle;
  const {Session, u64} = require(path.join(engine, 'app/session.cjs'));
  const filesystem = require(path.join(engine, 'app/filesystem.cjs'));
  const programId = BigInt(/^0x/i.test(programText) ? programText : '0x' + programText);

  await request(current.socketPath, {command: 'root-native-info'});
  const s = new Session('save-pull-root-' + Date.now(), 0x80000);
  s.record = async () => {};
  await s.initialize();

  // Raw 16-byte AccountUid values. Do not round-trip them through BigInt hex:
  // an AccountUid is two little-endian u64s, so the numeric hex is byte-swapped.
  const uids = [];
  try {
    const acc = await s.openService('acc:u0');
    const init = await s.ipc('acc InitializeApplicationInfo', acc, 140, u64(0), {pid: true});
    if (init.result) throw Error('acc:u0 initialization failed: ' + code(init.result));
    const at = s.base + 0x3000;
    await s.write(at, Buffer.alloc(0x80));
    const listed = await s.ipc('ListAllUsers', acc, 2, Buffer.alloc(0),
      {pointers: {receive: [{address: at, size: 0x80}]}});
    if (listed.result) throw Error('ListAllUsers failed: ' + code(listed.result));
    const bytes = await s.read(at, 0x80);
    for (let i = 0; i < 0x80 / 16; i++) {
      const uid = bytes.subarray(i * 16, (i + 1) * 16);
      if (uid.some(byte => byte !== 0)) uids.push(uid);
    }
    console.error('account users:', uids.length);
  } catch (error) {
    console.error('account enumeration failed:', error.message);
  }
  if (listUids) {
    for (const uid of uids) console.log(uid.toString('hex'));
    await s.cleanup().catch(() => {});
    return;
  }
  if (forcedUid) uids.splice(0, uids.length, Buffer.from(forcedUid.replace(/^0x/i, ''), 'hex'));
  if (!uids.length) uids.push(Buffer.alloc(16));
  if (uids.some(uid => uid.length !== 16)) throw Error('uid must be 16 raw bytes');

  let save = null;
  let chosen = null;
  try {
    // Types beyond Account/System matter: some titles (SmileBASIC 4 retail among
    // them) keep their save as a Device save, which an Account-only sweep reports
    // as "no save data".
    const spaces = onlySpace === null ? [1, 0, 3, 4] : [onlySpace];
    const types = onlyType === null ? [1, 0, 3, 4, 5] : [onlyType];
    if (onlySpace !== null || onlyType !== null)
      console.error('targeted open: space=' + spaces.join('/') + ' type=' + types.join('/'));
    for (const space of spaces) {
      for (const type of types) {
        for (const uid of uids) {
          const input = Buffer.alloc(0x48);
          input[0] = space;
          input.writeBigUInt64LE(programId, 8);
          uid.copy(input, 0x10);
          input[0x28] = type;
          const reply = await s.ipc('Open save data (read-only)', root, 53, input);
          console.error(`  space=${SPACES[space] ?? space} type=${TYPES[type] ?? type} ` +
            `uid=${uid.toString('hex').slice(0, 16)} -> ${reply.result ? code(reply.result) : 'ok'}`);
          if (!reply.result && reply.moves.length === 1) {
            save = reply.moves[0];
            chosen = {space, type, uid};
            break;
          }
        }
        if (save !== null) break;
      }
      if (save !== null) break;
    }
    if (save === null) throw Error('No save filesystem opened for 0x' + programId.toString(16));
    if (process.argv.includes('--filetime')) {
      // Probe IFileSystem's timestamp command: same technique that found the
      // working save-info reader (try the plausible shapes, print each result).
      const {packet} = require(path.join(run, 'shared/ipc.cjs'));
      const domain = require(path.join(engine, 'app/domain.cjs'));
      const out = s.base + 0x6000;
      const pathAddr = s.base + 0x2000;
      const buf = Buffer.alloc(0x304);
      Buffer.from(process.env.FTIMEPATH || '/').copy(buf);
      await s.write(pathAddr, buf);
      await s.write(out, Buffer.alloc(0x40));
      const target = process.env.FTIMEPATH || '/account.sav';
      // Sweep output sizes and path encodings: the call reached FS but was refused,
      // so the remaining unknowns are the reply struct size and the path buffer.
      for (const outSize of [8, 0x10, 0x18, 0x20, 0x28]) {
        for (const [variant, pathSize] of [['exact', Buffer.byteLength(target) + 1],
                                            ['padded', 0x301]]) {
          const buf = Buffer.alloc(0x304);
          Buffer.from(target).copy(buf);
          await s.write(pathAddr, buf);
          await s.write(out, Buffer.alloc(0x40));
          const bytes = packet(12, Buffer.alloc(0), {pointers: {
            send: [{address: pathAddr, size: pathSize}],
            receive: [{address: out, size: outSize}]}});
          try {
            const reply = await domain.send(s, 'filetime', save, bytes);
            const code = Number(reply.result) & 0x3fffff;
            const data = code ? null : await s.read(out, outSize);
            console.log(`12 out=${outSize} path=${variant} -> 0x${code.toString(16)}` +
              (data ? '  ' + data.toString('hex') : ''));
          } catch (error) {
            console.log(`12 out=${outSize} path=${variant} -> threw ${error.message}`);
          }
        }
      }
      await s.close(save).catch(() => {});
      return;
    }
    console.error(`mounted space=${SPACES[chosen.space] ?? chosen.space} ` +
      `type=${TYPES[chosen.type] ?? chosen.type} uid=${chosen.uid.toString('hex')}`);

    if (listOnly) {
      let count = 0, total = 0;
      const stampTargets = [];
      async function show(directory) {
        const entries = await filesystem.listDirectory(s, save, directory, 2048);
        for (const entry of entries) {
          const full = (directory.endsWith('/') ? directory : directory + '/') + entry.name;
          const opened = await filesystem.openFile(s, save, full);
          if (!opened.result) {
            const size = Number(await filesystem.fileSize(s, opened.handle));
            await s.close(opened.handle).catch(() => s.handles.delete(opened.handle));
            console.log(`${String(size).padStart(9)}  ${full}`);
            if (stampTargets.length < 8) stampTargets.push(full);
            count += 1; total += size;
          } else {
            console.log(`${'<dir>'.padStart(9)}  ${full}/`);
            await show(full);
          }
        }
      }
      // Newest write time, if the filesystem exposes GetFileTimeStampRaw (cmd 12).
      let newest = 0;
      try {
        const {packet} = require(path.join(run, 'shared/ipc.cjs'));
        const {u64} = require(path.join(engine, 'app/session.cjs'));
        const out = s.base + 0x6000;
        for (const full of stampTargets) {
          const text = Buffer.from(full, 'utf8');
          if (text.length >= 0x301) continue;
          const pathBuf = Buffer.alloc(0x304);
          text.copy(pathBuf);
          await s.write(s.base + 0x2000, pathBuf);
          const bytes = packet(12, Buffer.alloc(0), {pointers: {
            send: [{address: s.base + 0x2000}],
            receive: [{address: out, size: 0x20}],
          }});
          const reply = await domain.send(s, 'GetFileTimeStampRaw ' + full, save, bytes)
            .catch(() => null);
          if (!reply || reply.result) continue;
          const raw = await s.read(out, 0x20);
          const value = Number(raw.readBigUInt64LE(0));
          if (value > newest) newest = value;
        }
      } catch { /* timestamps are optional */ }
      await show('/');
      console.log(`listed ${count} files, ${total} bytes` +
        (newest ? `, newest ${Math.floor(newest / 1000000000)}` : '') + ' (read-only, nothing written)');
      return;
    }
    await fs.mkdir(outputDirectory, {recursive: true});
    let files = 0, bytes = 0;
    async function walk(directory, disk) {
      const entries = await filesystem.listDirectory(s, save, directory, 2048);
      await fs.mkdir(disk, {recursive: true});
      for (const entry of entries) {
        const full = (directory.endsWith('/') ? directory : directory + '/') + entry.name;
        const target = path.join(disk, entry.name);
        const opened = await filesystem.openFile(s, save, full);
        if (!opened.result) {
          const size = Number(await filesystem.fileSize(s, opened.handle));
          const file = await fs.open(target, 'w');
          let offset = 0;
          while (offset < size) {
            const chunk = Math.min(0x40000, size - offset);
            const data = await filesystem.readFile(s, opened.handle, offset, chunk);
            if (!data.length) throw Error('Short read at ' + full + ' +' + offset);
            await file.write(data);
            offset += data.length;
          }
          await file.close();
          await s.close(opened.handle).catch(() => s.handles.delete(opened.handle));
          files += 1; bytes += size;
          console.error(`  ${full} (${size} bytes)`);
        } else {
          await walk(full, target);
        }
      }
    }
    await walk('/', outputDirectory);
    console.error(`done: ${files} files, ${bytes} bytes -> ${outputDirectory}`);
  } finally {
    if (keepOpen) {
      console.error('--keep-open: leaving the save mounted and the session alive');
      return;
    }
    if (save !== null) await s.close(save).catch(() => s.handles.delete(save));
    await s.cleanup().catch(() => {});
  }
}

const SESSION_LOST = /transport (?:failed )?(0xf601|62977)/i;
const NO_HOST = /ENOENT.*memory\.sock/i;
function fail(error) {
  if (NO_HOST.test(error.message || '')) {
    console.error('');
    console.error('NO LIVE HOST - that run directory has no host attached.');
    console.error('Start one with: node ~/ns2jb-rpc/run.cjs --rpc <this-mac-ip>');
    console.error('Then use the run folder it prints.');
    process.exit(4);
  }
  if (SESSION_LOST.test(error.message || '')) {
    console.error('');
    console.error('SESSION LOST - the console stopped answering this session.');
    console.error('Close SmileBASIC on the console, reopen it, run the bootstrap, then');
    console.error('start a new host (run.cjs) and retry. Nothing was changed on the save.');
    process.exit(3);
  }
  console.error('FAILED:', error.message);
  process.exit(1);
}

main().catch(fail);
