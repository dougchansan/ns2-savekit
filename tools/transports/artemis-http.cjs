'use strict';
// Artemis HTTP transport: talk to the installed alula Artemis Launcher over its
// own HTTP server, with no ns2jb RPC session.
//
// Upstream endpoints (unmodified):
//   GET    /status
//   POST   /eval          body = Lua source
//   PUT    /save?path=    body = file bytes (server body cap 0x7000)
//   DELETE /delete?path=
//
// The server has no download or listing endpoint, so downloads are bounded
// `/eval` reads returned as hex. Uploads above the request body cap are sent as
// a first `/save` chunk plus `/eval` appends; that path is explicitly marked as
// non-atomic until hardware proves os.rename works.
//
// This module does not modify the launcher, its protected files, or native
// memory. It only uses the endpoints above.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');

const DEFAULT_PORT = 8080;
// The server parses at most 0x7000 bytes of request body.
const SERVER_BODY_CAP = 0x7000;
const DEFAULT_CHUNK = 4096;
const MAX_APPEND_CHUNK = 6144; // 12 KiB of hex + Lua stays well below the cap

const PROTECTED = new Set([
  'core.lua', 'inject.iet', 'inject.lua', 'http.lua', 'proggy.ttf',
  'save9999.dat', 'saveg.dat', 'system.dat',
]);

const KNOWN_FILES = ['core.lua', 'inject.iet', 'inject.lua', 'http.lua', 'exploita.lua',
  'proggy.ttf', 'save9999.dat', 'saveg.dat', 'system.dat'];

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

class ArtemisHttpError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'ArtemisHttpError';
    this.code = code;
    Object.assign(this, extra);
  }
}

function saveName(name) {
  if (typeof name !== 'string' || !name) throw new ArtemisHttpError('EPATH', 'empty save path');
  const bare = name.replace(/^save:\//, '');
  if (!/^[A-Za-z0-9_.-]+$/.test(bare)) {
    throw new ArtemisHttpError('EPATH', 'save path must be a flat /name of [A-Za-z0-9_.-]: ' + name);
  }
  if (PROTECTED.has(bare)) throw new ArtemisHttpError('EPROTECTED', bare + ' is a protected launcher file');
  return {bare, full: 'save:/' + bare};
}

function anyName(name) {
  // Read-only operations may read protected files; they still reject traversal.
  const bare = String(name).replace(/^save:\//, '');
  if (!/^[A-Za-z0-9_.-]+$/.test(bare)) {
    throw new ArtemisHttpError('EPATH', 'save path must be a flat /name: ' + name);
  }
  return {bare, full: 'save:/' + bare};
}

function parseEval(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const status = /^status:\s*(ok|error)\s*$/.exec(lines[0] || '');
  if (!status) throw new ArtemisHttpError('EPROTO', 'unexpected /eval response: ' + text.slice(0, 120));
  const body = lines.slice(1);
  let result = null;
  let outputAt = -1;
  for (let i = 0; i < body.length; i++) {
    if (body[i].startsWith('result: ')) result = body[i].slice(8);
    if (body[i] === 'output:') { outputAt = i; break; }
  }
  const output = outputAt >= 0 ? body.slice(outputAt + 1) : [];
  return {ok: status[1] === 'ok', status: status[1], result, output, raw: text};
}

class ArtemisHttp {
  constructor(options = {}) {
    this.host = options.host;
    if (!this.host) throw new ArtemisHttpError('EHOST', 'a console IP or hostname is required');
    this.port = Number(options.port || DEFAULT_PORT);
    this.timeout = Number(options.timeout || 8000);
    this.retries = Number(options.retries ?? 2);
    this.fetch = options.fetch || globalThis.fetch;
    this.base = 'http://' + this.host + ':' + this.port;
  }

  async request(pathname, {method = 'GET', body = null, timeout = this.timeout,
    retry = 0} = {}) {
    let last;
    for (let attempt = 0; attempt <= retry; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await this.fetch(this.base + pathname, {
          method, body: body === null ? undefined : body,
          signal: controller.signal,
          headers: body === null ? {} : {'Content-Type': 'application/octet-stream'},
        });
        const text = await response.text();
        if (!response.ok) {
          throw new ArtemisHttpError('EHTTP', method + ' ' + pathname + ' -> ' + response.status +
            ': ' + text.slice(0, 160), {status: response.status, body: text});
        }
        return {status: response.status, text};
      } catch (error) {
        last = error;
        // Retry transport failures and 5xx, never a 4xx (a refused request will
        // be refused again, and a write must not be replayed blindly).
        const retryable = !(error instanceof ArtemisHttpError) ||
          (error.status >= 500 && error.status <= 599);
        if (!retryable || attempt === retry) break;
        await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
      } finally {
        clearTimeout(timer);
      }
    }
    if (last instanceof ArtemisHttpError) throw last;
    if (last && last.name === 'AbortError') {
      throw new ArtemisHttpError('ETIMEDOUT', 'no response from ' + this.base + pathname +
        ' within ' + timeout + ' ms');
    }
    throw new ArtemisHttpError('ECONN', 'cannot reach ' + this.base + pathname + ': ' +
      (last && last.message || last));
  }

  async status() {
    const {status, text} = await this.request('/status', {retry: this.retries});
    return {ok: status === 200, status, banner: text.trim(), raw: text};
  }

  async eval(code, {retry = 0, timeout = this.timeout} = {}) {
    if (typeof code !== 'string' || !code.length) {
      throw new ArtemisHttpError('ELUA', 'eval needs Lua source');
    }
    if (Buffer.byteLength(code) > SERVER_BODY_CAP) {
      throw new ArtemisHttpError('ESIZE', 'Lua source exceeds the server body cap (' +
        SERVER_BODY_CAP + ' bytes)');
    }
    const {text} = await this.request('/eval', {
      method: 'POST', body: code, timeout, retry,
    });
    const parsed = parseEval(text);
    if (!parsed.ok) {
      throw new ArtemisHttpError('ELUA', 'Lua error: ' + (parsed.result || parsed.output.join(' ') ||
        'unknown'), {raw: text});
    }
    return parsed;
  }

  async evalFile(file, options = {}) {
    return this.eval(await fsp.readFile(file, 'utf8'), options);
  }

  // Health, Lua version, platform (n2h.platform) and whether `e` exists.
  async health() {
    const status = await this.status();
    const parsed = await this.eval([
      'print(_VERSION)',
      'print(_G.n2h and _G.n2h.platform or "unknown")',
      'print(type(_G.e))',
    ].join('\n'), {retry: this.retries});
    const [lua = 'unknown', platform = 'unknown', engine = 'unknown'] = parsed.output;
    return {ok: true, status: status.status, banner: status.banner, lua: lua.trim(),
      platform: platform.trim(), engine: engine.trim(), raw: parsed.raw};
  }

  // Read-only existence/size check.
  async stat(name) {
    const {bare} = anyName(name);
    const parsed = await this.eval([
      '-- ns2http:stat ' + JSON.stringify({path: bare}),
      'local f=io.open("save:/' + bare + '","rb")',
      'if not f then print("missing") else local s=f:seek("end"); f:close(); print("size "..s) end',
    ].join('\n'), {retry: this.retries});
    const line = (parsed.output[0] || '').trim();
    if (line === 'missing') return {exists: false, size: 0};
    const match = /^size (\d+)$/.exec(line);
    if (!match) throw new ArtemisHttpError('EPROTO', 'unexpected stat reply: ' + line);
    return {exists: true, size: Number(match[1])};
  }

  // One bounded hex read. Returns exactly `length` bytes for a non-final chunk.
  async readChunk(name, offset, length) {
    const {bare} = anyName(name);
    if (!Number.isInteger(offset) || offset < 0) throw new ArtemisHttpError('ERANGE', 'bad offset');
    if (!Number.isInteger(length) || length <= 0 || length > 65536) {
      throw new ArtemisHttpError('ERANGE', 'bad length');
    }
    const parsed = await this.eval([
      '-- ns2http:read ' + JSON.stringify({path: bare, offset, length}),
      'local f=assert(io.open("save:/' + bare + '","rb"))',
      'f:seek("set",' + offset + ')',
      'local d=f:read(' + length + ') or ""',
      'f:close()',
      'print(#d)',
      'local t={} for i=1,#d do t[i]=string.format("%02x",d:byte(i)) end',
      'print(table.concat(t))',
    ].join('\n'), {timeout: Math.max(this.timeout, 15000)});
    const count = Number((parsed.output[0] || '').trim());
    const hex = (parsed.output[1] || '').trim();
    if (!Number.isInteger(count) || count < 0 || count > length) {
      throw new ArtemisHttpError('EPROTO', 'read returned an invalid byte count: ' +
        parsed.output[0]);
    }
    if (hex.length !== count * 2 || !/^[0-9a-f]*$/.test(hex)) {
      throw new ArtemisHttpError('EPROTO', 'read returned malformed hex (' + hex.length +
        ' chars for ' + count + ' bytes)');
    }
    return Buffer.from(hex, 'hex');
  }

  // Download with chunk hashes, resume state and atomic promotion.
  async download(name, {out, chunkSize = DEFAULT_CHUNK, expectedSha256 = null,
    expectedSize = null, resume = true, onProgress = null} = {}) {
    const {bare} = anyName(name);
    if (!out) throw new ArtemisHttpError('EUSAGE', 'download needs --out');
    const target = path.resolve(out);
    const part = target + '.part';
    const stateFile = part + '.json';
    const stat = await this.stat(bare);
    if (!stat.exists) throw new ArtemisHttpError('ENOENT', 'save:/' + bare + ' does not exist');
    if (expectedSize !== null && stat.size !== expectedSize) {
      throw new ArtemisHttpError('ESIZE', 'size ' + stat.size + ' != expected ' + expectedSize);
    }
    const size = stat.size;

    let state = null;
    if (resume && fs.existsSync(stateFile) && fs.existsSync(part)) {
      try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { state = null; }
      if (state && (state.path !== bare || state.size !== size ||
          state.chunkSize !== chunkSize)) state = null;
    }
    if (!state) {
      state = {version: 1, path: bare, size, chunkSize, chunks: []};
      await fsp.rm(part, {force: true});
      await fsp.writeFile(part, Buffer.alloc(0), {mode: 0o600});
    } else {
      // Verify every recorded chunk against the partial file before resuming.
      const partial = await fsp.readFile(part);
      let offset = 0;
      for (const chunk of state.chunks) {
        if (chunk.offset !== offset) { state = null; break; }
        const bytes = partial.subarray(offset, offset + chunk.length);
        if (bytes.length !== chunk.length || sha256(bytes) !== chunk.sha256) { state = null; break; }
        offset += chunk.length;
      }
      if (state && offset !== partial.length) state = null;
      if (!state) {
        state = {version: 1, path: bare, size, chunkSize, chunks: []};
        await fsp.rm(part, {force: true});
        await fsp.writeFile(part, Buffer.alloc(0), {mode: 0o600});
      }
    }

    let offset = state.chunks.reduce((n, chunk) => n + chunk.length, 0);
    const handle = await fsp.open(part, 'r+');
    try {
      while (offset < size) {
        const want = Math.min(chunkSize, size - offset);
        const bytes = await this.readChunk(bare, offset, want);
        if (bytes.length !== want) {
          throw new ArtemisHttpError('ESIZE', 'short read at ' + offset + ': got ' +
            bytes.length + ' of ' + want + ' bytes; partial file kept for resume');
        }
        await handle.write(bytes, 0, bytes.length, offset);
        state.chunks.push({offset, length: bytes.length, sha256: sha256(bytes)});
        offset += bytes.length;
        await fsp.writeFile(stateFile, JSON.stringify(state, null, 2) + '\n', {mode: 0o600});
        if (onProgress) onProgress(offset, size);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    const total = state.chunks.reduce((n, chunk) => n + chunk.length, 0);
    if (total !== size) {
      throw new ArtemisHttpError('ESIZE', 'assembled ' + total + ' bytes, expected ' + size +
        '; partial file kept for resume');
    }
    const digest = sha256(await fsp.readFile(part));
    if (expectedSha256 && digest !== expectedSha256) {
      throw new ArtemisHttpError('EHASH', 'sha256 ' + digest + ' != expected ' + expectedSha256 +
        '; partial file kept');
    }
    await fsp.rename(part, target);
    await fsp.rm(stateFile, {force: true});
    return {path: target, size, sha256: digest};
  }

  // Upload: direct /save up to the server cap; larger files as a first chunk
  // plus /eval appends. Chunked writes are not atomic (documented); `atomic`
  // uploads to a temporary name and uses os.rename only when probed working.
  async upload(name, bytes, {overwrite = false, chunkSize = MAX_APPEND_CHUNK,
    atomic = false} = {}) {
    const {bare, full} = saveName(name);
    if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
    const existing = await this.stat(bare);
    if (existing.exists && !overwrite) {
      throw new ArtemisHttpError('EEXIST', 'save:/' + bare + ' exists; pass --force to overwrite');
    }
    let target = bare;
    if (atomic) {
      const probe = await this.probeRename();
      if (!probe.ok) throw new ArtemisHttpError('EATOMIC', 'os.rename is not available: ' +
        (probe.reason || 'unknown'));
      target = '.' + bare + '.http-part';
    }
    if (bytes.length <= SERVER_BODY_CAP - 1024) {
      await this.putRaw(target, bytes);
    } else {
      await this.putRaw(target, bytes.subarray(0, SERVER_BODY_CAP - 1024));
      let offset = SERVER_BODY_CAP - 1024;
      while (offset < bytes.length) {
        const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
        await this.appendRaw(target, chunk);
        offset += chunk.length;
      }
    }
    const after = await this.stat(target);
    if (!after.exists || after.size !== bytes.length) {
      throw new ArtemisHttpError('ESIZE', 'uploaded size ' + (after.exists ? after.size : 'missing') +
        ' != ' + bytes.length);
    }
    if (atomic) {
      const renamed = await this.renameRaw(target, bare, overwrite);
      if (!renamed.ok) {
        await this.removeRaw(target).catch(() => {});
        throw new ArtemisHttpError('EATOMIC', 'rename to target failed: ' +
          (renamed.reason || 'unknown') + ' (temporary file removed; upload was not atomic)');
      }
      target = bare;
    }
    const check = await this.stat(bare);
    return {path: full, size: check.size, sha256: sha256(bytes), atomic};
  }

  async putRaw(bare, bytes) {
    const {text} = await this.request('/save?path=' + encodeURIComponent('save:/' + bare), {
      method: 'PUT', body: bytes, timeout: Math.max(this.timeout, 20000),
    });
    const match = /wrote (\d+) bytes/.exec(text);
    if (!match || Number(match[1]) !== bytes.length) {
      throw new ArtemisHttpError('EPROTO', 'unexpected /save reply: ' + text.slice(0, 120));
    }
  }

  async appendRaw(bare, bytes) {
    const hex = bytes.toString('hex');
    const code = [
      '-- ns2http:append ' + JSON.stringify({path: bare, length: bytes.length}),
      'local h="' + hex + '"',
      'local f=assert(io.open("save:/' + bare + '","ab"))',
      'for i=1,#h,2 do f:write(string.char(tonumber(h:sub(i,i+1),16))) end',
      'f:close()',
      'print("appended")',
    ].join('\n');
    if (Buffer.byteLength(code) > SERVER_BODY_CAP) {
      throw new ArtemisHttpError('ESIZE', 'append chunk too large for the server body cap');
    }
    const parsed = await this.eval(code, {timeout: Math.max(this.timeout, 20000)});
    if ((parsed.output[0] || '').trim() !== 'appended') {
      throw new ArtemisHttpError('EPROTO', 'append did not confirm');
    }
  }

  async renameRaw(from, to, overwrite) {
    const code = [
      '-- ns2http:rename ' + JSON.stringify({from, to, overwrite: !!overwrite}),
      'local ok,err=os.rename("save:/' + from + '","save:/' + to + '")',
      'print(tostring(ok))',
      'if not ok then print(tostring(err)) end',
    ].join('\n');
    const parsed = await this.eval(code);
    const ok = (parsed.output[0] || '').trim() === 'true';
    return {ok, reason: ok ? null : (parsed.output[1] || 'rename failed')};
  }

  async probeRename() {
    // Two scratch files, rename one over the other, then clean both names.
    const a = '.ns2http-probe-a';
    const b = '.ns2http-probe-b';
    try {
      await this.putRaw(a, Buffer.from('a'));
      await this.putRaw(b, Buffer.from('b'));
      const renamed = await this.renameRaw(a, b, true);
      const after = await this.stat(b);
      await this.removeRaw(a).catch(() => {});
      await this.removeRaw(b).catch(() => {});
      return {ok: renamed.ok, reason: renamed.reason,
        overwrote: renamed.ok ? after.exists : false};
    } catch (error) {
      await this.removeRaw(a).catch(() => {});
      await this.removeRaw(b).catch(() => {});
      return {ok: false, reason: error.message};
    }
  }

  async removeRaw(bare) {
    const {text} = await this.request('/delete?path=' + encodeURIComponent('save:/' + bare),
      {method: 'DELETE'});
    if (!/deleted /.test(text)) throw new ArtemisHttpError('EPROTO', 'unexpected delete reply: ' + text);
    return text.trim();
  }

  async remove(name) {
    const {bare} = saveName(name);
    const before = await this.stat(bare);
    if (!before.exists) {
      throw new ArtemisHttpError('ENOENT', 'save:/' + bare + ' does not exist');
    }
    const text = await this.removeRaw(bare);
    const after = await this.stat(bare);
    if (after.exists) throw new ArtemisHttpError('ESTILL', 'save:/' + bare + ' is still present');
    return {path: bare, deleted: true, reply: text};
  }

  // Explicit-file backup. The server has no listing endpoint, so this is not a
  // complete archive and is marked as such.
  async backup(files, outDir, {chunkSize = DEFAULT_CHUNK} = {}) {
    const list = files && files.length ? files : KNOWN_FILES;
    const dir = path.resolve(outDir);
    await fsp.mkdir(dir, {recursive: true});
    const entries = [];
    for (const name of list) {
      const bare = anyName(name).bare;
      const stat = await this.stat(bare);
      if (!stat.exists) continue;
      const file = path.join(dir, bare);
      const got = await this.download(bare, {out: file, chunkSize});
      entries.push({path: '/' + bare, size: got.size, sha256: got.sha256});
    }
    const manifest = {
      transport: 'artemis-http',
      source: this.base,
      scope: 'explicit-files',
      complete: false,
      note: 'The upstream HTTP server has no directory listing, so this is an explicit-file ' +
        'backup, not a complete save archive. It cannot authorize a destructive full restore.',
      files: entries.length,
      bytes: entries.reduce((n, entry) => n + entry.size, 0),
      entries,
    };
    await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    return {dir, manifest};
  }
}

// Scan a /24 for Artemis servers. Explicit host always wins; discovery is a
// convenience and reports every banner match.
async function discover({subnet, port = DEFAULT_PORT, timeout = 400, concurrency = 32} = {}) {
  if (!subnet) throw new ArtemisHttpError('EUSAGE', 'discover needs --subnet a.b.c');
  const prefix = String(subnet).replace(/\.$/, '');
  const found = [];
  const queue = Array.from({length: 254}, (_, i) => i + 1);
  async function worker() {
    while (queue.length) {
      const last = queue.shift();
      const host = prefix + '.' + last;
      try {
        const client = new ArtemisHttp({host, port, timeout, retries: 0});
        const status = await client.status();
        if (/artemis|nora2hax|seedsow/i.test(status.banner)) found.push({host, banner: status.banner});
      } catch { /* not this host */ }
    }
  }
  await Promise.all(Array.from({length: Math.min(concurrency, queue.length)}, worker));
  found.sort((a, b) => a.host.localeCompare(b.host, undefined, {numeric: true}));
  return found;
}

module.exports = {
  ArtemisHttp, ArtemisHttpError, discover, saveName, anyName, parseEval, sha256,
  PROTECTED, KNOWN_FILES, SERVER_BODY_CAP, MAX_APPEND_CHUNK, DEFAULT_CHUNK,
};
